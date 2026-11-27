/* ==========================================================================
   ACRE — sign-in (employee ID + password), same model as CMMS
   - Nothing is shown until someone signs in. Records, the job tracking table
     and the job-request list load from Firestore only after sign-in.
   - Firebase Authentication needs an email, so each employee ID gets a hidden
     address nobody uses (…@acre.example.com). logins/{EMPLOYEE ID} maps the ID
     to that address; users/{uid} holds name, role and the "must change" flag.
   - The first account (set up once on an empty system) is the admin. The admin
     adds people from Team accounts; each gets a one-time temporary password
     and must choose their own at first sign-in.
   - firestore.rules (in this repository) is what actually protects the data.
   ========================================================================== */
(function () {
  'use strict';
  if (window.__acreAuth) return;
  window.__acreAuth = true;

  var DOMAIN = 'acre.example.com';
  var EMP_RE = /^[A-Z0-9][A-Z0-9._-]{1,19}$/;
  var MIN_PW = 8;
  var KEY_AUTH = 'orbray_auth_current_user_v1';
  var KEY_CUSTOM = 'orbray_team_custom_accounts_v1';
  var KEY_PINS = 'orbray_team_account_pins_v1';
  var KEY_DELETED = 'orbray_team_deleted_accounts_v1';
  var EMU = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && /[?&]acre-emulator=1/.test(location.search);

  var S = { user: null, profile: null, unlocked: false, wantsCloud: false, quiet: false, draft: {} };
  var gate, auth, db, config;

  /* ---------- small helpers ---------- */
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function normEmp(v) { return String(v || '').trim().toUpperCase(); }
  function rand(n, chars) { var a = new Uint32Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return chars[x % chars.length]; }).join(''); }
  function tempPassword() { return rand(8, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'); } // no 0/O 1/I/L, easy to read out
  function loginEmail(id) { return id.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.' + rand(6, 'abcdefghijkmnpqrstuvwxyz23456789') + '@' + DOMAIN; }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function readJSON(key, fallback) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function roster() { try { return typeof getTeamAccounts === 'function' ? getTeamAccounts() : []; } catch (e) { return []; } }
  function isAdmin() { return !!(S.profile && S.profile.role === 'admin'); }
  function errText(err) {
    var c = (err && err.code) || '';
    if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found' || c === 'auth/invalid-login-credentials') return 'Employee ID or password is incorrect.';
    if (c === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes, then try again.';
    if (c === 'auth/network-request-failed' || c === 'unavailable') return 'Cannot reach the server. Check the internet connection.';
    if (c === 'auth/operation-not-allowed') return 'Email/Password sign-in is not turned on in Firebase yet (Authentication › Sign-in method).';
    if (c === 'auth/weak-password') return 'Password needs at least ' + MIN_PW + ' characters.';
    if (c === 'auth/requires-recent-login') return 'Sign out, sign in again, then change the password.';
    if (c === 'permission-denied') return 'Permission denied by the database rules.';
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  /* ---------- the gate (full-screen page in front of the app) ---------- */
  var MARK = "<svg viewBox='0 0 64 64' aria-hidden='true'><rect width='64' height='64' rx='14' fill='currentColor'/>" +
    "<g transform='translate(11 12) scale(.656)' fill='#fff'><path d='M4 58 L32 6 L60 58 H47 L32 30 L17 58Z'/><path d='M23 58 L32 41 L41 58Z'/></g></svg>";
  var EYE = "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'><path d='M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'/><circle cx='12' cy='12' r='3'/></svg>";

  function ensureGate() {
    gate = document.getElementById('acreGate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'acreGate';
      gate.className = 'acre-gate no-case';
      document.body.insertBefore(gate, document.body.firstChild);
    }
    gate.classList.add('no-case');
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', 'ACRE sign in');
    document.documentElement.classList.remove('acre-open');
  }
  function shell(title, body) {
    return '<div class="acre-card"><div class="acre-brand"><span class="acre-tile">' + MARK + '</span><div><b>ACRE</b><span>ORBRAY (THAILAND)</span></div></div>' +
      '<h1 class="acre-title">' + esc(title) + '</h1>' + body + '</div>';
  }
  function paint(html, focusSel) {
    if (!gate) ensureGate();
    gate.innerHTML = '<div class="acre-gate-in">' + html + '</div>';
    gate.hidden = false;
    document.documentElement.classList.remove('acre-open');
    var f = focusSel && gate.querySelector(focusSel);
    if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 30);
  }
  function notice(msg, kind) { return msg ? '<p class="acre-note' + (kind === 'ok' ? ' is-ok' : '') + '" role="alert">' + esc(msg) + '</p>' : ''; }
  function field(id, label, attrs, isPw) {
    return '<div class="acre-field"><label for="' + id + '">' + esc(label) + '</label><div class="acre-input">' +
      '<input id="' + id + '" ' + (isPw ? 'class="has-eye" ' : '') + attrs + '>' + (isPw ? '<button type="button" class="acre-eye" data-eye="' + id + '" aria-label="Show password">' + EYE + '</button>' : '') + '</div></div>';
  }
  function showBoot(msg) {
    paint('<div class="acre-boot"><span class="acre-tile is-big">' + MARK + '</span><b>ACRE</b><span class="acre-track" aria-hidden="true"><span></span></span><p role="status">' + esc(msg || 'Opening ACRE') + '</p></div>');
  }
  function showLogin(err, note) {
    paint(shell('Sign in', '<form class="acre-form" data-form="login" novalidate>' +
      field('acreEmp', 'Employee ID', 'name="empId" autocomplete="username" autocapitalize="characters" spellcheck="false" required value="' + esc(S.draft.empId || '') + '"') +
      field('acrePw', 'Password', 'name="password" type="password" autocomplete="current-password" required', true) +
      notice(err) + notice(note, 'ok') +
      '<button class="acre-btn">Sign in</button>' +
      '<p class="acre-hint">Forgot your password or need an account? Ask your ACRE admin.</p></form>'), S.draft.empId ? '#acrePw' : '#acreEmp');
  }
  function showSetup(err) {
    paint(shell('Set up ACRE', '<form class="acre-form" data-form="setup" novalidate>' +
      '<p class="acre-lead">ACRE has no admin yet. The account you create here becomes the first admin, and this page closes for good.</p>' +
      field('acreSName', 'Full name', 'name="name" autocomplete="name" required value="' + esc(S.draft.name || '') + '"') +
      field('acreSEmp', 'Your employee ID (used to sign in)', 'name="empId" autocomplete="username" autocapitalize="characters" spellcheck="false" required value="' + esc(S.draft.empId || '') + '"') +
      field('acreSPw', 'Password (at least ' + MIN_PW + ' characters)', 'name="password" type="password" autocomplete="new-password" minlength="' + MIN_PW + '" required', true) +
      field('acreSPw2', 'Confirm password', 'name="password2" type="password" autocomplete="new-password" minlength="' + MIN_PW + '" required', true) +
      notice(err) + '<button class="acre-btn">Create admin account</button></form>'), '#acreSName');
  }
  function showFirstPassword(err) {
    var p = S.profile || {};
    paint(shell('Choose your password', '<form class="acre-form" data-form="firstpass" novalidate>' +
      '<p class="acre-lead">Welcome, <b>' + esc(p.name || '') + '</b> (<span class="acre-mono">' + esc(p.empId || '') + '</span>). You signed in with a temporary password. Set your own before you start.</p>' +
      field('acreFPw', 'New password (at least ' + MIN_PW + ' characters)', 'name="next" type="password" autocomplete="new-password" minlength="' + MIN_PW + '" required', true) +
      field('acreFPw2', 'Confirm new password', 'name="next2" type="password" autocomplete="new-password" minlength="' + MIN_PW + '" required', true) +
      notice(err) + '<button class="acre-btn">Save password</button>' +
      '<button type="button" class="acre-btn is-quiet" data-act="logout">Sign out</button></form>'), '#acreFPw');
  }
  function showBlocked(msg) {
    paint(shell('Account not active', '<div class="acre-form"><p class="acre-lead">' + esc(msg || 'This account is turned off or has no access yet. Ask your ACRE admin.') + '</p>' +
      '<button type="button" class="acre-btn" data-act="logout">Sign out</button></div>'));
  }

  /* ---------- state machine ---------- */
  function onAuth(user) {
    S.user = user;
    if (S.quiet) return; // setup / password flows finish themselves
    if (!user) {
      S.profile = null;
      if (S.unlocked) { try { localStorage.removeItem(KEY_AUTH); } catch (e) {} location.reload(); return; }
      return showSignedOut();
    }
    readProfile(user);
  }
  function showSignedOut(err) {
    showBoot();
    db.collection('config').doc('setup').get().then(function (snap) {
      if (snap.exists) showLogin(err); else showSetup(err);
    }).catch(function (e) {
      showLogin(err || ('Cannot check the system status (' + errText(e) + ').'));
    });
  }
  function readProfile(user) {
    if (!S.unlocked) showBoot('Checking your account');
    return db.collection('users').doc(user.uid).get().then(function (snap) {
      var p = snap.exists ? snap.data() : null;
      if (!p || (p.role !== 'admin' && p.role !== 'member')) {
        if (S.unlocked) { auth.signOut(); return; }
        return showBlocked(p && p.role === 'disabled' ? 'This account has been turned off. Ask your ACRE admin.' : null);
      }
      S.profile = Object.assign({}, p, { empId: normEmp(p.empId), uid: user.uid });
      if (p.mustChange) return showFirstPassword();
      unlock();
    }).catch(function (e) {
      showBlocked('Cannot read your account (' + errText(e) + ').');
    });
  }

  function unlock() {
    var first = !S.unlocked;
    S.unlocked = true;
    applyProfileToSession();
    if (first) {
      if (S.wantsCloud && origInitCloud) { try { origInitCloud(); } catch (e) { console.warn(e); } }
      loadPrivateData();
      if (isAdmin()) stripLegacyPins();
    }
    if (gate) { gate.hidden = true; gate.innerHTML = ''; }
    document.documentElement.classList.add('acre-open');
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}
  }

  /* the app's own session (currentUser) follows the signed-in profile */
  function applyProfileToSession() {
    if (!S.unlocked || !S.profile) return;
    var p = S.profile;
    var role = p.role === 'admin' ? 'ADMIN' : 'MEMBER';
    var acct = roster().filter(function (a) { return a.id === p.legacyId || normEmp(a.empId) === p.empId; })[0];
    var u = Object.assign({ company: 'ORBRAY', department: 'PRODUCTION TECHNOLOGY', avatar: '👤' },
      acct || { id: p.legacyId || ('usr_' + p.empId.toLowerCase()), name: p.name, empId: p.empId },
      { role: role, uid: p.uid, pin: '' });
    if (!acct) ensureRoster({ id: u.id, name: p.name, empId: p.empId, role: role });
    try { currentUser = u; } catch (e) {}
    window.currentUser = u;
    writeJSON(KEY_AUTH, u);
    if (typeof updateAuthHeaderUI === 'function') { try { updateAuthHeaderUI(); } catch (e) {} }
  }

  /* roster = the team list the app uses for owners and assignees */
  function ensureRoster(acc) {
    var custom = readJSON(KEY_CUSTOM, {}) || {};
    var cur = custom[acc.id] || {};
    custom[acc.id] = Object.assign({ company: 'ORBRAY', department: 'PRODUCTION TECHNOLOGY', avatar: '👤' }, cur, { name: acc.name, empId: acc.empId, role: acc.role });
    delete custom[acc.id].pin;
    writeJSON(KEY_CUSTOM, custom);
    var del = readJSON(KEY_DELETED, []) || [];
    if (del.indexOf(acc.id) !== -1) writeJSON(KEY_DELETED, del.filter(function (x) { return x !== acc.id; }));
    try { if (typeof resetAssigneeDropdown === 'function') resetAssigneeDropdown(); if (typeof populateAssigneeDropdown === 'function') populateAssigneeDropdown(); } catch (e) {}
    try { if (typeof syncTeamAccountsToFirestore === 'function') syncTeamAccountsToFirestore(); } catch (e) {}
  }

  /* old PINs are no longer used: clear them from this browser and from the shared settings */
  function stripLegacyPins() {
    writeJSON(KEY_PINS, {});
    var custom = readJSON(KEY_CUSTOM, {}) || {};
    Object.keys(custom).forEach(function (k) { if (custom[k]) delete custom[k].pin; });
    writeJSON(KEY_CUSTOM, custom);
    db.collection('settings').doc('team_accounts').get().then(function (snap) {
      if (!snap.exists) return;
      var d = snap.data() || {};
      var ca = d.customAccounts || {};
      var dirty = d.customPins && Object.keys(d.customPins).length > 0;
      Object.keys(ca).forEach(function (k) { if (ca[k] && 'pin' in ca[k]) { delete ca[k].pin; dirty = true; } });
      if (dirty) return db.collection('settings').doc('team_accounts').update({ customPins: {}, customAccounts: ca });
    }).catch(function () {});
  }

  /* job tracking rows + job-request list: stored in Firestore, never in the public files */
  function loadPrivateData() {
    var ref = db.collection('settings');
    return Promise.all([ref.doc('excel_master').get(), ref.doc('job_requests').get()]).then(function (r) {
      var changed = false;
      try {
        if (r[0].exists && r[0].data().json && typeof EXCEL_MASTER_MAP === 'object') { Object.assign(EXCEL_MASTER_MAP, JSON.parse(r[0].data().json)); changed = true; }
      } catch (e) { console.warn('excel_master', e); }
      try {
        if (r[1].exists && r[1].data().json) { window.JOB_REQUESTS_DB = JSON.parse(r[1].data().json); changed = true; }
      } catch (e) { console.warn('job_requests', e); }
      S.privateData = { excel: r[0].exists, jobs: r[1].exists };
      if (changed && typeof renderAll === 'function') { try { renderAll(); } catch (e) {} }
    }).catch(function (e) { console.warn('private data', e); S.privateData = { excel: false, jobs: false, error: true }; });
  }

  /* ---------- form handling on the gate ---------- */
  function onGateSubmit(e) {
    var form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    var kind = form.getAttribute('data-form');
    var btn = form.querySelector('.acre-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    var v = function (n) { return form.elements[n] ? form.elements[n].value : ''; };
    if (kind === 'login') return doLogin(normEmp(v('empId')), v('password'));
    if (kind === 'setup') return doSetup(v('name').trim().toUpperCase(), normEmp(v('empId')), v('password'), v('password2'));
    if (kind === 'firstpass') return doFirstPassword(v('next'), v('next2'));
  }
  function doLogin(id, pw) {
    S.draft.empId = id;
    var bad = function () { return Object.assign(new Error('invalid'), { code: 'auth/invalid-credential' }); };
    if (!EMP_RE.test(id) || !pw) return showLogin(!id ? 'Enter your employee ID.' : !pw ? 'Enter your password.' : errText(bad()));
    db.collection('logins').doc(id).get().then(function (snap) {
      if (!snap.exists) throw bad();
      return auth.signInWithEmailAndPassword(snap.data().email, pw);
    }).catch(function (err) { showLogin(errText(err)); });
  }
  function doSetup(name, id, pw, pw2) {
    S.draft = { name: name, empId: id };
    if (!name) return showSetup('Enter your full name.');
    if (!EMP_RE.test(id)) return showSetup('Employee ID: A–Z, 0–9, dot, dash or underscore, 2 to 20 characters.');
    if (pw.length < MIN_PW) return showSetup('Password needs at least ' + MIN_PW + ' characters.');
    if (pw !== pw2) return showSetup('The two passwords do not match.');
    var match = roster().filter(function (a) { return normEmp(a.empId) === id; })[0];
    var email = loginEmail(id);
    S.quiet = true;
    showBoot('Creating the admin account');
    auth.createUserWithEmailAndPassword(email, pw).then(function (cred) {
      var uid = cred.user.uid;
      var write = function () {
        var b = db.batch();
        b.set(db.collection('users').doc(uid), { name: name, empId: id, role: 'admin', legacyId: match ? match.id : ('usr_' + id.toLowerCase()), createdAt: ts() });
        b.set(db.collection('config').doc('setup'), { adminUid: uid, createdAt: ts() });
        b.set(db.collection('logins').doc(id), { email: email, uid: uid });
        return b.commit();
      };
      // the database may not see the new account's token for a moment: retry twice
      return cred.user.getIdToken(true).then(function attempt(_, i) {
        i = i || 0;
        return write().catch(function (err) {
          if (err && err.code === 'permission-denied' && i < 2) return sleep(1200).then(function () { return attempt(null, i + 1); });
          throw err;
        });
      }).catch(function (err) { return cred.user.delete().catch(function () {}).then(function () { throw err; }); });
    }).then(function () {
      S.quiet = false; S.draft = {};
      return readProfile(auth.currentUser);
    }).catch(function (err) {
      S.quiet = false;
      showSetup(errText(err));
    });
  }
  function doFirstPassword(pw, pw2) {
    if (pw.length < MIN_PW) return showFirstPassword('Password needs at least ' + MIN_PW + ' characters.');
    if (pw !== pw2) return showFirstPassword('The two passwords do not match.');
    var user = auth.currentUser;
    if (!user) return showSignedOut();
    S.quiet = true;
    user.updatePassword(pw).then(function () {
      return db.collection('users').doc(user.uid).update({ mustChange: false });
    }).then(function () { S.quiet = false; return readProfile(user); })
      .catch(function (err) { S.quiet = false; showFirstPassword(errText(err)); });
  }

  function onGateClick(e) {
    var eye = e.target.closest('[data-eye]');
    if (eye) {
      var inp = document.getElementById(eye.getAttribute('data-eye'));
      if (inp) { var show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); eye.classList.toggle('is-on', show); }
      return;
    }
    var act = e.target.closest('[data-act]');
    if (!act) return;
    var a = act.getAttribute('data-act');
    if (a === 'logout') { S.draft = {}; auth.signOut().then(function () { if (!S.unlocked) showSignedOut(); }); }
  }

  /* ---------- modals inside the app (change password, team accounts) ---------- */
  var modal;
  function openModal(html, wide) {
    closeModal();
    modal = document.createElement('div');
    modal.className = 'acre-modal no-case';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = '<div class="acre-modal-card' + (wide ? ' is-wide' : '') + '">' + html + '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.closest('[data-close]')) closeModal();
    });
    modal.addEventListener('click', onGateClick);
    document.addEventListener('keydown', escClose);
    var f = modal.querySelector('input, select, button:not([data-close])');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) {} }, 30);
    return modal;
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    if (S.usersUnsub) { try { S.usersUnsub(); } catch (e) {} S.usersUnsub = null; }
    document.removeEventListener('keydown', escClose);
    if (modal) { modal.remove(); modal = null; }
  }
  function modalHead(title) { return '<div class="acre-modal-head"><h2>' + esc(title) + '</h2><button type="button" class="acre-x" data-close aria-label="Close">×</button></div>'; }
  function closeAccountMenu() { var d = document.getElementById('authUserDropdown'); if (d) d.classList.remove('active'); }

  function openChangePassword(msg, ok) {
    closeAccountMenu();
    openModal(modalHead('Change password') + '<form class="acre-form" data-form="changepw" novalidate>' +
      field('acreCPw0', 'Current password', 'name="current" type="password" autocomplete="current-password" required', true) +
      field('acreCPw1', 'New password (at least ' + MIN_PW + ' characters)', 'name="next" type="password" autocomplete="new-password" minlength="' + MIN_PW + '" required', true) +
      field('acreCPw2', 'Confirm new password', 'name="next2" type="password" autocomplete="new-password" minlength="' + MIN_PW + '" required', true) +
      notice(ok ? '' : msg) + notice(ok ? msg : '', 'ok') + '<button class="acre-btn">Save password</button></form>');
    modal.querySelector('form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target, cur = f.elements.current.value, nx = f.elements.next.value, nx2 = f.elements.next2.value;
      if (!cur) return openChangePassword('Enter your current password.');
      if (nx.length < MIN_PW) return openChangePassword('New password needs at least ' + MIN_PW + ' characters.');
      if (nx !== nx2) return openChangePassword('The two new passwords do not match.');
      var user = auth.currentUser;
      f.querySelector('.acre-btn').disabled = true;
      user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, cur))
        .then(function () { return user.updatePassword(nx); })
        .then(function () { openChangePassword('Password changed.', true); })
        .catch(function (err) { openChangePassword(errText(err)); });
    });
  }

  /* create a sign-in account with a second Firebase app, so the admin stays signed in */
  function withNewAccount(id, pw, write) {
    var sec = firebase.initializeApp(config, 'acct-' + Date.now() + '-' + rand(4, 'abcdefgh'));
    var secAuth = sec.auth();
    if (EMU) secAuth.useEmulator('http://127.0.0.1:9099');
    var email = loginEmail(id);
    return secAuth.createUserWithEmailAndPassword(email, pw).then(function (cred) {
      return Promise.resolve().then(function () { return write(cred.user.uid, email); })
        .catch(function (err) { return cred.user.delete().catch(function () {}).then(function () { throw err; }); });
    }).then(function (r) {
      return secAuth.signOut().catch(function () {}).then(function () { return sec.delete(); }).then(function () { return r; });
    }, function (err) {
      return secAuth.signOut().catch(function () {}).then(function () { return sec.delete(); }).then(function () { throw err; });
    });
  }
  function createUser(o) {
    var id = normEmp(o.empId);
    if (!EMP_RE.test(id)) return Promise.reject(new Error('Employee ID: A–Z, 0–9, dot, dash or underscore, 2 to 20 characters.'));
    if (!o.name) return Promise.reject(new Error('Enter a name.'));
    return db.collection('logins').doc(id).get().then(function (snap) {
      if (snap.exists) throw new Error('Employee ID ' + id + ' already has an account.');
      var temp = tempPassword();
      var legacyId = o.legacyId || ('usr_' + id.toLowerCase());
      return withNewAccount(id, temp, function (uid, email) {
        var b = db.batch();
        b.set(db.collection('users').doc(uid), { name: o.name, empId: id, role: o.role, legacyId: legacyId, mustChange: true, createdAt: ts() });
        b.set(db.collection('logins').doc(id), { email: email, uid: uid });
        return b.commit();
      }).then(function () {
        ensureRoster({ id: legacyId, name: o.name, empId: id, role: o.role === 'admin' ? 'ADMIN' : 'MEMBER' });
        return { name: o.name, empId: id, temp: temp };
      });
    });
  }
  // reset without email: a fresh sign-in account for the same employee ID; the old one stops working
  function resetUser(u) {
    var temp = tempPassword();
    var profile = { name: u.name, empId: u.empId, role: u.role, legacyId: u.legacyId || ('usr_' + String(u.empId).toLowerCase()) };
    return withNewAccount(u.empId, temp, function (uid, email) {
      var b = db.batch();
      b.set(db.collection('users').doc(uid), Object.assign({}, profile, { mustChange: true, resetAt: ts() }));
      b.set(db.collection('logins').doc(u.empId), { email: email, uid: uid });
      b.delete(db.collection('users').doc(u.id));
      return b.commit();
    }).then(function () { return { name: u.name, empId: u.empId, temp: temp }; });
  }
  function deleteUser(u) {
    return db.collection('logins').doc(u.empId).get().then(function (snap) {
      var b = db.batch();
      if (snap.exists && snap.data().uid === u.id) b.delete(db.collection('logins').doc(u.empId));
      b.delete(db.collection('users').doc(u.id));
      return b.commit();
    });
  }
  function setRole(u, role) {
    return db.collection('users').doc(u.id).update({ role: role }).then(function () {
      if (role !== 'disabled') ensureRoster({ id: u.legacyId || ('usr_' + u.empId.toLowerCase()), name: u.name, empId: u.empId, role: role === 'admin' ? 'ADMIN' : 'MEMBER' });
    });
  }

  function openTeamAccounts() {
    closeAccountMenu();
    if (!isAdmin()) { if (typeof showToast === 'function') showToast('⚠️ Only an admin can manage team accounts'); return; }
    S.results = S.results || null;
    openModal(modalHead('Team accounts') + '<div class="acre-admin" id="acreAdmin"><p class="acre-dim">Loading…</p></div>', true);
    var users = [];
    S.usersUnsub = db.collection('users').onSnapshot(function (snap) {
      users = [];
      snap.forEach(function (d) { users.push(Object.assign({}, d.data(), { id: d.id })); });
      users.sort(function (a, b) { return String(a.empId).localeCompare(String(b.empId)); });
      S.users = users;
      renderAdmin(users);
    }, function (err) {
      var box = document.getElementById('acreAdmin');
      if (box) box.innerHTML = notice('Cannot load accounts (' + errText(err) + ').');
    });
  }
  function renderAdmin(users) {
    var box = document.getElementById('acreAdmin');
    if (!box) return;
    var have = {};
    users.forEach(function (u) { have[normEmp(u.empId)] = true; });
    var missing = roster().filter(function (a) { return a && a.name && EMP_RE.test(normEmp(a.empId)) && !have[normEmp(a.empId)]; });
    var me = S.user && S.user.uid;
    var rows = users.map(function (u) {
      var self = u.id === me;
      var roleSel = self ? '<span class="acre-chip">ADMIN</span>' :
        '<select data-role="' + esc(u.id) + '" aria-label="Role for ' + esc(u.name) + '">' +
        ['admin', 'member', 'disabled'].map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + (r === 'admin' ? 'Admin' : r === 'member' ? 'Member' : 'Off') + '</option>'; }).join('') + '</select>';
      var status = u.role === 'disabled' ? 'Turned off' : u.mustChange ? 'Temporary password' : 'Active';
      return '<tr><td><b>' + esc(u.name) + '</b>' + (self ? ' <span class="acre-dim">(you)</span>' : '') + '</td><td class="acre-mono">' + esc(u.empId) + '</td><td>' + roleSel + '</td>' +
        '<td><span class="acre-status' + (u.mustChange ? ' is-temp' : '') + (u.role === 'disabled' ? ' is-off' : '') + '">' + status + '</span></td>' +
        '<td class="acre-row-act">' + (self ? '' : '<button type="button" class="acre-btn is-small is-quiet" data-reset="' + esc(u.id) + '">Reset password</button><button type="button" class="acre-btn is-small is-danger" data-del="' + esc(u.id) + '">Remove</button>') + '</td></tr>';
    }).join('');
    var pd = S.privateData || {};
    box.innerHTML =
      (S.results ? resultsBlock(S.results) : '') +
      (S.adminMsg ? notice(S.adminMsg.text, S.adminMsg.ok ? 'ok' : '') : '') +
      '<form class="acre-add" data-form="add" novalidate>' +
      '<div class="acre-field"><label for="acreANm">Name</label><input id="acreANm" name="name" required></div>' +
      '<div class="acre-field"><label for="acreAEmp">Employee ID</label><input id="acreAEmp" name="empId" autocapitalize="characters" spellcheck="false" required></div>' +
      '<div class="acre-field"><label for="acreARole">Role</label><select id="acreARole" name="role"><option value="member">Member</option><option value="admin">Admin</option></select></div>' +
      '<button class="acre-btn">Add person</button></form>' +
      '<div class="acre-table-wrap"><table class="acre-table"><thead><tr><th>Name</th><th>Employee ID</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (missing.length ? '<div class="acre-box"><div><b>' + missing.length + ' team member' + (missing.length > 1 ? 's' : '') + ' from the old PIN list have no account yet</b><p class="acre-dim">' + missing.map(function (a) { return esc(a.name) + ' (' + esc(normEmp(a.empId)) + ')'; }).join(', ') + '</p></div>' +
        '<button type="button" class="acre-btn" data-act="import-roster">Create their accounts</button></div>' : '') +
      '<div class="acre-box"><div><b>Job data</b><p class="acre-dim">Job tracking table: ' + (pd.excel ? 'loaded' : 'not imported') + '. Job request list: ' + (pd.jobs ? 'loaded' : 'not imported') +
      '. Import <span class="acre-mono">acre-private-data.json</span> from the ACRE folder once; it is kept out of the public site.</p></div>' +
      '<label class="acre-btn is-quiet acre-file">Import file<input type="file" accept=".json,application/json" data-act="import-data" hidden></label></div>';
    wireAdmin(box, users);
  }
  function resultsBlock(list) {
    var text = list.map(function (r) { return r.name + '\t' + r.empId + '\t' + r.temp; }).join('\n');
    return '<div class="acre-results"><b>Temporary passwords — shown once</b><p class="acre-dim">Give each person their password. They set their own the first time they sign in.</p>' +
      '<table class="acre-table"><thead><tr><th>Name</th><th>Employee ID</th><th>Temporary password</th></tr></thead><tbody>' +
      list.map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td class="acre-mono">' + esc(r.empId) + '</td><td class="acre-mono acre-temp">' + esc(r.temp) + '</td></tr>'; }).join('') +
      '</tbody></table><div class="acre-results-act"><button type="button" class="acre-btn is-small" data-copy="' + esc(text) + '">Copy all</button><button type="button" class="acre-btn is-small is-quiet" data-act="clear-results">Done</button></div></div>';
  }
  function adminMsg(text, ok) { S.adminMsg = text ? { text: text, ok: !!ok } : null; }
  function wireAdmin(box, users) {
    var byId = {};
    users.forEach(function (u) { byId[u.id] = u; });
    var rerender = function () { renderAdmin(S.users || users); };
    var busy = function (el, on) { if (el) { el.disabled = on; el.setAttribute('aria-busy', on ? 'true' : 'false'); } };
    var add = box.querySelector('form[data-form="add"]');
    add.addEventListener('submit', function (e) {
      e.preventDefault();
      var b = add.querySelector('.acre-btn'); busy(b, true);
      createUser({ name: add.elements.name.value.trim().toUpperCase(), empId: add.elements.empId.value, role: add.elements.role.value })
        .then(function (r) { S.results = [r]; adminMsg(''); rerender(); })
        .catch(function (err) { adminMsg(errText(err)); rerender(); });
    });
    box.querySelectorAll('select[data-role]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var u = byId[sel.getAttribute('data-role')];
        setRole(u, sel.value).then(function () { adminMsg(u.name + ' is now ' + (sel.value === 'disabled' ? 'turned off' : sel.value) + '.', true); rerender(); })
          .catch(function (err) { adminMsg(errText(err)); rerender(); });
      });
    });
    box.querySelectorAll('[data-reset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = byId[b.getAttribute('data-reset')];
        if (!confirmInline(b, 'Confirm reset')) return;
        busy(b, true);
        resetUser(u).then(function (r) { S.results = [r]; adminMsg(''); rerender(); })
          .catch(function (err) { adminMsg(errText(err)); rerender(); });
      });
    });
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = byId[b.getAttribute('data-del')];
        if (!confirmInline(b, 'Confirm remove')) return;
        busy(b, true);
        deleteUser(u).then(function () { adminMsg(u.name + ' can no longer sign in.', true); rerender(); })
          .catch(function (err) { adminMsg(errText(err)); rerender(); });
      });
    });
    var imp = box.querySelector('[data-act="import-roster"]');
    if (imp) imp.addEventListener('click', function () {
      busy(imp, true);
      var have = {};
      (S.users || users).forEach(function (u) { have[normEmp(u.empId)] = true; });
      var todo = roster().filter(function (a) { return a && a.name && EMP_RE.test(normEmp(a.empId)) && !have[normEmp(a.empId)]; });
      var out = [], fails = [];
      todo.reduce(function (p, a) {
        return p.then(function () {
          return createUser({ name: a.name, empId: a.empId, role: a.role === 'ADMIN' ? 'admin' : 'member', legacyId: a.id })
            .then(function (r) { out.push(r); }, function (err) { fails.push(a.name + ': ' + errText(err)); });
        });
      }, Promise.resolve()).then(function () {
        S.results = out.length ? out : null;
        adminMsg(fails.length ? 'Not created — ' + fails.join('; ') : '', false);
        stripLegacyPins();
        rerender();
      });
    });
    var file = box.querySelector('[data-act="import-data"]');
    if (file) file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { importPrivateData(String(rd.result || '')).then(function (msg) { adminMsg(msg, true); rerender(); }, function (err) { adminMsg(errText(err)); rerender(); }); };
      rd.readAsText(f);
    });
    var clr = box.querySelector('[data-act="clear-results"]');
    if (clr) clr.addEventListener('click', function () { S.results = null; rerender(); });
    var cp = box.querySelector('[data-copy]');
    if (cp) cp.addEventListener('click', function () {
      var t = cp.getAttribute('data-copy');
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { cp.textContent = 'Copied'; }, function () { cp.textContent = 'Select and copy the table'; });
    });
  }
  // a second press within 4 s confirms; no browser dialogs
  function confirmInline(btn, label) {
    if (btn.getAttribute('data-armed') === '1') return true;
    var orig = btn.textContent;
    btn.setAttribute('data-armed', '1'); btn.textContent = label;
    setTimeout(function () { if (btn.isConnected) { btn.removeAttribute('data-armed'); btn.textContent = orig; } }, 4000);
    return false;
  }
  function importPrivateData(text) {
    var data;
    try { data = JSON.parse(text.replace(/^﻿/, '').replace(/^[^{]*?=\s*/, '').replace(/;\s*$/, '')); } catch (e) { return Promise.reject(new Error('This file is not valid JSON.')); }
    var excel = data && data.kind === 'acre-private-data' ? data.excelMaster : null;
    var jobs = data && data.kind === 'acre-private-data' ? data.jobRequests : (data && typeof data === 'object' && !Array.isArray(data) ? data : null);
    var ref = db.collection('settings'), jobs_n = jobs ? Object.keys(jobs).length : 0, excel_n = excel ? Object.keys(excel).length : 0;
    if (!jobs_n && !excel_n) return Promise.reject(new Error('Nothing to import in this file.'));
    var b = db.batch();
    if (excel_n) b.set(ref.doc('excel_master'), { json: JSON.stringify(excel), count: excel_n, updatedAt: ts() });
    if (jobs_n) b.set(ref.doc('job_requests'), { json: JSON.stringify(jobs), count: jobs_n, updatedAt: ts() });
    return b.commit().then(function () { return loadPrivateData(); }).then(function () {
      return 'Imported ' + [excel_n ? excel_n + ' tracking rows' : '', jobs_n ? jobs_n + ' job requests' : ''].filter(Boolean).join(' and ') + '.';
    });
  }

  /* ---------- wire into the app ---------- */
  var origInitCloud = window.initFirebaseFromStorage;
  window.initFirebaseFromStorage = function () {
    S.wantsCloud = true;
    if (S.unlocked && origInitCloud) return origInitCloud.apply(this, arguments);
  };
  var origInitSession = window.initAuthSession;
  window.initAuthSession = function () {
    if (typeof origInitSession === 'function') { try { origInitSession.apply(this, arguments); } catch (e) {} }
    applyProfileToSession();
  };
  window.openAuthPinModal = function (a, b, cb) {
    if (S.unlocked && window.currentUser) { if (typeof cb === 'function') setTimeout(cb, 0); return; }
    if (gate && gate.hidden) showSignedOut();
  };
  window.logoutUser = function () { closeAccountMenu(); closeModal(); auth.signOut(); };
  window.openChangePinModal = function () { openChangePassword(); };
  // the employee ID is the sign-in name: shown in My profile, not editable there
  var origProfile = window.openUserProfileModal;
  if (typeof origProfile === 'function') window.openUserProfileModal = function () {
    var r = origProfile.apply(this, arguments);
    var f = document.getElementById('userProfileEmpId');
    if (f && S.profile) { f.value = S.profile.empId; f.readOnly = true; f.title = 'Your sign-in ID. An admin can change accounts in Team accounts.'; }
    return r;
  };
  window.openAdminTeamPinsModal = function () { openTeamAccounts(); };
  window.acreAuth = { signOut: function () { return auth.signOut(); }, openTeamAccounts: openTeamAccounts, openChangePassword: openChangePassword };

  // the app's REST fallback reads Firestore directly: send the signed-in token with it
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('firestore.googleapis.com') !== -1 && auth && auth.currentUser) {
        var self = this, args = arguments;
        return auth.currentUser.getIdToken().then(function (tok) {
          var opts = Object.assign({}, init || {});
          var h = new Headers(opts.headers || (typeof input !== 'string' && input.headers) || {});
          h.set('Authorization', 'Bearer ' + tok);
          opts.headers = h;
          return nativeFetch.call(self, input, opts);
        }, function () { return nativeFetch.apply(self, args); });
      }
      return nativeFetch.apply(this, arguments);
    };
  }

  function start() {
    ensureGate();
    if (!gate.innerHTML.trim()) showBoot();
    gate.addEventListener('submit', onGateSubmit);
    gate.addEventListener('click', onGateClick);
    if (typeof firebase === 'undefined' || !firebase.auth) {
      return showBlocked('The sign-in service did not load. Check the internet connection and reload the page.');
    }
    config = null;
    try { var raw = localStorage.getItem('orbray_firebase_config_v1'); if (raw && typeof parseFirebaseConfig === 'function') config = parseFirebaseConfig(raw); } catch (e) {}
    if (!config && typeof DEFAULT_FIREBASE_CONFIG !== 'undefined') config = DEFAULT_FIREBASE_CONFIG;
    if (!config) return showBlocked('Firebase is not configured.');
    try {
      if (!firebase.apps.length) firebase.initializeApp(config);
      auth = firebase.auth();
      db = firebase.firestore();
      if (EMU) { auth.useEmulator('http://127.0.0.1:9099'); try { db.useEmulator('127.0.0.1', 8080); } catch (e) {} }
    } catch (e) {
      return showBlocked('Firebase could not start (' + errText(e) + ').');
    }
    auth.onAuthStateChanged(onAuth);
  }
  start();
})();
