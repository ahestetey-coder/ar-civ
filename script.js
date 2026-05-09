/* STRATA — interactive bits
   1. Scroll-scrubbing hero video
   2. Top-bar inversion when scrolled past hero
   3. Stage labels swap with progress
   4. IntersectionObserver reveals
   5. Reveal staggers via data-reveal-delay
*/

(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Reveal animations ───────────────────────────────── */
  const reveals = document.querySelectorAll('.reveal');
  reveals.forEach(el => {
    const d = el.getAttribute('data-reveal-delay');
    if (d) el.style.setProperty('--reveal-delay', d + 'ms');
  });
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(el => io.observe(el));
  } else {
    reveals.forEach(el => el.classList.add('is-in'));
  }

  /* ── 2. Top-bar inversion (light over video → dark over content) ── */
  const topbar = document.getElementById('topbar');
  const hero = document.getElementById('hero');
  if (topbar && hero) {
    const inv = new IntersectionObserver(
      ([entry]) => topbar.classList.toggle('is-stuck', !entry.isIntersecting),
      { threshold: 0, rootMargin: '-72px 0px 0px 0px' }
    );
    inv.observe(hero);
  }

  /* ── 3. Scroll-scrubbing hero video ─────────────────────── */
  const video = document.getElementById('heroVideo');
  const stages = document.querySelectorAll('.stage');
  const progressBar = document.getElementById('heroProgress');

  if (!video || !hero) return;

  /* NOTE: we deliberately do NOT honor `prefers-reduced-motion` here.
     Scroll-scrub is user-driven (the user controls every frame change
     by scrolling), not an auto-playing animation, so it is accessibility-
     compatible. Bailing out here is what was making mobile users with
     OS-level "Reduce motion" see the page scroll past with a frozen
     video. */

  let duration = 0;
  let metaReady = false;
  let pendingProgress = -1;
  let videoRaf = null;

  function setActiveStage(progress) {
    const idx = Math.min(stages.length - 1, Math.floor(progress * stages.length));
    stages.forEach((s, i) => s.classList.toggle('is-active', i === idx));
  }

  function applyProgress(p) {
    const np = Math.max(0, Math.min(1, p));
    if (np === pendingProgress) return;
    pendingProgress = np;

    /* Sync DOM updates — guaranteed to run on every scroll event,
       even if rAF is throttled (background tab, OS reduce-motion, etc.) */
    if (progressBar) progressBar.style.width = (np * 100).toFixed(2) + '%';
    setActiveStage(np);

    /* Video seek is the expensive bit — coalesce to one per frame */
    if (videoRaf) return;
    videoRaf = requestAnimationFrame(() => {
      videoRaf = null;
      if (!metaReady || duration <= 0) return;
      const t = pendingProgress * duration;
      if (Math.abs(video.currentTime - t) <= 0.02) return;
      try {
        /* fastSeek (when available) snaps to nearest keyframe — way
           cheaper for mobile decoders. */
        if (typeof video.fastSeek === 'function') video.fastSeek(t);
        else video.currentTime = t;
      } catch (_) { /* seek can throw mid-buffer */ }
    });
  }

  function calcProgress() {
    const rect = hero.getBoundingClientRect();
    const total = hero.offsetHeight - window.innerHeight;
    if (total <= 0) return 0;
    return -rect.top / total;
  }

  function onScroll() { applyProgress(calcProgress()); }

  video.addEventListener('loadedmetadata', () => {
    duration = video.duration || 0;
    metaReady = duration > 0;
    onScroll();
  });

  video.addEventListener('canplay', () => {
    if (!metaReady) {
      duration = video.duration || 0;
      metaReady = duration > 0;
    }
    onScroll();
  });

  // nudge browser to start fetching
  try { video.load(); } catch (_) {}

  /* Multiple events — some mobile browsers throttle plain `scroll`
     during momentum but still fire `touchmove` / `wheel`. */
  const opts = { passive: true };
  window.addEventListener('scroll', onScroll, opts);
  window.addEventListener('resize', onScroll, opts);
  window.addEventListener('orientationchange', onScroll, opts);
  document.addEventListener('touchmove', onScroll, opts);
  document.addEventListener('wheel', onScroll, opts);

  /* Initial paint */
  onScroll();
})();


/* ────────────────────────────────────────────────────────────────
   Instagram / Atölye Günlüğü feed
   Source-agnostic loader. Handles three formats:
     · plain array            (manual posts.json)
     · { posts: [...] }       (Behold.so response)
     · { data:  [...] }       (Instagram Graph API response)
   To switch from local JSON to a live auto-feed, change SOCIAL_FEED_URL
   to your Behold endpoint (https://feeds.behold.so/<FEED_ID>).
   ──────────────────────────────────────────────────────────────── */
(() => {
  const SOCIAL_FEED_URL = 'media/posts.json';
  const MAX_POSTS = 6;
  const PROFILE_URL = 'https://instagram.com/strata.studio';

  const grid = document.getElementById('journalGrid');
  if (!grid) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const RTF = ('Intl' in window && 'RelativeTimeFormat' in Intl)
    ? new Intl.RelativeTimeFormat('tr', { numeric: 'auto' })
    : null;

  function timeAgo(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const sec = (Date.now() - d.getTime()) / 1000;
    if (sec < 60) return 'biraz önce';
    if (RTF) {
      if (sec < 3600)   return RTF.format(-Math.round(sec / 60),    'minute');
      if (sec < 86400)  return RTF.format(-Math.round(sec / 3600),  'hour');
      if (sec < 604800) return RTF.format(-Math.round(sec / 86400), 'day');
      if (sec < 2592000)return RTF.format(-Math.round(sec / 604800),'week');
      if (sec < 31536000) return RTF.format(-Math.round(sec / 2592000), 'month');
      return RTF.format(-Math.round(sec / 31536000), 'year');
    }
    return d.toLocaleDateString('tr-TR');
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normalize(p) {
    const f = p.framing || {};
    /* Crop rectangle in image-percent space: cx/cy = top-left corner, cw/ch = size */
    let crop = null;
    if (typeof f.cw === 'number' && typeof f.ch === 'number') {
      crop = {
        cx: typeof f.cx === 'number' ? f.cx : 0,
        cy: typeof f.cy === 'number' ? f.cy : 0,
        cw: f.cw,
        ch: f.ch,
      };
    }
    return {
      id:           p.id || p._id || '',
      permalink:    p.permalink || p.link || PROFILE_URL,
      mediaUrl:     p.media_url || p.mediaUrl || p.url || '',
      thumbnailUrl: p.thumbnail_url || p.thumbnailUrl || p.media_url || p.mediaUrl || '',
      mediaType:    (p.media_type || p.mediaType || 'IMAGE').toUpperCase(),
      caption:      p.caption || '',
      timestamp:    p.timestamp || p.created_at || p.createdAt || '',
      likeCount:    p.like_count != null ? p.like_count : (p.likeCount != null ? p.likeCount : null),
      crop,
    };
  }

  function postIcon(type) {
    if (type === 'VIDEO') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
    if (type === 'CAROUSEL_ALBUM') return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="7" y="7" width="14" height="14" rx="2"/><path d="M3 17V5a2 2 0 0 1 2-2h12"/></svg>`;
    return '';
  }

  function renderPost(p, i) {
    const layouts = ['feature', 'vertical', 'square', 'square', 'wide', 'square'];
    const layout = layouts[i] || 'square';
    const ago = timeAgo(p.timestamp);
    const icon = postIcon(p.mediaType);
    const cap = escapeHtml(p.caption).replace(/\n+/g, ' ');
    const likeBadge = p.likeCount != null
      ? `<span class="post__likes"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.5-9.5-9.5C1 7.5 4 4 7.5 4c2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20 4 23 7.5 21.5 11.5 19.5 16.5 12 21 12 21z"/></svg><b class="num">${p.likeCount}</b></span>`
      : '';
    const c = p.crop;
    const mediaCls = c ? 'post__media is-cropped' : 'post__media';
    const imgStyle = c ? `--cx:${c.cx};--cy:${c.cy};--cw:${c.cw};--ch:${c.ch};` : '';

    return `
      <li class="post post--${layout} reveal" style="--reveal-delay:${i * 80}ms">
        <a class="post__link" href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener" aria-label="Instagram'da göster">
          <figure class="${mediaCls}">
            <img loading="lazy" decoding="async" alt="" src="${escapeHtml(p.thumbnailUrl)}" ${imgStyle ? `style="${imgStyle}"` : ''} />
          </figure>
          ${icon ? `<span class="post__type" aria-hidden="true">${icon}</span>` : ''}
          <div class="post__overlay">
            <p class="post__caption">${cap}</p>
            <div class="post__meta">
              <span class="post__date">${ago}</span>
              ${likeBadge}
            </div>
          </div>
        </a>
      </li>
    `;
  }

  function renderError() {
    grid.classList.add('is-error');
    grid.innerHTML = `
      <li class="journal__empty">
        <p>Şu an gönderiler yüklenemiyor.</p>
        <a class="link" href="${PROFILE_URL}" target="_blank" rel="noopener">Doğrudan Instagram'a git →</a>
      </li>
    `;
  }

  function paint(rawList) {
    const posts = rawList.slice(0, MAX_POSTS).map(normalize).filter(p => p.thumbnailUrl);
    if (!posts.length) return renderError();
    grid.removeAttribute('aria-busy');
    grid.innerHTML = posts.map(renderPost).join('');

    if ('IntersectionObserver' in window && !reduceMotion) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      grid.querySelectorAll('.reveal').forEach(el => io.observe(el));
    } else {
      grid.querySelectorAll('.reveal').forEach(el => el.classList.add('is-in'));
    }
  }

  function readLocalPosts() {
    try {
      const raw = localStorage.getItem('strata.posts');
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (_) {}
    return null;
  }

  async function load() {
    /* 1. localStorage wins — admin overrides */
    const local = readLocalPosts();
    if (local) { paint(local); return; }

    /* 2. otherwise pull from configured feed */
    try {
      const res = await fetch(SOCIAL_FEED_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const raw = Array.isArray(json) ? json : (json.posts || json.data || []);
      paint(raw);
    } catch (err) {
      console.warn('journal feed failed:', err);
      renderError();
    }
  }

  load();

  /* live-update if another tab (e.g. admin) writes a post */
  window.addEventListener('storage', (e) => {
    if (e.key === 'strata.posts') {
      const local = readLocalPosts();
      if (local) paint(local);
    }
  });
})();


/* ────────────────────────────────────────────────────────────────────
   Site content (featured + projects) hydration
   + lightbox gallery viewer
   ──────────────────────────────────────────────────────────────────── */
(() => {
  const CONTENT_URL = 'media/content.json';
  const CONTENT_KEY = 'strata.content';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── Lightbox state ──────────────────────────── */
  const lb       = document.getElementById('lightbox');
  const lbClose  = document.getElementById('lightboxClose');
  const lbTitle  = document.getElementById('lightboxTitle');
  const lbKicker = document.getElementById('lightboxKicker');
  const lbCnt    = document.getElementById('lightboxCounter');
  const lbImg    = document.getElementById('lightboxImg');
  const lbCap    = document.getElementById('lightboxCaption');
  const lbPrev   = document.getElementById('lightboxPrev');
  const lbNext   = document.getElementById('lightboxNext');
  const lbDots   = document.getElementById('lightboxDots');

  let lbPosts = [];     // current gallery items: [{ url, caption }]
  let lbIdx   = 0;
  let lbLastFocus = null;

  function renderLightbox() {
    if (!lbPosts.length) return;
    lbIdx = (lbIdx + lbPosts.length) % lbPosts.length;
    const p = lbPosts[lbIdx];
    lbImg.src = p.url || '';
    lbImg.alt = p.caption || '';
    lbCap.textContent = p.caption || '';
    lbCnt.textContent = (lbIdx + 1) + ' / ' + lbPosts.length;
    /* dots */
    const dots = lbPosts.map((_, i) =>
      `<li><button type="button" class="lightbox__dot ${i === lbIdx ? 'is-on' : ''}" data-i="${i}" aria-label="Görsel ${i + 1}"></button></li>`
    ).join('');
    lbDots.innerHTML = dots;
  }

  function openLightbox({ title, kicker, items, startIdx }) {
    if (!items || !items.length) return;
    lbPosts = items;
    lbIdx   = Math.max(0, Math.min(items.length - 1, startIdx || 0));
    lbTitle.textContent = title || '';
    lbKicker.textContent = kicker || 'Proje';
    lbLastFocus = document.activeElement;
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
    renderLightbox();
    requestAnimationFrame(() => {
      lb.classList.add('is-on');
      lbClose.focus();
    });
  }
  function closeLightbox() {
    lb.classList.remove('is-on');
    document.body.style.overflow = '';
    setTimeout(() => {
      lb.hidden = true;
      lbImg.src = '';
      if (lbLastFocus && typeof lbLastFocus.focus === 'function') lbLastFocus.focus();
    }, reduceMotion ? 0 : 250);
  }
  function step(dir) { lbIdx += dir; renderLightbox(); }

  if (lb) {
    lbClose.addEventListener('click', closeLightbox);
    lbPrev.addEventListener('click', () => step(-1));
    lbNext.addEventListener('click', () => step(1));
    lb.addEventListener('click', (e) => {
      /* clicking the backdrop (not children) closes */
      if (e.target === lb) closeLightbox();
    });
    lbDots.addEventListener('click', (e) => {
      const btn = e.target.closest('.lightbox__dot');
      if (!btn) return;
      lbIdx = parseInt(btn.dataset.i, 10) || 0;
      renderLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (lb.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft')  step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });

    /* touch swipe */
    let touchX = null;
    lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40) step(dx > 0 ? -1 : 1);
      touchX = null;
    }, { passive: true });
  }

  /* ── Content load ───────────────────────────── */
  async function loadContent() {
    try {
      const local = localStorage.getItem(CONTENT_KEY);
      if (local) {
        const parsed = JSON.parse(local);
        if (parsed && (parsed.featured || parsed.projects)) return parsed;
      }
    } catch (_) {}
    try {
      const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      console.warn('content.json load failed:', err);
      return null;
    }
  }

  /* ── Render featured (inline carousel + click-to-open lightbox) ─────────── */
  let featuredItems = [];
  let featuredIdx = 0;
  let featuredMeta = { name: '', kicker: '' };

  const fImg     = document.getElementById('featuredImg');
  const fOpenBtn = document.getElementById('featuredOpen');
  const fPrev    = document.getElementById('featuredPrev');
  const fNext    = document.getElementById('featuredNext');
  const fCounter = document.getElementById('featuredCounter');
  const fMedia   = document.getElementById('featuredMedia');

  function setFeaturedSlide(idx) {
    if (!featuredItems.length || !fImg) return;
    featuredIdx = ((idx % featuredItems.length) + featuredItems.length) % featuredItems.length;
    const slide = featuredItems[featuredIdx];
    fImg.style.opacity = '0';
    setTimeout(() => {
      fImg.src = slide.url;
      fImg.alt = slide.caption || featuredMeta.name || '';
      fImg.style.opacity = '1';
    }, 160);
    if (fCounter) fCounter.textContent = (featuredIdx + 1) + ' / ' + featuredItems.length;
    if (fMedia)   fMedia.classList.toggle('is-single', featuredItems.length <= 1);
  }

  if (fPrev) fPrev.addEventListener('click', (e) => { e.stopPropagation(); setFeaturedSlide(featuredIdx - 1); });
  if (fNext) fNext.addEventListener('click', (e) => { e.stopPropagation(); setFeaturedSlide(featuredIdx + 1); });
  if (fOpenBtn) fOpenBtn.addEventListener('click', () => {
    if (!featuredItems.length) return;
    openLightbox({
      title:    featuredMeta.name || '',
      kicker:   featuredMeta.kicker || 'Öne çıkan proje',
      items:    featuredItems,
      startIdx: featuredIdx,
    });
  });

  /* arrow keys when focus is inside the featured media */
  if (fMedia) fMedia.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setFeaturedSlide(featuredIdx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setFeaturedSlide(featuredIdx + 1); }
  });

  function renderFeatured(f) {
    if (!f) return;
    document.querySelectorAll('[data-cms-text="featured.kicker"]').forEach(el => el.textContent = f.kicker || '');
    document.querySelectorAll('[data-cms-text="featured.name"]').forEach(el => el.textContent = (f.name || '') + (f.name && !/[.!?]\s*$/.test(f.name) ? '.' : ''));
    document.querySelectorAll('[data-cms-text="featured.description"]').forEach(el => el.textContent = f.description || '');

    /* meta dl */
    const dl = document.querySelector('[data-cms="featured.meta"]');
    if (dl && Array.isArray(f.meta)) {
      dl.innerHTML = f.meta.map(m =>
        `<div><dt>${escapeHtml(m.label)}</dt><dd>${escapeHtml(m.value)}</dd></div>`
      ).join('');
    }

    /* build carousel items: cover (if any) + gallery */
    const items = [];
    if (f.cover && f.cover.url) items.push({ url: f.cover.url, caption: f.description || (f.name + ' — kapak') });
    if (Array.isArray(f.gallery)) f.gallery.forEach(g => { if (g && g.url) items.push({ url: g.url, caption: g.caption || '' }); });

    featuredItems = items;
    featuredMeta  = { name: f.name || '', kicker: f.kicker || 'Öne çıkan proje' };
    featuredIdx   = 0;
    if (items.length) setFeaturedSlide(0);
  }

  /* ── Render projects archive ─────────────────── */
  function renderProjects(projects) {
    const list = document.getElementById('projectsList');
    if (!list || !Array.isArray(projects)) return;

    /* Asymmetric row variants — alternate per project for visual rhythm:
       v0 (even index): wide row, 4 portraits, left-aligned
       v1 (odd  index): narrow row, 3 portraits, pushed to the right
       v2 (every 5th):  long row, 5 portraits, full width    */
    const variantMaxPhotos = [4, 3, 5];

    list.innerHTML = projects.map((p, i) => {
      const num = String(i + 1).padStart(2, '0');
      const cover = p.cover && p.cover.url ? p.cover.url : '';
      const gal   = Array.isArray(p.gallery) ? p.gallery : [];
      const totalShots = (cover ? 1 : 0) + gal.length;

      /* pick variant — every 5th gets the wide quintet variant */
      const variantIdx = (i % 5 === 4) ? 2 : (i % 2);
      const maxPhotos  = variantMaxPhotos[variantIdx];

      const strip = [];
      if (cover) strip.push(cover);
      gal.forEach(g => { if (g && g.url && strip.length < maxPhotos) strip.push(g.url); });

      const moreInLightbox = Math.max(0, totalShots - strip.length);
      const photoNodes = strip.map((url, k) => {
        const isLast = (k === strip.length - 1) && moreInLightbox > 0;
        return `
          <figure class="proj__photo">
            <img loading="lazy" decoding="async" alt="" src="${escapeHtml(url)}" />
            ${isLast ? `<span class="proj__more"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> ${moreInLightbox} daha</span>` : ''}
          </figure>
        `;
      }).join('');

      return `
        <li class="proj proj--v${variantIdx} reveal" data-project-idx="${i}" tabindex="0" role="button" aria-label="${escapeHtml(p.name || '')} galerisini aç">
          <header class="proj__head">
            <span class="proj__id num">${num}</span>
            <div class="proj__main">
              <h3>${escapeHtml(p.name || '')}</h3>
              <span class="proj__type">${escapeHtml(p.type || '')}</span>
            </div>
            <span class="proj__year num">${escapeHtml(p.year || '')}</span>
            <span class="proj__loc">${escapeHtml(p.location || '')}</span>
          </header>
          ${strip.length ? `<div class="proj__photos proj__photos--v${variantIdx}">${photoNodes}</div>` : ''}
        </li>
      `;
    }).join('');

    /* hook clicks */
    list.querySelectorAll('.proj[data-project-idx]').forEach(row => {
      const idx = parseInt(row.dataset.projectIdx, 10);
      const open = () => {
        const p = projects[idx];
        if (!p) return;
        const items = (p.gallery && p.gallery.length ? p.gallery : []).slice();
        if (p.cover && p.cover.url) items.unshift({ url: p.cover.url, caption: p.name + ' — kapak' });
        if (!items.length) return;
        openLightbox({ title: p.name || '', kicker: 'Proje · ' + (p.year || ''), items, startIdx: 0 });
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });

    /* re-arm reveal observer for newly-added rows */
    if ('IntersectionObserver' in window && !reduceMotion) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(en => {
          if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      list.querySelectorAll('.reveal').forEach(el => io.observe(el));
    } else {
      list.querySelectorAll('.reveal').forEach(el => el.classList.add('is-in'));
    }
  }

  /* ── Boot ─────────────────────────────────────── */
  (async () => {
    const content = await loadContent();
    if (!content) return; /* keep static fallback */
    if (content.featured) renderFeatured(content.featured);
    if (Array.isArray(content.projects)) renderProjects(content.projects);
  })();

  /* live-update from admin tab */
  window.addEventListener('storage', async (e) => {
    if (e.key === CONTENT_KEY) {
      const content = await loadContent();
      if (!content) return;
      if (content.featured) renderFeatured(content.featured);
      if (Array.isArray(content.projects)) renderProjects(content.projects);
    }
  });
})();


/* ════════════════════════════════════════════════════════════════════
   GENERIC TEXT HYDRATION + INLINE EDIT MODE
   - Walks every [data-edit-key] element on the page and sets its value
     from content (localStorage 'strata.content' OR media/content.json).
   - When ?edit=1 is in the URL, attaches an editing toolbar and makes
     each editable element click-to-edit (contentEditable).
   - Saves write back to localStorage 'strata.content' (live-merging
     with existing project data).
   ════════════════════════════════════════════════════════════════════ */
(() => {
  const CONTENT_KEY = 'strata.content';
  const CONTENT_URL = 'media/content.json';

  /* Path helpers — support dotted paths and array indexes like "list[2].title" */
  function parsePath(path) {
    return String(path).split('.').flatMap(seg => {
      const out = [];
      const re = /([^\[\]]+)|\[(\d+)\]/g;
      let m; while ((m = re.exec(seg)) !== null) {
        out.push(m[1] != null ? m[1] : parseInt(m[2], 10));
      }
      return out;
    });
  }
  function getAt(obj, path) {
    return parsePath(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setAt(obj, path, value) {
    const keys = parsePath(path);
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i], next = keys[i + 1];
      if (cur[k] == null || typeof cur[k] !== 'object') {
        cur[k] = (typeof next === 'number') ? [] : {};
      }
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
    return obj;
  }

  /* ── Storage ─────────────────────────────────── */
  let _content = null;
  let _defaults = null;

  function readLocal() {
    try {
      const raw = localStorage.getItem(CONTENT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (_) { return null; }
  }
  async function readDefaults() {
    if (_defaults) return _defaults;
    try {
      const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      _defaults = await res.json();
    } catch (err) {
      console.warn('content.json default load failed:', err);
      _defaults = {};
    }
    return _defaults;
  }
  function persist() {
    if (!_content) return;
    _content.updatedAt = new Date().toISOString();
    localStorage.setItem(CONTENT_KEY, JSON.stringify(_content));
  }

  /* ── Hydration ───────────────────────────────── */
  function hydrate(content) {
    if (!content) return;
    document.querySelectorAll('[data-edit-key]').forEach(el => {
      const key = el.getAttribute('data-edit-key');
      const value = getAt(content, key);
      if (value == null) return;
      if (el.dataset.editHtml === '1') el.innerHTML = String(value);
      else el.textContent = String(value);
    });
  }

  /* ── Edit mode ───────────────────────────────── */
  function inEditMode() {
    return new URLSearchParams(location.search).get('edit') === '1';
  }

  function buildEditBar() {
    const bar = document.createElement('div');
    bar.className = 'editbar-site';
    bar.innerHTML = `
      <div class="editbar-site__inner">
        <span class="editbar-site__brand">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          <strong>Düzenleme modu</strong>
        </span>
        <span class="editbar-site__hint">Metnin üstüne tıkla → yaz · Boşluğa tıkla → kaydet · Esc / Enter → çık</span>
        <span class="editbar-site__actions">
          <button type="button" id="editbarReset" class="editbar-site__btn">Varsayılana dön</button>
          <a href="admin.html" class="editbar-site__btn editbar-site__btn--ghost">Admin'e dön</a>
          <a href="${location.pathname}" class="editbar-site__btn editbar-site__btn--accent">Çık (önizle)</a>
        </span>
      </div>
    `;
    document.body.prepend(bar);
    document.body.classList.add('is-editing-site');

    const adjust = () => {
      const h = bar.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--editbar-h', h + 'px');
    };
    adjust();
    window.addEventListener('resize', adjust);

    bar.querySelector('#editbarReset').addEventListener('click', async () => {
      if (!confirm('Tüm metin değişiklikleri silinecek, varsayılan içeriğe dönülecek. Devam?')) return;
      const def = await readDefaults();
      _content = JSON.parse(JSON.stringify(def || {}));
      persist();
      hydrate(_content);
      flash('Varsayılana döndürüldü');
    });
  }

  let toastTimer = null;
  function flash(msg) {
    let t = document.getElementById('editbarToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'editbarToast';
      t.className = 'editbar-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 2000);
  }

  function activateEditing() {
    document.querySelectorAll('[data-edit-key]').forEach(el => {
      el.classList.add('editable');

      el.addEventListener('click', (e) => {
        if (el.isContentEditable) return;
        e.preventDefault();
        e.stopPropagation();
        const editType = (el.dataset.editHtml === '1') ? 'true' : 'plaintext-only';
        el.setAttribute('contenteditable', editType);
        el.classList.add('is-editing-now');
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });

      el.addEventListener('keydown', (e) => {
        if (!el.isContentEditable) return;
        if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
        else if (e.key === 'Enter' && !e.shiftKey && el.dataset.editMultiline !== '1') {
          e.preventDefault(); el.blur();
        }
      });

      el.addEventListener('blur', () => {
        if (!el.hasAttribute('contenteditable')) return;
        el.removeAttribute('contenteditable');
        el.classList.remove('is-editing-now');
        const key = el.getAttribute('data-edit-key');
        const value = (el.dataset.editHtml === '1') ? el.innerHTML.trim() : el.innerText.trim();
        const prev  = getAt(_content, key);
        if (String(prev || '') !== String(value)) {
          setAt(_content, key, value);
          persist();
          flash('Kaydedildi: ' + key);
        }
      });
    });
  }

  /* ── Boot ─────────────────────────────────────── */
  (async () => {
    const local = readLocal();
    const def   = await readDefaults();
    _content = local ? local : JSON.parse(JSON.stringify(def || {}));

    hydrate(_content);

    if (inEditMode()) {
      buildEditBar();
      activateEditing();
    }
  })();

  /* react when admin tab updates content */
  window.addEventListener('storage', (e) => {
    if (e.key !== CONTENT_KEY) return;
    const local = readLocal();
    if (local) { _content = local; hydrate(_content); }
  });
})();
