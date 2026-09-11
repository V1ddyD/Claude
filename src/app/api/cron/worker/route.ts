import { NextResponse, type NextRequest } from 'next/server';
import { runWorker } from '@/server/jobs';
import { env } from '@/server/config/env';

/**
 * Drains the job queue. Invoked by the platform's scheduler.
 *
 * Authenticated by a shared secret in a constant-time comparison — a public
 * endpoint that runs arbitrary queued work is a denial-of-service surface.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Worker is not configured.' }, { status: 503 });
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!timingSafeEqual(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const report = await runWorker();
  return NextResponse.json(report);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
