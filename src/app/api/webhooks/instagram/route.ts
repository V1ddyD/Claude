import { NextResponse, after, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { receiveChannelMessage } from '@/server/channels/inbound';
import { runWorker } from '@/server/jobs';
import { env, features, messagingSecrets } from '@/server/config/env';

/**
 * Instagram and Messenger direct messages.
 *
 * Both arrive here: they are one Meta app, one subscription and one payload
 * shape, distinguished by the `object` field. Splitting them into two routes
 * would duplicate the signature check, which is the one part that must not be
 * duplicated.
 *
 * Node runtime: it verifies an HMAC, opens database transactions and calls the
 * model. The tenant comes from the account the message was sent TO, never from
 * anything the sender controls.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Meta's own cap is 1000 characters for a DM. */
const MAX_INBOUND_CHARS = 2000;

/**
 * The subscription handshake.
 *
 * Meta calls this once, when the webhook is first pointed at us, and expects
 * the challenge echoed back verbatim as plain text. It proves we own the
 * endpoint; every real delivery is authenticated by signature instead.
 */
export async function GET(request: NextRequest) {
  // From the URL rather than `nextUrl`: the same values, and it leaves the
  // handshake exercisable with an ordinary Request.
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  const expected = env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'Webhooks are not configured.' }, { status: 503 });
  }

  // Constant time: this is a secret comparison, however short-lived.
  if (mode !== 'subscribe' || !token || !equals(token, expected)) {
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
  }

  return new Response(challenge ?? '', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/** See the size check in POST. */
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();

  if (!features.messagingWebhooks) {
    return NextResponse.json({ error: 'Webhooks are not configured.' }, { status: 503 });
  }

  // Size first. Verifying a signature means reading and hashing the whole
  // body, and this endpoint is public: without a ceiling, anybody can make it
  // read and hash as much as they care to send. Meta's own payloads are a few
  // kilobytes; a megabyte is room for a large batch and nothing else.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  // Read as text and verify BEFORE parsing. An unverified webhook is an
  // anonymous stranger able to put words in a customer's mouth, start a
  // conversation under a dealership's name, and be answered by its assistant.
  const raw = await request.text();
  // The header is a claim; the body is the fact.
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  if (!verifySignature(raw, request.headers.get('x-hub-signature-256'), messagingSecrets())) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(raw) as MetaWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  const messages = extractMessages(payload);

  // Acknowledge FIRST, work after.
  //
  // Meta expects a prompt 200 and redelivers anything slower, and a reply that
  // calls the model takes seconds. Answering inside the request would turn one
  // customer message into several redeliveries of it — which the inbound dedup
  // ledger would then have to catch. `after` runs once the response is out, so
  // the acknowledgement is never waiting on a model.
  after(async () => {
    for (const message of messages) {
      try {
        await receiveChannelMessage({ ...message, requestId });
      } catch (error) {
        // Never surfaced: Meta has already had its 200, and a failure here is
        // an operational problem rather than something to redeliver forever.
        console.error(`[webhook:instagram] ${requestId}`, error);
      }
    }

    // Deliver whatever was queued, for the same reason the chat endpoint
    // drains: on a free plan a scheduled worker may run once a DAY, and a
    // reply that waits until tomorrow is not a reply.
    try {
      await runWorker();
    } catch (error) {
      console.error(`[webhook:instagram:worker] ${requestId}`, error);
    }
  });

  return NextResponse.json({ received: messages.length });
}

/**
 * The bits of Meta's payload we read.
 *
 * Everything else — reactions, read receipts, postbacks, deliveries — is
 * ignored rather than half-handled.
 */
interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    messaging?: Array<{
      sender?: { id?: string; username?: string };
      recipient?: { id?: string };
      message?: {
        mid?: string;
        text?: string;
        is_echo?: boolean;
        is_deleted?: boolean;
        attachments?: unknown[];
      };
    }>;
  }>;
}

type ExtractedMessage = Omit<Parameters<typeof receiveChannelMessage>[0], 'requestId'>;

function extractMessages(payload: MetaWebhookPayload): ExtractedMessage[] {
  const channel = payload.object === 'instagram' ? 'instagram' : 'messenger';
  const found: ExtractedMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      const senderId = event.sender?.id;
      // The recipient IS the business account for an inbound message. Falling
      // back to the entry id covers the shapes where it is only given there.
      const accountId = event.recipient?.id ?? entry.id;

      if (!message?.mid || !senderId || !accountId) continue;
      // An echo is our OWN outbound message coming back. Answering one would
      // be the assistant replying to itself, forever.
      if (message.is_echo || message.is_deleted) continue;
      if (!message.text) continue;

      found.push({
        channel,
        externalAccountId: accountId,
        externalUserId: senderId,
        externalMessageId: message.mid,
        text: message.text.slice(0, MAX_INBOUND_CHARS),
        displayName: event.sender?.username ?? null,
      });
    }
  }

  return found;
}

/**
 * Meta signs the raw body with an app secret, as `sha256=<hex>`.
 *
 * Verified against the bytes we received, not against a re-serialisation of
 * the parsed object: JSON.stringify would reorder keys and change whitespace,
 * and the signature would never match.
 *
 * Checked against EVERY configured secret because Meta issues two — a Facebook
 * app secret and an Instagram one — and which signs a given delivery depends
 * on how the account was connected. Every candidate is compared even after a
 * match, so the work does not depend on which secret was the right one.
 */
function verifySignature(body: string, header: string | null, secrets: string[]): boolean {
  if (!header?.startsWith('sha256=')) return false;
  if (secrets.length === 0) return false;

  const supplied = header.slice('sha256='.length);
  return secrets.reduce((matched, secret) => {
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    return equals(supplied, expected) || matched;
  }, false);
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Checked first, and the comparison still runs in constant time for
  // the case that matters.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
