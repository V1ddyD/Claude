import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { bootstrapDemonstration } from '@/server/services/onboarding/bootstrap';
import { env, features } from '@/server/config/env';

/**
 * Migrate and seed the hosted demonstration database.
 *
 * Three things keep this from being a liability:
 *
 *   DEMO_MODE      it does not exist on a deployment that has not declared
 *                  itself a demonstration, so a real dealership's database
 *                  cannot be seeded with a fictional one
 *   CRON_SECRET    the same shared secret the worker route uses, compared in
 *                  constant time
 *   idempotence    calling it twice changes nothing
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!features.demoPortal) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const secret = env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Bootstrap is not configured.' }, { status: 503 });
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!matches(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await bootstrapDemonstration({
      hostname: request.headers.get('host') ?? undefined,
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    console.error('[bootstrap]', error);
    // The message only. A driver error carries the host and the role.
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

function matches(supplied: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}
