import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '@/server/config/env';
import { operatorTenantIdBySlug } from '@/server/db/control-plane';
import { withTenant } from '@/server/db/tenant-db';
import { provisionOwner } from '@/server/services/team';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Give a business an owner login: POST { business, email, fullName }.
 *
 * For the operator only. Off unless OPERATOR_TOKEN is set, and a 404 to
 * anyone without it, so it does not advertise itself. The temporary password
 * it returns must be replaced at first sign-in.
 */
export async function POST(request: NextRequest) {
  const expected = env.OPERATOR_TOKEN;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!expected || !matches(supplied, expected)) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { business?: string; email?: string; fullName?: string };
  const tenantId = body.business ? await operatorTenantIdBySlug(String(body.business)) : null;
  if (!tenantId) return NextResponse.json({ error: 'No business with that slug.' }, { status: 400 });

  const result = await withTenant(tenantId, (db) =>
    provisionOwner(db, { email: String(body.email ?? ''), fullName: String(body.fullName ?? '') }),
  );
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}

function matches(supplied: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(supplied), hash(expected));
}
