/* ────────────────────────────────────────────────────────────────────
   /api/admin-auth — admin login gate.

   Validates a password against ADMIN_PASSWORD (the same env var that
   /api/publish uses). The admin page sends a POST here; on 200 it
   stores a session flag in sessionStorage and unlocks the UI.

   This is intentionally lightweight: the real protection is the
   server-side check on /api/publish — even if someone bypasses the
   admin gate by editing JS, they cannot push changes without the
   correct password. The gate just keeps the editor UI out of casual
   reach.
   ──────────────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ADMIN_PASSWORD } = process.env;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Sunucu yapılandırması eksik (ADMIN_PASSWORD)' });
  }

  const body = req.body || {};
  const password = String(body.password || '');

  if (!password || password !== ADMIN_PASSWORD) {
    /* Tiny delay to slow down brute force from the client side */
    await new Promise(r => setTimeout(r, 300));
    return res.status(401).json({ error: 'Geçersiz şifre' });
  }

  return res.status(200).json({ ok: true });
};
