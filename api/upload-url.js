/* ────────────────────────────────────────────────────────────────────
   /api/upload-url — generates a presigned PUT URL for Cloudflare R2.

   Flow:
     1. Admin browser POSTs { filename, contentType, size }.
     2. We validate the arciv_auth cookie (same scheme as middleware.js).
     3. We validate contentType (image/* or video/*) and size limits.
     4. We compute a unique R2 object key: uploads/YYYY/MM/<rand>-<name>
     5. We sign a 5-minute PUT URL with the R2 (S3-compatible) endpoint.
     6. Browser PUTs the file body straight to R2 — Vercel's 4.5 MB body
        limit is bypassed entirely. Public URL goes into content.json.

   Required env vars (Vercel → Project → Settings → Environment):
     R2_ACCOUNT_ID          Cloudflare account ID (R2 dashboard sidebar)
     R2_ACCESS_KEY_ID       R2 API token Access Key ID
     R2_SECRET_ACCESS_KEY   R2 API token Secret
     R2_BUCKET              bucket name (e.g. ar-civ-media)
     R2_PUBLIC_URL          public base URL, no trailing slash
                            e.g. https://pub-xxxx.r2.dev
                            or   https://images.ar-civ.com
     ADMIN_PASSWORD         already exists — used to verify arciv_auth
   ──────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { check, getClientIp, _scheduleReap } = require('./_rate-limit.js');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;        /* 20 MB */
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;       /* 500 MB */
const URL_TTL_SECONDS = 300;                      /* 5 min */
const COOKIE_NAME = 'arciv_auth';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* Per-IP rate limit: 60 upload-url requests per 10 minutes — plenty
     for editing a project (10-20 photos) without inviting abuse. */
  const ip = getClientIp(req);
  const limit = check({ key: 'upload-url', ip, windowMs: 10 * 60 * 1000, max: 60 });
  _scheduleReap();
  if (!limit.ok) {
    const secs = Math.ceil(limit.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(secs));
    return res.status(429).json({
      error: `Çok sık yükleme. ${Math.ceil(secs / 60)} dakika sonra tekrar dene.`,
    });
  }

  const {
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
    R2_BUCKET, R2_PUBLIC_URL, ADMIN_PASSWORD,
  } = process.env;

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY ||
      !R2_BUCKET || !R2_PUBLIC_URL || !ADMIN_PASSWORD) {
    return res.status(500).json({
      error: 'Sunucu yapılandırması eksik: R2 değişkenleri veya ADMIN_PASSWORD ayarlanmamış',
    });
  }

  /* Verify the arciv_auth cookie — same HMAC scheme as middleware.js */
  const cookies = parseCookies(req.headers.cookie || '');
  if (!verifyAuthCookie(cookies[COOKIE_NAME], ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Oturum geçersiz — yeniden giriş yap' });
  }

  const body = req.body || {};
  const filename     = String(body.filename || '').trim();
  const contentType  = String(body.contentType || '').trim().toLowerCase();
  const size         = Number(body.size);

  if (!filename || !contentType || !Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'filename, contentType ve size zorunlu' });
  }

  const isImage = contentType.startsWith('image/');
  const isVideo = contentType.startsWith('video/');
  if (!isImage && !isVideo) {
    return res.status(400).json({ error: 'Sadece resim ve video yüklenebilir' });
  }
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (size > maxBytes) {
    return res.status(413).json({
      error: `Dosya çok büyük (${formatBytes(size)}) — maks ${formatBytes(maxBytes)}`,
    });
  }

  const key = buildObjectKey(filename);

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  try {
    const cmd = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: URL_TTL_SECONDS });
    const publicBase = R2_PUBLIC_URL.replace(/\/+$/, '');
    const publicUrl  = `${publicBase}/${key}`;

    return res.status(200).json({
      ok: true,
      uploadUrl,
      publicUrl,
      key,
      expiresIn: URL_TTL_SECONDS,
    });
  } catch (err) {
    console.error('[upload-url]', err);
    return res.status(500).json({ error: 'Presigned URL üretilemedi: ' + (err.message || err) });
  }
};

/* ── helpers ─────────────────────────────────────────────────────── */

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

function verifyAuthCookie(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiry = parseInt(token.slice(0, dot), 10);
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

/* Build a collision-resistant object key. Keeps original basename so
   R2 lists are still browsable, but prefixes a random hex slug and
   bins by month for tidiness. */
function buildObjectKey(originalName) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const rand = crypto.randomBytes(5).toString('hex');
  const safe = sanitizeFilename(originalName);
  return `uploads/${yyyy}/${mm}/${rand}-${safe}`;
}

function sanitizeFilename(name) {
  /* Lowercase, strip diacritics, replace anything outside [a-z0-9.-] with -.
     Cap at 80 chars to keep object keys short. */
  const stripped = String(name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return stripped || 'file';
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
