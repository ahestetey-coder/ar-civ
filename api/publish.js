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
    return res.status(200).json({ ok: true, branch, results });
  } catch (err) {
    console.error('[publish]', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

async function commitFile({ token, repo, branch, path, data }) {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Read current file to get its sha (and to skip if unchanged)
  let sha = null;
  let currentText = null;
  const getRes = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.status === 200) {
    const meta = await getRes.json();
    sha = meta.sha;
    if (meta.content) {
      try {
        currentText = Buffer.from(meta.content, 'base64').toString('utf-8');
      } catch (_) { /* ignore decode errors */ }
    }
  } else if (getRes.status !== 404) {
    throw new Error(`GitHub GET ${path}: ${getRes.status} ${await getRes.text()}`);
  }

  const newText = JSON.stringify(data, null, 2) + '\n';

  // No-op if content identical — avoid empty commits.
  if (currentText && currentText === newText) {
    return { commitSha: null, changed: false };
  }

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `content: update ${path.split('/').pop()} via admin`,
      content: Buffer.from(newText, 'utf-8').toString('base64'),
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
