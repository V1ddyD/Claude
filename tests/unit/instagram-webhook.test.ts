import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The webhook door.
 *
 * An unverified webhook is an anonymous stranger able to put words in a
 * customer's mouth, open a conversation under a dealership's name, and have
 * its assistant answer. So the signature is not a formality here — it is the
 * only thing standing between the public internet and the conversation loop.
 */

const ORIGINAL = { ...process.env };
const SECRET = 'app-secret-for-tests';
const VERIFY_TOKEN = 'verify-token-for-tests';

const received: Record<string, unknown>[] = [];

/**
 * `after` belongs to the platform's request lifecycle, which the test runner
 * does not have. Replaced with something that runs the callback and keeps its
 * promise, so the deferred work can be awaited and asserted rather than
 * skipped — the whole point of the route is what it does after the 200.
 */
const deferred = vi.hoisted(() => ({ work: Promise.resolve() as Promise<unknown> }));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => {
      deferred.work = Promise.resolve(fn()).catch(() => undefined);
    },
  };
});

// The work past the door needs a database. What is under test is the door.
vi.mock('@/server/channels/inbound', () => ({
  receiveChannelMessage: async (message: Record<string, unknown>) => {
    received.push(message);
    return { status: 'ignored', reason: 'mocked' };
  },
}));
vi.mock('@/server/jobs', () => ({ runWorker: async () => ({}) }));

async function loadRoute(vars: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env.META_APP_SECRET = SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../../src/app/api/webhooks/instagram/route');
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function post(body: string, signature: string | null) {
  return new Request('https://sinclairmotors.test/api/webhooks/instagram', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    body,
  }) as never;
}

function message(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: '17841400000000000',
        messaging: [
          {
            sender: { id: 'igsid-1' },
            recipient: { id: '17841400000000000' },
            message: { mid: 'mid.1', text: 'hello', ...overrides },
          },
        ],
      },
    ],
  });
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  received.length = 0;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('the subscription handshake', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const { GET } = await loadRoute();
    const url =
      'https://sinclairmotors.test/api/webhooks/instagram' +
      `?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`;

    const response = await GET(new Request(url) as never);

    expect(response.status).toBe(200);
    // Verbatim and as plain text. Meta compares the body exactly; a JSON
    // wrapper fails the subscription with no useful error.
    expect(await response.text()).toBe('1158201444');
  });

  it('refuses a wrong verify token', async () => {
    const { GET } = await loadRoute();
    const url =
      'https://sinclairmotors.test/api/webhooks/instagram' +
      '?hub.mode=subscribe&hub.verify_token=not-the-token&hub.challenge=1158201444';

    expect((await GET(new Request(url) as never)).status).toBe(403);
  });
});

describe('an inbound delivery', () => {
  it('refuses a body signed with the wrong secret', async () => {
    const { POST } = await loadRoute();
    const body = message();

    const response = await POST(post(body, sign(body, 'not-our-secret')));

    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('refuses an unsigned body', async () => {
    const { POST } = await loadRoute();
    const body = message();

    expect((await POST(post(body, null))).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('refuses a signature for different bytes', async () => {
    const { POST } = await loadRoute();
    // Signed correctly, for a DIFFERENT body: the check must be over the bytes
    // received, not over a re-serialisation of the parsed object.
    const response = await POST(post(message({ text: 'tampered' }), sign(message())));

    expect(response.status).toBe(401);
  });

  it('accepts a correctly signed message and hands it on intact', async () => {
    const { POST } = await loadRoute();
    const body = message();

    const response = await POST(post(body, sign(body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 1 });

    await deferred.work;
    expect(received).toHaveLength(1);
    // The dealership is the RECIPIENT of an inbound message, never the sender.
    // Reading those the wrong way round would route every customer's message
    // to a tenant chosen by whoever sent it.
    expect(received[0]).toMatchObject({
      channel: 'instagram',
      externalAccountId: '17841400000000000',
      externalUserId: 'igsid-1',
      externalMessageId: 'mid.1',
      text: 'hello',
    });
  });

  it('answers after the 200, never before it', () => {
    // Structural, deliberately. Whether `after` defers is Next's contract, not
    // ours, and a test double cannot faithfully reproduce it — what is ours is
    // the decision to put the reply there at all.
    //
    // Meta expects a prompt 200 and redelivers anything slower. Answering
    // inside the request means calling the model first, which turns one
    // customer message into several redeliveries of it.
    const route = readFileSync('src/app/api/webhooks/instagram/route.ts', 'utf8');

    expect(route).toMatch(/after\(async \(\) => \{[\s\S]*receiveChannelMessage\(/);
    // And the acknowledgement is not itself inside the deferred work.
    expect(route).toMatch(/\n  return NextResponse\.json\(\{ received:/);
  });

  it('ignores an echo of our own outbound message', async () => {
    const { POST } = await loadRoute();
    // Without this the assistant answers itself, and then answers that, and
    // the dealership's Instagram argues with itself until the window closes.
    const body = message({ is_echo: true });

    const response = await POST(post(body, sign(body)));

    expect(await response.json()).toEqual({ received: 0 });
  });

  it('ignores a message with no text', async () => {
    const { POST } = await loadRoute();
    // A photo, a sticker, a reaction. Recognised as something we cannot read
    // rather than answered as though it were empty.
    const body = message({ text: undefined, attachments: [{ type: 'image' }] });

    const response = await POST(post(body, sign(body)));

    expect(await response.json()).toEqual({ received: 0 });
  });

  it('refuses everything when no app secret is configured', async () => {
    const { POST } = await loadRoute({ META_APP_SECRET: undefined });
    const body = message();

    // Not "allow it through because we cannot check": a deployment without a
    // secret cannot authenticate anyone, so it serves no one.
    expect((await POST(post(body, sign(body)))).status).toBe(503);
  });
});
