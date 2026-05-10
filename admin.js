/* AR-CİV admin — Atölye günlüğü
   Pure client-side: localStorage persistence + Microlink fetch + import/export
   + Instagram-style crop tool (drag-frame + corner-resize + slider) + edit existing posts.

   Crop data is stored as { cx, cy, cw, ch } — image-percent rectangle.
   Site CSS uses these vars to position the image so the crop region exactly fills the cell. */

(() => {
  const STORAGE_KEY = 'strata.posts';

  /* layout/aspect map: which slot each index lands in (0=newest = 'feature') */
  const SLOT_DEFS = [
    { key: 'feature',  ratioStr: '2 / 1', ratioNum: 2,    label: 'Öne çıkan (2:1)' },
    { key: 'vertical', ratioStr: '1 / 2', ratioNum: 0.5,  label: 'Dikey (1:2)' },
    { key: 'square',   ratioStr: '1 / 1', ratioNum: 1,    label: 'Kare (1:1)' },
    { key: 'square',   ratioStr: '1 / 1', ratioNum: 1,    label: 'Kare (1:1)' },
    { key: 'wide',     ratioStr: '2 / 1', ratioNum: 2,    label: 'Geniş (2:1)' },
    { key: 'square',   ratioStr: '1 / 1', ratioNum: 1,    label: 'Kare (1:1)' },
  ];
  function slotForIndex(i) { return SLOT_DEFS[Math.max(0, Math.min(SLOT_DEFS.length - 1, i))]; }

  /* ── DOM refs ────────────────────────────────── */
  const $ = (id) => document.getElementById(id);
  const form        = $('postForm');
  const urlInput    = $('f-url');
  const imageInput  = $('f-image');
  const uploadInput = $('f-upload');
  const captionEl   = $('f-caption');
  const captionHint = $('captionHint');
  const fetchHint   = $('fetchHint');
  const typeEl      = $('f-type');
  const dateEl      = $('f-date');
  const likesEl     = $('f-likes');
  const fetchBtn    = $('fetchBtn');
  const resetBtn    = $('resetBtn');
  const saveBtn     = $('saveBtn');
  const list        = $('postList');
  const countEl     = $('count');
  const emptyEl     = $('emptyState');
  const exportBtn   = $('exportBtn');
  const importInput = $('importInput');
  const clearBtn    = $('clearBtn');
  const toastEl     = $('toast');

  /* cropper */
  const cropperStage = $('cropperStage');
  const cropperImg   = $('cropperImg');
  const cropperFrame = $('cropperFrame');
  const cropperSize  = $('cropperSize');
  const cropperSizeVal = $('cropperSizeVal');
  const cropperSlot  = $('cropperSlot');
  const cropperReset = $('cropperReset');

  /* edit bar */
  const editBar    = $('editBar');
  const editIdLbl  = $('editIdLabel');
  const editCancel = $('editCancel');

  /* ── State ───────────────────────────────────── */
  let editingId = null;
  /* crop = rectangle in image-percent space */
  let crop = { x: 0, y: 0, w: 100, h: 100 };
  let imgW = 0, imgH = 0;            // natural image dimensions (px)
  let currentSlotIdx = 0;
  /* whether user has touched the crop since image loaded — avoids overwrite on slot change */
  let userTouchedCrop = false;

  /* ── Helpers ─────────────────────────────────── */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    toastEl.className = 'toast ' + (kind === 'error' ? 'is-error' : kind === 'warn' ? 'is-warn' : '');
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add('is-on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2800);
  }
  function nowLocalISOForInput() {
    const d = new Date();
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function getPosts() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function setPosts(arr) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    renderList();
  }

  /* ── Cropper ─────────────────────────────────── */

  /* Required ratio of crop in image-percent space, given current image and slot.
     cellAspect / imgAspect — when applied to image px, crop matches cell shape. */
  function getCropPctRatio() {
    const slot = slotForIndex(currentSlotIdx);
    const imgAspect = imgW / imgH;
    if (!isFinite(imgAspect) || imgAspect <= 0) return slot.ratioNum;
    return slot.ratioNum / imgAspect;
  }

  /* Maximum (size, position) crop rectangle that fits image with required ratio, centered. */
  function maxCenteredCrop() {
    const r = getCropPctRatio();   // cropW% / cropH%
    let w, h;
    if (r >= 1) { w = 100;        h = 100 / r; }
    else        { h = 100;        w = 100 * r; }
    return { x: (100 - w) / 2, y: (100 - h) / 2, w, h };
  }

  function applyCrop() {
    cropperFrame.style.left   = crop.x.toFixed(3) + '%';
    cropperFrame.style.top    = crop.y.toFixed(3) + '%';
    cropperFrame.style.width  = crop.w.toFixed(3) + '%';
    cropperFrame.style.height = crop.h.toFixed(3) + '%';
    /* Slider tracks the larger dimension (which spans 20-100) */
    const r = getCropPctRatio();
    const bigger = r >= 1 ? crop.w : crop.h;
    cropperSize.value = Math.round(bigger);
    cropperSizeVal.textContent = Math.round(bigger) + '%';
    cropperSize.style.setProperty('--p', Math.round(bigger) + '%');
  }

  /* Resize the crop to a target "bigger dimension" %, keeping the center fixed. */
  function setCropSize(biggerPct) {
    const r = getCropPctRatio();
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    let newW, newH;
    if (r >= 1) { newW = clamp(biggerPct, 20, 100); newH = newW / r; }
    else        { newH = clamp(biggerPct, 20, 100); newW = newH * r; }
    /* clamp dimensions to ≤ 100 */
    if (newW > 100) { const k = 100 / newW; newW = 100; newH *= k; }
    if (newH > 100) { const k = 100 / newH; newH = 100; newW *= k; }
    crop.w = newW;
    crop.h = newH;
    crop.x = clamp(cx - crop.w / 2, 0, 100 - crop.w);
    crop.y = clamp(cy - crop.h / 2, 0, 100 - crop.h);
  }

  function resetCrop() {
    const m = maxCenteredCrop();
    crop = m;
    userTouchedCrop = false;
    applyCrop();
  }

  /* Re-fit crop to a new slot/aspect, attempting to preserve center & relative size */
  function refitForSlot() {
    const r = getCropPctRatio();
    const cx = crop.x + crop.w / 2;
    const cy = crop.y + crop.h / 2;
    const bigger = Math.max(crop.w, crop.h);
    let w, h;
    if (r >= 1) { w = bigger;       h = bigger / r; }
    else        { h = bigger;       w = bigger * r; }
    if (w > 100) { const k = 100 / w; w = 100; h *= k; }
    if (h > 100) { const k = 100 / h; h = 100; w *= k; }
    crop.w = w; crop.h = h;
    crop.x = clamp(cx - w / 2, 0, 100 - w);
    crop.y = clamp(cy - h / 2, 0, 100 - h);
    applyCrop();
  }

  function setSlot(idx, opts = {}) {
    currentSlotIdx = clamp(idx, 0, SLOT_DEFS.length - 1);
    const slot = slotForIndex(currentSlotIdx);
    cropperSlot.textContent = 'Hücre: ' + slot.label;
    if (imgW > 0 && imgH > 0) {
      if (opts.preserve) refitForSlot();
      else resetCrop();
    }
  }

  function loadCropperImage(url) {
    if (!url) {
      cropperImg.removeAttribute('src');
      cropperStage.classList.add('is-empty');
      cropperStage.style.removeProperty('--img-aspect');
      cropperStage.style.maxWidth = '';
      imgW = imgH = 0;
      return;
    }
    cropperImg.onload = () => {
      imgW = cropperImg.naturalWidth || 1;
      imgH = cropperImg.naturalHeight || 1;
      const aspectNum = imgW / imgH;
      cropperStage.style.setProperty('--img-aspect', `${imgW} / ${imgH}`);
      /* For portrait images: cap stage WIDTH so derived height stays ≤ 70vh.
         This keeps the stage at the image's natural aspect (no letterbox bars
         inside, no cut-off content). For landscape images the default
         `width: 100%` + `aspect-ratio` is already correct. */
      if (aspectNum < 1) {
        cropperStage.style.maxWidth = `calc(70vh * ${aspectNum.toFixed(4)})`;
      } else {
        cropperStage.style.maxWidth = '';
      }
      cropperStage.classList.remove('is-empty');
      if (!userTouchedCrop) resetCrop();
      else applyCrop();
    };
    cropperImg.onerror = () => {
      cropperStage.classList.add('is-empty');
      cropperStage.style.removeProperty('--img-aspect');
      cropperStage.style.maxWidth = '';
    };
    cropperImg.src = url;
  }

  /* ── Slider ───────────────────────────────────── */
  cropperSize.addEventListener('input', () => {
    userTouchedCrop = true;
    setCropSize(parseInt(cropperSize.value, 10));
    applyCrop();
  });

  cropperReset.addEventListener('click', () => {
    if (imgW > 0) resetCrop();
  });

  /* ── Drag (move frame) ────────────────────────── */
  let drag = null;
  cropperFrame.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('cropper__handle')) return; // handle has its own listener
    if (cropperStage.classList.contains('is-empty')) return;
    cropperFrame.setPointerCapture(e.pointerId);
    cropperFrame.classList.add('is-acting');
    drag = { mode: 'move', startX: e.clientX, startY: e.clientY, sx: crop.x, sy: crop.y };
  });

  /* Resize handles */
  cropperStage.querySelectorAll('.cropper__handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (cropperStage.classList.contains('is-empty')) return;
      handle.setPointerCapture(e.pointerId);
      cropperFrame.classList.add('is-acting');
      drag = {
        mode: 'resize',
        corner: handle.dataset.h,
        startX: e.clientX, startY: e.clientY,
        sx: crop.x, sy: crop.y, sw: crop.w, sh: crop.h,
      };
    });
  });

  /* Pointer move/up handled at document level so the user can drag past the stage edge */
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    userTouchedCrop = true;
    const stageRect = cropperStage.getBoundingClientRect();
    const dxPct = (e.clientX - drag.startX) / stageRect.width  * 100;
    const dyPct = (e.clientY - drag.startY) / stageRect.height * 100;

    if (drag.mode === 'move') {
      crop.x = clamp(drag.sx + dxPct, 0, 100 - crop.w);
      crop.y = clamp(drag.sy + dyPct, 0, 100 - crop.h);
      applyCrop();
      return;
    }

    /* resize: drag corner inward/outward; aspect locked, anchor opposite corner */
    const r = getCropPctRatio();
    const corner = drag.corner;
    const anchor = {
      nw: { ax: drag.sx + drag.sw, ay: drag.sy + drag.sh, dirX: -1, dirY: -1 },
      ne: { ax: drag.sx,           ay: drag.sy + drag.sh, dirX:  1, dirY: -1 },
      sw: { ax: drag.sx + drag.sw, ay: drag.sy,            dirX: -1, dirY:  1 },
      se: { ax: drag.sx,           ay: drag.sy,            dirX:  1, dirY:  1 },
    }[corner];

    /* desired width derived from drag delta along x (with corner direction) */
    let newW = drag.sw + dxPct * anchor.dirX;
    let newH = drag.sh + dyPct * anchor.dirY;
    /* enforce aspect ratio: pick the larger absolute change as the driver */
    if (Math.abs(newW - drag.sw) * (1 / Math.max(r, 1)) >= Math.abs(newH - drag.sh) * Math.max(r, 1)) {
      newH = newW / r;
    } else {
      newW = newH * r;
    }
    /* min size & max size */
    if (r >= 1) { newW = clamp(newW, 20, 100); newH = newW / r; }
    else        { newH = clamp(newH, 20, 100); newW = newH * r; }

    let nx = anchor.dirX > 0 ? anchor.ax              : anchor.ax - newW;
    let ny = anchor.dirY > 0 ? anchor.ay              : anchor.ay - newH;

    /* keep within stage */
    if (nx < 0)            { newW += nx; if (r >= 1) newH = newW / r; else newW = newH * r; nx = 0; }
    if (ny < 0)            { newH += ny; if (r >= 1) newW = newH * r; else newH = newW / r; ny = 0; }
    if (nx + newW > 100)   { newW = 100 - nx; if (r >= 1) newH = newW / r; else newW = newH * r; }
    if (ny + newH > 100)   { newH = 100 - ny; if (r >= 1) newW = newH * r; else newH = newW / r; }

    crop.x = clamp(nx, 0, 100 - newW);
    crop.y = clamp(ny, 0, 100 - newH);
    crop.w = clamp(newW, 20, 100);
    crop.h = clamp(newH, 20, 100);
    applyCrop();
  });

  function endDrag() {
    drag = null;
    cropperFrame.classList.remove('is-acting');
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  /* ── File upload → dataURL ───────────────────── */
  uploadInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      toast('Görsel 1.5 MB üzerinde — küçült veya URL kullan', 'warn');
    }
    const r = new FileReader();
    r.onload = (ev) => {
      const dataUrl = ev.target.result;
      imageInput.value = dataUrl;
      userTouchedCrop = false;
      loadCropperImage(dataUrl);
    };
    r.readAsDataURL(file);
  });

  imageInput.addEventListener('input', () => {
    userTouchedCrop = false;
    loadCropperImage(imageInput.value.trim());
  });

  /* ── Microlink fetch ─────────────────────────── */
  function isInstagramUrl(u) {
    return /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[\w-]+/i.test(u);
  }
  function detectTypeFromUrl(u) {
    if (/\/reel(s)?\//i.test(u)) return 'VIDEO';
    if (/\/tv\//i.test(u))       return 'VIDEO';
    return 'IMAGE';
  }
  function parseInstagramDescription(desc) {
    const out = { caption: '', likeCount: null };
    if (!desc) return out;
    const text = String(desc).replace(/\s+/g, ' ').trim();
    const likes = text.match(/([\d.,]+)\s*[Ll]ikes?/);
    if (likes) out.likeCount = parseInt(likes[1].replace(/[.,]/g, ''), 10) || null;
    const afterColon = text.match(/[:—\-—]\s*[""'']?([\s\S]+?)[""'']?\s*$/);
    if (afterColon && afterColon[1].length > 4) out.caption = afterColon[1].trim();
    else out.caption = text;
    return out;
  }
  async function fetchFromMicrolink(url) {
    const api = 'https://api.microlink.io/?meta=true&video=false&audio=false&url=' + encodeURIComponent(url);
    const res = await fetch(api, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Microlink HTTP ' + res.status);
    const json = await res.json();
    if (!json || json.status !== 'success' || !json.data) throw new Error('Microlink: meta okunamadı');
    return json.data;
  }
  fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); return; }
    if (!isInstagramUrl(url)) { toast('Geçerli bir Instagram /p/, /reel/ veya /tv/ URL\'i girin', 'warn'); return; }
    fetchBtn.classList.add('is-busy');
    fetchHint.textContent = 'Microlink çekiyor…';
    try {
      const data = await fetchFromMicrolink(url);
      const img = (data.image && data.image.url) || '';
      const parsed = parseInstagramDescription(data.description);

      if (!imageInput.value) imageInput.value = img;
      if (img) { userTouchedCrop = false; loadCropperImage(img); }
      if (!captionEl.value && parsed.caption) captionEl.value = parsed.caption;
      if (!likesEl.value && parsed.likeCount != null) likesEl.value = parsed.likeCount;

      const inferred = detectTypeFromUrl(url);
      if (inferred !== 'IMAGE') typeEl.value = inferred;

      if (data.date && !dateEl.value) {
        const d = new Date(data.date);
        if (!isNaN(d.getTime())) {
          const off = d.getTimezoneOffset() * 60000;
          dateEl.value = new Date(d.getTime() - off).toISOString().slice(0, 16);
        }
      }

      /* Inform the user about Instagram's og:image limitation. Once the image
         loads we'll know its dimensions; until then show a tentative note. */
      const isCarousel = (data.description || '').match(/comments/i)
        || (data.title || '').match(/Instagram\s+(post|photo)/i);
      const carouselNote = isCarousel
        ? ' Carousel postlarında yalnızca ilk slayt çekilir — başka bir slayt istiyorsan bilgisayardan yükle.'
        : '';
      fetchHint.innerHTML =
        'Instagram\'ın paylaşım önizlemesi (og:image) çekildi.' + carouselNote +
        '<br/><b>Tam orijinal için</b> "Bilgisayardan" butonu ile yükle.';
      captionHint.textContent = parsed.caption ? 'Caption Instagram özetinden çıkarıldı — gerektiğinde düzelt.' : '';
      toast('Önizleme dolduruldu — gerekirse orijinali yükle');
    } catch (err) {
      console.warn(err);
      fetchHint.textContent = 'Otomatik çekme başarısız — alanları elle doldurabilirsin.';
      toast('Veri alınamadı: alanları elle doldur', 'error');
    } finally {
      fetchBtn.classList.remove('is-busy');
    }
  });

  /* ── Form submit (add OR update) ─────────────── */
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    const img = imageInput.value.trim();
    if (!url || !img) { toast('URL ve görsel zorunlu', 'error'); return; }
    const tsLocal = dateEl.value || nowLocalISOForInput();
    const tsDate  = new Date(tsLocal);
    const ts      = isNaN(tsDate.getTime()) ? new Date().toISOString() : tsDate.toISOString();

    const post = {
      id:             editingId || ('post_' + Date.now()),
      permalink:      url,
      media_type:     typeEl.value || 'IMAGE',
      media_url:      img,
      thumbnail_url:  img,
      caption:        captionEl.value.trim(),
      timestamp:      ts,
      like_count:     likesEl.value ? parseInt(likesEl.value, 10) : null,
      comments_count: null,
      framing: {
        cx: +crop.x.toFixed(3),
        cy: +crop.y.toFixed(3),
        cw: +crop.w.toFixed(3),
        ch: +crop.h.toFixed(3),
      },
    };

    const posts = getPosts();
    if (editingId) {
      const idx = posts.findIndex(p => p.id === editingId);
      if (idx >= 0) {
        posts[idx] = { ...posts[idx], ...post };
        setPosts(posts);
        toast('Güncellendi');
      } else {
        posts.unshift(post);
        setPosts(posts);
        toast('Yeni gönderi olarak kaydedildi');
      }
      exitEditMode();
    } else {
      posts.unshift(post);
      setPosts(posts);
      toast('Kaydedildi · ilk 6 gönderi sitede görünür');
    }
    resetForm();
  });

  function resetForm() {
    form.reset();
    loadCropperImage('');
    userTouchedCrop = false;
    setSlot(0);
    captionHint.textContent = '';
    fetchHint.textContent = 'Microlink.io üzerinden bir kerelik veri çekimi · 50 istek/gün ücretsiz';
    dateEl.value = nowLocalISOForInput();
  }

  resetBtn.addEventListener('click', () => {
    if (editingId) exitEditMode();
    resetForm();
  });

  /* ── Edit mode ──────────────────────────────── */
  function enterEditMode(post, idx) {
    editingId = post.id;
    editBar.classList.add('is-on');
    editIdLbl.textContent = '#' + (idx + 1);
    saveBtn.querySelector('span').textContent = 'Güncelle';

    urlInput.value   = post.permalink || '';
    imageInput.value = post.thumbnail_url || post.media_url || '';
    captionEl.value  = post.caption || '';
    typeEl.value     = post.media_type || 'IMAGE';
    likesEl.value    = post.like_count != null ? post.like_count : '';
    if (post.timestamp) {
      const d = new Date(post.timestamp);
      if (!isNaN(d.getTime())) {
        const off = d.getTimezoneOffset() * 60000;
        dateEl.value = new Date(d.getTime() - off).toISOString().slice(0, 16);
      }
    }

    /* prepare slot first so refit knows the right aspect */
    currentSlotIdx = clamp(idx, 0, SLOT_DEFS.length - 1);
    cropperSlot.textContent = 'Hücre: ' + slotForIndex(currentSlotIdx).label;

    /* prime crop with stored data; if absent, will reset on image load */
    if (post.framing && typeof post.framing.cw === 'number' && typeof post.framing.ch === 'number') {
      crop = {
        x: typeof post.framing.cx === 'number' ? post.framing.cx : 0,
        y: typeof post.framing.cy === 'number' ? post.framing.cy : 0,
        w: post.framing.cw,
        h: post.framing.ch,
      };
      userTouchedCrop = true;  // suppress reset on image load
    } else {
      userTouchedCrop = false;
    }
    loadCropperImage(post.thumbnail_url || post.media_url || '');

    cropperStage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function exitEditMode() {
    editingId = null;
    editBar.classList.remove('is-on');
    saveBtn.querySelector('span').textContent = 'Kaydet';
  }

  editCancel.addEventListener('click', () => { exitEditMode(); resetForm(); });

  /* ── List render + actions ───────────────────── */
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('tr-TR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /* Thumbnails are a fixed 64×64 (1:1) so we can't faithfully reproduce the
     site's crop rect (which carries the slot's aspect). Use object-position at
     the crop's center as an approximate preview — the focal point matches. */
  function thumbStyle(p) {
    const f = p.framing;
    if (!f || typeof f.cw !== 'number' || typeof f.ch !== 'number') {
      return { cls: '', style: '' };
    }
    const cx = ((typeof f.cx === 'number' ? f.cx : 0) + f.cw / 2).toFixed(2);
    const cy = ((typeof f.cy === 'number' ? f.cy : 0) + f.ch / 2).toFixed(2);
    return { cls: '', style: `object-position:${cx}% ${cy}%;` };
  }

  function renderList() {
    const posts = getPosts();
    countEl.textContent = posts.length;
    if (!posts.length) { list.innerHTML = ''; emptyEl.hidden = false; return; }
    emptyEl.hidden = true;

    list.innerHTML = posts.map((p, i) => {
      const visible = i < 6;
      const slot = slotForIndex(i);
      const thumb = p.thumbnail_url || p.media_url || '';
      const cap   = p.caption || '<span class="muted">(caption yok)</span>';
      const type  = p.media_type || 'IMAGE';
      const likes = p.like_count != null ? `<span class="badge">${p.like_count}</span>` : '';
      const t = thumbStyle(p);
      return `
        <li class="postrow ${visible ? '' : 'is-hidden'}" data-idx="${i}">
          <span class="postrow__thumbwrap ${t.cls}">
            <img class="postrow__thumb" src="${escapeHtml(thumb)}" alt="" style="${t.style}" onerror="this.style.opacity=0.2" />
          </span>
          <div class="postrow__body">
            <p class="postrow__caption">${escapeHtml(cap)}</p>
            <div class="postrow__meta">
              <span>#${i + 1}${visible ? ' · ' + slot.label : ' · gizli'}</span>
              <span class="dot">·</span>
              <span>${escapeHtml(type)}</span>
              <span class="dot">·</span>
              <span>${formatDate(p.timestamp)}</span>
              ${likes ? '<span class="dot">·</span>' + likes : ''}
            </div>
          </div>
          <div class="postrow__actions">
            <button class="ic" data-act="edit" title="Düzenle / yeniden kırp" aria-label="Düzenle">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button class="ic" data-act="up"   ${i === 0 ? 'disabled' : ''} title="Yukarı" aria-label="Yukarı taşı">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
            <button class="ic" data-act="down" ${i === posts.length - 1 ? 'disabled' : ''} title="Aşağı" aria-label="Aşağı taşı">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
            </button>
            <a class="ic" href="${escapeHtml(p.permalink)}" target="_blank" rel="noopener" title="Instagram'da aç" aria-label="Instagram'da aç">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l9-9M9 8h8v8"/></svg>
            </a>
            <button class="ic ic--del" data-act="del" title="Sil" aria-label="Gönderiyi sil">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </li>
      `;
    }).join('');
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.postrow');
    const idx = parseInt(row.dataset.idx, 10);
    const posts = getPosts();
    const act = btn.dataset.act;

    if (act === 'del') {
      if (!confirm('Bu gönderiyi sil?')) return;
      const removed = posts.splice(idx, 1)[0];
      setPosts(posts);
      if (editingId && removed && removed.id === editingId) { exitEditMode(); resetForm(); }
      toast('Silindi');
    } else if (act === 'edit') {
      enterEditMode(posts[idx], idx);
    } else if (act === 'up' && idx > 0) {
      [posts[idx - 1], posts[idx]] = [posts[idx], posts[idx - 1]];
      setPosts(posts);
    } else if (act === 'down' && idx < posts.length - 1) {
      [posts[idx], posts[idx + 1]] = [posts[idx + 1], posts[idx]];
      setPosts(posts);
    }
  });

  /* ── Export / Import ─────────────────────────── */
  exportBtn.addEventListener('click', () => {
    const posts = getPosts();
    if (!posts.length) { toast('Önce en az bir gönderi ekle', 'warn'); return; }
    const blob = new Blob([JSON.stringify(posts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'posts.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('posts.json indirildi · media/ klasörüne yükle');
  });

  importInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const arr  = Array.isArray(data) ? data : (data.posts || data.data || []);
        if (!Array.isArray(arr)) throw new Error('JSON dizi değil');
        setPosts(arr);
        toast(`${arr.length} gönderi içe aktarıldı`);
      } catch (err) {
        toast('İçe aktarma başarısız: ' + err.message, 'error');
      }
    };
    r.readAsText(file);
    importInput.value = '';
  });

  clearBtn.addEventListener('click', () => {
    if (!getPosts().length) { toast('Zaten boş', 'warn'); return; }
    if (!confirm('Tüm gönderiler silinecek. Emin misin?')) return;
    setPosts([]);
    if (editingId) { exitEditMode(); resetForm(); }
    toast('Hepsi silindi');
  });

  /* ── Boot ─────────────────────────────────────── */
  setSlot(0);
  loadCropperImage('');
  dateEl.value = nowLocalISOForInput();
  renderList();

  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) renderList(); });
})();


/* ════════════════════════════════════════════════════════════════════
   PROJECTS / CONTENT MODULE
   - Tab switching (Projeler / Sosyal medya)
   - CRUD for featured + archive projects
   - Gallery editor (multi-image add/remove/reorder/caption)
   - Persists to localStorage 'strata.content'; export/import to content.json
   ════════════════════════════════════════════════════════════════════ */
(() => {
  const CONTENT_KEY = 'strata.content';
  const CONTENT_URL = 'media/content.json';

  const $ = (id) => document.getElementById(id);

  /* ── DOM refs ────────────────────────────────── */
  const tabProj   = $('adtabProjects');
  const tabSoc    = $('adtabSocial');
  const tabBrand  = $('adtabBrand');
  const tabContact= $('adtabContact');
  const panelProj = $('tabProjects');
  const panelSoc  = $('tabSocial');
  const panelBrand= $('tabBrand');
  const panelContact = $('tabContact');
  const footProj  = $('adminfootProjects');
  const footSoc   = document.querySelector('#tabSocial .adminfoot');

  /* Brand tab DOM */
  const brandForm     = $('brandForm');
  const bfTitle       = $('bf-title');
  const bfDescription = $('bf-description');
  const bfLogo        = $('bf-logo');
  const bfLogoUpload  = $('bf-logo-upload');
  const bfLogoPreview = $('bf-logo-preview');
  const bfFavicon     = $('bf-favicon');
  const bfFaviconUpload = $('bf-favicon-upload');
  const bfFaviconPreview= $('bf-favicon-preview');
  const brandClearBtn = $('brandClearBtn');

  const featuredList = $('featuredList');
  const projectsList = $('projectsListAdmin');
  const projectsCnt  = $('projectsCount');
  const addBtn       = $('projectAddBtn');

  const editor       = $('projectEditor');
  const editorKicker = $('projectEditorKicker');
  const editorTitle  = $('projectEditorTitle');
  const closeBtn     = $('projectCloseBtn');
  const cancelBtn    = $('projectCancelBtn');
  const deleteBtn    = $('projectDeleteBtn');
  const form         = $('projectForm');

  const fName    = $('pf-name');
  const fType    = $('pf-type');
  const fYear    = $('pf-year');
  const fLoc     = $('pf-loc');
  const fStatus  = $('pf-status');
  const fStatusLabel = $('pf-status-label');
  const fCover   = $('pf-cover');
  const fCoverUp = $('pf-cover-upload');
  const fDescField = $('pf-description-field');
  const fDesc    = $('pf-description');
  const fMetaField = $('pf-meta-field');
  const fMetaList  = $('pf-meta-list');
  const fMetaAdd   = $('pf-meta-add');
  const fGallery   = $('pf-gallery');
  const fGalUrl    = $('pf-gallery-url');
  const fGalUp     = $('pf-gallery-upload');
  const fGalAdd    = $('pf-gallery-add');

  const exportBtn = $('contentExportBtn');
  const importIn  = $('contentImportInput');
  const resetBtn  = $('contentResetBtn');
  const clearBtn  = $('contentClearBtn');

  const toastEl = $('toast');

  /* ── State ───────────────────────────────────── */
  let content = null;
  let defaultContent = null;       // fetched once, used for "reset to default"
  let editingId = null;            // 'featured' OR project id (e.g. 'proj_xxx')
  let editingIsFeatured = false;
  let editingGallery = [];         // working copy while editing
  let editingMeta    = [];         // working copy of featured meta

  /* ── Helpers ─────────────────────────────────── */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    if (!toastEl) return;
    toastEl.className = 'toast ' + (kind === 'error' ? 'is-error' : kind === 'warn' ? 'is-warn' : '');
    toastEl.textContent = msg;
    requestAnimationFrame(() => toastEl.classList.add('is-on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2800);
  }

  async function fetchDefault() {
    try {
      const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) { console.warn('default content load failed:', err); return null; }
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(CONTENT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && (parsed.featured || parsed.projects)) return parsed;
    } catch (_) {}
    return null;
  }
  function writeLocal(c) {
    localStorage.setItem(CONTENT_KEY, JSON.stringify(c));
  }

  function persist() {
    if (!content) return;
    content.updatedAt = new Date().toISOString();
    writeLocal(content);
    renderProjectLists();
  }

  /* ── Tab switching ───────────────────────────── */
  function activate(tab) {
    const tabs = { projects: tabProj, social: tabSoc, brand: tabBrand, contact: tabContact };
    const panels = { projects: panelProj, social: panelSoc, brand: panelBrand, contact: panelContact };
    Object.entries(tabs).forEach(([k, btn]) => {
      if (!btn) return;
      const on = (k === tab);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on);
    });
    Object.entries(panels).forEach(([k, p]) => { if (p) p.hidden = (k !== tab); });
    if (footProj) footProj.style.display = (tab === 'projects') ? 'block' : 'none';
    if (footSoc)  footSoc.style.display  = (tab === 'social')   ? 'block' : 'none';
    if (tab === 'brand')   refreshBrandForm();
    if (tab === 'contact') refreshContactForm();
    try { localStorage.setItem('strata.adminTab', tab); } catch (_) {}
  }
  tabProj.addEventListener('click', () => activate('projects'));
  tabSoc.addEventListener('click',  () => activate('social'));
  if (tabBrand)   tabBrand.addEventListener('click',   () => activate('brand'));
  if (tabContact) tabContact.addEventListener('click', () => activate('contact'));

  /* ── Brand tab: logo + favicon uploads ──────── */
  function applyBrandPreview(input, previewBox) {
    if (!previewBox) return;
    const v = (input.value || '').trim();
    if (!v) { previewBox.hidden = true; return; }
    previewBox.hidden = false;
    const chip = previewBox.querySelector('.brandpreview__chip');
    if (chip) chip.style.backgroundImage = `url("${v.replace(/"/g, '\\"')}")`;
  }
  function refreshBrandForm() {
    const brand = (content && content.brand) || {};
    const meta  = (content && content.meta)  || {};
    if (bfTitle)       bfTitle.value       = meta.title       || '';
    if (bfDescription) bfDescription.value = meta.description || '';
    if (bfLogo)        bfLogo.value        = brand.logoUrl    || '';
    if (bfFavicon)     bfFavicon.value     = brand.faviconUrl || '';
    applyBrandPreview(bfLogo,    bfLogoPreview);
    applyBrandPreview(bfFavicon, bfFaviconPreview);
  }
  function attachBrandUpload(fileInput, urlInput, previewBox, sizeLimitMB) {
    if (!fileInput || !urlInput) return;
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > sizeLimitMB * 1024 * 1024) {
        toast(`Görsel ${sizeLimitMB} MB üzerinde — küçült veya URL kullan`, 'warn');
      }
      const r = new FileReader();
      r.onload = (ev) => {
        urlInput.value = ev.target.result;
        applyBrandPreview(urlInput, previewBox);
      };
      r.readAsDataURL(file);
      e.target.value = '';
    });
    urlInput.addEventListener('input', () => applyBrandPreview(urlInput, previewBox));
  }
  attachBrandUpload(bfLogoUpload,    bfLogo,    bfLogoPreview,    1.5);
  attachBrandUpload(bfFaviconUpload, bfFavicon, bfFaviconPreview, 0.5);

  if (brandForm) {
    brandForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!content) return;
      content.brand = content.brand || {};
      content.meta  = content.meta  || {};
      content.meta.title       = (bfTitle && bfTitle.value || '').trim();
      content.meta.description = (bfDescription && bfDescription.value || '').trim();
      content.brand.logoUrl    = (bfLogo.value || '').trim();
      content.brand.faviconUrl = (bfFavicon.value || '').trim();
      persist();
      /* Title change reflects on the LIVE site only after publish.
         Update document.title in the admin tab too for instant feedback
         on browser-tab UI elsewhere isn't relevant — admin keeps its own. */
      toast('Marka kaydedildi · canlı sayfa otomatik güncellenir');
    });
  }
  if (brandClearBtn) {
    brandClearBtn.addEventListener('click', () => {
      if (!confirm('Logo ve favicon temizlenecek (varsayılan ☰ rozeti geri gelir). Devam?')) return;
      if (!content) return;
      content.brand = content.brand || {};
      delete content.brand.logoUrl;
      delete content.brand.faviconUrl;
      persist();
      refreshBrandForm();
      toast('Sıfırlandı');
    });
  }

  /* ── Contact tab: studio + team + social ──────── */
  const contactForm     = $('contactForm');
  const cfStudioKicker  = $('cf-studio-kicker');
  const cfStudioMaps    = $('cf-studio-maps');
  const cfStudioAddress = $('cf-studio-address');
  const cfTeamKicker    = $('cf-team-kicker');
  const cfTeamList      = $('cf-team-list');
  const cfTeamAdd       = $('cf-team-add');
  const cfSocialKicker  = $('cf-social-kicker');
  const cfSocial = {
    instagram: $('cf-social-instagram'),
    twitter:   $('cf-social-twitter'),
    pinterest: $('cf-social-pinterest'),
    youtube:   $('cf-social-youtube'),
    linkedin:  $('cf-social-linkedin'),
  };

  let editingMembers = [];

  function renderMemberRows() {
    if (!cfTeamList) return;
    cfTeamList.innerHTML = editingMembers.map((m, i) => `
      <li class="memberrow" data-i="${i}">
        <input type="text" class="member-role"  placeholder="Rol (Mimar, İnşaat Mühendisi…)" value="${escapeHtml(m.role || '')}" />
        <input type="text" class="member-name"  placeholder="Ad Soyad" value="${escapeHtml(m.name || '')}" />
        <input type="tel"  class="member-phone" placeholder="+90 555 000 00 00" value="${escapeHtml(m.phone || '')}" />
        <button type="button" class="ic ic--del" data-act="del-member" aria-label="Üyeyi sil">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>
        </button>
      </li>
    `).join('');
  }
  function captureMemberRowsFromDOM() {
    if (!cfTeamList) return;
    editingMembers = Array.from(cfTeamList.querySelectorAll('.memberrow')).map(row => ({
      role:  row.querySelector('.member-role').value.trim(),
      name:  row.querySelector('.member-name').value.trim(),
      phone: row.querySelector('.member-phone').value.trim(),
    }));
  }
  if (cfTeamList) {
    cfTeamList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="del-member"]');
      if (!btn) return;
      captureMemberRowsFromDOM();
      const i = parseInt(btn.closest('.memberrow').dataset.i, 10);
      editingMembers.splice(i, 1);
      renderMemberRows();
    });
  }
  if (cfTeamAdd) {
    cfTeamAdd.addEventListener('click', () => {
      captureMemberRowsFromDOM();
      editingMembers.push({ role: '', name: '', phone: '' });
      renderMemberRows();
    });
  }

  function refreshContactForm() {
    const c = (content && content.contact) || {};
    const s = c.studio || {}, t = c.team || {}, soc = c.social || {};
    if (cfStudioKicker)  cfStudioKicker.value  = s.kicker  || '';
    if (cfStudioMaps)    cfStudioMaps.value    = s.mapsUrl || '';
    if (cfStudioAddress) cfStudioAddress.value = s.address || '';
    if (cfTeamKicker)    cfTeamKicker.value    = t.kicker  || '';
    editingMembers = Array.isArray(t.members) ? t.members.map(m => ({
      role: m.role || '', name: m.name || '', phone: m.phone || ''
    })) : [];
    renderMemberRows();
    if (cfSocialKicker) cfSocialKicker.value = soc.kicker || '';
    Object.keys(cfSocial).forEach(k => {
      if (cfSocial[k]) cfSocial[k].value = soc[k] || '';
    });
  }

  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!content) return;
      captureMemberRowsFromDOM();
      content.contact = content.contact || {};
      content.contact.studio = {
        kicker:  cfStudioKicker.value.trim() || 'Atölye',
        address: cfStudioAddress.value.trim(),
        mapsUrl: cfStudioMaps.value.trim(),
      };
      content.contact.team = {
        kicker:  cfTeamKicker.value.trim() || 'Ekip',
        members: editingMembers.filter(m => m.name || m.phone || m.role),
      };
      const social = { kicker: cfSocialKicker.value.trim() || 'İzleyin' };
      Object.keys(cfSocial).forEach(k => {
        const v = cfSocial[k] ? cfSocial[k].value.trim() : '';
        social[k] = v;
      });
      content.contact.social = social;
      persist();
      toast('İletişim kaydedildi · canlı sayfa otomatik güncellenir');
    });
  }

  /* ── Render lists ────────────────────────────── */
  function renderProjectLists() {
    /* featured */
    if (content && content.featured) {
      const f = content.featured;
      const galN = (f.gallery && f.gallery.length || 0) + (f.cover && f.cover.url ? 1 : 0);
      featuredList.innerHTML = `
        <li class="projitem ${editingIsFeatured ? 'is-editing' : ''}" data-target="featured" tabindex="0" role="button" aria-label="${escapeHtml(f.name || '')} düzenle">
          <img class="projitem__cover" alt="" src="${escapeHtml((f.cover && f.cover.url) || '')}" onerror="this.style.opacity=0.2"/>
          <div class="projitem__body">
            <h3 class="projitem__name">${escapeHtml(f.name || '(Adsız)')}</h3>
            <div class="projitem__meta">
              <span>Öne çıkan</span><span class="dot">·</span><span>${galN} foto</span>
            </div>
          </div>
          <span class="projitem__count">düzenle →</span>
        </li>
      `;
    } else {
      featuredList.innerHTML = `<li class="emptystate"><span>Öne çıkan proje yok.</span></li>`;
    }

    /* archive */
    const projects = (content && Array.isArray(content.projects)) ? content.projects : [];
    projectsCnt.textContent = projects.length;

    if (!projects.length) {
      projectsList.innerHTML = `<li class="emptystate"><span>Arşivde proje yok.</span><span class="muted">"Yeni proje" butonu ile ekle.</span></li>`;
      return;
    }

    projectsList.innerHTML = projects.map((p, i) => {
      const num = String(i + 1).padStart(2, '0');
      const galN = (p.gallery && p.gallery.length || 0) + (p.cover && p.cover.url ? 1 : 0);
      const isEditing = (editingId === p.id && !editingIsFeatured);
      return `
        <li class="projitem ${isEditing ? 'is-editing' : ''}" data-target="project" data-id="${escapeHtml(p.id || '')}" tabindex="0" role="button">
          <img class="projitem__cover" alt="" src="${escapeHtml((p.cover && p.cover.url) || '')}" onerror="this.style.opacity=0.2"/>
          <div class="projitem__body">
            <h3 class="projitem__name">${num} · ${escapeHtml(p.name || '(Adsız)')}</h3>
            <div class="projitem__meta">
              <span>${escapeHtml(p.year || '')}</span><span class="dot">·</span>
              <span>${escapeHtml(p.location || '')}</span><span class="dot">·</span>
              <span>${galN} foto</span>
            </div>
          </div>
          <span class="projitem__count">düzenle →</span>
        </li>
      `;
    }).join('');
  }

  function onProjectListClick(e) {
    const li = e.target.closest('.projitem');
    if (!li) return;
    if (li.dataset.target === 'featured') openEditorForFeatured();
    else if (li.dataset.target === 'project') openEditorForProject(li.dataset.id);
  }
  featuredList.addEventListener('click', onProjectListClick);
  projectsList.addEventListener('click', onProjectListClick);
  featuredList.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onProjectListClick(e); } });
  projectsList.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onProjectListClick(e); } });

  /* ── Editor: open / close ────────────────────── */
  function openEditorForFeatured() {
    if (!content || !content.featured) return;
    editingId = 'featured';
    editingIsFeatured = true;
    fillForm(content.featured, /*isFeatured*/ true);
    showEditor('Öne çıkan projeyi düzenle', 'Öne çıkan');
  }
  function openEditorForProject(id) {
    if (!content) return;
    const p = (content.projects || []).find(x => x.id === id);
    if (!p) return;
    editingId = id;
    editingIsFeatured = false;
    fillForm(p, /*isFeatured*/ false);
    showEditor(p.name || 'Proje düzenle', 'Arşiv projesi');
  }
  function openEditorForNew() {
    if (!content) content = { featured: null, projects: [] };
    if (!Array.isArray(content.projects)) content.projects = [];
    editingId = null;
    editingIsFeatured = false;
    fillForm({ name: '', type: '', year: '', location: '', cover: { url: '' }, gallery: [] }, false);
    showEditor('Yeni proje', 'Arşivde yeni kayıt');
    fName.focus();
  }
  function closeEditor() {
    editor.hidden = true;
    editingId = null;
    editingIsFeatured = false;
    deleteBtn.hidden = true;
    renderProjectLists();
  }
  function showEditor(title, kicker) {
    editor.hidden = false;
    editorTitle.textContent = title;
    editorKicker.textContent = kicker;
    deleteBtn.hidden = !editingId;  // can delete only existing items
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  closeBtn.addEventListener('click', closeEditor);
  cancelBtn.addEventListener('click', closeEditor);
  addBtn.addEventListener('click', openEditorForNew);

  /* ── Editor: form fill / read ────────────────── */
  function fillForm(data, isFeatured) {
    fName.value  = data.name || '';
    fType.value  = data.type || '';
    fYear.value  = data.year || '';
    fLoc.value   = data.location || '';
    fStatus.value = isFeatured ? 'featured' : 'archive';
    fStatus.disabled = true;  /* status not editable in v1 */
    fStatusLabel.textContent = 'Statü ' + (isFeatured ? '(öne çıkan)' : '(arşiv)');

    fCover.value = (data.cover && data.cover.url) || '';

    /* featured-only fields */
    fDescField.hidden = !isFeatured;
    fMetaField.hidden = !isFeatured;
    if (isFeatured) {
      fDesc.value = data.description || '';
      editingMeta = Array.isArray(data.meta) ? data.meta.map(m => ({ label: m.label || '', value: m.value || '' })) : [];
      renderMeta();
    }

    editingGallery = Array.isArray(data.gallery) ? data.gallery.map(g => ({ url: g.url || '', caption: g.caption || '' })) : [];
    renderGallery();
  }

  function readForm() {
    const out = {
      name: fName.value.trim(),
      type: fType.value.trim(),
      year: fYear.value.trim(),
      location: fLoc.value.trim(),
      cover: { url: fCover.value.trim(), framing: null },
      gallery: editingGallery.slice(),
    };
    if (editingIsFeatured) {
      out.description = fDesc.value.trim();
      out.meta = editingMeta.slice();
    }
    return out;
  }

  /* ── Cover upload ────────────────────────────── */
  fCoverUp.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) toast('Görsel 1.5 MB üzerinde — küçült veya URL kullan', 'warn');
    const r = new FileReader();
    r.onload = (ev) => { fCover.value = ev.target.result; };
    r.readAsDataURL(file);
    e.target.value = '';
  });

  /* ── Meta editor (featured only) ─────────────── */
  function renderMeta() {
    fMetaList.innerHTML = editingMeta.map((m, i) => `
      <li class="metarow" data-i="${i}">
        <input type="text" class="meta-label" placeholder="Etiket (Tip)" value="${escapeHtml(m.label || '')}" />
        <input type="text" class="meta-value" placeholder="Değer (Konut · 3 villa)" value="${escapeHtml(m.value || '')}" />
        <button type="button" class="ic ic--del" data-act="del" aria-label="Satır sil">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>
        </button>
      </li>
    `).join('');
  }
  fMetaAdd.addEventListener('click', () => {
    editingMeta.push({ label: '', value: '' });
    renderMeta();
  });
  fMetaList.addEventListener('input', (e) => {
    const row = e.target.closest('.metarow');
    if (!row) return;
    const i = parseInt(row.dataset.i, 10);
    if (e.target.classList.contains('meta-label')) editingMeta[i].label = e.target.value;
    if (e.target.classList.contains('meta-value')) editingMeta[i].value = e.target.value;
  });
  fMetaList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act="del"]');
    if (!btn) return;
    const i = parseInt(btn.closest('.metarow').dataset.i, 10);
    editingMeta.splice(i, 1);
    renderMeta();
  });

  /* ── Gallery editor ──────────────────────────── */
  function renderGallery() {
    if (!editingGallery.length) {
      fGallery.innerHTML = `<li class="muted" style="grid-column:1/-1;padding:18px;text-align:center;font-size:13px;">Henüz galeri görseli yok. Aşağıdan ekle.</li>`;
      return;
    }
    fGallery.innerHTML = editingGallery.map((g, i) => `
      <li class="galitem" data-i="${i}">
        <img class="galitem__thumb" src="${escapeHtml(g.url)}" alt="" onerror="this.style.opacity=0.2"/>
        <textarea class="galitem__caption" rows="2" placeholder="Caption (isteğe bağlı)" data-act="caption">${escapeHtml(g.caption)}</textarea>
        <div class="galitem__actions">
          <button type="button" class="galitem__btn" data-act="up"   ${i === 0 ? 'disabled' : ''} title="Yukarı">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7"/></svg>
          </button>
          <button type="button" class="galitem__btn" data-act="down" ${i === editingGallery.length - 1 ? 'disabled' : ''} title="Aşağı">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9l-7 7-7-7"/></svg>
          </button>
          <button type="button" class="galitem__btn galitem__btn--del" data-act="del" title="Sil">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </li>
    `).join('');
  }

  fGallery.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('.galitem');
    const i = parseInt(li.dataset.i, 10);
    const a = btn.dataset.act;
    if (a === 'del') editingGallery.splice(i, 1);
    else if (a === 'up' && i > 0) [editingGallery[i - 1], editingGallery[i]] = [editingGallery[i], editingGallery[i - 1]];
    else if (a === 'down' && i < editingGallery.length - 1) [editingGallery[i], editingGallery[i + 1]] = [editingGallery[i + 1], editingGallery[i]];
    renderGallery();
  });
  fGallery.addEventListener('input', (e) => {
    if (e.target.dataset.act !== 'caption') return;
    const li = e.target.closest('.galitem');
    if (!li) return;
    const i = parseInt(li.dataset.i, 10);
    if (editingGallery[i]) editingGallery[i].caption = e.target.value;
  });

  fGalAdd.addEventListener('click', () => {
    const url = fGalUrl.value.trim();
    if (!url) { fGalUrl.focus(); return; }
    editingGallery.push({ url, caption: '' });
    fGalUrl.value = '';
    renderGallery();
  });
  fGalUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fGalAdd.click(); } });
  fGalUp.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    let oversized = 0;
    files.forEach(file => {
      if (file.size > 1.5 * 1024 * 1024) oversized++;
      const r = new FileReader();
      r.onload = (ev) => {
        editingGallery.push({ url: ev.target.result, caption: '' });
        renderGallery();
      };
      r.readAsDataURL(file);
    });
    if (oversized) toast(`${oversized} görsel 1.5 MB üzerinde — saklama kotanı zorlayabilir`, 'warn');
    e.target.value = '';
  });

  /* ── Save / Delete ───────────────────────────── */
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = readForm();
    if (!data.name) { toast('Proje adı zorunlu', 'error'); fName.focus(); return; }
    if (!data.cover.url) { toast('Kapak görseli zorunlu', 'error'); fCover.focus(); return; }

    if (!content) content = { featured: null, projects: [] };
    if (!Array.isArray(content.projects)) content.projects = [];

    if (editingIsFeatured) {
      content.featured = { ...content.featured, ...data, kicker: (content.featured && content.featured.kicker) || 'Öne Çıkan — 03' };
      toast('Öne çıkan proje güncellendi');
    } else if (editingId) {
      const idx = content.projects.findIndex(p => p.id === editingId);
      if (idx >= 0) {
        content.projects[idx] = { ...content.projects[idx], ...data };
        toast('Proje güncellendi');
      } else {
        content.projects.unshift({ id: editingId, ...data });
        toast('Proje eklendi');
      }
    } else {
      const id = 'proj_' + Date.now();
      content.projects.unshift({ id, ...data });
      toast('Yeni proje eklendi');
    }
    persist();
    closeEditor();
  });

  deleteBtn.addEventListener('click', () => {
    if (!editingId) return;
    if (editingIsFeatured) {
      if (!confirm('Öne çıkan projeyi gerçekten sil? (varsayılana dönmek için "Varsayılana dön"ü kullan)')) return;
      content.featured = null;
    } else {
      if (!confirm('Bu projeyi sil? Galeri görselleri de silinecek.')) return;
      content.projects = content.projects.filter(p => p.id !== editingId);
    }
    persist();
    closeEditor();
    toast('Silindi');
  });

  /* ── Tools (export/import/reset/clear) ───────── */
  exportBtn.addEventListener('click', () => {
    if (!content) { toast('İçerik yok', 'warn'); return; }
    const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'content.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('content.json indirildi · media/ klasörüne yükle');
  });

  importIn.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed || typeof parsed !== 'object') throw new Error('JSON nesne değil');
        content = parsed;
        persist();
        toast('İçe aktarıldı');
      } catch (err) {
        toast('İçe aktarılamadı: ' + err.message, 'error');
      }
    };
    r.readAsText(file);
    importIn.value = '';
  });

  resetBtn.addEventListener('click', async () => {
    if (!confirm('Tüm değişiklikler kaybolur, varsayılan içeriğe dönülür. Devam?')) return;
    if (!defaultContent) defaultContent = await fetchDefault();
    if (!defaultContent) { toast('Varsayılan content.json yüklenemedi', 'error'); return; }
    content = JSON.parse(JSON.stringify(defaultContent));
    persist();
    closeEditor();
    toast('Varsayılana döndürüldü');
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('TÜM proje içeriği silinecek (öne çıkan + arşiv + galeriler). Emin misin?')) return;
    content = { featured: null, projects: [] };
    persist();
    closeEditor();
    toast('Tüm içerik silindi');
  });

  /* ── Boot ─────────────────────────────────────── */
  (async () => {
    /* prefer localStorage; fall back to bundled default */
    const local = readLocal();
    if (local) {
      content = local;
    } else {
      defaultContent = await fetchDefault();
      content = defaultContent ? JSON.parse(JSON.stringify(defaultContent)) : { featured: null, projects: [] };
    }
    /* fetch default in background for "reset" */
    if (!defaultContent) defaultContent = await fetchDefault();
    renderProjectLists();

    /* restore last active tab */
    const lastTab = (() => { try { return localStorage.getItem('strata.adminTab'); } catch (_) { return null; } })();
    const validTab = ['projects', 'social', 'brand', 'contact'].includes(lastTab) ? lastTab : 'projects';
    activate(validTab);
  })();

  /* live update from another tab (e.g. live site visiting admin) */
  window.addEventListener('storage', (e) => {
    if (e.key === CONTENT_KEY) {
      const local = readLocal();
      if (local) { content = local; renderProjectLists(); }
    }
  });
})();


/* ════════════════════════════════════════════════════════════════════
   PUBLISH — push localStorage content + posts to GitHub via /api/publish.
   Vercel sees the new commit and auto-deploys. ~30-60s to live.
   ════════════════════════════════════════════════════════════════════ */
(() => {
  const btn = document.getElementById('publishBtn');
  if (!btn) return;

  const PWD_KEY     = 'strata.publishPwd';   // session-cached password
  const POSTS_KEY   = 'strata.posts';
  const CONTENT_KEY = 'strata.content';
  const TOAST_EL    = document.getElementById('toast');

  function toast(msg, kind) {
    if (!TOAST_EL) { alert(msg); return; }
    TOAST_EL.className = 'toast ' + (kind === 'error' ? 'is-error' : kind === 'warn' ? 'is-warn' : '');
    TOAST_EL.textContent = msg;
    requestAnimationFrame(() => TOAST_EL.classList.add('is-on'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => TOAST_EL.classList.remove('is-on'), 4000);
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function getPassword() {
    let pwd = '';
    try { pwd = sessionStorage.getItem(PWD_KEY) || ''; } catch (_) {}
    if (pwd) return pwd;
    pwd = window.prompt('Yayın şifresi (Vercel ADMIN_PASSWORD):');
    if (pwd) { try { sessionStorage.setItem(PWD_KEY, pwd); } catch (_) {} }
    return pwd;
  }

  async function publish() {
    const password = getPassword();
    if (!password) return;

    const content = readJSON(CONTENT_KEY);
    const posts   = readJSON(POSTS_KEY);

    if (!content && !posts) {
      toast('Yayınlanacak değişiklik yok — önce admin\'de bir şey kaydet', 'warn');
      return;
    }

    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>Gönderiliyor...</span>';

    try {
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, content, posts }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) {
        try { sessionStorage.removeItem(PWD_KEY); } catch (_) {}
        throw new Error(data.error || 'Geçersiz şifre');
      }
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

      const changed = (data.results || []).filter(r => r.changed);
      if (!changed.length) {
        toast('İçerik zaten güncel — yeni commit yok', 'warn');
      } else {
        toast(`✓ Yayında — ${changed.length} dosya gönderildi · Vercel ~30-60s sonra canlı`);
      }
    } catch (err) {
      toast('Yayın başarısız: ' + (err.message || err), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  }

  btn.addEventListener('click', publish);
})();
