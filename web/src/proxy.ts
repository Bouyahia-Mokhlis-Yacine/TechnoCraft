// Optimistic gate: no session cookie → sign-in page. Real checks happen on the server for every
// write and export (session.ts / route handlers); this only spares an unauthenticated round trip.
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(req: NextRequest) {
  if (!req.cookies.get('pai_session')) {
    if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: { code: 'unauthenticated', message: 'Sign in first.' } }, { status: 401 });
    const url = new URL('/login', req.url);
    url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // everything except sign-in, health check, Next internals and static brand files
  matcher: ['/((?!login|api/v1/health|_next/|brand/|icon\\.svg|favicon).*)'],
};
