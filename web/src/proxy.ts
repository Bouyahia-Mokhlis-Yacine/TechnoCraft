// Gate for every page and API call: a valid session, and the page in the account's list. Writes
// and exports are checked again in their route handlers (session.ts `can`).
import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, canSee, decode, homeOf } from '@/lib/session';

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname, api = path.startsWith('/api/');
  const user = decode(req.cookies.get(COOKIE)?.value);
  if (!user) {
    if (api) return NextResponse.json({ error: { code: 'unauthenticated', message: 'Sign in first.' } }, { status: 401 });
    const url = new URL('/login', req.url);
    url.searchParams.set('next', path + req.nextUrl.search);
    const res = NextResponse.redirect(url);
    res.cookies.delete(COOKIE);   // expired, edited or deleted account
    return res;
  }
  if (!canSee(user, path)) {
    if (api) return NextResponse.json({ error: { code: 'forbidden', message: 'Your account does not have access to this page.' } }, { status: 403 });
    return NextResponse.redirect(new URL(homeOf(user), req.url));
  }
  return NextResponse.next();
}

export const config = {
  // everything except sign-in, health check, Next internals and static brand files
  matcher: ['/((?!login|api/v1/health|_next/|brand/|icon\\.svg|favicon).*)'],
};
