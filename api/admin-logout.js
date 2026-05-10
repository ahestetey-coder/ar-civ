/* ────────────────────────────────────────────────────────────────────
   /api/admin-logout — clears the admin auth cookie.

   POST or GET: returns 200 with a Set-Cookie that immediately expires
   `arciv_auth`. After this the middleware will redirect any /admin.html
   request to the login page.
   ──────────────────────────────────────────────────────────────────── */

module.exports = async function handler(_req, res) {
  /* Set-Cookie with Max-Age=0 deletes the cookie. Need to match the
     original Path/Secure flags so the browser actually overwrites it. */
  res.setHeader('Set-Cookie',
    `arciv_auth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`
  );
  return res.status(200).json({ ok: true });
};
