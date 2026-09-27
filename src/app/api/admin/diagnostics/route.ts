import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { channelDiagnostics } from '@/server/channels/diagnostics';
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

function matches(supplied: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}
