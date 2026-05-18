/* ────────────────────────────────────────────────────────────────────
   /api/admin-auth — admin login. POST { password }.

   On success: sets an HttpOnly, Secure, SameSite=Strict cookie named
   `arciv_auth` containing an HMAC-signed token. The Edge middleware
   at /middleware.js validates this cookie before serving /admin.html.

   Token format: `<expiry-ms>.<hex-hmac>` where the HMAC is computed
   with HMAC-SHA-256 using ADMIN_PASSWORD as the secret. Expiry is
   7 days from issue.
   ──────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { check, getClientIp, _scheduleReap } = require('./_rate-limit.js');

const COOKIE_NAME = 'arciv_auth';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; /* 7 days */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* Per-IP rate limit: 10 attempts per 15 minutes. Real users won't
     come anywhere near; brute-forcers hit the wall fast. */
  const ip = getClientIp(req);
  const limit = check({ key: 'admin-auth', ip, windowMs: 15 * 60 * 1000, max: 10 });
  _scheduleReap();
  if (!limit.ok) {
    const secs = Math.ceil(limit.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(secs));
    return res.status(429).json({
      error: `Çok fazla deneme. ${Math.ceil(secs / 60)} dakika sonra tekrar dene.`,
    });
  }

  const { ADMIN_PASSWORD } = process.env;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Sunucu yapılandırması eksik (ADMIN_PASSWORD)' });
  }

  const body = req.body || {};
  const password = String(body.password || '');

  if (!password || password !== ADMIN_PASSWORD) {
    /* Tiny delay to slow down brute-force attempts */
    await new Promise(r => setTimeout(r, 400));
    return res.status(401).json({ error: 'Geçersiz şifre' });
  }

  const expiry = Date.now() + TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', ADMIN_PASSWORD).update(String(expiry)).digest('hex');
  const token = `${expiry}.${sig}`;
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);

  /* HttpOnly: JS cannot read it. Secure: HTTPS-only. SameSite=Strict:
     never sent on cross-site requests. Path=/: visible to middleware
     for any route (we only check on /admin.html). */
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`
  );

  return res.status(200).json({ ok: true });
};
