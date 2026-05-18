/* ────────────────────────────────────────────────────────────────────
   Light-weight in-memory rate limiter for Vercel serverless functions.

   Notes:
   - Per-instance memory. Vercel reuses warm instances across requests,
     so this DOES throttle bursts effectively in practice. Cold starts
     reset the counter, but the legitimate user shouldn't hit limits
     either way.
   - Use it as a first line of defense; for hard guarantees you would
     swap the Map for Upstash/Vercel KV. The semantics stay the same.
   ──────────────────────────────────────────────────────────────────── */

const buckets = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * @param {Object} options
 * @param {string} options.key         unique bucket name (e.g. 'admin-auth')
 * @param {string} options.ip          client identifier
 * @param {number} options.windowMs    sliding window in ms
 * @param {number} options.max         max events per window
 * @returns {{ ok: boolean, retryAfterMs: number, remaining: number }}
 */
function check({ key, ip, windowMs, max }) {
  const bucketKey = key + ':' + ip;
  const now = Date.now();
  let b = buckets.get(bucketKey);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(bucketKey, b);
  }
  b.count++;
  if (b.count > max) {
    return {
      ok: false,
      retryAfterMs: Math.max(0, windowMs - (now - b.start)),
      remaining: 0,
    };
  }
  return {
    ok: true,
    retryAfterMs: 0,
    remaining: max - b.count,
  };
}

/* Opportunistic cleanup to keep the Map small */
function reap() {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.start > 60 * 60 * 1000) buckets.delete(k);
  }
}
let _reapTimer = null;
function _scheduleReap() {
  if (_reapTimer) return;
  _reapTimer = setTimeout(() => { _reapTimer = null; reap(); }, 5 * 60 * 1000);
}

module.exports = { check, getClientIp, _scheduleReap };
