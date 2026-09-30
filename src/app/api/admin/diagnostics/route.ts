import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { channelDiagnostics, healthCheck, resubscribeInstagram } from '@/server/channels/diagnostics';
import { env } from '@/server/config/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Whether direct messages are arriving and replies are leaving.
 *
 * For whoever operates the platform, when "the bot isn't replying" needs an
 * answer and the host's logs are not to hand. Off unless DIAGNOSTICS_TOKEN is
 * set, and then only with that token: a 404 either way to anybody else, so
 * the endpoint does not advertise itself.
 */
export async function GET(request: NextRequest) {
  const expected = env.DIAGNOSTICS_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!expected || !matches(supplied, expected)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  try {
    return NextResponse.json(await channelDiagnostics(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[diagnostics]', error);
    return NextResponse.json({ error: 'Diagnostics failed.' }, { status: 500 });
  }
}

/**
 * POST ?action=check: the hourly check. Delivers stuck replies, repairs what
 * it can, and reports what a person still has to fix.
 * POST with no action: re-subscribes connected Instagram accounts to message
 * webhooks.
 */
export async function POST(request: NextRequest) {
  const expected = env.DIAGNOSTICS_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!expected || !matches(supplied, expected)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (new URL(request.url).searchParams.get('action') === 'check') {
    try {
      return NextResponse.json(await healthCheck(), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('[diagnostics:check]', error);
      return NextResponse.json(
        { ok: false, problems: ['The check itself failed: the server or its database may be down.'] },
        { status: 500 },
      );
    }
  }
  try {
    return NextResponse.json({ resubscribed: await resubscribeInstagram() });
  } catch (error) {
    console.error('[diagnostics]', error);
    return NextResponse.json({ error: 'Resubscribe failed.' }, { status: 500 });
  }
}

function matches(supplied: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}
