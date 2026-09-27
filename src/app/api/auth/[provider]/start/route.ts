import { NextResponse, type NextRequest } from 'next/server';
import {
  STATE_COOKIE, authorizationUrl, callbackUrl, configuredProviders, isProvider, newState, sealState,
  stateCookieOptions,
} from '@/server/auth/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** "Continue with Google": off to the provider, with a signed state to come back with. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const origin = new URL(request.url).origin;
  if (!isProvider(provider) || !configuredProviders().includes(provider)) {
    return NextResponse.redirect(`${origin}/portal/sign-in?error=unavailable`, 303);
  }
  const state = newState(provider);
  const response = NextResponse.redirect(authorizationUrl(provider, state, callbackUrl(origin, provider)), 303);
  response.cookies.set(STATE_COOKIE, sealState(state), stateCookieOptions);
  return response;
}
