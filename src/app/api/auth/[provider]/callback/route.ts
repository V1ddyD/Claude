import { NextResponse, type NextRequest } from 'next/server';
import {
  STATE_COOKIE, callbackUrl, configuredProviders, isProvider, openState, stateCookieOptions, verifiedEmail,
} from '@/server/auth/oauth';
import { signInWithVerifiedEmail } from '@/server/auth/staff-auth';
import { SESSION_COOKIE, sessionCookieOptions } from '@/server/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Back from Google, Facebook or Apple.
 *
 * Google and Facebook return with a GET; Apple POSTs a form. Either way the
 * state must match the signed cookie this browser was given when it left,
 * the code is exchanged for a verified email server-to-server, and only an
 * email already on a business's team gets a session. Every failure lands on
 * the sign-in page with a reason from a fixed list.
 */
async function complete(request: NextRequest, provider: string, code: string | null, state: string | null) {
  const origin = new URL(request.url).origin;
  const fail = (reason: string) => {
    const response = NextResponse.redirect(`${origin}/portal/sign-in?error=${reason}`, 303);
    response.cookies.set(STATE_COOKIE, '', { ...stateCookieOptions, maxAge: 0 });
    return response;
  };

  if (!isProvider(provider) || !configuredProviders().includes(provider)) return fail('unavailable');
  const opened = openState(request.cookies.get(STATE_COOKIE)?.value, provider, state);
  // Cancelled at the provider, or a state that is not this browser's.
  if (!opened || !code) return fail('cancelled');

  const email = await verifiedEmail(provider, code, opened, callbackUrl(origin, provider));
  if (!email.ok) return fail(email.reason);

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const session = await signInWithVerifiedEmail(email.email, ip);
  if (!session.ok) return fail(session.reason);

  const response = NextResponse.redirect(`${origin}/portal`, 303);
  response.cookies.set(STATE_COOKIE, '', { ...stateCookieOptions, maxAge: 0 });
  response.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions);
  return response;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const url = new URL(request.url);
  return complete(request, (await params).provider, url.searchParams.get('code'), url.searchParams.get('state'));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const form = await request.formData().catch(() => null);
  return complete(
    request,
    (await params).provider,
    form ? String(form.get('code') ?? '') || null : null,
    form ? String(form.get('state') ?? '') || null : null,
  );
}
