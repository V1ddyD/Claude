import { NextResponse, type NextRequest } from 'next/server';
import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { resolveTenantByHost } from '@/server/context/tenant';
import { openConversation } from '@/server/ai/extraction';
import { respondToMessage } from '@/server/ai/conversation';
import { withTenant } from '@/server/db/tenant-db';
import { enqueue } from '@/server/jobs';
import { createHash } from 'node:crypto';
import { toPublicError, isAppError, AppError } from '@/server/errors';
import { checkRateLimit } from '@/server/services/limits';
import { isProduction } from '@/server/config/env';

/**
 * The customer chat endpoint.
 *
 * Node runtime: it opens database transactions and calls the model. The tenant
 * comes from the hostname and the visitor from a signed cookie — neither is
 * ever accepted from the request body, which is the whole attack.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VISITOR_COOKIE = 'sinclair_visitor';

const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
  /** Server-sent events. The non-streaming path stays for simple clients. */
  stream: z.boolean().optional(),
});

/**
 * Per-visitor limit, held in Postgres.
 *
 * It used to be an in-process Map, which meant every serverless instance had
 * its own copy and the limit was effectively unenforced — on a public endpoint
 * that calls a paid model, which is the one place it matters.
 */
const CHAT_LIMIT = { bucket: 'chat', max: 12, windowSeconds: 60 };

/**
 * Stream the reply as server-sent events.
 *
 * Events: `status` while a tool runs, `delta` for text as it arrives,
 * `receipt` for a confirmation slip, `done` at the end, `error` if something
 * fails mid-stream.
 *
 * Errors are delivered as an event rather than an HTTP status, because the
 * headers are long gone by the time anything can go wrong. A customer must
 * never be left watching a stream that simply stops.
 */
function streamReply(params: {
  tenantId: string;
  conversationId: string;
  visitorId: string;
  userMessage: string;
  requestId: string;
}): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const reply = await respondToMessage({
          ...params,
          stream: {
            onDelta: (text) => send('delta', { text }),
            onStatus: (status) => send('status', { status }),
          },
        });

        if (reply.receipt) send('receipt', reply.receipt);
        send('done', {
          conversationId: reply.conversationId,
          degraded: reply.degraded,
          mode: reply.mode,
        });
      } catch (error) {
        if (!isAppError(error)) {
          console.error(`[chat:stream] ${params.requestId}`, error);
        }
        send('error', toPublicError(error));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops nginx and similar buffering the stream into one lump.
      'X-Accel-Buffering': 'no',
    },
  });
}


export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();

  try {
    const tenant = await resolveTenantByHost((await headers()).get('host'));

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'That message could not be read.');
    }

    const cookieStore = await cookies();
    const existingVisitor = cookieStore.get(VISITOR_COOKIE)?.value;

    // The subject is opaque: a visitor id, or a hashed forwarded-for. Never an
    // email or a name — a rate-limit table is not a place for personal data.
    const subject =
      existingVisitor ??
      createHash('sha256')
        .update(request.headers.get('x-forwarded-for') ?? 'anonymous')
        .digest('hex')
        .slice(0, 32);

    const limit = await checkRateLimit({ ...CHAT_LIMIT, subject: `${tenant.id}:${subject}` });
    if (!limit.allowed) {
      return NextResponse.json(
        toPublicError(
          new AppError(
            'RATE_LIMITED',
            'You are sending messages very quickly. Please pause a moment.',
          ),
        ),
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
      );
    }

    // Creates the visitor if the cookie is missing, unknown, or belongs to
    // another dealership — a cookie value is never trusted as an identity.
    //
    // Extraction and scoring run off the customer's critical path, and are
    // queued in the same transaction: enqueued BEFORE the reply is produced so
    // a client that disconnects mid-stream still leaves the lead to be scored,
    // and committed together with the conversation it refers to.
    const session = await withTenant(tenant.id, async (db) => {
      const opened = await openConversation(db, {
        conversationId: parsed.data.conversationId,
        visitorId: existingVisitor,
      });
      await enqueue(db, 'extract_and_score', { conversationId: opened.conversationId });
      return opened;
    });

    const setVisitorCookie = (response: Response) => {
      if (session.visitorId === existingVisitor) return response;
      // A Set-Cookie on a streamed response: the header goes out with the
      // headers, before the first byte of the body, so it is not affected by
      // the stream that follows.
      response.headers.append(
        'Set-Cookie',
        `${VISITOR_COOKIE}=${session.visitorId}; HttpOnly; SameSite=Lax; Path=/; ` +
          `Max-Age=${60 * 60 * 24 * 180}${isProduction ? '; Secure' : ''}`,
      );
      return response;
    };

    if (parsed.data.stream) {
      return setVisitorCookie(
        streamReply({
          tenantId: tenant.id,
          conversationId: session.conversationId,
          visitorId: session.visitorId,
          userMessage: parsed.data.message,
          requestId,
        }),
      );
    }

    const reply = await respondToMessage({
      tenantId: tenant.id,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: parsed.data.message,
      requestId,
    });

    return setVisitorCookie(
      NextResponse.json({
        message: reply.text,
        conversationId: session.conversationId,
        degraded: reply.degraded,
        mode: reply.mode,
        ...(reply.receipt ? { receipt: reply.receipt } : {}),
      }),
    );
  } catch (error) {
    if (!isAppError(error)) {
      console.error(`[chat] ${requestId}`, error);
    }
    const published = toPublicError(error);
    return NextResponse.json(published, {
      status: isAppError(error) ? error.status : 500,
    });
  }
}
