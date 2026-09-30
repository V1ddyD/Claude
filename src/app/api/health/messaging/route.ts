import { NextResponse } from 'next/server';
import { healthCheck } from '@/server/channels/diagnostics';
import { checkRateLimit } from '@/server/services/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Are direct messages being answered? Yes or no, for an hourly check.
 *
 * Public, so a scheduler can call it without holding a key. It says nothing
 * else: no account, no count, no error text. The detail is behind the
 * diagnostics token, for whoever is fixing it.
 *
 * Calling it also repairs what the check can repair (stuck replies go out, a
 * dropped webhook subscription is renewed), so it runs at most once a minute
 * however often a stranger calls it.
 */
export async function GET() {
  const limit = await checkRateLimit({ bucket: 'messaging-health', subject: 'all', max: 1, windowSeconds: 60 });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: null, retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let ok = false;
  try {
    ok = (await healthCheck()).ok;
  } catch (error) {
    console.error('[health:messaging]', error);
  }
  return NextResponse.json({ ok }, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
