import { NextResponse, type NextRequest } from 'next/server';

/**
 * Middleware is a redirect, NOT the authorization boundary.
 *
 * It exists so an unauthenticated browser lands on the sign-in page instead of
 * an error, and it checks only for the PRESENCE of a session cookie — it does
 * not verify it, because a cookie's contents prove nothing. Every portal route
 * independently calls requireStaff(), which is what actually protects the data.
 *
 * Treating this file as the security boundary is the classic Next.js mistake:
 * it can be bypassed, and it cannot express per-permission rules.
 */
// Presence only: whether to bother rendering the portal at all. Whether the
// session is real is decided on the server, against the database, by every
// page (requireStaff). A forged cookie gets past this line and no further.
const SESSION_COOKIES = ['__Host-portal_session', 'portal_session', 'sb-access-token'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/portal') && !pathname.startsWith('/portal/sign-in')) {
    const hasSession =
      SESSION_COOKIES.some((name) => request.cookies.has(name)) ||
      request.cookies.getAll().some((c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'));

    if (!hasSession) {
      const url = request.nextUrl.clone();
      url.pathname = '/portal/sign-in';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  const response = NextResponse.next();
  // Correlates a request across logs without identifying the person making it.
  response.headers.set('x-request-id', crypto.randomUUID());
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|avif)$).*)'],
};
