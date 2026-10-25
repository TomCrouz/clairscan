'use strict';
/* Traitement d'image : détection des bords, redressement de perspective, filtres. */
const Scanner = (() => {
  const OPENCV_URL = 'lib/opencv-4.12.0.js';
  let cvPromise = null;
  let cvReady = false;

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ---------- OpenCV (chargé à la demande, uniquement pour la détection) ----------

  function loadOpenCV() {
    if (!cvPromise) {
      cvPromise = new Promise(resolve => {
        const s = document.createElement('script');
        s.src = OPENCV_URL;
        s.async = true;
        const done = cv => { cvReady = true; resolve({ cv }); };
        s.onload = () => {
          const c = window.cv;
          if (!c) return resolve(null);
          if (c.Mat) return done(c);
          // Selon la version, cv est un module « thenable » ou expose onRuntimeInitialized.
          if (typeof c.then === 'function') return c.then(m => done(m));
          c.onRuntimeInitialized = () => done(window.cv);
        };
        s.onerror = () => { cvPromise = null; resolve(null); };
        document.head.appendChild(s);
      });
    }
    return cvPromise;
  }

  async function detect(src) {
    const lib = await Promise.race([loadOpenCV(), wait(25000).then(() => null)]);
    if (!lib) return null;
    try {
      return findQuad(lib.cv, src);
    } catch (err) {
      console.warn('Détection impossible', err);
      return null;
    }
  }

  function matPoints(m) {
    const d = m.data32S;
    const pts = [];
    for (let i = 0; i < m.rows; i++) pts.push({ x: d[i * 2], y: d[i * 2 + 1] });
    return pts;
  }

  function extremeCorners(pts) {
    let tl = pts[0], tr = pts[0], br = pts[0], bl = pts[0];
    for (const p of pts) {
      if (p.x + p.y < tl.x + tl.y) tl = p;
      if (p.x + p.y > br.x + br.y) br = p;
      if (p.x - p.y > tr.x - tr.y) tr = p;
      if (p.x - p.y < bl.x - bl.y) bl = p;
    }
    return [tl, tr, br, bl];
  }

  function findQuad(cv, src) {
    const scale = Math.min(1, 480 / Math.max(src.width, src.height));
    const small = createCanvas(Math.round(src.width * scale), Math.round(src.height * scale));
    small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);

    const mats = [];
    const keep = m => (mats.push(m), m);
    try {
      const rgba = keep(cv.imread(small));
      const gray = keep(new cv.Mat());
      const edges = keep(new cv.Mat());
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      // La fermeture morphologique efface le texte pour ne garder que les bords de la feuille.
      const k9 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
      cv.morphologyEx(gray, gray, cv.MORPH_CLOSE, k9);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 30, 100);
      const k3 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      cv.dilate(edges, edges, k3);

      const contours = keep(new cv.MatVector());
      const hier = keep(new cv.Mat());
      cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const minArea = small.width * small.height * 0.12;
      let best = null, bestArea = 0, big = null, bigArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        if (area >= minArea) {
          const approx = new cv.Mat();
          cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
          if (approx.rows === 4 && cv.isContourConvex(approx) && area > bestArea) {
            bestArea = area;
            best = matPoints(approx);
          }
          approx.delete();
          if (area > bigArea) {
            bigArea = area;
            big = matPoints(c);
          }
        }
        c.delete();
      }
      const pts = best || (big && extremeCorners(big));
      if (!pts) return null;
      const quad = orderQuad(pts.map(p => ({
        x: clamp(p.x / scale, 0, src.width),
        y: clamp(p.y / scale, 0, src.height),
      })));
      return isValidQuad(quad) ? quad : null;
    } finally {
      mats.forEach(m => m.delete());
    }
  }

  // Trie les 4 coins dans l'ordre : haut-gauche, haut-droite, bas-droite, bas-gauche.
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let start = 0;
    sorted.forEach((p, i) => { if (p.x + p.y < sorted[start].x + sorted[start].y) start = i; });
    return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
  }

  function isValidQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-6) return false;
      const s = Math.sign(cross);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return Math.min(dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])) > 20;
  }

  function fullQuad(src) {
    const w = src.width, h = src.height;
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }

  // ---------- Redressement de perspective ----------

  // Homographie qui envoie from[i] sur to[i] (8 coefficients, h33 = 1).
  function homography(from, to) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i];
      const { x: X, y: Y } = to[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      const p = A[col][col];
      for (let k = col; k < 9; k++) A[col][k] /= p;
      for (let r = 0; r < 8; r++) {
        const f = A[r][col];
        if (r !== col && f) for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
      }
    }
    return A.map(r => r[8]);
  }

  function warp(src, quad, maxSide) {
    const [tl, tr, br, bl] = quad;
    const w = Math.max(dist(tl, tr), dist(bl, br));
    const h = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, maxSide / Math.max(w, h));
    const W = Math.max(1, Math.round(w * s));
    const H = Math.max(1, Math.round(h * s));
    const [a, b, c, d, e, f, g, hh] = homography(
      [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], quad);

    const sw = src.width, sh = src.height;
    const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = createCanvas(W, H);
    const octx = out.getContext('2d');
    const img = octx.createImageData(W, H);
    const od = img.data;
    const maxX = sw - 1.001, maxY = sh - 1.001, row = sw * 4;

    let o = 0;
    for (let y = 0; y < H; y++) {
      const v = y + 0.5;
      for (let x = 0; x < W; x++, o += 4) {
        const u = x + 0.5;
        const den = g * u + hh * v + 1;
        let sx = (a * u + b * v + c) / den - 0.5;
        let sy = (d * u + e * v + f) / den - 0.5;
        sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
        sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + row, i11 = i01 + 4;
        for (let k = 0; k < 3; k++) {
          const top = sd[i00 + k] + (sd[i10 + k] - sd[i00 + k]) * fx;
          const bot = sd[i01 + k] + (sd[i11 + k] - sd[i01 + k]) * fx;
          od[o + k] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // ---------- Filtres ----------

  // Estime l'éclairage du fond (maximum local, lissé) pour supprimer ombres et dominantes.
  function background(d, w, h) {
    const block = Math.max(8, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / block), gh = Math.ceil(h / block);
    const grid = new Uint8ClampedArray(gw * gh * 4);
    for (let y = 0; y < h; y++) {
      const gRow = ((y / block) | 0) * gw;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, j = (gRow + ((x / block) | 0)) * 4;
        if (d[i] > grid[j]) grid[j] = d[i];
        if (d[i + 1] > grid[j + 1]) grid[j + 1] = d[i + 1];
        if (d[i + 2] > grid[j + 2]) grid[j + 2] = d[i + 2];
      }
    }
    for (let j = 3; j < grid.length; j += 4) grid[j] = 255;
    const smooth = boxBlur(boxBlur(grid, gw, gh), gw, gh);

    const gc = createCanvas(gw, gh);
    gc.getContext('2d').putImageData(new ImageData(smooth, gw, gh), 0, 0);
    const big = createCanvas(w, h);
    const bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(gc, 0, 0, w, h);
    return bctx.getImageData(0, 0, w, h).data;
  }

  function boxBlur(src, w, h) {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const i = (yy * w + xx) * 4;
            r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
          }
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return out;
  }

  function curve(black, white, gamma) {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      const t = clamp((i - black) / (white - black), 0, 1);
      lut[i] = Math.round(255 * Math.pow(t, gamma));
    }
    return lut;
  }

  const LUTS = {
    enhance: curve(30, 228, 1.15),
    gray: curve(25, 232, 1.2),
    bw: curve(150, 205, 1),
  };

  function applyFilter(canvas, name) {
    if (name === 'original') return canvas;
    const w = canvas.width, h = canvas.height;
    const out = createCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const bg = background(d, w, h);
    const lut = LUTS[name];
    const norm = (c, b) => (b ? Math.min(255, (c * 255 / b) | 0) : 255);

    if (name === 'enhance') {
      for (let i = 0; i < d.length; i += 4) {
        const r = lut[norm(d[i], bg[i])];
        const g = lut[norm(d[i + 1], bg[i + 1])];
        const b = lut[norm(d[i + 2], bg[i + 2])];
        const l = (r * 77 + g * 150 + b * 29) >> 8;
        d[i] = l + (r - l) * 1.3;
        d[i + 1] = l + (g - l) * 1.3;
        d[i + 2] = l + (b - l) * 1.3;
      }
    } else {
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        const lb = (bg[i] * 77 + bg[i + 1] * 150 + bg[i + 2] * 29) >> 8;
        d[i] = d[i + 1] = d[i + 2] = lut[norm(l, lb)];
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  // ---------- Utilitaires ----------

  function rotate(canvas, quarterTurns) {
    const t = ((quarterTurns % 4) + 4) % 4;
    if (!t) return canvas;
    const odd = t % 2 === 1;
    const out = createCanvas(odd ? canvas.height : canvas.width, odd ? canvas.width : canvas.height);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(t * Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }

  // Réduction par étapes successives (meilleure qualité qu'un seul drawImage).
  function resize(canvas, maxSide) {
    let cur = canvas;
    const target = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    if (target >= 1) return canvas;
    const tw = Math.max(1, Math.round(canvas.width * target));
    const th = Math.max(1, Math.round(canvas.height * target));
    while (cur.width / 2 > tw) {
      const half = createCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
      half.getContext('2d').drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    const out = createCanvas(tw, th);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, tw, th);
    return out;
  }

  return {
    preload: loadOpenCV,
    isReady: () => cvReady,
    detect,
    isValidQuad,
    fullQuad,
    warp,
    applyFilter,
    rotate,
    resize,
    createCanvas,
  };
})();
