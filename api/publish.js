/* ────────────────────────────────────────────────────────────────────
   /api/publish — admin's "Publish" button calls this.

   Reads content/posts JSON from request body, commits them straight
   to the GitHub repo via the Contents API. Vercel sees the new commit
   on `main` and triggers an auto-redeploy → live site updates.

   Required env vars (set in Vercel → Project → Settings → Env):
     GITHUB_TOKEN     — fine-grained PAT, "Contents: Read and write"
                        scoped only to this repo.
     GITHUB_REPO      — e.g. "ahestetey-coder/ar-civ"
     ADMIN_PASSWORD   — passcode required by the admin UI.

   Optional:
     GITHUB_BRANCH    — defaults to "main".
   ──────────────────────────────────────────────────────────────────── */

const GITHUB_API = 'https://api.github.com';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { GITHUB_TOKEN, GITHUB_REPO, ADMIN_PASSWORD } = process.env;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!GITHUB_TOKEN || !GITHUB_REPO || !ADMIN_PASSWORD) {
    return res.status(500).json({
      error: 'Sunucu yapılandırması eksik: GITHUB_TOKEN / GITHUB_REPO / ADMIN_PASSWORD',
    });
  }

  // Vercel auto-parses JSON when Content-Type is application/json
  const body = req.body || {};
  const { password, content, posts } = body;

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Geçersiz şifre' });
  }

  const updates = [];
  if (content && typeof content === 'object') {
    updates.push({ path: 'media/content.json', data: content });
  }
  if (Array.isArray(posts)) {
    updates.push({ path: 'media/posts.json', data: posts });
  }
  if (!updates.length) {
    return res.status(400).json({ error: 'İçerik veya gönderi gönderilmedi' });
  }

  try {
    const results = [];
    for (const u of updates) {
      const r = await commitFile({
        token: GITHUB_TOKEN,
        repo: GITHUB_REPO,
        branch,
        path: u.path,
        data: u.data,
      });
      results.push({ path: u.path, commit: r.commitSha, changed: r.changed });
    }
    /* Rewrite parts of index.html so first-time / cache-cold visitors
       get the brand assets and meta tags inline, before any JS runs:
         · the <!-- BRAND_INLINE_START --> block (logo CSS + favicon)
         · the <title> element
         · the <meta name="description"> tag */
    if (content && (content.brand || content.meta)) {
      const r2 = await commitInlineBrand({
        token: GITHUB_TOKEN,
        repo: GITHUB_REPO,
        branch,
        brand: content.brand || {},
        meta:  content.meta  || {},
      });
      results.push({ path: 'index.html', commit: r2.commitSha, changed: r2.changed });
    }
    return res.status(200).json({ ok: true, branch, results });
  } catch (err) {
    console.error('[publish]', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};

async function commitFile({ token, repo, branch, path, data }) {
  return commitText({
    token, repo, branch, path,
    text: JSON.stringify(data, null, 2) + '\n',
    message: `content: update ${path.split('/').pop()} via admin`,
  });
}

async function commitText({ token, repo, branch, path, text, message }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  let sha = null;
  let currentText = null;
  const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.status === 200) {
    const meta = await getRes.json();
    sha = meta.sha;
    if (meta.content) {
      try { currentText = Buffer.from(meta.content, 'base64').toString('utf-8'); }
      catch (_) { /* ignore decode errors */ }
    }
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET ${path}: ${getRes.status} ${await getRes.text()}`);
  }

  if (currentText && currentText === text) {
    return { commitSha: null, changed: false };
  }

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || `content: update ${path.split('/').pop()} via admin`,
      content: Buffer.from(text, 'utf-8').toString('base64'),
      sha,
      branch,
    }),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub PUT ${path}: ${putRes.status} ${errText}`);
  }
  const out = await putRes.json();
  return { commitSha: out.commit && out.commit.sha, changed: true };
}

/* Rewrite parts of index.html so first-time visitors get the brand and
   meta inlined directly:
     · <!-- BRAND_INLINE_START --> block: CSS for logo + <link rel=icon>
     · <title>: replaced with admin's meta.title
     · <meta name="description">: replaced with admin's meta.description */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
async function commitInlineBrand({ token, repo, branch, brand, meta }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/index.html`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.status !== 200) {
    return { commitSha: null, changed: false };
  }
  const fileMeta = await getRes.json();
  let html = Buffer.from(fileMeta.content, 'base64').toString('utf-8');
  const original = html;

  /* 1. <!-- BRAND_INLINE_START --> block */
  const startMarker = '<!-- BRAND_INLINE_START';
  const endMarker = '<!-- BRAND_INLINE_END -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  const startEnd = startIdx === -1 ? -1 : html.indexOf('-->', startIdx);
  if (startIdx !== -1 && endIdx !== -1 && startEnd !== -1 && startEnd < endIdx) {
    const blocks = [];
    if (brand && brand.logoUrl) {
      const safeUrl = String(brand.logoUrl).replace(/"/g, '%22').replace(/\)/g, '%29');
      blocks.push(
        '<style id="brand-inline">.brand__mark{background:url("' + safeUrl + '") center/contain no-repeat !important;background-color:transparent !important;border:0 !important}.brand__mark>svg{display:none !important}</style>'
      );
    }
    if (brand && brand.faviconUrl) {
      blocks.push('<link rel="icon" href="' + escapeAttr(brand.faviconUrl) + '">');
    }
    const block = blocks.length ? '\n  ' + blocks.join('\n  ') + '\n  ' : '\n  ';
    html = html.slice(0, startEnd + 3) + block + html.slice(endIdx);
  }

  /* 2. <title> — only swap when admin provided one */
  if (meta && meta.title) {
    html = html.replace(
      /<title\b[^>]*>[\s\S]*?<\/title>/,
      '<title data-edit-key="meta.title">' + escapeAttr(meta.title) + '</title>'
    );
  }

  /* 3. <meta name="description"> — content attr only */
  if (meta && meta.description) {
    const re = /<meta\b[^>]*\bname=["']description["'][^>]*>/i;
    if (re.test(html)) {
      html = html.replace(re,
        '<meta name="description" data-edit-key="meta.description" data-edit-attr="content" content="' + escapeAttr(meta.description) + '" />'
      );
    }
  }

  /* 4. brand.word and brand.subtitle — inline so the topbar/footer
     don't briefly show the default 'AR-CİV' and flicker when the user
     has set a different (or empty) value. */
  if (brand && typeof brand.word === 'string') {
    html = html.replace(
      /(<span\b[^>]*\bdata-edit-key="brand\.word"[^>]*>)[\s\S]*?(<\/span>)/g,
      '$1' + escapeAttr(brand.word) + '$2'
    );
  }
  if (brand && typeof brand.subtitle === 'string') {
    html = html.replace(
      /(<span\b[^>]*\bdata-edit-key="brand\.subtitle"[^>]*>)[\s\S]*?(<\/span>)/g,
      '$1' + escapeAttr(brand.subtitle) + '$2'
    );
  }

  if (html === original) {
    return { commitSha: null, changed: false };
  }
  return commitText({
    token, repo, branch, path: 'index.html',
    text: html,
    message: 'content: inline brand + meta into index.html via admin',
  });
}
