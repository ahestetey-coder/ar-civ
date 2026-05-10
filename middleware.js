/* ────────────────────────────────────────────────────────────────────
   Vercel Edge Middleware — gates /admin.html behind a signed cookie.

   Flow:
     1. Browser requests /admin.html.
     2. Middleware reads the `arciv_auth` cookie.
     3. If missing or signature invalid → 302 to /login.html.
     4. /login.html POSTs the password to /api/admin-auth.
     5. /api/admin-auth signs an HMAC token with ADMIN_PASSWORD as the
        secret, sets it as an HttpOnly cookie, and returns 200.
     6. Browser redirects back to /admin.html → cookie OK → page served.

   Token format: `<expiry-ms>.<hex-hmac>`
   Cookies are HttpOnly + Secure + SameSite=Strict, valid for 7 days.

   Local dev (`node .serve.js`) does not run middleware, so the admin
   page is open there — acceptable since /api/publish is unavailable
   locally anyway and the only sensitive action requires hitting Vercel.
   ──────────────────────────────────────────────────────────────────── */

export const config = {
  matcher: ['/admin.html'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies['arciv_auth'];

  if (await isValidToken(token)) {
    return; /* let the static admin.html through */
  }

  const loginUrl = new URL('/login.html', url.origin);
  loginUrl.searchParams.set('next', url.pathname);
  return Response.redirect(loginUrl.toString(), 302);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

async function isValidToken(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiry = parseInt(token.slice(0, dot), 10);
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) return false;

  try {
    const expected = await hmacHex(String(expiry), secret);
    return constantTimeEq(sig, expected);
  } catch (_) {
    return false;
  }
}

async function hmacHex(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
