'use strict';

const MAX_SRC = 2600;  // côté max de la photo d'origine conservée
const MAX_OUT = 2480;  // côté max d'une page (≈ A4 à 300 dpi)
const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const FILTERS = [
  { id: 'enhance', label: 'Magique' },
  { id: 'original', label: 'Original' },
  { id: 'gray', label: 'Gris' },
  { id: 'bw', label: 'N&B' },
];

const $ = (sel, root = document) => root.querySelector(sel);
const state = { view: 'home', docs: [], doc: null, queue: [], queueTotal: 0, edit: null, pdf: null };
const crop = { s: 1, ox: 0, oy: 0, W: 0, H: 0, drag: -1, dx: 0, dy: 0 };
const urls = { home: [], doc: [] };

// ---------- Utilitaires ----------

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem('clairscan.' + key);
    localStorage.setItem('clairscan.' + key, value);
  } catch { /* stockage indisponible : on ignore */ }
  return null;
}

function trackUrl(group, blob) {
  const u = URL.createObjectURL(blob);
  urls[group].push(u);
  return u;
}

function releaseUrls(group) {
  urls[group].forEach(u => URL.revokeObjectURL(u));
  urls[group] = [];
}

function show(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
}

function busy(msg) {
  $('#busy-msg').textContent = msg || '';
  $('#busy').hidden = !msg;
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Encodage impossible'))), type, quality));
}

async function loadImage(blob, maxSide) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = Scanner.createCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const scripts = {};
function loadScript(src) {
  scripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete scripts[src]; reject(new Error('Chargement impossible : ' + src)); };
    document.head.appendChild(s);
  });
  return scripts[src];
}

function defaultName() {
  const d = new Date();
  return 'Scan ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

// ---------- Accueil ----------

async function renderHome() {
  state.docs = (await DB.all()).sort((a, b) => b.updated - a.updated);
  releaseUrls('home');
  $('#doc-list').innerHTML = state.docs.map(doc => {
    const first = doc.pages[0];
    const img = first ? `<img src="${trackUrl('home', first.thumb)}" alt="">` : '';
    return `<button class="card" data-id="${doc.id}">
      <span class="thumb">${img}</span>
      <span class="info"><strong>${escapeHtml(doc.name)}</strong>
      <small>${plural(doc.pages.length, 'page')} · ${formatDate(doc.updated)}</small></span>
    </button>`;
  }).join('');
  $('#home-empty').hidden = state.docs.length > 0;
}

function goHome() {
  releaseUrls('doc');
  state.doc = null;
  show('home');
  renderHome();
}

function startNew(source) {
  const now = Date.now();
  state.doc = { id: uid(), name: defaultName(), created: now, updated: now, pages: [] };
  pick(source);
}

function pick(source) {
  $(source === 'camera' ? '#in-camera' : '#in-gallery').click();
}

function onFilesPicked(ev) {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  state.queue = files;
  state.queueTotal = files.length;
  nextInQueue();
}

// ---------- Recadrage ----------

async function nextInQueue() {
  const file = state.queue.shift();
  if (!file) {
    if (state.doc && state.doc.pages.length) openDoc(state.doc);
    else goHome();
    return;
  }
  busy(Scanner.isReady() ? 'Détection des bords…' : 'Chargement du moteur de détection…');
  try {
    const src = await loadImage(file, MAX_SRC);
    const detected = await Scanner.detect(src);
    state.edit = {
      src,
      quad: detected || Scanner.fullQuad(src),
      filter: pref('filter') || 'enhance',
      rotation: 0,
      pageId: null,
      originalBlob: null,
    };
    const done = state.queueTotal - state.queue.length;
    $('#crop-counter').textContent = state.queueTotal > 1 ? `${done}/${state.queueTotal}` : '';
    openCrop();
    if (!detected) toast('Bords non détectés : ajustez les coins à la main.');
  } catch (err) {
    console.error(err);
    toast('Impossible de lire cette image.');
    nextInQueue();
  } finally {
    busy();
  }
}

function openCrop() {
  show('crop');
  requestAnimationFrame(layoutCrop);
}

function layoutCrop() {
  const e = state.edit;
  if (!e) return;
  const stage = $('#crop-stage');
  const W = stage.clientWidth, H = stage.clientHeight, pad = 28;
  const s = Math.min((W - pad * 2) / e.src.width, (H - pad * 2) / e.src.height);
  const cw = e.src.width * s, ch = e.src.height * s;
  Object.assign(crop, { s, ox: (W - cw) / 2, oy: (H - ch) / 2, W, H });

  const cv = $('#crop-canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  Object.assign(cv.style, { width: cw + 'px', height: ch + 'px', left: crop.ox + 'px', top: crop.oy + 'px' });
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(e.src, 0, 0, cv.width, cv.height);

  $('#crop-overlay').setAttribute('viewBox', `0 0 ${W} ${H}`);
  drawOverlay();
}

const toScreen = p => ({ x: crop.ox + p.x * crop.s, y: crop.oy + p.y * crop.s });

function drawOverlay() {
  const svg = $('#crop-overlay');
  const pts = state.edit.quad.map(toScreen);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('') + 'Z';
  svg.classList.toggle('invalid', !Scanner.isValidQuad(state.edit.quad));
  svg.innerHTML =
    `<path class="mask" fill-rule="evenodd" d="M0 0H${crop.W}V${crop.H}H0Z${path}"/>` +
    `<path class="quad" d="${path}"/>` +
    pts.map((p, i) => `<circle class="handle${i === crop.drag ? ' active' : ''}" cx="${p.x}" cy="${p.y}" r="12"/>`).join('');
}

function localPoint(ev) {
  const r = $('#crop-overlay').getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function onCropDown(ev) {
  const p = localPoint(ev);
  const pts = state.edit.quad.map(toScreen);
  let best = -1, bestDist = 48;
  pts.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  if (best < 0) return;
  ev.preventDefault();
  crop.drag = best;
  crop.dx = pts[best].x - p.x;
  crop.dy = pts[best].y - p.y;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  moveHandle(p);
}

function onCropMove(ev) {
  if (crop.drag >= 0) moveHandle(localPoint(ev));
}

function onCropUp() {
  if (crop.drag < 0) return;
  crop.drag = -1;
  $('#loupe').style.display = 'none';
  drawOverlay();
}

function moveHandle(p) {
  const e = state.edit;
  const pt = {
    x: clamp((p.x + crop.dx - crop.ox) / crop.s, 0, e.src.width),
    y: clamp((p.y + crop.dy - crop.oy) / crop.s, 0, e.src.height),
  };
  e.quad[crop.drag] = pt;
  drawOverlay();
  drawLoupe(pt);
}

// Loupe : zoom autour du coin déplacé pour un placement précis.
function drawLoupe(pt) {
  const L = 120, zoom = 3;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const loupe = $('#loupe');
  const size = L * dpr;
  if (loupe.width !== size) loupe.width = loupe.height = size;
  const screen = toScreen(pt);
  Object.assign(loupe.style, { display: 'block', left: (screen.x < crop.W / 2 ? crop.W - L - 12 : 12) + 'px' });

  const region = L / (crop.s * zoom);
  const x0 = pt.x - region / 2, y0 = pt.y - region / 2, k = size / region;
  const ctx = loupe.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(state.edit.src, x0, y0, region, region, 0, 0, size, size);

  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  state.edit.quad.forEach((q, i) => ctx[i ? 'lineTo' : 'moveTo']((q.x - x0) * k, (q.y - y0) * k));
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(size / 2, size / 2 - 12 * dpr); ctx.lineTo(size / 2, size / 2 + 12 * dpr);
  ctx.moveTo(size / 2 - 12 * dpr, size / 2); ctx.lineTo(size / 2 + 12 * dpr, size / 2);
  ctx.stroke();
}

async function autoDetect() {
  busy(Scanner.isReady() ? 'Détection des bords…' : 'Chargement du moteur de détection…');
  const quad = await Scanner.detect(state.edit.src);
  busy();
  if (quad) {
    state.edit.quad = quad;
    drawOverlay();
  } else {
    toast('Aucun bord net trouvé.');
  }
}

function skipCurrent() {
  state.edit = null;
  if (state.queue.length) nextInQueue();
  else if (state.doc && state.doc.pages.length) openDoc(state.doc);
  else goHome();
}

// ---------- Filtres ----------

async function goFilter() {
  const e = state.edit;
  if (!Scanner.isValidQuad(e.quad)) {
    toast('Le cadre est croisé : replacez les coins.');
    return;
  }
  busy('Redressement de la page…');
  await nextFrame();
  try {
    e.warped = Scanner.warp(e.src, e.quad, MAX_OUT);
    e.preview = Scanner.resize(e.warped, 1400);
    e.thumbBase = Scanner.resize(e.warped, 160);
    show('filter');
    renderFilterThumbs();
    renderFilter();
  } finally {
    busy();
  }
}

function renderFilter() {
  const e = state.edit;
  const out = Scanner.applyFilter(Scanner.rotate(e.preview, e.rotation), e.filter);
  const cv = $('#filter-canvas');
  cv.width = out.width;
  cv.height = out.height;
  cv.getContext('2d').drawImage(out, 0, 0);
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === e.filter));
}

function renderFilterThumbs() {
  const base = Scanner.rotate(state.edit.thumbBase, state.edit.rotation);
  document.querySelectorAll('.filter-btn').forEach(btn => {
    const out = Scanner.applyFilter(base, btn.dataset.filter);
    const c = btn.querySelector('canvas');
    c.width = out.width;
    c.height = out.height;
    c.getContext('2d').drawImage(out, 0, 0);
  });
}

function rotateEdit(delta) {
  state.edit.rotation = (state.edit.rotation + delta + 4) % 4;
  renderFilterThumbs();
  renderFilter();
}

async function savePage() {
  const e = state.edit;
  const doc = state.doc;
  busy('Enregistrement…');
  await nextFrame();
  try {
    const full = Scanner.applyFilter(Scanner.rotate(e.warped, e.rotation), e.filter);
    const page = {
      id: e.pageId || uid(),
      blob: await toBlob(full, 'image/jpeg', 0.88),
      thumb: await toBlob(Scanner.resize(full, 360), 'image/jpeg', 0.8),
      original: e.originalBlob || await toBlob(e.src, 'image/jpeg', 0.9),
      quad: e.quad,
      filter: e.filter,
      rotation: e.rotation,
      w: full.width,
      h: full.height,
    };
    const idx = doc.pages.findIndex(p => p.id === page.id);
    if (idx >= 0) doc.pages[idx] = page;
    else doc.pages.push(page);
    doc.updated = Date.now();
    await DB.put(doc);
    pref('filter', e.filter);
    navigator.storage?.persist?.();
    state.edit = null;
  } catch (err) {
    console.error(err);
    toast("Échec de l'enregistrement (espace disque ?)");
    return;
  } finally {
    busy();
  }
  if (state.queue.length) nextInQueue();
  else openDoc(doc);
}

// ---------- Document ----------

function openDoc(doc) {
  state.doc = doc;
  show('doc');
  renderDoc();
}

function renderDoc() {
  const doc = state.doc;
  $('#doc-name').value = doc.name;
  releaseUrls('doc');
  const n = doc.pages.length;
  $('#page-grid').innerHTML = doc.pages.map((p, i) => `
    <div class="card" data-index="${i}">
      <button class="thumb" data-act="edit" aria-label="Modifier la page ${i + 1}">
        <img src="${trackUrl('doc', p.thumb)}" alt=""><span class="num">${i + 1}</span>
      </button>
      <div class="page-actions">
        <button class="icon-btn" data-act="left" aria-label="Déplacer avant" ${i === 0 ? 'disabled' : ''}><svg><use href="#i-left"/></svg></button>
        <button class="icon-btn" data-act="edit" aria-label="Modifier"><svg><use href="#i-edit"/></svg></button>
        <button class="icon-btn danger" data-act="del" aria-label="Supprimer"><svg><use href="#i-trash"/></svg></button>
        <button class="icon-btn" data-act="right" aria-label="Déplacer après" ${i === n - 1 ? 'disabled' : ''}><svg><use href="#i-right"/></svg></button>
      </div>
    </div>`).join('');
  $('#btn-export').disabled = n === 0;
}

async function saveDoc() {
  state.doc.updated = Date.now();
  await DB.put(state.doc);
}

async function onPageAction(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const i = Number(btn.closest('.card').dataset.index);
  const pages = state.doc.pages;
  switch (btn.dataset.act) {
    case 'left':
    case 'right': {
      const j = btn.dataset.act === 'left' ? i - 1 : i + 1;
      if (j < 0 || j >= pages.length) return;
      [pages[i], pages[j]] = [pages[j], pages[i]];
      await saveDoc();
      renderDoc();
      break;
    }
    case 'del':
      if (!confirm(`Supprimer la page ${i + 1} ?`)) return;
      pages.splice(i, 1);
      await saveDoc();
      renderDoc();
      break;
    case 'edit':
      editPage(i);
      break;
  }
}

async function editPage(i) {
  const p = state.doc.pages[i];
  busy('Ouverture…');
  try {
    const src = await loadImage(p.original, MAX_SRC);
    state.edit = {
      src,
      quad: p.quad.map(q => ({ ...q })),
      filter: p.filter,
      rotation: p.rotation,
      pageId: p.id,
      originalBlob: p.original,
    };
    state.queue = [];
    state.queueTotal = 0;
    $('#crop-counter').textContent = '';
    openCrop();
  } finally {
    busy();
  }
}

async function deleteDoc() {
  if (!confirm(`Supprimer « ${state.doc.name} » et toutes ses pages ?`)) return;
  await DB.remove(state.doc.id);
  goHome();
}

function renameDoc() {
  const name = $('#doc-name').value.trim() || defaultName();
  $('#doc-name').value = name;
  if (name === state.doc.name) return;
  state.doc.name = name;
  if (state.doc.pages.length) saveDoc();
}

// ---------- Export PDF ----------

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

function openExport() {
  state.pdf = null;
  $('#export-status').textContent = plural(state.doc.pages.length, 'page');
  $('#export-ready').hidden = true;
  $('#btn-make-pdf').hidden = false;
  $('#export-dialog').showModal();
}

async function makePdf() {
  const form = $('#export-dialog form');
  const format = form.elements.format.value;
  const compact = form.elements.size.value === 'compact';
  const status = $('#export-status');
  const makeBtn = $('#btn-make-pdf');
  makeBtn.disabled = true;
  try {
    status.textContent = 'Préparation…';
    await loadScript(JSPDF_URL);
    const { jsPDF } = window.jspdf;
    const pages = state.doc.pages;
    let pdf = null;
    for (const [i, p] of pages.entries()) {
      status.textContent = `Page ${i + 1} sur ${pages.length}…`;
      let blob = p.blob, w = p.w, h = p.h;
      if (compact) {
        const c = await loadImage(p.blob, 1650);
        blob = await toBlob(c, 'image/jpeg', 0.7);
        w = c.width;
        h = c.height;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const landscape = w > h;
      let pw, ph;
      if (format === 'fit') {
        // Le grand côté de la page fait la taille du grand côté d'un A4.
        const k = PAGE_SIZES.a4[1] / Math.max(w, h);
        pw = w * k;
        ph = h * k;
      } else {
        [pw, ph] = PAGE_SIZES[format];
        if (landscape) [pw, ph] = [ph, pw];
      }
      const orientation = landscape ? 'landscape' : 'portrait';
      if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [pw, ph], orientation, compress: true });
      else pdf.addPage([pw, ph], orientation);
      const s = Math.min(pw / w, ph / h);
      pdf.addImage(bytes, 'JPEG', (pw - w * s) / 2, (ph - h * s) / 2, w * s, h * s, 'p' + i, 'NONE');
      await nextFrame();
    }
    pdf.setProperties({ title: state.doc.name, creator: 'ClairScan' });
    const blob = pdf.output('blob');
    const name = state.doc.name.replace(/[\\/:*?"<>|]+/g, '-').trim() + '.pdf';
    state.pdf = new File([blob], name, { type: 'application/pdf' });
    status.textContent = `${name} · ${(blob.size / 1048576).toFixed(1).replace('.', ',')} Mo`;
    $('#btn-share').hidden = !(navigator.canShare && navigator.canShare({ files: [state.pdf] }));
    $('#export-ready').hidden = false;
    makeBtn.hidden = true;
  } catch (err) {
    console.error(err);
    status.textContent = 'La création du PDF a échoué. Vérifiez la connexion au premier usage.';
  } finally {
    makeBtn.disabled = false;
  }
}

async function sharePdf() {
  try {
    await navigator.share({ files: [state.pdf], title: state.doc.name });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Partage impossible.');
  }
}

function downloadPdf() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(state.pdf);
  a.download = state.pdf.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- Démarrage ----------

function init() {
  $('#filter-list').innerHTML = FILTERS.map(f =>
    `<button class="filter-btn" data-filter="${f.id}"><canvas></canvas>${f.label}</button>`).join('');

  $('#btn-new-camera').onclick = () => startNew('camera');
  $('#btn-new-gallery').onclick = () => startNew('gallery');
  $('#doc-list').onclick = ev => {
    const card = ev.target.closest('.card');
    if (card) openDoc(state.docs.find(d => d.id === card.dataset.id));
  };
  $('#in-camera').onchange = onFilesPicked;
  $('#in-gallery').onchange = onFilesPicked;

  const overlay = $('#crop-overlay');
  overlay.addEventListener('pointerdown', onCropDown);
  overlay.addEventListener('pointermove', onCropMove);
  overlay.addEventListener('pointerup', onCropUp);
  overlay.addEventListener('pointercancel', onCropUp);
  $('#btn-crop-back').onclick = skipCurrent;
  $('#btn-crop-auto').onclick = autoDetect;
  $('#btn-crop-full').onclick = () => { state.edit.quad = Scanner.fullQuad(state.edit.src); drawOverlay(); };
  $('#btn-crop-next').onclick = goFilter;
  window.addEventListener('resize', () => { if (state.view === 'crop') layoutCrop(); });

  $('#btn-filter-back').onclick = openCrop;
  $('#btn-rot-left').onclick = () => rotateEdit(-1);
  $('#btn-rot-right').onclick = () => rotateEdit(1);
  $('#filter-list').onclick = ev => {
    const btn = ev.target.closest('.filter-btn');
    if (!btn) return;
    state.edit.filter = btn.dataset.filter;
    renderFilter();
  };
  $('#btn-filter-ok').onclick = savePage;

  $('#btn-doc-back').onclick = goHome;
  $('#btn-doc-delete').onclick = deleteDoc;
  $('#doc-name').addEventListener('change', renameDoc);
  $('#doc-name').addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.target.blur(); });
  $('#page-grid').onclick = onPageAction;
  $('#btn-add-camera').onclick = () => pick('camera');
  $('#btn-add-gallery').onclick = () => pick('gallery');
  $('#btn-export').onclick = openExport;
  $('#btn-make-pdf').onclick = makePdf;
  $('#btn-share').onclick = sharePdf;
  $('#btn-download').onclick = downloadPdf;

  renderHome();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker', err));
  }
  // Le moteur de détection est lourd : on le charge en arrière-plan pour que le premier scan soit rapide.
  setTimeout(() => Scanner.preload(), 1500);
}

init();
