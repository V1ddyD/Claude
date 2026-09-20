import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { headers } from 'next/headers';
import { z } from 'zod';
import { resolveTenantByHost } from '@/server/context/tenant';
import {
  connectChannelAccount, disconnectChannelAccount, listChannelAccounts,
} from '@/server/channels/accounts';
import { env } from '@/server/config/env';

/**
 * Connect a dealership's Instagram or Messenger account.
 *
 * The last missing piece of onboarding a channel: until a row exists here, a
 * webhook arrives for an account nobody owns and is correctly ignored. Doing
 * it by hand against the production database was the only alternative, and a
 * credential pasted into a SQL console is a credential in somebody's shell
 * history.
 *
 * The dealership comes from the HOSTNAME, exactly as it does for the customer
 * site — never from the request body. A caller who could name a tenant could
 * attach their own Instagram account to somebody else's dealership and start
 * answering their customers.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const connectSchema = z.object({
  channel: z.enum(['instagram', 'messenger', 'whatsapp']),
  externalAccountId: z.string().min(1).max(200),
  accessToken: z.string().min(10).max(1000),
  displayName: z.string().max(200).optional(),
  expiresInSeconds: z.number().int().positive().max(60 * 60 * 24 * 400).optional(),
});

export async function POST(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;

  const parsed = connectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.issues.map((i) => i.path.join('.')) },
      { status: 400 },
    );
  }

  const tenant = await resolveTenantByHost((await headers()).get('host'));

  try {
    const account = await connectChannelAccount({ tenantId: tenant.id, ...parsed.data });
    // The token is never echoed, not even to the caller who just supplied it:
    // a response body ends up in logs, proxies and terminal scrollback.
    return NextResponse.json({ ok: true, tenant: tenant.slug, account });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error' },
      { status: 409 },
    );
  }
}

/** What this dealership has connected. Useful for confirming a connection took. */
export async function GET(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;

  const tenant = await resolveTenantByHost((await headers()).get('host'));
  return NextResponse.json({
    tenant: tenant.slug,
    accounts: await listChannelAccounts(tenant.id),
  });
}

export async function DELETE(request: NextRequest) {
  const denied = await authorize(request);
  if (denied) return denied;

  const channel = new URL(request.url).searchParams.get('channel');
  const externalAccountId = new URL(request.url).searchParams.get('externalAccountId');

  if (!channel || !externalAccountId) {
    return NextResponse.json({ error: 'channel and externalAccountId are required' }, { status: 400 });
  }
  if (channel !== 'instagram' && channel !== 'messenger' && channel !== 'whatsapp') {
    return NextResponse.json({ error: 'Unknown channel' }, { status: 400 });
  }

  const tenant = await resolveTenantByHost((await headers()).get('host'));
  const found = await disconnectChannelAccount(tenant.id, channel, externalAccountId);

  return NextResponse.json({ ok: found });
}

/**
 * The same shared secret the worker and bootstrap routes use.
 *
 * Returns a response when the caller is refused, and nothing when they are
 * allowed — so a handler that forgets to check reads as obviously wrong.
 */
async function authorize(request: NextRequest): Promise<NextResponse | null> {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Not configured.' }, { status: 503 });
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!matches(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

function matches(supplied: string, expected: string): boolean {
  if (expected.length === 0) return false;
  // Hashed first so the comparison is over equal-length buffers:
  // timingSafeEqual throws on a length mismatch, which leaks the length.
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}
