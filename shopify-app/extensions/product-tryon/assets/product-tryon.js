(function () {
  'use strict';

  function el(root, sel) { return root.querySelector(sel); }

  // ================= keep the shopper's real face =================
  // The AI sometimes subtly changes the face. For products that do not cover the face, the shopper's real face (eyebrows down)
  // is put back on top of the AI picture, but ONLY when the two faces line up well; otherwise the plain AI picture is shown.
  var VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  var MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  var HI_SIDE = 1024;          // size of the shopper's photo kept for the face (sharper than what the AI receives)
  var MERGE_MAX_ERR = 0.10;    // beyond this average landmark mismatch (fraction of face width) the AI drew a different face/pose: no merge
  var OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
  var BROWS = [70,63,105,66,107,300,293,334,296,336];

  var landmarkerPromise = null;
  function getLandmarker() {
    if (window.__PTN_LANDMARKER__) return Promise.resolve(window.__PTN_LANDMARKER__); // test seam
    if (!landmarkerPromise) {
      landmarkerPromise = import(VISION + '/vision_bundle.mjs').then(function (mod) {
        return mod.FilesetResolver.forVisionTasks(VISION + '/wasm').then(function (files) {
          return mod.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, runningMode: 'IMAGE', numFaces: 1 });
        });
      });
      landmarkerPromise.catch(function () { landmarkerPromise = null; });
    }
    return landmarkerPromise;
  }
  function detectFace(c) {
    return Promise.resolve().then(getLandmarker).then(function (lm) { var r = lm.detect(c); return (r.faceLandmarks && r.faceLandmarks[0]) || null; }).catch(function () { return null; });
  }


  // ---------- is the right body part in the photo? (checked on the shopper's device, before any AI call) ----------
  var HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  var handsPromise = null;
  function getHands() {
    if (window.__PTN_HANDS__) return Promise.resolve(window.__PTN_HANDS__); // test seam
    if (!handsPromise) {
      handsPromise = import(VISION + '/vision_bundle.mjs').then(function (mod) {
        return mod.FilesetResolver.forVisionTasks(VISION + '/wasm').then(function (files) {
          return mod.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'IMAGE', numHands: 1 });
        });
      });
      handsPromise.catch(function () { handsPromise = null; });
    }
    return handsPromise;
  }
  // Each returns { state: 'ok', points } | { state: 'none' } (looked, found nothing) | { state: 'unavailable' } (the detector could not run).
  function findFace(c) {
    return Promise.resolve().then(getLandmarker).then(function (lm) {
      var r = lm.detect(c), L = r.faceLandmarks && r.faceLandmarks[0];
      return L ? { state: 'ok', points: L } : { state: 'none' };
    }).catch(function () { return { state: 'unavailable' }; });
  }
  function findHand(c) {
    return Promise.resolve().then(getHands).then(function (hm) {
      var r = hm.detect(c), P = r.landmarks && r.landmarks[0];
      return P ? { state: 'ok', points: P } : { state: 'none' };
    }).catch(function () { return { state: 'unavailable' }; });
  }

  var MSG = {
    face: 'We could not find a face in that photo. Please use a clear, front-facing photo with your whole face in view.',
    small: 'Your face looks very small in this photo. Please move closer or use a closer photo.',
    ears: 'Your ears are cut off in this photo. Please use a photo that shows both ears.',
    neck: 'We cannot see enough of your neck and shoulders. Please use a photo that shows your neck and shoulders.',
    hand: 'We could not find a hand or wrist in that photo. This product needs a photo of your wrist and hand (a face photo will not work).',
    wrist: 'Your wrist is cut off in this photo. Please show your whole wrist and hand.',
    fingers: 'Your fingers are cut off in this photo. Please show your whole hand with the fingers visible.'
  };

  // What the product needs the photo to show: face | ears | neck | wrist | hand. Resolves { ok, face?, msg? }.
  // If the detector cannot run (blocked, offline) the shopper is never stopped: ok is true.
  function checkPhoto(needs, c) {
    if (needs === 'wrist' || needs === 'hand') {
      return findHand(c).then(function (h) {
        if (h.state === 'unavailable') return { ok: true };
        if (h.state === 'none') return { ok: false, msg: MSG.hand };
        var P = h.points, inFrame = function (i) { return P[i].x > 0.01 && P[i].x < 0.99 && P[i].y > 0.01 && P[i].y < 0.99; };
        if (needs === 'wrist' && !inFrame(0)) return { ok: false, msg: MSG.wrist };
        if (needs === 'hand' && ![4, 8, 12, 16, 20].every(inFrame)) return { ok: false, msg: MSG.fingers };
        return { ok: true };
      });
    }
    return findFace(c).then(function (f) {
      if (f.state === 'unavailable') return { ok: true };
      if (f.state === 'none') return { ok: false, msg: MSG.face };
      var L = f.points, w = Math.abs(L[454].x - L[234].x), h = L[152].y - L[10].y;
      if (w < 0.14) return { ok: false, msg: MSG.small };
      if (needs === 'ears' && (L[234].x < 0.01 || L[454].x > 0.99)) return { ok: false, msg: MSG.ears };
      if (needs === 'neck' && L[152].y + 0.35 * h > 0.99) return { ok: false, msg: MSG.neck };
      return { ok: true, face: L };
    });
  }

  // Affine transform mapping three source points onto three destination points: [a,b,c,d,e,f] for canvas setTransform.
  function solveAffine(S, D) {
    var M = [[S[0][0], S[0][1], 1], [S[1][0], S[1][1], 1], [S[2][0], S[2][1], 1]];
    function solve(rhs) {
      var A = M.map(function (r, i) { return r.concat(rhs[i]); });
      for (var i = 0; i < 3; i++) {
        var p = i;
        for (var r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        var t = A[i]; A[i] = A[p]; A[p] = t;
        if (Math.abs(A[i][i]) < 1e-9) return null;
        for (var r2 = i + 1; r2 < 3; r2++) { var f = A[r2][i] / A[i][i]; for (var c = i; c < 4; c++) A[r2][c] -= f * A[i][c]; }
      }
      var x = [0, 0, 0];
      for (var i2 = 2; i2 >= 0; i2--) { var s = A[i2][3]; for (var c2 = i2 + 1; c2 < 3; c2++) s -= A[i2][c2] * x[c2]; x[i2] = s / A[i2][i2]; }
      return x;
    }
    var X = solve(D.map(function (p) { return p[0]; })), Y = solve(D.map(function (p) { return p[1]; }));
    if (!X || !Y) return null;
    return [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
  }

  // The face to keep: the face oval, cut off at the eyebrows (so hair, fringe and hats stay AI-made), pulled in a little.
  function facePolygon(L, w, h) {
    var topY = L[10].y * h, chinY = L[152].y * h, faceH = chinY - topY;
    var browY = Math.min.apply(null, BROWS.map(function (i) { return L[i].y * h; }));
    var cut = browY - 0.03 * faceH;
    var pts = OVAL.map(function (i) { return [L[i].x * w, Math.max(L[i].y * h, cut)]; });
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= pts.length; cy /= pts.length;
    return pts.map(function (p) { return [cx + (p[0] - cx) * 0.94, cy + (p[1] - cy) * 0.94]; });
  }

  // Feathered mask using the shadow trick (works in Safari, unlike ctx.filter).
  function softMask(w, h, poly, blur) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'), OFF = w + blur * 4;
    x.shadowColor = '#000'; x.shadowBlur = blur; x.shadowOffsetX = OFF; x.fillStyle = '#000';
    x.beginPath();
    poly.forEach(function (p, i) { if (i) x.lineTo(p[0] - OFF, p[1]); else x.moveTo(p[0] - OFF, p[1]); });
    x.closePath(); x.fill();
    return c;
  }

  function meanRGB(ctx, cx, cy, r) {
    var x = Math.max(0, Math.round(cx - r)), y = Math.max(0, Math.round(cy - r)), s = Math.max(2, Math.round(r * 2));
    var d = ctx.getImageData(x, y, s, s).data, n = 0, a = 0, b = 0, c = 0;
    for (var i = 0; i < d.length; i += 4) { if (d[i + 3] < 250) continue; a += d[i]; b += d[i + 1]; c += d[i + 2]; n++; }
    return n ? [a / n, b / n, c / n] : null;
  }

  // Points of the face mesh used to warp the real face onto the AI's face shape (outline, brows, eyes, nose, mouth, cheeks).
  var MESH = OVAL.concat(BROWS, [33,133,159,145,263,362,386,374, 1,2,98,327,168,6,195,5, 61,291,0,17,13,14,37,267,84,314,78,308, 50,280,205,425,116,345,117,346]);
  MESH = MESH.filter(function (v, i) { return MESH.indexOf(v) === i; });

  // Delaunay triangulation (Bowyer-Watson) of a few dozen points. Returns triples of point indexes.
  function delaunay(pts) {
    var n = pts.length, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    pts.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); });
    var m = Math.max(maxX - minX, maxY - minY, 1), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    var P = pts.concat([[cx - 20 * m, cy - m], [cx, cy + 20 * m], [cx + 20 * m, cy - m]]);
    var tris = [[n, n + 1, n + 2]];
    function inCircle(p, a, b, c) {
      var ax = a[0] - p[0], ay = a[1] - p[1], bx = b[0] - p[0], by = b[1] - p[1], cx2 = c[0] - p[0], cy2 = c[1] - p[1];
      var det = (ax * ax + ay * ay) * (bx * cy2 - cx2 * by) - (bx * bx + by * by) * (ax * cy2 - cx2 * ay) + (cx2 * cx2 + cy2 * cy2) * (ax * by - bx * ay);
      var orient = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      return orient > 0 ? det > 0 : det < 0;
    }
    for (var i = 0; i < n; i++) {
      var bad = [], keep = [];
      tris.forEach(function (t) { (inCircle(P[i], P[t[0]], P[t[1]], P[t[2]]) ? bad : keep).push(t); });
      var edges = {};
      bad.forEach(function (t) {
        [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(function (e) {
          var k = Math.min(e[0], e[1]) + '_' + Math.max(e[0], e[1]);
          edges[k] = edges[k] ? null : e;
        });
      });
      Object.keys(edges).forEach(function (k) { if (edges[k]) keep.push([edges[k][0], edges[k][1], i]); });
      tris = keep;
    }
    return tris.filter(function (t) { return t[0] < n && t[1] < n && t[2] < n; });
  }

  // Put the real face back onto the AI picture. photo: canvas with the shopper's photo. aiImg: AI result (image or canvas).
  // LP / LA: face landmarks of each. The real face is WARPED onto the AI's face shape (piece by piece), so small changes the AI made
  // to the head shape or pose do not matter. Returns a canvas, or null only when the faces differ too much to match at all.
  function mergeFace(photo, aiImg, LP, LA) {
    var aw = aiImg.naturalWidth || aiImg.width, ah = aiImg.naturalHeight || aiImg.height;
    var k = Math.max(1, HI_SIDE / Math.max(aw, ah));
    var ow = Math.round(aw * k), oh = Math.round(ah * k);
    var anchors = function (L, w, h) {
      return [[L[33].x * w, L[33].y * h], [L[263].x * w, L[263].y * h], [((L[13].x + L[14].x) / 2) * w, ((L[13].y + L[14].y) / 2) * h]];
    };
    var T = solveAffine(anchors(LP, photo.width, photo.height), anchors(LA, ow, oh));
    if (!T) return null;

    // Sanity gate: after the simple alignment, how far off is the AI's face? A little is fixed by the warp; a lot means the AI drew
    // a different face or pose, and nothing sensible can be pasted.
    var aFaceW = Math.hypot((LA[454].x - LA[234].x) * ow, (LA[454].y - LA[234].y) * oh) || 1, err = 0;
    var check = [1, 152, 10, 234, 454, 61, 291];
    check.forEach(function (i) {
      var x = LP[i].x * photo.width, y = LP[i].y * photo.height;
      err += Math.hypot(T[0] * x + T[2] * y + T[4] - LA[i].x * ow, T[1] * x + T[3] * y + T[5] - LA[i].y * oh);
    });
    if (err / check.length / aFaceW > MERGE_MAX_ERR) return null;

    var out = document.createElement('canvas'); out.width = ow; out.height = oh;
    var o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(aiImg, 0, 0, ow, oh);

    // Warp: same triangles on both faces; each triangle of the real photo is drawn onto the matching triangle of the AI face.
    var src = MESH.map(function (i) { return [LP[i].x * photo.width, LP[i].y * photo.height]; });
    var dst = MESH.map(function (i) { return [LA[i].x * ow, LA[i].y * oh]; });
    var f = document.createElement('canvas'); f.width = ow; f.height = oh;
    var fc = f.getContext('2d');
    fc.imageSmoothingQuality = 'high';
    delaunay(src).forEach(function (t) {
      var S = [src[t[0]], src[t[1]], src[t[2]]], D = [dst[t[0]], dst[t[1]], dst[t[2]]];
      var A = solveAffine(S, D);
      if (!A) return;
      var cx = (D[0][0] + D[1][0] + D[2][0]) / 3, cy = (D[0][1] + D[1][1] + D[2][1]) / 3;
      fc.save();
      fc.beginPath();
      D.forEach(function (p, i) { // grown by under a pixel so neighbouring triangles leave no hairline gaps
        var dx = p[0] - cx, dy = p[1] - cy, len = Math.hypot(dx, dy) || 1, q = [p[0] + (dx / len) * 0.8, p[1] + (dy / len) * 0.8];
        if (i) fc.lineTo(q[0], q[1]); else fc.moveTo(q[0], q[1]);
      });
      fc.closePath();
      fc.clip();
      fc.setTransform(A[0], A[1], A[2], A[3], A[4], A[5]);
      fc.drawImage(photo, 0, 0);
      fc.restore();
    });

    var poly = facePolygon(LA, ow, oh);
    var faceW = aFaceW;

    // Match skin tone to the AI picture around the cheeks so the join is not visible.
    try {
      var r = Math.max(4, faceW * 0.05), gain = [0, 0, 0], got = 0;
      [50, 280].forEach(function (i) {
        var a = meanRGB(o, LA[i].x * ow, LA[i].y * oh, r), b = meanRGB(fc, LA[i].x * ow, LA[i].y * oh, r);
        if (a && b) { for (var c = 0; c < 3; c++) gain[c] += a[c] / Math.max(1, b[c]); got++; }
      });
      if (got) {
        gain = gain.map(function (g) { return Math.min(1.25, Math.max(0.8, g / got)); });
        var xs = poly.map(function (p) { return p[0]; }), ys = poly.map(function (p) { return p[1]; });
        var bx = Math.max(0, Math.floor(Math.min.apply(null, xs) - 8)), by = Math.max(0, Math.floor(Math.min.apply(null, ys) - 8));
        var bw = Math.min(ow - bx, Math.ceil(Math.max.apply(null, xs) - bx + 8)), bh = Math.min(oh - by, Math.ceil(Math.max.apply(null, ys) - by + 8));
        var img = fc.getImageData(bx, by, bw, bh), d = img.data;
        for (var i2 = 0; i2 < d.length; i2 += 4) { d[i2] = Math.min(255, d[i2] * gain[0]); d[i2 + 1] = Math.min(255, d[i2 + 1] * gain[1]); d[i2 + 2] = Math.min(255, d[i2 + 2] * gain[2]); }
        fc.putImageData(img, bx, by);
      }
    } catch (e) { /* tone match is optional */ }

    var mask = softMask(ow, oh, poly, Math.max(4, faceW * 0.06));
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(mask, 0, 0);
    fc.globalCompositeOperation = 'source-over';
    o.drawImage(f, 0, 0);
    return out;
  }

  if (typeof globalThis !== 'undefined' && globalThis.__PTN_TEST__) {
    globalThis.__PTN_TEST__.mergeFace = mergeFace;
    globalThis.__PTN_TEST__.solveAffine = solveAffine;
    globalThis.__PTN_TEST__.delaunay = delaunay;
    globalThis.__PTN_TEST__.checkPhoto = checkPhoto;
  }

  function loadImg(src) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('The preview image could not be loaded.')); };
      img.src = src;
    });
  }

  function init(root) {
    if (root.dataset.ready) return;
    root.dataset.ready = '1';

    var api = (root.dataset.api || '').replace(/\/$/, '');
    var shop = root.dataset.shop, handle = root.dataset.handle, hint = root.dataset.category || '';
    var consent = el(root, '.ptn-consent-box'), status = el(root, '.ptn-status'), stage = el(root, '.ptn-stage');
    var result = el(root, '.ptn-result'), toggle = el(root, '.ptn-toggle'), regen = el(root, '.ptn-regen'), download = el(root, '.ptn-download');
    var selfieBtn = el(root, '.ptn-selfie'), cam = el(root, '.ptn-camera'), video = el(root, '.ptn-video');
    var snap = el(root, '.ptn-snap'), camClose = el(root, '.ptn-cam-close'), selfieFile = el(root, '.ptn-selfie-file');
    var label = el(root, '.ptn-btn-label'), hintEl = el(root, '.ptn-hint'), keepWrap = el(root, '.ptn-keep'), keepBox = el(root, '.ptn-keepface'), anyway = el(root, '.ptn-anyway');

    var info = null;        // what the server says about this product
    var photoUrl = null;    // the shopper's own photo (data URL) for the compare toggle
    var small = null;       // the photo as sent to the AI
    var hi = null, LP = null;  // the shopper's photo at face-quality size, and its face landmarks
    var resultUrl = null, mergedUrl = null, shownOriginal = false, lastVariant = null, busy = false, camStream = null;

    // ---- which variant is selected? (the shopper can change it at any time) ----
    function currentVariant() {
      var p = new URLSearchParams(location.search).get('variant');
      if (p) return p;
      var f = document.querySelector('form[action*="/cart/add"] [name="id"]');
      return (f && f.value) || root.dataset.variant || '';
    }

    function setBusy(b) { busy = b; root.classList.toggle('ptn-busy', b); }
    function say(t) { status.textContent = t || ''; }

    // ---- ask the server what this product is (category, supported or not) ----
    function loadInfo() {
      var q = new URLSearchParams({ shop: shop, handle: handle, variant: currentVariant() });
      if (hint) q.set('category', hint);
      return fetch(api + '/api/product?' + q).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (x) {
        if (!x.ok) throw new Error(x.j && x.j.error || 'The try-on is not available right now.');
        return x.j;
      });
    }

    function boot() {
      loadInfo().then(function (j) {
        info = j;
        if (!j.tryable) {
          if (window.Shopify && window.Shopify.designMode) { root.hidden = false; say('Theme editor note: ' + (j.reason || 'this product cannot be tried on.') + ' (Set the product metafield custom.tryon_category to force a category.)'); }
          return; // not a wearable: show nothing to shoppers
        }
        if (label && j.category && (!root.dataset.label || root.dataset.label === 'Choose photo')) label.textContent = 'Choose photo to try on ' + (j.category.label || '');
        if (hintEl && j.photoHint) { hintEl.textContent = j.photoHint; hintEl.hidden = false; }
        root.hidden = false;
      }).catch(function (e) {
        if (window.Shopify && window.Shopify.designMode) { root.hidden = false; say('Theme editor note: ' + e.message); }
      });
    }

    // ---- photo handling ----
    // Halve repeatedly with high-quality smoothing, so eyes and hairline stay sharp in the smaller copy.
    function downscale(src, tw, th) {
      var cur = src, cw = src.width, ch = src.height;
      while (cw / 2 >= tw && ch / 2 >= th) {
        var nw = Math.round(cw / 2), nh = Math.round(ch / 2);
        var t = document.createElement('canvas'); t.width = nw; t.height = nh;
        var tx = t.getContext('2d'); tx.imageSmoothingQuality = 'high'; tx.drawImage(cur, 0, 0, nw, nh);
        cur = t; cw = nw; ch = nh;
      }
      var out = document.createElement('canvas'); out.width = tw; out.height = th;
      var ox = out.getContext('2d'); ox.imageSmoothingQuality = 'high'; ox.drawImage(cur, 0, 0, tw, th);
      return out;
    }

    function readPhoto(file, maxSide) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
        var full = document.createElement('canvas'); full.width = bmp.width; full.height = bmp.height;
        full.getContext('2d').drawImage(bmp, 0, 0); // re-encoding also strips EXIF / location data
        var sized = function (side) {
          var k = Math.min(1, side / Math.max(bmp.width, bmp.height));
          var w = Math.max(64, Math.round(bmp.width * k)), h = Math.max(64, Math.round(bmp.height * k));
          return k < 1 ? downscale(full, w, h) : full;
        };
        var c = sized(maxSide), hiC = sized(HI_SIDE);
        var url = c.toDataURL('image/jpeg', 0.95);
        return { url: hiC.toDataURL('image/jpeg', 0.92), hi: hiC, payload: { mime: 'image/jpeg', data: url.split(',')[1], width: c.width, height: c.height } };
      });
    }

    function showImage(url) { result.src = url; }

    function run() {
      if (busy || !small || !info) return;
      var variant = currentVariant();
      setBusy(true);
      regen.hidden = true;
      say('Styling your preview… this can take up to a minute.');
      fetch(api + '/api/tryon', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop: shop, handle: handle, variantId: variant, image: small, consent: true, category: hint || undefined }),
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (!x.ok) throw new Error(x.j.error || 'Something went wrong. Please try again.');
          resultUrl = 'data:' + x.j.image.mime + ';base64,' + x.j.image.data;
          lastVariant = variant;
          shownOriginal = false;
          toggle.textContent = 'Show my original photo';
          mergedUrl = null;
          var wantFace = Boolean(info.keepFace && x.j.keepFace !== false && LP && hi);
          return (wantFace ? finishWithFace(resultUrl) : Promise.resolve(false)).then(function (merged) {
            keepWrap.hidden = !wantFace;
            render();
            stage.hidden = false;
            var what = x.j.label || 'this product';
            if (merged) say('AI preview of ' + what + '. Your real face is kept exactly as in your photo; the rest is AI-made.');
            else if (info.keepFace && x.j.keepFace !== false && !LP) say('AI preview of ' + what + '. We could not find your face in the photo (or the face finder could not load), so the face may differ slightly. A clear, front-facing photo works best.');
            else if (wantFace) say('AI preview of ' + what + '. We could not line your face up exactly, so the plain AI picture is shown.');
            else say('AI preview of ' + what + ' on you.');
          });
        })
        .catch(function (e) { say(e.message); })
        .then(function () { setBusy(false); });
    }

    function render() { showImage(shownOriginal ? photoUrl : (keepBox.checked && mergedUrl) ? mergedUrl : resultUrl); }

    // Find the face in the AI picture, and if it lines up with the real one, build the version with the real face kept.
    function finishWithFace(aiUrl) {
      return loadImg(aiUrl).then(function (aiImg) {
        var a = document.createElement('canvas'); a.width = aiImg.naturalWidth; a.height = aiImg.naturalHeight;
        a.getContext('2d').drawImage(aiImg, 0, 0);
        return detectFace(a).then(function (LA) {
          if (!LA) return false;
          var m;
          try { m = mergeFace(hi, aiImg, LP, LA); } catch (e) { m = null; }
          if (!m) return false;
          mergedUrl = m.toDataURL('image/jpeg', 0.95);
          return true;
        });
      }).catch(function () { return false; });
    }

    function loadFile(file) {
      if (!file) return;
      if (!consent.checked) { say('Please tick the box above first.'); return; }
      if (!info) { say('One moment, the try-on is still loading.'); return; }
      say('Loading your photo…');
      if (anyway) anyway.hidden = true;
      readPhoto(file, info.maxPersonSide || 480).then(function (p) {
        small = p.payload; photoUrl = p.url; hi = p.hi; LP = null;
        say('Checking your photo…');
        return checkPhoto(info.needs || 'face', hi).then(function (r) {
          if (r.face) LP = r.face;
          if (r.ok) return true;
          say(r.msg);                       // no AI call is spent on a photo that cannot work...
          if (anyway) anyway.hidden = false; // ...but the shopper can still go ahead if the checker got it wrong
          return false;
        });
      }).then(function (go) { if (go) run(); }).catch(function () { say('Sorry, that image could not be loaded.'); });
    }

    root.querySelectorAll('.ptn-file').forEach(function (inp) {
      inp.addEventListener('change', function () { loadFile(inp.files && inp.files[0]); inp.value = ''; });
    });

    // ---- selfie camera ----
    function stopCam() {
      if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
      if (video) video.srcObject = null;
      if (cam) cam.hidden = true;
    }
    selfieBtn.addEventListener('click', function () {
      if (!consent.checked) { say('Please tick the box above first.'); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { selfieFile.click(); return; }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false }).then(function (s) {
        camStream = s; video.srcObject = s; cam.hidden = false;
        var pr = video.play && video.play(); if (pr && pr.catch) pr.catch(function () {});
        say('Look at the camera and press Capture.');
      }).catch(function () { camStream = null; say('The camera is not available. Please use Choose photo instead.'); });
    });
    snap.addEventListener('click', function () {
      var w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) { say('The camera is still starting. Try again in a second.'); return; }
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      stopCam();
      c.toBlob(function (b) { if (b) loadFile(b); }, 'image/jpeg', 0.95);
    });
    camClose.addEventListener('click', function () { stopCam(); say(''); });
    window.addEventListener('pagehide', stopCam);

    // ---- result controls ----
    toggle.addEventListener('click', function () {
      shownOriginal = !shownOriginal;
      render();
      toggle.textContent = shownOriginal ? 'Show the preview' : 'Show my original photo';
    });
    regen.addEventListener('click', run);
    if (anyway) anyway.addEventListener('click', function () { anyway.hidden = true; run(); });
    keepBox.addEventListener('change', function () { shownOriginal = false; toggle.textContent = 'Show my original photo'; render(); });
    download.addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = (keepBox.checked && mergedUrl) ? mergedUrl : resultUrl; a.download = 'tryon-preview.jpg';
      document.body.appendChild(a); a.click(); a.remove();
    });

    // When the shopper picks another colour/size after a preview, offer a new preview (each one costs an AI call, so it is not automatic).
    setInterval(function () {
      if (busy || !resultUrl) return;
      var changed = currentVariant() !== lastVariant;
      if (regen.hidden === changed) regen.hidden = !changed;
    }, 600);

    boot();
  }

  function bootAll() { document.querySelectorAll('.ptn').forEach(init); }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAll); else bootAll();
    document.addEventListener('shopify:section:load', bootAll);
  }
})();
