/* ==========================================================================
   ACRE — profile photos
   Lets a logged-in user upload, change or remove their own profile photo.
   Photos are resized in the browser to a 160×160 JPEG (~10 KB), kept in
   localStorage and, when Firebase is connected, shared through
   Firestore document settings/profile_photos so every device sees them.
   ========================================================================== */
(function () {
  'use strict';
  var KEY = 'acre_profile_photos_v1';
  var SIZE = 160;
  var photos = {};
  try { photos = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { photos = {}; }

  function me() { try { return currentUser || null; } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(photos)); } catch (e) {} }
  function toast(m) { try { showToast(m); } catch (e) {} }
  function initials(name) {
    var p = String(name || '').replace(/\(.*?\)/g, '').trim().split(/[\s./-]+/).filter(Boolean);
    if (!p.length) return '–';
    return ((p[0].charAt(0) || '') + (p[1] ? p[1].charAt(0) : (p[0].charAt(1) || ''))).toUpperCase();
  }
  window.acreGetPhoto = function (userId) { return photos[userId] || null; };

  /* ---------- cloud ---------- */
  function db() { try { return firebaseDb || null; } catch (e) { return null; } }
  var subscribed = false;
  function subscribe() {
    var d = db();
    if (!d || subscribed) return;
    subscribed = true;
    try {
      d.collection('settings').doc('profile_photos').onSnapshot(function (snap) {
        if (!snap || !snap.exists) return;
        var remote = (snap.data() || {}).photos || {};
        photos = remote; save(); paint();
      }, function () {});
    } catch (e) { subscribed = false; }
  }
  setInterval(subscribe, 3000);
  function pushCloud(userId, dataUrl) {
    var d = db();
    if (!d) return;
    try {
      var upd = {}; upd['photos.' + userId] = dataUrl === null ? firebase.firestore.FieldValue.delete() : dataUrl;
      var ref = d.collection('settings').doc('profile_photos');
      ref.update(upd).catch(function () {
        var body = { photos: {} }; if (dataUrl) body.photos[userId] = dataUrl;
        return ref.set(body, { merge: true });
      });
    } catch (e) {}
  }

  /* ---------- image processing ---------- */
  function resize(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('type')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(img.width, img.height), sx = (img.width - s) / 2, sy = (img.height - s) / 2;
        var c = document.createElement('canvas'); c.width = c.height = SIZE;
        var ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, sx, sy, s, s, 0, 0, SIZE, SIZE);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }

  /* ---------- position & zoom editor ----------
     The square crop is chosen by dragging the photo and zooming. The source photo
     (longest edge 800 px) and the chosen position are kept so it can be adjusted later. */
  var SRC_KEY = 'acre_profile_photo_src_v1';
  var sources = {};
  try { sources = JSON.parse(localStorage.getItem(SRC_KEY) || '{}') || {}; } catch (e) { sources = {}; }
  function saveSources() { try { localStorage.setItem(SRC_KEY, JSON.stringify(sources)); } catch (e) { /* storage full: keep in memory */ } }
  function srcDocId(userId) { return 'photo_src_' + String(userId).replace(/[^A-Za-z0-9_-]/g, '_'); }
  function pushSource(userId, rec) {
    var d = db(); if (!d) return;
    try {
      var ref = d.collection('settings').doc(srcDocId(userId));
      (rec ? ref.set({ src: rec.src, crop: rec.crop, updatedAt: new Date().toISOString() }) : ref.delete()).catch(function () {});
    } catch (e) {}
  }
  function loadSource(userId) {
    if (sources[userId]) return Promise.resolve(sources[userId]);
    var d = db(); if (!d) return Promise.resolve(null);
    return d.collection('settings').doc(srcDocId(userId)).get().then(function (snap) {
      if (!snap.exists) return null;
      var v = snap.data(); sources[userId] = { src: v.src, crop: v.crop }; saveSources(); return sources[userId];
    }).catch(function () { return null; });
  }
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('type')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, 800 / Math.max(img.width, img.height));
        var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        var ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }

  var CROP_CSS = '.fx-crop{position:fixed;inset:0;z-index:2147482500;background:rgba(17,24,39,.4);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:Inter,"IBM Plex Sans Thai",system-ui,sans-serif;color:#111827}' +
    '.fx-crop-card{width:100%;max-width:360px;background:#FEFEFD;border:1px solid #E5E7EB;border-radius:12px;padding:20px;box-sizing:border-box;box-shadow:0 16px 40px rgba(17,24,39,.14)}' +
    '.fx-crop-card h3{margin:0 0 4px;font-size:16px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}' +
    '.fx-crop-card p{margin:0 0 16px;font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:.02em}' +
    '.fx-crop-view{position:relative;width:240px;height:240px;margin:0 auto;border-radius:16px;overflow:hidden;background:#EEF0F2;cursor:grab;touch-action:none;user-select:none;outline:none}' +
    '.fx-crop-view:focus-visible{box-shadow:0 0 0 2px #FEFEFD,0 0 0 4px #111827}' +
    '.fx-crop-view.is-drag{cursor:grabbing}' +
    '.fx-crop-view img{position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;pointer-events:none;will-change:transform}' +
    '.fx-crop-view::after{content:"";position:absolute;inset:0;border-radius:16px;box-shadow:inset 0 0 0 1px rgba(17,24,39,.08);pointer-events:none}' +
    '.fx-crop-zoom{display:flex;align-items:center;gap:10px;margin:16px 4px 0;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.04em}' +
    '.fx-crop-zoom input{flex:1;accent-color:#111827}' +
    '.fx-crop-act{display:flex;gap:8px;margin-top:20px}' +
    '.fx-crop-act button{flex:1;height:40px;border-radius:8px;font:600 12px/1 Inter,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}' +
    '.fx-crop-act .is-quiet{background:#FEFEFD;color:#111827;border:1px solid #E5E7EB}.fx-crop-act .is-quiet:hover{background:#EEF0F2}' +
    '.fx-crop-act .is-main{background:#111827;color:#FEFEFD;border:1px solid #111827}.fx-crop-act .is-main:hover{background:#1F2937}' +
    '.fx-crop-act button:focus-visible{outline:2px solid #111827;outline-offset:2px}';

  // opens the editor on a source photo; resolves { photo (160 px), crop } or null when cancelled
  function editCrop(src, crop) {
    return new Promise(function (resolve) {
      if (!document.getElementById('fxCropCss')) { var st = document.createElement('style'); st.id = 'fxCropCss'; st.textContent = CROP_CSS; document.head.appendChild(st); }
      var V = 240;
      var wrap = document.createElement('div');
      wrap.className = 'fx-crop no-case'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Adjust photo');
      wrap.innerHTML = '<div class="fx-crop-card"><h3>Adjust photo</h3><p>Drag to move. Zoom to fit.</p>' +
        '<div class="fx-crop-view" tabindex="0" aria-label="Photo position. Use arrow keys to move, plus and minus to zoom."><img alt=""></div>' +
        '<label class="fx-crop-zoom">Zoom<input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom"></label>' +
        '<div class="fx-crop-act"><button type="button" class="is-quiet" data-a="cancel">Cancel</button><button type="button" class="is-main" data-a="save">Save</button></div></div>';
      document.body.appendChild(wrap);
      var view = wrap.querySelector('.fx-crop-view'), img = view.querySelector('img'), range = wrap.querySelector('input[type=range]');
      var w = 0, h = 0, s0 = 1, z = 1, ox = 0, oy = 0;
      function scale() { return s0 * z; }
      function clamp() { var W = w * scale(), H = h * scale(); ox = Math.min(0, Math.max(V - W, ox)); oy = Math.min(0, Math.max(V - H, oy)); }
      function draw() { clamp(); img.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + scale() + ')'; }
      function zoomTo(nz, px, py) {
        nz = Math.min(4, Math.max(1, nz));
        px = px == null ? V / 2 : px; py = py == null ? V / 2 : py;
        var ix = (px - ox) / scale(), iy = (py - oy) / scale();
        z = nz; ox = px - ix * scale(); oy = py - iy * scale();
        range.value = String(z); draw();
      }
      img.onload = function () {
        w = img.naturalWidth; h = img.naturalHeight; s0 = V / Math.min(w, h);
        img.style.width = w + 'px'; img.style.height = h + 'px';
        z = crop && crop.z ? Math.min(4, Math.max(1, crop.z)) : 1; range.value = String(z);
        var cx = crop && crop.cx != null ? crop.cx * w : w / 2, cy = crop && crop.cy != null ? crop.cy * h : h / 2;
        ox = V / 2 - cx * scale(); oy = V / 2 - cy * scale(); draw();
        view.focus();
      };
      img.src = src;
      var drag = null;
      view.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, ox: ox, oy: oy }; view.setPointerCapture(e.pointerId); view.classList.add('is-drag'); });
      view.addEventListener('pointermove', function (e) { if (!drag) return; ox = drag.ox + (e.clientX - drag.x); oy = drag.oy + (e.clientY - drag.y); draw(); });
      function end() { drag = null; view.classList.remove('is-drag'); }
      view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
      view.addEventListener('wheel', function (e) {
        e.preventDefault();
        var r = view.getBoundingClientRect();
        zoomTo(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      range.addEventListener('input', function () { zoomTo(parseFloat(range.value)); });
      view.addEventListener('keydown', function (e) {
        var step = e.shiftKey ? 20 : 6;
        if (e.key === 'ArrowLeft') { ox += step; } else if (e.key === 'ArrowRight') { ox -= step; }
        else if (e.key === 'ArrowUp') { oy += step; } else if (e.key === 'ArrowDown') { oy -= step; }
        else if (e.key === '+' || e.key === '=') { zoomTo(z * 1.1); return; } else if (e.key === '-') { zoomTo(z / 1.1); return; }
        else return;
        e.preventDefault(); draw();
      });
      function close(result) { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(result); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(null); } }
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('click', function (e) {
        if (e.target === wrap) return close(null);
        var a = e.target.closest('[data-a]'); if (!a) return;
        if (a.getAttribute('data-a') === 'cancel') return close(null);
        var c = document.createElement('canvas'); c.width = c.height = SIZE;
        var ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, SIZE, SIZE);
        var sc = scale();
        ctx.drawImage(img, -ox / sc, -oy / sc, V / sc, V / sc, 0, 0, SIZE, SIZE);
        close({ photo: c.toDataURL('image/jpeg', 0.86), crop: { cx: (V / 2 - ox) / sc / w, cy: (V / 2 - oy) / sc / h, z: z } });
      });
    });
  }
  function pickAndEdit(file) {
    var u = me(); if (!u) return;
    readFile(file).then(function (src) {
      return editCrop(src, null).then(function (r) {
        if (!r) return;
        sources[u.id] = { src: src, crop: r.crop }; saveSources(); pushSource(u.id, sources[u.id]);
        setPhoto(r.photo); toast('Profile photo updated');
      });
    }).catch(function () { toast('Choose an image file (JPG or PNG)'); });
  }
  function adjustCurrent() {
    var u = me(); if (!u || !photos[u.id]) return;
    loadSource(u.id).then(function (rec) {
      var src = rec && rec.src ? rec.src : photos[u.id];
      var crop = rec && rec.src ? rec.crop : null;
      return editCrop(src, crop).then(function (r) {
        if (!r) return;
        sources[u.id] = { src: src, crop: r.crop }; saveSources(); pushSource(u.id, sources[u.id]);
        setPhoto(r.photo); toast('Profile photo updated');
      });
    });
  }

  function setPhoto(dataUrl) {
    var u = me(); if (!u) return;
    if (dataUrl) photos[u.id] = dataUrl; else delete photos[u.id];
    save(); pushCloud(u.id, dataUrl || null); paint();
  }

  /* ---------- painting ---------- */
  function avatarHtml(u, cls) {
    var p = u && photos[u.id];
    return p ? '<img class="' + cls + '" src="' + p + '" alt="">' : '';
  }
  function paint() {
    var u = me(), p = u ? photos[u.id] : null;
    // account menu avatar
    var av = document.querySelector('#fxAcct .fx-acct-av');
    if (av) {
      if (p) { av.innerHTML = '<img src="' + p + '" alt="">'; av.classList.add('has-photo'); }
      else { av.textContent = initials(u ? u.name : 'GUEST'); av.classList.remove('has-photo'); }
    }
    // sidebar button
    var btn = document.getElementById('btnHeaderAuth');
    if (btn) {
      btn.classList.toggle('fx-has-photo', !!p);
      if (p) btn.style.setProperty('--fx-photo', 'url("' + p + '")'); else btn.style.removeProperty('--fx-photo');
    }
    // mobile header button
    var mob = document.getElementById('mobileAuthBtn');
    if (mob) {
      var img = mob.querySelector('img.fx-mob-photo');
      if (p) { if (!img) { img = document.createElement('img'); img.className = 'fx-mob-photo'; img.alt = ''; mob.appendChild(img); } img.src = p; mob.classList.add('fx-has-photo'); }
      else { if (img) img.remove(); mob.classList.remove('fx-has-photo'); }
    }
    paintModal();
  }

  /* ---------- profile modal ---------- */
  function ensureModalUi() {
    var holder = document.getElementById('userProfileAvatar');
    if (!holder || document.getElementById('fxPhotoBox')) return;
    var row = holder.parentElement;
    var box = document.createElement('div');
    box.id = 'fxPhotoBox'; box.className = 'fx-photo-box';
    box.innerHTML =
      '<button type="button" class="fx-photo-av" id="fxPhotoAv" title="Change profile photo" aria-label="Change profile photo"></button>' +
      '<div class="fx-photo-info"><b id="fxPhotoName"></b><span id="fxPhotoRole" class="fx-acct-role"></span>' +
      '<div class="fx-photo-actions"><button type="button" class="btn btn-outline btn-sm" id="fxPhotoPick">Upload photo</button>' +
      '<button type="button" class="btn btn-outline btn-sm" id="fxPhotoAdjust">Adjust</button>' +
      '<button type="button" class="fx-photo-remove" id="fxPhotoRemove">Remove</button></div>' +
      '<small>JPG or PNG. Drag and zoom to fit the square.</small></div>' +
      '<input type="file" id="fxPhotoInput" accept="image/*" hidden>';
    row.parentElement.insertBefore(box, row);
    row.style.display = 'none';
    var input = box.querySelector('#fxPhotoInput');
    box.querySelector('#fxPhotoAv').onclick = function () { input.click(); };
    box.querySelector('#fxPhotoPick').onclick = function () { input.click(); };
    box.querySelector('#fxPhotoAdjust').onclick = adjustCurrent;
    box.querySelector('#fxPhotoRemove').onclick = function () {
      var u = me(); if (u) { delete sources[u.id]; saveSources(); pushSource(u.id, null); }
      setPhoto(null); toast('Profile photo removed');
    };
    input.onchange = function () {
      var f = input.files && input.files[0]; input.value = '';
      if (!f) return;
      pickAndEdit(f);
    };
    // drag & drop onto the avatar
    var av = box.querySelector('#fxPhotoAv');
    av.addEventListener('dragover', function (e) { e.preventDefault(); av.classList.add('is-drop'); });
    av.addEventListener('dragleave', function () { av.classList.remove('is-drop'); });
    av.addEventListener('drop', function (e) {
      e.preventDefault(); av.classList.remove('is-drop');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) pickAndEdit(f);
    });
  }
  function paintModal() {
    var box = document.getElementById('fxPhotoBox'); if (!box) return;
    var u = me(), p = u ? photos[u.id] : null;
    var av = box.querySelector('#fxPhotoAv');
    av.innerHTML = (p ? '<img src="' + p + '" alt="">' : '<span>' + initials(u ? u.name : '') + '</span>') +
      '<i class="fx-photo-cam" aria-hidden="true"></i>';
    box.querySelector('#fxPhotoName').textContent = u ? String(u.name || '').toUpperCase() : '';
    var r = box.querySelector('#fxPhotoRole'); r.textContent = u ? String(u.role || '').toUpperCase() : ''; r.classList.toggle('is-admin', !!u && u.role === 'ADMIN');
    box.querySelector('#fxPhotoRemove').style.display = p ? '' : 'none';
    box.querySelector('#fxPhotoAdjust').style.display = p ? '' : 'none';
    box.querySelector('#fxPhotoPick').textContent = p ? 'Change photo' : 'Upload photo';
  }

  function wrap(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { var r = orig.apply(this, arguments); try { after(); } catch (e) {} return r; };
  }
  function init() {
    wrap('updateAuthHeaderUI', paint);
    wrap('openUserProfileModal', function () { ensureModalUi(); paint(); });
    wrap('handleAuthHeaderClick', paint);
    ensureModalUi();
    paint();
    subscribe();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 30); });
  else setTimeout(init, 30);
})();
