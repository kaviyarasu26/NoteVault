/* NoteVault — app.js */
'use strict';

// ── UTILS ────────────────────────────────────────────────
function gid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function today() { return new Date().toISOString().split('T')[0]; }
function now() { return new Date().toISOString(); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function $(id) { return document.getElementById(id); }
function fmtTime(m) { return m < 60 ? m + 'm' : Math.floor(m/60) + 'h ' + (m%60) + 'm'; }

function sm2(q, srs) {
  var r = (srs && srs.repetitions) || 0;
  var ef = (srs && srs.easeFactor) || 2.5;
  var iv = (srs && srs.interval) || 0;
  var nr, nef, ni;
  if (q >= 3) { nr = r + 1; ni = r === 0 ? 1 : r === 1 ? 6 : Math.round(iv * ef); }
  else { nr = 0; ni = 1; }
  nef = Math.max(1.3, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  var d = new Date(); d.setDate(d.getDate() + ni);
  return { repetitions: nr, easeFactor: nef, interval: ni, dueDate: d.toISOString().split('T')[0], lastReviewed: today() };
}

function isFC(it) { return it.content.indexOf('>>') >= 0; }
function isDue(it) { return it.srs && it.srs.dueDate <= today(); }
function parseFC(c) {
  var i = c.indexOf('>>');
  return i < 0 ? { q: c.trim(), a: '' } : { q: c.slice(0, i).trim(), a: c.slice(i + 2).trim() };
}

var FOLDER_COLORS = ['#00d4a8','#4a9eff','#a06aff','#f06478','#f0a040','#e8d040','#ff6090','#40d4e0','#ff9040','#80e060'];
var NOTE_ICONS = ['📝','📖','📚','🔬','🧪','⚗️','🧬','🌍','📐','🎯','💡','🧠','📊','🗒️','✍️','🔖','📋','🎨','💻','🏆'];

var toastTimer;
function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.classList.remove('on'); }, 2600);
}

// ── STATE ────────────────────────────────────────────────
var LS = 'nv_v7';
var S = {
  user: null,
  documents: [],
  folders: [],
  tests: [],
  settings: { theme: 'dark', fontSize: 'medium', dailyGoal: 20, focusMode: false },
  progress: { currentStreak: 0, longestStreak: 0, lastStudyDate: '', totalReviewed: 0, totalCreated: 0, dailyReviewed: {}, testScores: [], dailyMinutes: {}, totalMinutes: 0 },
  curDocId: null, focIdx: -1, undoStack: [], redoStack: [],
  rvCards: [], rvIdx: 0, rvShowAns: false, rvSessionCount: 0,
  rvMode: 'due', rvLen: 5, rvFolderScope: null, rvDocScope: null,
  curTest: null, curTestQ: 0, testAnswers: [], testTimer: null, testStartTime: 0,
  notesFilter: 'all', notesSearch: '', activeFolderId: null,
  testType: 'mcq', testSrcType: 'doc', mergeMode: 'merge', importPending: null,
  firebaseReady: false, unsubDocs: null, currentScreen: 'dashboard',
  selNoteIcon: '📝', selFolderColor: null, editingFolderId: null, newFolderParentId: null
};

function loadLS() {
  try {
    var r = localStorage.getItem(LS);
    if (!r) return;
    var d = JSON.parse(r);
    if (d.documents) S.documents = d.documents;
    if (d.folders) S.folders = d.folders;
    if (d.tests) S.tests = d.tests;
    if (d.settings) { for (var k in d.settings) S.settings[k] = d.settings[k]; }
    if (d.progress) { for (var k in d.progress) S.progress[k] = d.progress[k]; }
  } catch(e) {}
}

function saveLS() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      documents: S.documents, folders: S.folders, tests: S.tests,
      settings: S.settings, progress: S.progress
    }));
  } catch(e) {}
}

// ── FIREBASE ────────────────────────────────────────────
var auth, db;
function isCfg() {
  return typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf('PASTE') < 0;
}

window.addEventListener('load', function() {
  loadLS();
  applyTheme();
  if (!isCfg()) {
    $('cfg-banner').classList.add('show');
    $('loading-screen').style.display = 'none';
    $('app').style.display = 'flex';
    startApp(null);
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(function() {});
    S.firebaseReady = true;
    auth.onAuthStateChanged(function(user) {
      $('loading-screen').style.display = 'none';
      $('app').style.display = 'flex';
      if (user) { S.user = user; startApp(user); }
      else { showAuthView('login'); showScreen('auth'); }
    });
  } catch(e) {
    $('cfg-banner').classList.add('show');
    $('loading-screen').style.display = 'none';
    $('app').style.display = 'flex';
    startApp(null);
  }
});

function startApp(user) {
  updateUserUI();
  applySettings();
  if (user && db) subscribeFB();
  nav('dashboard');
  checkStreak();
  startSessionTimer();
  setupGlobalShortcuts();
}

function subscribeFB() {
  if (!S.user || !S.user.uid || !db) return;
  setSyncDot('busy');
  var path = 'users/' + S.user.uid + '/data';
  S.unsubDocs = db.collection(path).doc('main').onSnapshot(function(snap) {
    if (snap.exists) {
      var d = snap.data();
      if (d.documents) S.documents = d.documents;
      if (d.folders) S.folders = d.folders;
      if (d.tests) S.tests = d.tests;
      if (d.progress) { for (var k in d.progress) S.progress[k] = d.progress[k]; }
      saveLS();
    }
    setSyncDot('on');
    refreshScreen();
  }, function() { setSyncDot('off'); });
}

var cloudTimer;
function cloudSave() {
  saveLS();
  if (!S.user || !S.user.uid || !db) return;
  setSyncDot('busy');
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(function() {
    var path = 'users/' + S.user.uid + '/data';
    db.collection(path).doc('main').set({
      documents: S.documents, folders: S.folders, tests: S.tests,
      progress: S.progress, updatedAt: now()
    }).then(function() { setSyncDot('on'); }).catch(function() { setSyncDot('off'); });
  }, 1200);
}

function setSyncDot(s) {
  var el = $('sb-sync');
  if (!el) return;
  el.className = 'sb-sync';
  if (s === 'off') el.classList.add('off');
  else if (s === 'busy') el.classList.add('busy');
  var dot = $('ed-dot'), lbl = $('ed-lbl');
  if (dot && lbl) {
    if (s === 'busy') { dot.style.background = 'var(--yellow)'; lbl.textContent = 'saving…'; }
    else if (s === 'on') { dot.style.background = 'var(--acc)'; lbl.textContent = 'saved'; }
    else { dot.style.background = 'var(--t3)'; lbl.textContent = 'offline'; }
  }
}

// ── SESSION TIME TRACKING ────────────────────────────────
var sessionStart = Date.now();
function startSessionTimer() {
  sessionStart = Date.now();
  setInterval(function() {
    var mins = Math.round((Date.now() - sessionStart) / 60000);
    if (mins < 1) return;
    S.progress.dailyMinutes = S.progress.dailyMinutes || {};
    var prev = S.progress.dailyMinutes[today()] || 0;
    if (mins > prev) {
      S.progress.totalMinutes = (S.progress.totalMinutes || 0) + (mins - prev);
      S.progress.dailyMinutes[today()] = mins;
      saveLS();
    }
  }, 60000);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      var mins = Math.round((Date.now() - sessionStart) / 60000);
      if (mins > 0) {
        S.progress.dailyMinutes = S.progress.dailyMinutes || {};
        S.progress.dailyMinutes[today()] = (S.progress.dailyMinutes[today()] || 0) + mins;
        S.progress.totalMinutes = (S.progress.totalMinutes || 0) + mins;
        saveLS();
        cloudSave();
      }
      sessionStart = Date.now();
    }
  });
}

// ── AUTH ─────────────────────────────────────────────────
function showAuthView(mode) {
  var isLogin = mode === 'login';
  var html = '<div class="auth-box" style="margin:auto">';
  html += '<div style="text-align:center;margin-bottom:18px">';
  html += '<div class="auth-logo-mark">⬡</div>';
  html += '<div class="auth-h">' + (isLogin ? 'Welcome back' : 'Create account') + '</div>';
  html += '<div class="auth-sub">' + (isLogin ? 'Sign in to sync across devices' : 'Your private study vault') + '</div>';
  html += '</div>';
  html += '<div class="auth-err" id="auth-err"></div>';
  if (!isLogin) html += '<label class="auth-label">Name</label><input class="auth-inp" id="auth-name" placeholder="Your name"/>';
  html += '<label class="auth-label">Email</label><input class="auth-inp" id="auth-email" type="email" placeholder="you@email.com" autocomplete="email"/>';
  html += '<label class="auth-label">Password</label>';
  if (isLogin) {
    html += '<input class="auth-inp" id="auth-pass" type="password" placeholder="Password" onkeydown="if(event.key===\'Enter\')doLogin()"/>';
  } else {
    html += '<input class="auth-inp" id="auth-pass" type="password" placeholder="Password (min 8)"/>';
    html += '<label class="auth-label">Confirm Password</label>';
    html += '<input class="auth-inp" id="auth-pass2" type="password" placeholder="Repeat password" onkeydown="if(event.key===\'Enter\')doRegister()"/>';
  }
  html += '<button class="auth-btn" onclick="' + (isLogin ? 'doLogin()' : 'doRegister()') + '">';
  html += isLogin ? 'Sign In' : 'Create Account';
  html += '</button>';
  html += '<div class="auth-divider"><span>or</span></div>';
  html += '<button class="auth-btn google" onclick="doGoogle()">&#9654; Continue with Google</button>';
  html += '<button class="auth-btn ghost" onclick="startOffline()">Use without account</button>';
  if (isLogin) {
    html += '<div class="auth-link">No account? <a onclick="showAuthView(\'register\')">Register →</a></div>';
  } else {
    html += '<div class="auth-link"><a onclick="showAuthView(\'login\')">← Back to sign in</a></div>';
  }
  html += '</div>';
  $('auth-view').innerHTML = html;
}

function authErr(m) {
  var e = $('auth-err');
  if (e) { e.textContent = m; e.classList.add('show'); }
}

function doLogin() {
  if (!auth) { startOffline(); return; }
  var email = $('auth-email') && $('auth-email').value.trim();
  var pass = $('auth-pass') && $('auth-pass').value;
  if (!email || !pass) { authErr('Fill all fields'); return; }
  auth.signInWithEmailAndPassword(email, pass).catch(function(e) { authErr(e.message || 'Login failed'); });
}

function doRegister() {
  if (!auth) { startOffline(); return; }
  var name = $('auth-name') && $('auth-name').value.trim();
  var email = $('auth-email') && $('auth-email').value.trim();
  var pass = $('auth-pass') && $('auth-pass').value;
  var pass2 = $('auth-pass2') && $('auth-pass2').value;
  if (!name || !email || !pass) { authErr('Fill all fields'); return; }
  if (pass.length < 8) { authErr('Password min 8 chars'); return; }
  if (pass !== pass2) { authErr('Passwords do not match'); return; }
  auth.createUserWithEmailAndPassword(email, pass).then(function(c) {
    c.user.updateProfile({ displayName: name });
    toast('Account created!');
  }).catch(function(e) { authErr(e.message); });
}

function doGoogle() {
  if (!auth) { startOffline(); return; }
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(function() { authErr('Google sign-in failed'); });
}

function startOffline() { S.user = null; startApp(null); }

function signOut() {
  closeProfile();
  if (S.unsubDocs) S.unsubDocs();
  if (auth) auth.signOut();
  S.user = null; S.documents = []; S.folders = []; S.tests = [];
  showAuthView('login');
  showScreen('auth');
}

function updateUserUI() {
  var u = S.user;
  $('sb-uname').textContent = u ? (u.displayName || u.email || 'User') : 'Offline Mode';
  $('sb-uemail').textContent = u ? (u.email || '') : 'Data saved locally';
  var av = $('sb-avatar');
  if (av && u && u.photoURL) av.innerHTML = '<img src="' + u.photoURL + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
}

// ── NAVIGATION ───────────────────────────────────────────
var SCREENS = ['dashboard','notes','editor','review','test','progress','settings','auth'];

function showScreen(id) {
  for (var i = 0; i < SCREENS.length; i++) {
    var el = $('s-' + SCREENS[i]);
    if (el) el.classList.remove('active');
  }
  var el = $('s-' + id);
  if (el) el.classList.add('active');
  S.currentScreen = id;
}

function nav(screen) {
  document.querySelectorAll('.sb-item').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.bnav-item').forEach(function(el) { el.classList.remove('active'); });
  var sbi = $('sbi-' + screen); if (sbi) sbi.classList.add('active');
  var bni = $('bn-' + screen); if (bni) bni.classList.add('active');
  if (screen === 'dashboard') renderDashboard();
  else if (screen === 'notes') { renderFolderTree(); renderNotesList(); }
  else if (screen === 'review') showRvModeSelector(null, null);
  else if (screen === 'test') renderTestList();
  else if (screen === 'progress') renderProgress();
  else if (screen === 'settings') renderSettings();
  showScreen(screen);
}

function refreshScreen() {
  if (S.currentScreen === 'dashboard') renderDashboard();
  else if (S.currentScreen === 'notes') { renderFolderTree(); renderNotesList(); }
  else if (S.currentScreen === 'progress') renderProgress();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', S.settings.theme || 'dark');
  document.documentElement.setAttribute('data-font', S.settings.fontSize || 'medium');
}
function applySettings() { applyTheme(); }

// ── FOLDER SYSTEM ────────────────────────────────────────
function getFolderChildren(parentId) {
  var pid = parentId || null;
  return S.folders.filter(function(f) {
    return (f.parentId || null) === pid;
  }).sort(function(a, b) {
    if (a.favourite && !b.favourite) return -1;
    if (!a.favourite && b.favourite) return 1;
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (a.order || 0) - (b.order || 0);
  });
}

function getAllFolderIds(folderId) {
  var ids = [folderId];
  S.folders.forEach(function(f) {
    if (f.parentId === folderId) {
      var sub = getAllFolderIds(f.id);
      for (var i = 0; i < sub.length; i++) ids.push(sub[i]);
    }
  });
  return ids;
}

function getFolderDocCount(folderId) {
  var ids = getAllFolderIds(folderId);
  return S.documents.filter(function(d) { return ids.indexOf(d.folderId) >= 0; }).length;
}

function getFolderDueCount(folderId) {
  var ids = getAllFolderIds(folderId);
  var count = 0;
  S.documents.forEach(function(d) {
    if (ids.indexOf(d.folderId) >= 0) {
      (d.items || []).forEach(function(i) { if (isDue(i) && isFC(i)) count++; });
    }
  });
  return count;
}

function getFolderDocs(folderId) {
  var ids = getAllFolderIds(folderId);
  return S.documents.filter(function(d) { return ids.indexOf(d.folderId) >= 0; });
}

function getFolderCards(folderId) {
  var result = [];
  getFolderDocs(folderId).forEach(function(d) {
    (d.items || []).forEach(function(it) {
      if (isFC(it)) result.push({ id: it.id, content: it.content, level: it.level, srs: it.srs, highlighted: it.highlighted, _d: d.id, _dn: d.title });
    });
  });
  return result;
}

function getFolderPath(folderId) {
  var parts = [];
  var id = folderId;
  while (id) {
    var f = null;
    for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === id) { f = S.folders[i]; break; } }
    if (!f) break;
    parts.unshift(f.name);
    id = f.parentId || null;
  }
  return parts.join(' / ');
}

var expandedFolders = {};

function renderFolderTree() {
  var tree = $('folder-tree');
  if (!tree) return;
  var favFolders = S.folders.filter(function(f) { return f.favourite; });
  var pinnedFolders = S.folders.filter(function(f) { return f.pinned; });
  var allDocCount = S.documents.filter(function(d) { return !d.archived; }).length;

  function specialItem(filter, icon, label, count) {
    var active = (!S.activeFolderId && S.notesFilter === filter) ? ' active' : '';
    return '<div class="folder-special' + active + '" onclick="setFolderFilter(null,\'' + filter + '\')">' +
      icon + ' ' + label +
      '<span style="margin-left:auto;font-size:9px;background:var(--s3);padding:1px 5px;border-radius:5px;color:var(--t2)">' + count + '</span>' +
      '</div>';
  }

  var html = specialItem('fav', '⭐', 'Favourites', favFolders.length)
    + specialItem('all', '📄', 'All Notes', allDocCount)
    + specialItem('pinned', '📌', 'Pinned', pinnedFolders.length)
    + '<div style="height:1px;background:var(--border);margin:8px 5px;"></div>'
    + '<div style="padding:4px 10px 3px;font-size:9px;font-family:var(--mono);color:var(--t3);text-transform:uppercase;letter-spacing:.1em;display:flex;align-items:center;justify-content:space-between">'
    + '<span>Folders</span>'
    + '<button onclick="showNewFolder(null)" style="background:transparent;border:none;color:var(--t3);cursor:pointer;font-size:15px;padding:0 2px;line-height:1" title="New folder">+</button>'
    + '</div>'
    + renderFolderNodes(null);

  tree.innerHTML = html;
}

function renderFolderNodes(parentId) {
  var children = getFolderChildren(parentId);
  if (!children.length) {
    if (!parentId) return '<div style="padding:8px 12px;font-size:10px;color:var(--t3);font-family:var(--mono)">No folders yet — tap + above</div>';
    return '';
  }
  var html = '';
  children.forEach(function(f) {
    var due = getFolderDueCount(f.id);
    var cnt = getFolderDocCount(f.id);
    var hasChildren = getFolderChildren(f.id).length > 0;
    var isActive = S.activeFolderId === f.id;
    var isExp = expandedFolders[f.id];
    var icon = f.favourite ? '⭐' : (f.pinned ? '📌' : (f.icon || '📁'));
    var nameStyle = f.color ? 'color:' + f.color + ';font-weight:600' : '';

    html += '<div class="folder-node" id="fn-' + f.id + '">';
    html += '<div class="folder-row' + (isActive ? ' active' : '') + '"'
      + ' onclick="setFolderFilter(\'' + f.id + '\',\'all\')"'
      + ' oncontextmenu="showCtxMenu(event,\'' + f.id + '\')"'
      + ' draggable="true" ondragstart="folderDragStart(event,\'' + f.id + '\')"'
      + ' ondragover="event.preventDefault()" ondrop="dropOnFolder(event,\'' + f.id + '\')">';
    html += '<div class="folder-toggle' + (isExp ? ' open' : '') + '"'
      + ' style="visibility:' + (hasChildren ? 'visible' : 'hidden') + '"'
      + ' onclick="event.stopPropagation();toggleFolderExpand(\'' + f.id + '\')">▶</div>';
    html += '<div class="folder-icon">' + icon + '</div>';
    html += '<div class="folder-name" style="' + nameStyle + '">' + esc(f.name) + '</div>';
    html += '<div class="folder-badges">';
    if (due) html += '<span class="f-badge f-due">' + due + '</span>';
    if (cnt) html += '<span class="f-badge f-cards">' + cnt + '</span>';
    html += '</div></div>';
    html += '<div class="folder-children" id="fc-' + f.id + '" style="' + (isExp ? 'display:block' : 'display:none') + '">';
    if (isExp) html += renderFolderNodes(f.id);
    html += '</div></div>';
  });
  return html;
}

function toggleFolderExpand(id) {
  var el = $('fc-' + id);
  var toggle = document.querySelector('#fn-' + id + ' .folder-toggle');
  if (!el) return;
  if (expandedFolders[id]) {
    delete expandedFolders[id];
    el.style.display = 'none';
    if (toggle) toggle.classList.remove('open');
  } else {
    expandedFolders[id] = true;
    el.style.display = 'block';
    if (toggle) toggle.classList.add('open');
    if (!el.innerHTML.trim()) el.innerHTML = renderFolderNodes(id);
  }
}

function closeMobFolders() {
  var p = document.querySelector('.folder-panel');
  if (p) p.classList.remove('mob-open');
  var bd = $('mob-backdrop');
  if (bd) bd.classList.remove('show');
}
function toggleMobFolders() {
  var p = document.querySelector('.folder-panel');
  if (!p) return;
  var open = p.classList.toggle('mob-open');
  var bd = $('mob-backdrop');
  if (bd) bd.classList.toggle('show', open);
}

function setFolderFilter(folderId, filter) {
  S.activeFolderId = folderId;
  S.notesFilter = filter || 'all';
  closeMobFolders();
  renderFolderTree();
  renderNotesList();
  if (folderId) {
    $('notes-hdr').textContent = getFolderPath(folderId);
  } else {
    var labels = { all: 'Notes', fav: '⭐ Favourites', pinned: '📌 Pinned' };
    $('notes-hdr').textContent = labels[filter] || 'Notes';
  }
}

// ── CONTEXT MENU ─────────────────────────────────────────
var ctxFolderId = null;

function showCtxMenu(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  ctxFolderId = folderId;
  var f = null;
  for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === folderId) { f = S.folders[i]; break; } }
  if (!f) return;
  var due = getFolderDueCount(folderId);
  var html = '<div style="padding:6px 12px 4px;font-size:10px;font-family:var(--mono);color:var(--t3);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">' + esc(f.name) + '</div>';
  html += '<div class="ctx-sep"></div>';
  html += '<div class="ctx-item" onclick="ctxRename()"><span class="ctx-ico">✎</span>Rename Folder</div>';
  html += '<div class="ctx-item" onclick="ctxPin()"><span class="ctx-ico">' + (f.pinned ? '📌' : '📍') + '</span>' + (f.pinned ? 'Unpin Folder' : 'Pin Folder') + '</div>';
  html += '<div class="ctx-item" onclick="ctxFav()"><span class="ctx-ico">' + (f.favourite ? '⭐' : '☆') + '</span>' + (f.favourite ? 'Remove Favourite' : 'Add to Favourites') + '</div>';
  html += '<div class="ctx-sep"></div>';
  html += '<div class="ctx-item" onclick="ctxExportJson()"><span class="ctx-ico">💾</span>Export Folder as JSON</div>';
  html += '<div class="ctx-item" onclick="ctxImportInto()"><span class="ctx-ico">📂</span>Import JSON into Folder</div>';
  html += '<div class="ctx-sep"></div>';
  html += '<div class="ctx-item" onclick="showNewFolder(\'' + folderId + '\')"><span class="ctx-ico">📁</span>Create Sub Folder</div>';
  html += '<div class="ctx-sep"></div>';
  html += '<div class="ctx-item danger" onclick="ctxDelete()"><span class="ctx-ico">🗑</span>Delete Folder</div>';
  $('ctx-body').innerHTML = html;
  var menu = $('ctx-menu');
  menu.style.display = 'block';
  var x = Math.min(e.clientX, window.innerWidth - 220);
  var y = Math.min(e.clientY, window.innerHeight - 360);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideCtx() { $('ctx-menu').style.display = 'none'; ctxFolderId = null; }
document.addEventListener('click', function(e) { if (!e.target.closest('#ctx-menu')) hideCtx(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideCtx(); });

var longPressT;
document.addEventListener('touchstart', function(e) {
  var row = e.target.closest('.folder-row');
  if (!row) return;
  var fn = row.closest('.folder-node');
  if (!fn) return;
  var fid = fn.id.replace('fn-', '');
  longPressT = setTimeout(function() {
    var touch = e.touches[0];
    showCtxMenu({ preventDefault: function(){}, stopPropagation: function(){}, clientX: touch.clientX, clientY: touch.clientY }, fid);
  }, 600);
}, { passive: true });
document.addEventListener('touchend', function() { clearTimeout(longPressT); }, { passive: true });
document.addEventListener('touchmove', function() { clearTimeout(longPressT); }, { passive: true });

function ctxGetF() {
  for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === ctxFolderId) return S.folders[i]; }
  return null;
}

function ctxPin() {
  var f = ctxGetF(); if (!f) return;
  S.folders = S.folders.map(function(x) { return x.id === ctxFolderId ? Object.assign({}, x, { pinned: !x.pinned }) : x; });
  cloudSave(); renderFolderTree(); hideCtx(); toast(f.pinned ? 'Unpinned' : '📌 Pinned to top');
}

function ctxFav() {
  var f = ctxGetF(); if (!f) return;
  S.folders = S.folders.map(function(x) { return x.id === ctxFolderId ? Object.assign({}, x, { favourite: !x.favourite }) : x; });
  cloudSave(); renderFolderTree(); hideCtx(); toast(f.favourite ? 'Removed from Favourites' : '⭐ Added to Favourites');
}

function ctxExportJson() { var fid = ctxFolderId; hideCtx(); exportFolderJson(fid); }
function ctxRename() {
  var f = ctxGetF(); if (!f) return; hideCtx();
  S.editingFolderId = f.id;
  S.newFolderParentId = f.parentId || null;
  $('nf-title').textContent = 'Rename Folder';
  $('nf-name').value = f.name;
  $('nf-icon').value = f.icon || '📁';
  S.selFolderColor = f.color || null;
  var pillsHtml = '';
  FOLDER_COLORS.forEach(function(c) {
    pillsHtml += '<div class="cpill' + (f.color === c ? ' sel' : '') + '" style="background:' + c + '" onclick="selectFolderColor(\'' + c + '\')" title="' + c + '"></div>';
  });
  $('nf-colors').innerHTML = pillsHtml;
  $('new-folder-ov').classList.add('open');
  setTimeout(function() { $('nf-name').focus(); }, 150);
}

function ctxImportInto() {
  var targetId = ctxFolderId; hideCtx();
  var inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,.nvault,.nvault.json';
  inp.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var parsed = JSON.parse(ev.target.result);
        var docs = parsed.documents || (parsed.document ? [parsed.document] : []);
        docs.forEach(function(d) {
          var existing = null;
          for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === d.id) { existing = S.documents[i]; break; } }
          if (existing) {
            var itemMap = {};
            (existing.items || []).forEach(function(it) { itemMap[it.id] = it; });
            (d.items || []).forEach(function(fi) {
              if (itemMap[fi.id]) {
                var li = itemMap[fi.id];
                var merged = Object.assign({}, li, { content: fi.content });
                if (fi.srs && li.srs) {
                  merged.srs = ((fi.srs.lastReviewed || '0') > (li.srs.lastReviewed || '0')) ? fi.srs : li.srs;
                } else if (fi.srs) {
                  merged.srs = fi.srs;
                }
                itemMap[fi.id] = merged;
              } else {
                itemMap[fi.id] = fi;
              }
            });
            var newItems = [];
            for (var k in itemMap) newItems.push(itemMap[k]);
            S.documents = S.documents.map(function(x) { return x.id === d.id ? Object.assign({}, x, { items: newItems }) : x; });
          } else {
            S.documents.push(Object.assign({}, d, { id: d.id || gid(), folderId: targetId, createdAt: now(), updatedAt: now() }));
          }
        });
        cloudSave(); renderFolderTree(); renderNotesList();
        toast('✅ Imported ' + docs.length + ' note(s) into folder');
      } catch(err) { toast('❌ Invalid JSON file'); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

function ctxDelete() {
  var fid = ctxFolderId; hideCtx();
  var f = null; for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === fid) { f = S.folders[i]; break; } }
  if (!f) return;
  showConfirm('🗑 Delete Folder', 'Delete "' + f.name + '" and ALL its notes? Cannot be undone.', function() {
    var allIds = getAllFolderIds(fid);
    S.folders = S.folders.filter(function(x) { return allIds.indexOf(x.id) < 0; });
    S.documents = S.documents.filter(function(d) { return allIds.indexOf(d.folderId) < 0; });
    S.tests = S.tests.filter(function(t) { return allIds.indexOf(t.folderId) < 0; });
    cloudSave(); renderFolderTree(); renderNotesList(); toast('Folder deleted');
  }, 'Delete', 'var(--red)');
}

var dragFolderSrc = null;
function folderDragStart(e, id) { dragFolderSrc = id; }
function dropOnFolder(e, targetId) {
  e.preventDefault();
  if (!dragFolderSrc || dragFolderSrc === targetId) return;
  var src = null, tgt = null;
  S.folders.forEach(function(f) { if (f.id === dragFolderSrc) src = f; if (f.id === targetId) tgt = f; });
  if (!src || !tgt) return;
  S.folders = S.folders.map(function(f) {
    if (f.id === dragFolderSrc) return Object.assign({}, f, { order: tgt.order || 0 });
    if (f.id === targetId) return Object.assign({}, f, { order: src.order || 0 });
    return f;
  });
  cloudSave(); renderFolderTree(); dragFolderSrc = null;
}

// ── FOLDER CREATE / EDIT ─────────────────────────────────
function showNewFolder(parentId) {
  S.editingFolderId = null;
  S.newFolderParentId = parentId;
  $('nf-title').textContent = parentId ? 'New Sub Folder' : 'New Folder';
  $('nf-name').value = '';
  $('nf-icon').value = '📁';
  S.selFolderColor = null;
  var pillsHtml = '';
  FOLDER_COLORS.forEach(function(c) {
    pillsHtml += '<div class="cpill" style="background:' + c + '" onclick="selectFolderColor(\'' + c + '\')" title="' + c + '"></div>';
  });
  $('nf-colors').innerHTML = pillsHtml;
  $('new-folder-ov').classList.add('open');
  setTimeout(function() { $('nf-name').focus(); }, 150);
}

function selectFolderColor(c) {
  S.selFolderColor = c;
  document.querySelectorAll('#nf-colors .cpill').forEach(function(p) { p.classList.toggle('sel', p.style.background === c); });
}

function closeNewFolder() { $('new-folder-ov').classList.remove('open'); S.editingFolderId = null; }

function confirmFolder() {
  var name = ($('nf-name').value || '').trim();
  if (!name) { toast('Enter a folder name'); return; }
  var icon = ($('nf-icon').value || '').trim() || '📁';
  if (S.editingFolderId) {
    S.folders = S.folders.map(function(f) {
      return f.id === S.editingFolderId ? Object.assign({}, f, { name: name, icon: icon, color: S.selFolderColor, updatedAt: now() }) : f;
    });
    cloudSave(); closeNewFolder(); renderFolderTree(); toast('✓ Folder updated');
  } else {
    var fid = gid();
    var f = { id: fid, name: name, icon: icon, color: S.selFolderColor, parentId: S.newFolderParentId || null, pinned: false, favourite: false, archived: false, order: Date.now(), lastReviewed: null, createdAt: now(), updatedAt: now() };
    S.folders.push(f);
    var autoTest = { id: gid(), title: name + '_test', folderId: fid, sourceLabel: name, type: 'mcq', timeLimit: 0, questions: [], scores: [], createdAt: now() };
    S.tests.push(autoTest);
    cloudSave(); closeNewFolder(); renderFolderTree();
    if (S.newFolderParentId && !expandedFolders[S.newFolderParentId]) toggleFolderExpand(S.newFolderParentId);
    toast('📁 Folder created');
  }
}

// ── NOTES LIST ───────────────────────────────────────────
function filterNotes() {
  var raw = ($('notes-search') && $('notes-search').value) || '';
  S.notesGlobalSearch = raw.charAt(0) === '/';
  S.notesSearch = S.notesGlobalSearch ? raw.slice(1) : raw;
  renderNotesList();
}
function toggleFilter(f) {
  S.notesFilter = S.notesFilter === f ? 'all' : f;
  var fp = $('fb-pin'), ff = $('fb-fc');
  if (fp) fp.classList.toggle('active', S.notesFilter === 'pinned');
  if (ff) ff.classList.toggle('active', S.notesFilter === 'flashcards');
  renderNotesList();
}

function buildNoteCard(d) {
  var cards = (d.items || []).filter(function(i) { return i.srs; }).length;
  var due = (d.items || []).filter(function(i) { return isDue(i) && isFC(i); }).length;
  var hl = (d.items || []).filter(function(i) { return i.highlighted; }).length;
  var date = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
  var folder = null;
  for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === d.folderId) { folder = S.folders[i]; break; } }
  var border = (folder && folder.color) ? 'border-left:2px solid ' + folder.color + ';' : '';
  var preview = (d.items || []).filter(function(i) { return i.content.trim(); })[0];
  var previewText = preview ? preview.content.slice(0, 70) : 'Empty';
  var icon = d.icon || '📝';
  var html = '<div class="note-card' + (d.pinned ? ' pinned' : '') + '" style="' + border + '" onclick="openEditor(\'' + d.id + '\')">';
  html += '<div class="nc-title">' + icon + ' ' + esc(d.title || 'Untitled') + '</div>';
  html += '<div class="nc-preview">' + esc(previewText) + '</div>';
  html += '<div class="nc-meta">';
  if (folder) html += '<span class="nc-tag" style="background:' + (folder.color || 'var(--s3)') + ';color:' + (folder.color ? '#fff' : 'var(--t2)') + ';opacity:.85">' + esc((folder.icon || '📁') + ' ' + folder.name) + '</span>';
  (d.tags || []).slice(0, 2).forEach(function(t) { html += '<span class="nc-tag">' + esc(t) + '</span>'; });
  if (cards) html += '<span style="font-size:10px;color:var(--acc);font-family:var(--mono)">🃏' + cards + (due ? ' ⚡' + due : '') + '</span>';
  if (hl) html += '<span style="font-size:10px;color:var(--yellow)">✦' + hl + '</span>';
  html += '<span class="nc-date">' + date + '</span>';
  html += '</div></div>';
  return html;
}

function renderNotesList() {
  var el = $('notes-list');

  if (S.notesFilter === 'pinned') {
    var pf = S.folders.filter(function(f) { return f.pinned; });
    var pd = S.documents.filter(function(d) { return d.pinned; });
    var html = '';
    if (pf.length) {
      html += '<div style="padding:8px 14px 4px;font-size:10px;font-family:var(--mono);color:var(--t3);text-transform:uppercase">Pinned Folders</div>';
      pf.forEach(function(f) {
        var due = getFolderDueCount(f.id), cnt = getFolderDocCount(f.id);
        var cb = f.color ? 'border-left:2px solid ' + f.color : '';
        html += '<div class="note-card" style="' + cb + '" onclick="setFolderFilter(\'' + f.id + '\',\'all\')">';
        html += '<div class="nc-title">' + (f.icon || '📁') + ' ' + esc(f.name) + '</div>';
        html += '<div class="nc-meta">' + (cnt ? '<span class="nc-tag">📝 ' + cnt + '</span>' : '') + (due ? '<span style="font-size:10px;color:var(--acc);font-family:var(--mono)">⚡ ' + due + '</span>' : '') + '</div>';
        html += '</div>';
      });
    }
    if (pd.length) pd.forEach(function(d) { html += buildNoteCard(d); });
    if (!pf.length && !pd.length) html = '<div class="empty-state"><div class="es-ico">📌</div><div class="es-h">Nothing pinned</div><div class="es-s">Right-click a folder to pin it</div></div>';
    el.innerHTML = html;
    return;
  }

  if (S.notesFilter === 'fav') {
    var ff = S.folders.filter(function(f) { return f.favourite; });
    var html = '';
    if (ff.length) {
      html += '<div style="padding:8px 14px 4px;font-size:10px;font-family:var(--mono);color:var(--t3);text-transform:uppercase">Favourite Folders</div>';
      ff.forEach(function(f) {
        var due = getFolderDueCount(f.id), cnt = getFolderDocCount(f.id);
        var cb = f.color ? 'border-left:2px solid ' + f.color : '';
        html += '<div class="note-card" style="' + cb + '" onclick="setFolderFilter(\'' + f.id + '\',\'all\')">';
        html += '<div class="nc-title">⭐ ' + esc(f.name) + '</div>';
        html += '<div class="nc-meta">' + (cnt ? '<span class="nc-tag">📝 ' + cnt + '</span>' : '') + (due ? '<span style="font-size:10px;color:var(--acc);font-family:var(--mono)">⚡ ' + due + '</span>' : '') + '</div>';
        html += '</div>';
      });
      var favIds = ff.map(function(f) { return f.id; });
      var favDocs = S.documents.filter(function(d) { return favIds.indexOf(d.folderId) >= 0; });
      if (favDocs.length) {
        html += '<div style="padding:8px 14px 4px;font-size:10px;font-family:var(--mono);color:var(--t3);text-transform:uppercase">Notes</div>';
        favDocs.forEach(function(d) { html += buildNoteCard(d); });
      }
    } else {
      html = '<div class="empty-state"><div class="es-ico">⭐</div><div class="es-h">No favourites</div><div class="es-s">Right-click a folder → Add to Favourites</div></div>';
    }
    el.innerHTML = html;
    return;
  }

  var docs = S.documents.slice();
  if (S.notesFilter === 'flashcards') {
    docs = docs.filter(function(d) { return (d.items || []).some(function(i) { return i.srs; }); });
  } else {
    if (S.activeFolderId && !S.notesGlobalSearch) {
      var ids = getAllFolderIds(S.activeFolderId);
      docs = docs.filter(function(d) { return ids.indexOf(d.folderId) >= 0; });
    }
  }
  var q = S.notesSearch.toLowerCase();
  if (q) {
    docs = docs.filter(function(d) {
      if ((d.title || '').toLowerCase().indexOf(q) >= 0) return true;
      return (d.items || []).some(function(i) { return i.content.toLowerCase().indexOf(q) >= 0; });
    });
  }
  docs.sort(function(a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || '').localeCompare(a.updatedAt || ''); });
  if (!docs.length) {
    el.innerHTML = '<div class="empty-state"><div class="es-ico">📂</div><div class="es-h">No notes here</div><div class="es-s">Tap + to create a note</div></div>';
    return;
  }
  var html = '';
  docs.forEach(function(d) { html += buildNoteCard(d); });
  el.innerHTML = html;
}

// ── DOC MANAGEMENT ───────────────────────────────────────
function showNewDocSheet(editDocId) {
  var existingDoc = null;
  if (editDocId) {
    for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === editDocId) { existingDoc = S.documents[i]; break; } }
  }
  $('nd-title-h').textContent = editDocId ? 'Edit Note' : 'New Note';
  $('nd-title').value = existingDoc ? (existingDoc.title || '') : '';
  $('nd-tags').value = existingDoc ? (existingDoc.tags || []).join(', ') : '';
  S.selNoteIcon = existingDoc ? (existingDoc.icon || '📝') : '📝';

  var iconHtml = '<div class="field-lbl">Note Icon</div><div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px" id="note-icon-row">';
  NOTE_ICONS.forEach(function(ico) {
    var border = ico === S.selNoteIcon ? 'var(--acc)' : 'var(--border)';
    iconHtml += '<div id="nico-' + ico.codePointAt(0) + '" onclick="selectNoteIcon(\'' + ico + '\')" style="width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:17px;border:2px solid ' + border + ';background:var(--bg)">' + ico + '</div>';
  });
  iconHtml += '</div>';
  $('nd-icon-area').innerHTML = iconHtml;

  var folderOpts = '<option value="">No folder</option>';
  S.folders.forEach(function(f) {
    var sel = '';
    if (existingDoc && existingDoc.folderId === f.id) sel = ' selected';
    else if (!existingDoc && S.activeFolderId === f.id) sel = ' selected';
    folderOpts += '<option value="' + f.id + '"' + sel + '>' + (f.icon || '📁') + ' ' + esc(f.name) + '</option>';
  });
  $('nd-folder').innerHTML = folderOpts;
  $('new-doc-ov').dataset.editId = editDocId || '';
  $('new-doc-ov').classList.add('open');
  setTimeout(function() { $('nd-title').focus(); }, 150);
}

function selectNoteIcon(ico) {
  S.selNoteIcon = ico;
  document.querySelectorAll('#note-icon-row div').forEach(function(el) { el.style.borderColor = 'var(--border)'; });
  var el = document.getElementById('nico-' + ico.codePointAt(0));
  if (el) el.style.borderColor = 'var(--acc)';
}

function closeNewDoc() { $('new-doc-ov').classList.remove('open'); }

function confirmNewDoc() {
  var title = ($('nd-title').value || '').trim() || 'Untitled';
  var tags = ($('nd-tags').value || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  var folderId = $('nd-folder').value || null;
  var editId = $('new-doc-ov').dataset.editId;
  if (editId) {
    S.documents = S.documents.map(function(d) {
      return d.id === editId ? Object.assign({}, d, { title: title, tags: tags, folderId: folderId, icon: S.selNoteIcon, updatedAt: now() }) : d;
    });
    cloudSave(); closeNewDoc();
    if (S.currentScreen === 'editor') renderEditor();
    return;
  }
  var doc = { id: gid(), title: title, icon: S.selNoteIcon || '📝', tags: tags, folderId: folderId, pinned: false, archived: false, items: [{ id: gid(), content: '', level: 0, srs: null, highlighted: false }], createdAt: now(), updatedAt: now() };
  S.documents.unshift(doc);
  S.progress.totalCreated = (S.progress.totalCreated || 0) + 1;
  cloudSave(); closeNewDoc(); openEditor(doc.id);
}

// ── EDITOR ───────────────────────────────────────────────
function getDoc() {
  for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === S.curDocId) return S.documents[i]; }
  return null;
}

function saveDoc(items, title) {
  S.documents = S.documents.map(function(d) {
    if (d.id !== S.curDocId) return d;
    var upd = { updatedAt: now() };
    if (items !== undefined && items !== null) upd.items = items;
    if (title !== undefined) upd.title = title;
    return Object.assign({}, d, upd);
  });
  cloudSave();
}

function openEditor(docId) {
  S.curDocId = docId; S.focIdx = -1; S.undoStack = []; S.redoStack = [];
  renderEditor(); showScreen('editor');
  document.querySelectorAll('.bnav-item').forEach(function(el) { el.classList.remove('active'); });
  var bn = $('bn-notes'); if (bn) bn.classList.add('active');
}

function closeEditor() { hideFT(); nav('notes'); }

function renderEditor() {
  var doc = getDoc(); if (!doc) return;
  var ti = $('ed-title');
  ti.value = doc.title || '';
  ti.oninput = function(e) { saveDoc(null, e.target.value); };

  var el = $('ed-items');
  if (!doc.items || !doc.items.length) {
    el.innerHTML = '<div style="padding:14px 0;font-size:12px;color:var(--t3);font-family:var(--mono)">empty — use toolbar to add items</div>';
    return;
  }
  var html = '';
  doc.items.forEach(function(it, i) {
    var fc = isFC(it), due2 = isDue(it), indent = it.level * 24;
    var badge = '';
    if (fc) {
      if (due2) badge = '<span class="fc-badge fc-due">⚡due</span>';
      else if (it.srs && it.srs.repetitions > 0) badge = '<span class="fc-badge fc-sched">+' + it.srs.interval + 'd</span>';
      else badge = '<span class="fc-badge fc-new">new</span>';
    }
    html += '<div class="item-row" data-i="' + i + '" style="padding-left:' + indent + 'px" draggable="true" ondragstart="dragStart(event,' + i + ')" ondragover="dragOver(event,' + i + ')" ondrop="dragDrop(event,' + i + ')" ondragend="dragEnd()">';
    html += '<div class="item-drag">⣿</div>';
    html += '<div class="item-bullet" onclick="toggleHL(' + i + ')"><div class="bdot' + (it.level > 0 ? ' child' : '') + (it.highlighted ? ' hl' : '') + '"></div></div>';
    html += '<textarea class="item-ta' + (fc ? ' fc' : '') + (it.highlighted ? ' hl' : '') + '" data-i="' + i + '" rows="1" oninput="onInput(this,' + i + ')" onfocus="onFocus(' + i + ')" onkeydown="onKey(event,' + i + ')" placeholder="' + (i === 0 && doc.items.length <= 1 ? 'Start writing… Q >> A for flashcard' : '') + '"></textarea>';
    html += badge;
    html += '<div class="item-acts"><button class="ia-b" onclick="toggleHL(' + i + ')" title="Highlight">✦</button><button class="ia-b" onclick="makeCard(' + i + ')" title="Flashcard">⚡</button><button class="ia-b" onclick="deleteItem(' + i + ')" style="color:var(--red)">✕</button></div>';
    html += '</div>';
  });
  el.innerHTML = html;
  doc.items.forEach(function(it, i) {
    var ta = document.querySelector('.item-ta[data-i="' + i + '"]');
    if (ta) ta.value = it.content;
  });
  setTimeout(resizeAll, 30);
}

function resizeAll() { document.querySelectorAll('.item-ta').forEach(resize); }
function resize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

function pushUndo() {
  var doc = getDoc(); if (!doc) return;
  S.undoStack.push(JSON.stringify(doc.items));
  if (S.undoStack.length > 50) S.undoStack.shift();
  S.redoStack = [];
}

function onInput(el, i) {
  resize(el);
  var doc = getDoc(); if (!doc) return;
  pushUndo();
  var items = doc.items.slice();
  var it = Object.assign({}, items[i], { content: el.value });
  if (el.value.indexOf('>>') >= 0 && !it.srs) {
    it.srs = { repetitions: 0, easeFactor: 2.5, interval: 0, dueDate: today() };
    toast('⚡ Flashcard created!');
  }
  items[i] = it;
  saveDoc(items);
  el.classList.toggle('fc', isFC(it));
}

function onFocus(i) { S.focIdx = i; showFT(); }

function onKey(e, i) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addItemAt(i); }
  else if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) doOutdent(i); else doIndent(i); }
  else if (e.key === 'Backspace' && e.target.value === '') { e.preventDefault(); deleteItem(i); }
  else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); focusItem(i - 1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(i + 1); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); tbUndo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); tbRedo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); tbCard(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); tbHighlight(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); tbSave(); }
}

function focusItem(i) {
  var tas = document.querySelectorAll('.item-ta');
  if (tas[i]) { tas[i].focus(); var v = tas[i].value; tas[i].setSelectionRange(v.length, v.length); }
}

function tbNew() { addItemAt(S.focIdx >= 0 ? S.focIdx : ((getDoc() ? getDoc().items.length - 1 : 0))); }

function addItemAt(i) {
  var doc = getDoc(); if (!doc) return;
  pushUndo();
  var lv = (i >= 0 && i < doc.items.length) ? doc.items[i].level : 0;
  var ni = { id: gid(), content: '', level: lv, srs: null, highlighted: false };
  var items = doc.items.slice(0, i + 1).concat([ni], doc.items.slice(i + 1));
  saveDoc(items); renderEditor(); setTimeout(function() { focusItem(i + 1); }, 40);
}

function doIndent(i) {
  var doc = getDoc(); if (!doc) return;
  var max = i > 0 ? doc.items[i - 1].level + 1 : 0;
  if (doc.items[i].level < max) {
    pushUndo();
    var items = doc.items.map(function(it, j) { return j === i ? Object.assign({}, it, { level: it.level + 1 }) : it; });
    saveDoc(items); renderEditor(); setTimeout(function() { focusItem(i); }, 40);
  }
}

function doOutdent(i) {
  var doc = getDoc(); if (!doc) return;
  if (doc.items[i].level > 0) {
    pushUndo();
    var items = doc.items.map(function(it, j) { return j === i ? Object.assign({}, it, { level: it.level - 1 }) : it; });
    saveDoc(items); renderEditor(); setTimeout(function() { focusItem(i); }, 40);
  }
}

function tbIndent() { if (S.focIdx >= 0) doIndent(S.focIdx); }
function tbOutdent() { if (S.focIdx >= 0) doOutdent(S.focIdx); }

function makeCard(i) {
  var doc = getDoc(); if (!doc) return;
  pushUndo();
  var items = doc.items.map(function(it, j) {
    if (j !== i) return it;
    var content = it.content.indexOf('>>') >= 0 ? it.content : it.content + (it.content.trim() ? '  >>  ' : ' >>  ');
    var srs = it.srs || { repetitions: 0, easeFactor: 2.5, interval: 0, dueDate: today() };
    return Object.assign({}, it, { content: content, srs: srs });
  });
  saveDoc(items); renderEditor(); setTimeout(function() { focusItem(i); }, 40); toast('⚡ Flashcard created!');
}

function tbCard() { if (S.focIdx >= 0) makeCard(S.focIdx); }

function toggleHL(i) {
  var doc = getDoc(); if (!doc) return;
  var items = doc.items.map(function(it, j) { return j === i ? Object.assign({}, it, { highlighted: !it.highlighted }) : it; });
  saveDoc(items); renderEditor(); setTimeout(function() { focusItem(i); }, 40);
}
function tbHighlight() { if (S.focIdx >= 0) toggleHL(S.focIdx); }

function deleteItem(i) {
  var doc = getDoc(); if (!doc) return;
  if (doc.items.length <= 1) { toast("Can't delete last item"); return; }
  pushUndo();
  var nf = Math.max(0, i - 1);
  var items = doc.items.filter(function(_, j) { return j !== i; });
  saveDoc(items); renderEditor(); setTimeout(function() { focusItem(nf); }, 40);
}
function tbDel() { if (S.focIdx >= 0) deleteItem(S.focIdx); }

function tbUndo() {
  if (!S.undoStack.length) { toast('Nothing to undo'); return; }
  var doc = getDoc(); if (!doc) return;
  S.redoStack.push(JSON.stringify(doc.items));
  saveDoc(JSON.parse(S.undoStack.pop())); renderEditor(); toast('↩ Undone');
}

function tbRedo() {
  if (!S.redoStack.length) { toast('Nothing to redo'); return; }
  var doc = getDoc(); if (!doc) return;
  S.undoStack.push(JSON.stringify(doc.items));
  saveDoc(JSON.parse(S.redoStack.pop())); renderEditor(); toast('↪ Redone');
}

function toggleFocus() {
  S.settings.focusMode = !S.settings.focusMode;
  var d = S.settings.focusMode ? 'none' : 'flex';
  $('ed-toolbar').style.display = d;
  var tb2 = $('ed-toolbar-2'); if (tb2) tb2.style.display = d;
  var fb = $('focus-btn'); if (fb) fb.classList.toggle('on', S.settings.focusMode);
  toast(S.settings.focusMode ? 'Focus mode on' : 'Focus mode off');
}

var dragIdx = -1;
function dragStart(e, i) { dragIdx = i; }
function dragEnd() { document.querySelectorAll('.item-row').forEach(function(r) { r.classList.remove('drag-over'); }); dragIdx = -1; }
function dragOver(e, i) {
  e.preventDefault(); if (dragIdx === i) return;
  document.querySelectorAll('.item-row').forEach(function(r) { r.classList.remove('drag-over'); });
  e.currentTarget.classList.add('drag-over');
}
function dragDrop(e, i) {
  e.preventDefault(); if (dragIdx < 0 || dragIdx === i) return;
  var doc = getDoc(); if (!doc) return;
  pushUndo();
  var items = doc.items.slice();
  var moved = items.splice(dragIdx, 1)[0];
  items.splice(i, 0, moved);
  saveDoc(items); renderEditor(); dragIdx = -1;
}

function showFT() { document.getElementById('ftoolbar').classList.add('on'); }
function hideFT() { document.getElementById('ftoolbar').classList.remove('on'); S.focIdx = -1; }

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', function() {
    var ft = document.getElementById('ftoolbar'); if (!ft.classList.contains('on')) return;
    var kbH = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
    ft.style.bottom = Math.max(0, kbH) + 'px';
  });
}
$('ed-content').addEventListener('touchstart', function(e) {
  if (!e.target.closest('.item-ta') && !e.target.closest('#ftoolbar')) hideFT();
}, { passive: true });

function showEdMenu() {
  var doc = getDoc(); if (!doc) return;
  $('ed-menu-h').textContent = doc.title || 'Untitled';
  function btn(action, txt, isDanger) {
    var bg = isDanger ? '#1a0c0c' : 'var(--s2)';
    var border = isDanger ? '#3a1818' : 'var(--border)';
    var color = isDanger ? 'var(--red)' : 'var(--text)';
    return '<button onclick="edMenuAct(\'' + action + '\')" style="display:flex;align-items:center;gap:9px;width:100%;background:' + bg + ';border:1px solid ' + border + ';border-radius:10px;padding:12px;color:' + color + ';font-size:12px;cursor:pointer;font-family:var(--body);text-align:left;margin-bottom:7px">' + txt + '</button>';
  }
  $('ed-menu-body').innerHTML = btn('pin', doc.pinned ? '📌 Unpin' : '📌 Pin this note', false)
    + btn('edit', '✎ Edit title, icon & tags', false)
    + btn('review', '▶ Review this note\'s cards', false)
    + btn('export', '💾 Export as JSON', false)
    + btn('delete', '🗑 Delete note', true);
  $('ed-menu-ov').classList.add('open');
}

function closeEdMenu() { $('ed-menu-ov').classList.remove('open'); }

function edMenuAct(a) {
  closeEdMenu();
  var doc = getDoc(); if (!doc) return;
  if (a === 'pin') {
    S.documents = S.documents.map(function(d) { return d.id === S.curDocId ? Object.assign({}, d, { pinned: !d.pinned }) : d; });
    cloudSave(); toast(doc.pinned ? 'Unpinned' : '📌 Pinned');
  } else if (a === 'review') {
    showRvModeSelector(null, doc.id);
  } else if (a === 'edit') {
    showNewDocSheet(S.curDocId);
  } else if (a === 'export') {
    exportDocJson(S.curDocId);
  } else if (a === 'delete') {
    showConfirm('🗑 Delete Note', 'Delete "' + doc.title + '"? Cannot be undone.', function() {
      S.documents = S.documents.filter(function(d) { return d.id !== S.curDocId; });
      cloudSave(); closeEditor(); toast('Deleted');
    }, 'Delete', 'var(--red)');
  }
}

// ── REVIEW ───────────────────────────────────────────────
function showRvModeSelector(folderId, docId) {
  S.rvFolderScope = folderId;
  S.rvDocScope = docId;
  S.rvMode = 'due';
  S.rvLen = 5;
  var cards = [];
  if (docId) {
    var d = null; for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === docId) { d = S.documents[i]; break; } }
    if (d) (d.items || []).forEach(function(it) { if (isFC(it)) cards.push(Object.assign({}, it, { _d: d.id, _dn: d.title })); });
  } else if (folderId) {
    cards = getFolderCards(folderId);
  } else {
    S.documents.forEach(function(d) {
      (d.items || []).forEach(function(it) { if (isFC(it)) cards.push(Object.assign({}, it, { _d: d.id, _dn: d.title })); });
    });
  }
  var due = cards.filter(isDue).length;
  var weak = cards.filter(function(c) { return c.srs && c.srs.easeFactor < 2.2; }).length;
  var title = folderId ? ('Review: ' + getFolderPath(folderId)) : (docId ? 'Review: Note' : 'Review All');
  $('rv-mode-title').textContent = title;
  $('rv-mode-sub').textContent = cards.length + ' cards · ' + due + ' due · ' + weak + ' weak';
  selRvMode('due'); selRvLen(5);
  $('rv-mode-ov').classList.add('open');
}

function selRvMode(m) {
  S.rvMode = m;
  document.querySelectorAll('.rv-mode-opt').forEach(function(el) { el.classList.remove('sel'); });
  var el = $('rmo-' + m); if (el) el.classList.add('sel');
  var wrap = $('rv-custom-folder-wrap'); if (!wrap) return;
  if (m === 'custom') {
    wrap.style.display = 'block';
    var opts = '<option value="">— Choose a folder —</option>';
    S.folders.forEach(function(f) {
      var cards = getFolderCards(f.id).length;
      var due = getFolderDueCount(f.id);
      opts += '<option value="' + f.id + '">' + (f.icon || '📁') + ' ' + esc(f.name) + ' (' + cards + ' cards' + (due ? ', ⚡' + due : '') + ')</option>';
    });
    $('rv-custom-folder-sel').innerHTML = opts;
    $('rv-custom-folder-info').textContent = 'Select a folder above';
  } else {
    wrap.style.display = 'none';
  }
}

function onRvCustomFolder(fid) {
  if (!fid) { $('rv-custom-folder-info').textContent = 'Select a folder above'; return; }
  var cards = getFolderCards(fid);
  var due = cards.filter(isDue).length;
  var weak = cards.filter(function(c) { return c.srs && c.srs.easeFactor < 2.2; }).length;
  var f = null; for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === fid) { f = S.folders[i]; break; } }
  $('rv-custom-folder-info').textContent = (f ? f.name : 'Folder') + ' · ' + cards.length + ' flashcards · ⚡ ' + due + ' due · 🎯 ' + weak + ' weak';
  S.rvFolderScope = fid;
}

function selRvLen(n) {
  S.rvLen = n;
  document.querySelectorAll('.rv-len-btn').forEach(function(el) { el.classList.remove('sel'); });
  var vals = [5, 10, 20, 999];
  var btns = document.querySelectorAll('.rv-len-btn');
  vals.forEach(function(v, i) { if (v === n && btns[i]) btns[i].classList.add('sel'); });
}

function closeRvMode() { $('rv-mode-ov').classList.remove('open'); }

function startReviewSession() {
  if (S.rvMode === 'custom') {
    var sel = $('rv-custom-folder-sel');
    var fid = sel && sel.value;
    if (!fid) { toast('Please select a folder first'); return; }
    S.rvFolderScope = fid;
  }
  closeRvMode();
  var cards = [];
  if (S.rvDocScope) {
    var d = null; for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === S.rvDocScope) { d = S.documents[i]; break; } }
    if (d) (d.items || []).forEach(function(it) { if (isFC(it)) cards.push(Object.assign({}, it, { _d: d.id, _dn: d.title })); });
  } else if (S.rvFolderScope) {
    cards = getFolderCards(S.rvFolderScope);
  } else {
    S.documents.forEach(function(d) {
      (d.items || []).forEach(function(it) { if (isFC(it)) cards.push(Object.assign({}, it, { _d: d.id, _dn: d.title })); });
    });
  }
  if (S.rvMode === 'due') cards = cards.filter(isDue);
  else if (S.rvMode === 'weak') cards = cards.filter(function(c) { return c.srs && c.srs.easeFactor < 2.2; });
  // Shuffle
  for (var i = cards.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = cards[i]; cards[i] = cards[j]; cards[j] = tmp;
  }
  if (S.rvLen < 999) cards = cards.slice(0, S.rvLen);
  if (!cards.length) { toast('No cards match the selected criteria'); return; }
  S.rvCards = cards; S.rvIdx = 0; S.rvShowAns = false; S.rvSessionCount = 0;
  renderRvCard(); showScreen('review');
  document.querySelectorAll('.bnav-item').forEach(function(el) { el.classList.remove('active'); });
  var bn = $('bn-review'); if (bn) bn.classList.add('active');
}

function exitReview() { nav('dashboard'); }

function renderRvCard() {
  var total = S.rvCards.length;
  $('rv-ctr').textContent = (S.rvIdx + 1) + '/' + total;
  $('rv-prog').style.width = ((S.rvIdx / total) * 100) + '%';
  if (S.rvIdx >= total) { showRvDone(); return; }
  var card = S.rvCards[S.rvIdx];
  var pfc = parseFC(card.content);
  var html = '<div class="rv-container fade-in">';
  html += '<div style="width:100%;max-width:540px">';
  html += '<div class="rv-card" id="rv-card">';
  html += '<div class="rv-src">' + esc(card._dn || '') + '</div>';
  html += '<div class="rv-q">' + esc(pfc.q) + '</div>';
  if (S.rvShowAns) {
    html += '<div class="rv-sep"></div><div class="rv-a-lbl">Answer</div>';
    html += '<div class="rv-a">' + esc(pfc.a || '(no answer)') + '</div>';
  }
  html += '</div></div>';
  html += '<div style="font-size:10px;color:var(--t3);font-family:var(--mono);text-align:center">← swipe to skip &nbsp;·&nbsp; swipe right = easy</div>';
  if (!S.rvShowAns) {
    html += '<button class="reveal-btn" onclick="rvReveal()">Tap to Reveal ↓</button>';
  } else {
    html += '<div style="font-size:10px;color:var(--t3);font-family:var(--mono);text-align:center;margin-bottom:4px">How well did you recall this?</div>';
    html += '<div class="rate-row">';
    html += '<button class="rate-btn" onclick="rvRate(1)" style="background:#1a0c0c;color:var(--red);border-color:#3a1818">Again<br><small>forgot</small></button>';
    html += '<button class="rate-btn" onclick="rvRate(2)" style="background:#1a140c;color:var(--orange);border-color:#3a2818">Hard<br><small>tough</small></button>';
    html += '<button class="rate-btn" onclick="rvRate(3)" style="background:#0c1a0c;color:var(--acc);border-color:#183818">Good<br><small>ok</small></button>';
    html += '<button class="rate-btn" onclick="rvRate(4)" style="background:#0c1428;color:var(--blue);border-color:#182840">Easy<br><small>quick</small></button>';
    html += '<button class="rate-btn" onclick="rvRate(5)" style="background:#0c1828;color:var(--acc2);border-color:#183040">★<br><small>perfect</small></button>';
    html += '</div>';
  }
  html += '<button onclick="exitReview()" style="background:transparent;border:none;color:var(--t3);cursor:pointer;font-family:var(--mono);font-size:10px;padding:5px">← exit</button>';
  html += '</div>';
  $('rv-content').innerHTML = html;
  setupSwipe();
}

function rvReveal() { S.rvShowAns = true; renderRvCard(); }

function rvRate(q) {
  var card = S.rvCards[S.rvIdx];
  var ns = sm2(q, card.srs);
  // Update the SRS data for this card in documents
  S.documents = S.documents.map(function(d) {
    if (d.id !== card._d) return d;
    var newItems = (d.items || []).map(function(it) {
      if (it.id !== card.id) return it;
      return Object.assign({}, it, { srs: ns });
    });
    return Object.assign({}, d, { items: newItems });
  });
  // Update folder lastReviewed
  for (var i = 0; i < S.documents.length; i++) {
    if (S.documents[i].id === card._d && S.documents[i].folderId) {
      var fid = S.documents[i].folderId;
      S.folders = S.folders.map(function(f) { return f.id === fid ? Object.assign({}, f, { lastReviewed: today() }) : f; });
      break;
    }
  }
  S.progress.totalReviewed = (S.progress.totalReviewed || 0) + 1;
  S.progress.dailyReviewed = S.progress.dailyReviewed || {};
  S.progress.dailyReviewed[today()] = (S.progress.dailyReviewed[today()] || 0) + 1;
  S.rvSessionCount++;
  cloudSave();
  if (S.rvIdx < S.rvCards.length - 1) { S.rvIdx++; S.rvShowAns = false; renderRvCard(); }
  else showRvDone();
}

function showRvDone() {
  updateStreak();
  $('rv-prog').style.width = '100%';
  $('rv-ctr').textContent = '✓ done';
  $('rv-content').innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:48px 24px;text-align:center;gap:14px">'
    + '<div style="font-size:52px">🎉</div>'
    + '<div style="font-family:var(--head);font-size:20px;font-weight:700;color:var(--acc)">Session complete!</div>'
    + '<div style="font-size:13px;color:var(--t2);line-height:1.6">Reviewed ' + S.rvSessionCount + ' card' + (S.rvSessionCount !== 1 ? 's' : '') + '.<br>🔥 Streak: ' + S.progress.currentStreak + ' day' + (S.progress.currentStreak !== 1 ? 's' : '') + '</div>'
    + '<button onclick="exitReview()" style="background:var(--acc);border:none;border-radius:11px;color:var(--bg);padding:12px 28px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--head)">Back to Home</button>'
    + '</div>';
}

function setupSwipe() {
  var card = $('rv-card'); if (!card) return;
  var sx = 0;
  card.addEventListener('touchstart', function(e) { sx = e.touches[0].clientX; }, { passive: true });
  card.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 60) {
      if (dx > 0) { card.classList.add('swipe-r'); setTimeout(function() { rvRate(4); }, 280); }
      else { card.classList.add('swipe-l'); setTimeout(function() { rvRate(1); }, 280); }
    }
  }, { passive: true });
}

// ── EXPORT ───────────────────────────────────────────────
function dlFile(content, name, type) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: type }));
  a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function exportFolderJson(folderId) {
  var f = null;
  for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === folderId) { f = S.folders[i]; break; } }
  if (!f) { toast('❌ Folder not found'); return; }
  var allIds = getAllFolderIds(folderId);
  // subFolders = all descendants (not the root folder itself, which is stored separately as "folder")
  var subFolders = S.folders.filter(function(x) { return allIds.indexOf(x.id) >= 0 && x.id !== folderId; });
  var docs = S.documents.filter(function(d) { return allIds.indexOf(d.folderId) >= 0; });
  var data = {
    exportType: 'notevault-folder', version: 5,
    exportedAt: now(), exportedBy: (S.user && S.user.email) || 'anonymous',
    folder: f, subFolders: subFolders, documents: docs
  };
  var filename = (f.name || 'folder').replace(/[^a-z0-9_\-]/gi, '_') + '-' + today() + '.nvault.json';
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  toast('💾 Exported ' + (subFolders.length + 1) + ' folder(s) + ' + docs.length + ' note(s)');
}

function exportDocJson(docId) {
  var doc = null; for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === docId) { doc = S.documents[i]; break; } }
  if (!doc) return;
  var data = { exportType: 'notevault-doc', version: 5, exportedAt: now(), exportedBy: (S.user && S.user.email) || 'anonymous', document: doc };
  dlFile(JSON.stringify(data, null, 2), (doc.title || 'note') + '-' + today() + '.nvault.json', 'application/json');
  toast('💾 Exported as JSON');
}

function exportAllJson() {
  var data = { exportType: 'notevault-full', version: 5, exportedAt: now(), exportedBy: (S.user && S.user.email) || 'anonymous', documents: S.documents, folders: S.folders, tests: S.tests, progress: S.progress };
  dlFile(JSON.stringify(data, null, 2), 'notevault-full-' + today() + '.nvault.json', 'application/json');
  toast('💾 Full export saved');
}

// ── IMPORT ───────────────────────────────────────────────
function showImport() {
  $('import-info').style.display = 'none';
  $('import-merge-opts').style.display = 'none';
  S.importPending = null; S.mergeMode = 'merge';
  $('import-ov').classList.add('open');
}
function closeImport() { $('import-ov').classList.remove('open'); }

function selMerge(m) {
  S.mergeMode = m;
  ['merge','replace','folder'].forEach(function(x) {
    var el = $('mo-' + x); if (el) el.classList.toggle('sel', x === m);
  });
}

function handleFileImport(input) {
  var file = input.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var parsed = JSON.parse(e.target.result);
      S.importPending = { data: parsed };
      var allDocs = parsed.documents || (parsed.document ? [parsed.document] : []);
      var allFolders = parsed.folders || (parsed.folder ? [parsed.folder].concat(parsed.subFolders || []) : (parsed.subFolders || []));
      var cardCount = 0;
      allDocs.forEach(function(d) { (d.items || []).forEach(function(it) { if (it.srs) cardCount++; }); });
      var info = '';
      if (parsed.exportType === 'notevault-folder') info = '📁 Folder: <strong>' + esc((parsed.folder && parsed.folder.name) || '?') + '</strong><br>' + allFolders.length + ' folder(s) · ' + allDocs.length + ' notes · ' + cardCount + ' flashcards';
      else if (parsed.exportType === 'notevault-doc') info = '📝 Note: <strong>' + esc((parsed.document && parsed.document.title) || '?') + '</strong><br>' + cardCount + ' flashcards';
      else if (parsed.exportType === 'notevault-full') info = '📦 Full export: ' + allDocs.length + ' notes · ' + allFolders.length + ' folders · ' + cardCount + ' flashcards';
      else info = '✅ ' + allDocs.length + ' notes · ' + allFolders.length + ' folders · ' + cardCount + ' flashcards detected';
      var at = parsed.exportedAt ? ('Exported ' + new Date(parsed.exportedAt).toLocaleString() + '<br>') : '';
      $('import-info').innerHTML = at + info;
      $('import-info').style.display = 'block';
      $('import-merge-opts').style.display = 'block';
      selMerge('merge');
    } catch(err) { toast('❌ Invalid JSON file: ' + err.message); }
  };
  reader.readAsText(file);
  input.value = '';
}

function confirmImport() {
  var pending = S.importPending; if (!pending) { toast('Choose a file first'); return; }
  var data = pending.data;
  if (S.mergeMode === 'replace') {
    if (data.documents) S.documents = data.documents;
    if (data.folders) S.folders = data.folders;
    if (data.tests) S.tests = data.tests;
    cloudSave(); closeImport(); toast('✅ Data replaced');
  } else if (S.mergeMode === 'folder') {
    importAsNewFolder(data);
  } else {
    smartMerge(data); cloudSave(); closeImport(); toast('✅ Merged successfully');
  }
  S.importPending = null; renderFolderTree(); renderNotesList();
}

function importAsNewFolder(data) {
  var idMap = {};
  function remapId(old) { if (!idMap[old]) idMap[old] = gid(); return idMap[old]; }
  var srcFolders = [], srcDocs = [];
  if (data.exportType === 'notevault-folder') {
    srcFolders = [data.folder].concat(data.subFolders || []).filter(Boolean);
    srcDocs = data.documents || [];
  } else if (data.exportType === 'notevault-doc') {
    srcDocs = [data.document].filter(Boolean);
  } else {
    srcFolders = data.folders || [];
    srcDocs = data.documents || [];
  }
  srcFolders.forEach(function(f) { remapId(f.id); });
  var srcFolderIds = srcFolders.map(function(f) { return f.id; });
  var roots = srcFolders.filter(function(f) { return !f.parentId || srcFolderIds.indexOf(f.parentId) < 0; });
  var containerId = null;
  if (srcFolders.length === 0 || roots.length > 1) {
    containerId = gid();
    S.folders.push({ id: containerId, name: 'Import ' + new Date().toLocaleDateString(), icon: '📥', color: '#4a9eff', parentId: null, pinned: false, favourite: false, archived: false, order: Date.now(), lastReviewed: null, createdAt: now(), updatedAt: now() });
  }
  srcFolders.forEach(function(f) {
    var isRoot = roots.indexOf(f) >= 0;
    var newParent = null;
    if (f.parentId && srcFolderIds.indexOf(f.parentId) >= 0) newParent = remapId(f.parentId);
    else if (isRoot && containerId) newParent = containerId;
    S.folders.push(Object.assign({}, f, { id: remapId(f.id), parentId: newParent, pinned: false, favourite: false, archived: false, createdAt: now(), updatedAt: now() }));
  });
  srcDocs.forEach(function(d) {
    var newFolderId = null;
    if (d.folderId && srcFolderIds.indexOf(d.folderId) >= 0) newFolderId = remapId(d.folderId);
    else if (containerId) newFolderId = containerId;
    else if (roots[0]) newFolderId = remapId(roots[0].id);
    S.documents.push(Object.assign({}, d, { id: gid(), folderId: newFolderId, createdAt: now(), updatedAt: now() }));
  });
  cloudSave(); closeImport();
  toast('📥 Imported ' + srcFolders.length + ' folder(s) · ' + srcDocs.length + ' note(s)');
  renderFolderTree(); renderNotesList();
}

function smartMerge(data) {
  var srcFolders = [], srcDocs = [];
  if (data.exportType === 'notevault-folder') {
    srcFolders = [data.folder].concat(data.subFolders || []).filter(Boolean);
    srcDocs = data.documents || [];
  } else if (data.exportType === 'notevault-doc') {
    srcDocs = [data.document].filter(Boolean);
  } else {
    srcFolders = data.folders || [];
    srcDocs = data.documents || [];
  }
  var existingFIds = {};
  S.folders.forEach(function(f) { existingFIds[f.id] = true; });
  srcFolders.forEach(function(f) { if (!existingFIds[f.id]) S.folders.push(Object.assign({}, f, { createdAt: f.createdAt || now() })); });
  var docMap = {};
  S.documents.forEach(function(d) { docMap[d.id] = d; });
  srcDocs.forEach(function(fd) {
    if (docMap[fd.id]) {
      var ld = docMap[fd.id];
      var itemMap = {};
      (ld.items || []).forEach(function(it) { itemMap[it.id] = it; });
      (fd.items || []).forEach(function(fi) {
        if (itemMap[fi.id]) {
          var li = itemMap[fi.id];
          var merged = Object.assign({}, li, { content: fi.content });
          if (fi.srs && li.srs) {
            merged.srs = ((fi.srs.lastReviewed || '0') > (li.srs.lastReviewed || '0')) ? fi.srs : li.srs;
          } else if (fi.srs) {
            merged.srs = fi.srs;
          }
          itemMap[fi.id] = merged;
        } else {
          itemMap[fi.id] = fi;
        }
      });
      var newItems = [];
      for (var k in itemMap) newItems.push(itemMap[k]);
      docMap[fd.id] = Object.assign({}, ld, { items: newItems });
    } else {
      docMap[fd.id] = fd;
    }
  });
  var newDocs = [];
  for (var k in docMap) newDocs.push(docMap[k]);
  S.documents = newDocs;
}

// ── DASHBOARD ────────────────────────────────────────────
function renderDashboard() {
  var allItems = [];
  S.documents.forEach(function(d) { (d.items || []).forEach(function(it) { allItems.push(it); }); });
  var due = allItems.filter(function(i) { return isDue(i) && isFC(i); }).length;
  var totalCards = allItems.filter(function(i) { return i.srs; }).length;
  var todayRev = (S.progress.dailyReviewed && S.progress.dailyReviewed[today()]) || 0;
  var goal = S.settings.dailyGoal || 20;
  var pct = Math.min(100, Math.round(todayRev / goal * 100));
  $('goal-lbl').textContent = 'Daily goal: ' + todayRev + '/' + goal;
  $('goal-pct').textContent = pct + '%';
  $('goal-bar').style.width = pct + '%';
  var dc = $('sb-due'), bnd = $('bn-due');
  if (dc) { dc.style.display = due > 0 ? 'inline' : 'none'; dc.textContent = due; }
  if (bnd) { bnd.style.display = due > 0 ? 'flex' : 'none'; bnd.textContent = due; }
  var cards = [
    { ico: '🔥', n: S.progress.currentStreak || 0, l: 'Day Streak', sub: 'Keep it going!', color: '#009978' },
    { ico: '⚡', n: due, l: 'Cards Due', sub: 'Tap to review', action: "nav('review')" },
    { ico: '📁', n: S.folders.length, l: 'Folders', sub: S.documents.length + ' notes' },
    { ico: '🃏', n: totalCards, l: 'Flashcards', sub: Math.round((totalCards - due) / Math.max(1, totalCards) * 100) + '% mastered' },
    { ico: '⭐', n: S.folders.filter(function(f) { return f.favourite; }).length, l: 'Favourites', sub: 'starred folders' },
    { ico: '🎯', n: S.progress.totalReviewed || 0, l: 'Total Reviewed', sub: 'All time' }
  ];
  var gridHtml = '';
  cards.forEach(function(c) {
    gridHtml += '<div class="dash-card"' + (c.action ? ' onclick="' + c.action + '"' : '') + '>';
    gridHtml += '<div class="dc-ico">' + c.ico + '</div>';
    gridHtml += '<div class="dc-n"' + (c.color ? ' style="color:' + c.color + '"' : '') + '>' + c.n + '</div>';
    gridHtml += '<div class="dc-l">' + c.l + '</div><div class="dc-sub">' + c.sub + '</div></div>';
  });
  $('dash-grid').innerHTML = gridHtml;
  var recent = S.documents.slice().sort(function(a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); }).slice(0, 5);
  var recentHtml = '';
  recent.forEach(function(d) {
    var preview = (d.items || []).filter(function(i) { return i.content.trim(); })[0];
    var previewText = preview ? preview.content.slice(0, 70) : 'Empty';
    recentHtml += '<div style="padding:9px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s" onclick="openEditor(\'' + d.id + '\')" onmouseover="this.style.background=\'var(--s2)\'" onmouseout="this.style.background=\'\'">';
    recentHtml += '<div style="font-family:var(--head);font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px">' + (d.icon || '📝') + ' ' + esc(d.title || 'Untitled') + '</div>';
    recentHtml += '<div style="font-size:10px;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(previewText) + '</div></div>';
  });
  $('recent-notes').innerHTML = recentHtml || '<div style="padding:16px 14px;font-size:11px;color:var(--t3);font-family:var(--mono)">No notes yet.</div>';
}

function quickAdd() {
  var inp = $('quick-inp');
  var content = (inp.value || '').trim();
  if (!content) return;
  var fc = content.indexOf('>>') >= 0;
  var item = { id: gid(), content: content, level: 0, srs: fc ? { repetitions: 0, easeFactor: 2.5, interval: 0, dueDate: today() } : null, highlighted: false };
  var pfc = parseFC(content);
  var folderId = S.activeFolderId || (S.folders[0] && S.folders[0].id) || null;
  var doc = { id: gid(), title: fc ? (pfc.q.slice(0, 40) || 'Flashcard') : 'Quick Note', icon: '📝', folderId: folderId, tags: [], pinned: false, archived: false, items: [item], createdAt: now(), updatedAt: now() };
  S.documents.unshift(doc);
  S.progress.totalCreated = (S.progress.totalCreated || 0) + 1;
  cloudSave(); inp.value = ''; renderDashboard();
  toast(fc ? '⚡ Flashcard added!' : '📝 Note added!');
}

// ── PROGRESS ─────────────────────────────────────────────
var progViewYear = new Date().getFullYear();
var progViewMonth = new Date().getMonth();
function prevProgMonth() {
  progViewMonth--; if (progViewMonth < 0) { progViewMonth = 11; progViewYear--; } renderProgress();
}
function nextProgMonth() {
  var cur = new Date();
  if (progViewYear < cur.getFullYear() || (progViewYear === cur.getFullYear() && progViewMonth < cur.getMonth())) {
    progViewMonth++; if (progViewMonth > 11) { progViewMonth = 0; progViewYear++; } renderProgress();
  }
}
function renderProgress() {
  var p = S.progress;
  var allItems = [];
  S.documents.forEach(function(d) { (d.items || []).forEach(function(it) { allItems.push(it); }); });
  var totalCards = allItems.filter(function(i) { return i.srs; }).length;
  var mastered = allItems.filter(function(i) { return i.srs && i.srs.repetitions >= 3; }).length;
  var weak = [];
  S.documents.forEach(function(d) {
    (d.items || []).forEach(function(it) { if (it.srs && it.srs.repetitions < 2 && it.srs.easeFactor < 2.2) weak.push(Object.assign({}, it, { _dn: d.title })); });
  });
  var daily = p.dailyReviewed || {};
  var dailyMins = p.dailyMinutes || {};
  var last30 = [];
  for (var k = 0; k < 30; k++) { var dd = new Date(); dd.setDate(dd.getDate() - 29 + k); last30.push(dd.toISOString().split('T')[0]); }
  var studyDays = last30.filter(function(dk) { return daily[dk] > 0 || dailyMins[dk] > 0; }).length;
  var consistency = Math.round(studyDays / 30 * 100);
  var todayMins = dailyMins[today()] || 0;
  var totalMins = p.totalMinutes || 0;
  // Calendar (dynamic month)
  var year = progViewYear, month = progViewMonth;
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var firstDay = new Date(year, month, 1).getDay();
  var monthName = new Date(year, month, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  var curDate = new Date(); var isFutureMonth = (year > curDate.getFullYear() || (year === curDate.getFullYear() && month > curDate.getMonth()));
  var calCells = '';
  ['S','M','T','W','T','F','S'].forEach(function(d) {
    calCells += '<div style="text-align:center;font-size:8px;font-family:var(--mono);color:var(--t3);padding:2px 0">' + d + '</div>';
  });
  for (var e = 0; e < firstDay; e++) calCells += '<div></div>';
  for (var dd2 = 1; dd2 <= daysInMonth; dd2++) {
    var kk = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(dd2).padStart(2, '0');
    var n = daily[kk] || 0;
    var worked = n > 0 || (dailyMins[kk] || 0) > 0;
    var isToday = kk === today();
    var lvl = n === 0 ? 0 : n < 5 ? 1 : n < 10 ? 2 : n < 20 ? 3 : 4;
    var bg = ['var(--s3)','#0a3028','#0d5040','#10a080','var(--acc)'][lvl];
    var bdr = isToday ? 'border:2px solid var(--acc2)' : 'border:1px solid transparent';
    calCells += '<div title="' + kk + ': ' + n + ' cards" style="width:100%;aspect-ratio:1;border-radius:3px;background:' + bg + ';' + bdr + ';display:flex;align-items:center;justify-content:center">';
    calCells += '<span style="font-size:12px;font-family:var(--mono);color:' + (worked ? '#fff' : 'var(--t3)') + ';font-weight:' + (isToday ? 700 : 500) + ';line-height:1">' + dd2 + '</span></div>';
  }
  // Test scores
  var scores = (p.testScores || []).slice().reverse().slice(0, 8);
  var scoreHtml = '<div class="sec-h">📋 Test Results</div>';
  if (scores.length) {
    scores.forEach(function(s) {
      var pct = s.pct || Math.round((s.score / s.total) * 100) || 0;
      var date = s.date ? new Date(s.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '';
      var col = pct >= 80 ? 'var(--acc)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)';
      scoreHtml += '<div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border)">';
      scoreHtml += '<div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.testTitle || 'Test') + '</div>';
      scoreHtml += '<div style="font-size:9px;color:var(--t3);font-family:var(--mono);margin-top:1px">' + date + ' · ' + s.score + '/' + s.total + '</div></div>';
      scoreHtml += '<div style="width:70px;height:4px;background:var(--s3);border-radius:3px;overflow:hidden;flex-shrink:0"><div style="height:100%;background:' + col + ';width:' + pct + '%"></div></div>';
      scoreHtml += '<div style="font-size:12px;font-weight:700;font-family:var(--mono);color:' + col + ';flex-shrink:0;width:34px;text-align:right">' + pct + '%</div></div>';
    });
  } else {
    scoreHtml += '<div style="padding:14px;font-size:11px;color:var(--t3);font-family:var(--mono)">No tests taken yet</div>';
  }
  // Weak topics html
  var weakHtml = '';
  if (weak.length) {
    weakHtml = '<div class="sec-h">🎯 Weak Topics</div>';
    weak.slice(0, 6).forEach(function(it) {
      var ef = it.srs ? it.srs.easeFactor : 2.5;
      weakHtml += '<div class="weak-item"><div style="flex:1;min-width:0"><div style="font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(parseFC(it.content).q) + '</div><div style="font-size:9px;color:var(--t3);font-family:var(--mono)">' + esc(it._dn) + '</div></div><div class="weak-bar"><div class="weak-fill" style="width:' + Math.max(10, 100 - ef * 20) + '%"></div></div></div>';
    });
  }
  $('progress-content').innerHTML = '<div class="prog-grid">'
    + '<div class="prog-card" style="border-color:#1a3a2a"><div class="prog-n" style="color:var(--acc)">' + (p.currentStreak || 0) + '</div><div class="prog-l">🔥 Streak</div></div>'
    + '<div class="prog-card"><div class="prog-n">' + (p.longestStreak || 0) + '</div><div class="prog-l">Best Streak</div></div>'
    + '<div class="prog-card" style="border-color:#1a2a40"><div class="prog-n" style="color:var(--blue)">' + consistency + '%</div><div class="prog-l">Consistency</div></div>'
    + '<div class="prog-card"><div class="prog-n">' + studyDays + '</div><div class="prog-l">Days (30d)</div></div>'
    + '<div class="prog-card"><div class="prog-n">' + fmtTime(todayMins) + '</div><div class="prog-l">Today</div></div>'
    + '<div class="prog-card"><div class="prog-n">' + fmtTime(totalMins) + '</div><div class="prog-l">Total Time</div></div>'
    + '<div class="prog-card"><div class="prog-n">' + (p.totalReviewed || 0) + '</div><div class="prog-l">Reviewed</div></div>'
    + '<div class="prog-card"><div class="prog-n">' + (totalCards > 0 ? Math.round(mastered / totalCards * 100) : 0) + '%</div><div class="prog-l">Mastered</div></div>'
    + '</div>'
    + '<div style="display:flex;align-items:center;padding:14px 14px 6px;gap:8px">'
    + '<button onclick="prevProgMonth()" style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:4px 10px;color:var(--t2);font-size:12px;cursor:pointer">◀</button>'
    + '<div style="flex:1;font-family:var(--head);font-size:12px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.06em">📅 ' + monthName + '</div>'
    + '<button onclick="nextProgMonth()" style="background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:4px 10px;color:' + (isFutureMonth ? 'var(--t3)' : 'var(--t2)') + ';font-size:12px;cursor:pointer">▶</button>'
    + '</div>'
    + '<div style="padding:0 14px 10px"><div style="display:grid;grid-template-columns:repeat(7,minmax(0,32px));gap:2px;background:var(--s1);padding:6px;border-radius:11px;border:1px solid var(--border);width:fit-content">' + calCells + '</div>'
    + '<div style="display:flex;align-items:center;gap:5px;margin-top:6px;font-size:9px;font-family:var(--mono);color:var(--t3)">'
    + '<div style="width:10px;height:10px;border-radius:2px;background:var(--s3)"></div>none '
    + '<div style="width:10px;height:10px;border-radius:2px;background:#0a3028"></div>low '
    + '<div style="width:10px;height:10px;border-radius:2px;background:#10a080"></div>med '
    + '<div style="width:10px;height:10px;border-radius:2px;background:var(--acc)"></div>high'
    + '</div></div>'
    + (function() {
        var testScores = S.progress.testScores || [];
        var last14 = [];
        for (var ti = 0; ti < 14; ti++) { var td = new Date(); td.setDate(td.getDate() - 13 + ti); last14.push(td.toISOString().split('T')[0]); }
        var ttMap = {};
        testScores.forEach(function(s) { if (!s.date) return; var day = s.date.split('T')[0]; ttMap[day] = (ttMap[day] || 0) + (s.time || 0); });
        var maxT = Math.max(1, Math.max.apply(null, last14.map(function(d) { return ttMap[d] || 0; })));
        var hasData = last14.some(function(d) { return ttMap[d] > 0; });
        var ch = '<div class="sec-h">⏱ Test Time · Last 14 Days</div><div style="padding:4px 14px 14px">';
        ch += '<div style="display:flex;align-items:flex-end;gap:3px;height:72px;background:var(--s1);border:1px solid var(--border);border-radius:10px;padding:6px 8px 0">';
        last14.forEach(function(day) {
          var secs = ttMap[day] || 0;
          var h = secs > 0 ? Math.max(4, Math.round(secs / maxT * 52)) : 2;
          var isT = day === today();
          var col = isT ? 'var(--acc)' : (secs > 0 ? 'var(--blue)' : 'var(--s3)');
          var label = parseInt(day.slice(8));
          ch += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px" title="' + day + (secs > 0 ? ': ' + Math.floor(secs/60) + 'm ' + (secs%60) + 's' : ': no tests') + '">'
            + '<div style="width:100%;height:' + h + 'px;background:' + col + ';border-radius:2px 2px 0 0;margin-top:auto"></div>'
            + '<div style="font-size:8px;font-family:var(--mono);color:var(--t3);line-height:1">' + label + '</div>'
            + '</div>';
        });
        ch += '</div>';
        if (!hasData) ch += '<div style="font-size:10px;color:var(--t3);font-family:var(--mono);padding-top:6px">No test data yet — take a test to see your study time.</div>';
        else ch += '<div style="font-size:9px;color:var(--t3);font-family:var(--mono);padding-top:4px;text-align:right">peak: ' + Math.floor(maxT/60) + 'm ' + (maxT%60) + 's in a day</div>';
        ch += '</div>';
        return ch;
      })()
    + weakHtml + scoreHtml
    + '<div style="height:16px"></div>';
}

// ── TESTS ────────────────────────────────────────────────
function selTestType(t) {
  S.testType = t;
  ['mcq','fill','fc'].forEach(function(x) { var el = $('ct-' + x); if (el) el.classList.toggle('active', x === t); });
}
function selTestSrc(s) {
  S.testSrcType = s;
  ['doc','folder'].forEach(function(x) { var el = $('ct-src-' + x); if (el) el.classList.toggle('active', x === s); });
  $('ct-doc-wrap').style.display = s === 'doc' ? 'block' : 'none';
  $('ct-folder-wrap').style.display = s === 'folder' ? 'block' : 'none';
}
function onTestFolderChange(fid) {
  if (!fid) { $('ct-folder-info').textContent = ''; return; }
  var cards = getFolderCards(fid).filter(isFC);
  var f = null; for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === fid) { f = S.folders[i]; break; } }
  $('ct-folder-info').textContent = (f ? f.name : 'Folder') + ' · ' + getFolderDocCount(fid) + ' notes · ' + cards.length + ' flashcards';
}

function renderTestList() {
  $('test-back-btn').style.display = 'none'; $('create-test-btn').style.display = 'flex'; $('test-hdr').textContent = 'Practice Tests';
  var el = $('test-content');
  if (!S.tests.length) { el.innerHTML = '<div class="empty-state"><div class="es-ico">📋</div><div class="es-h">No tests yet</div><div class="es-s">Tap + to create a test from your notes</div></div>'; return; }
  var html = '';
  S.tests.forEach(function(t) {
    var last = t.scores && t.scores[t.scores.length - 1];
    html += '<div class="test-card" onclick="takeTest(\'' + t.id + '\')">';
    html += '<div class="tc-title">' + esc(t.title) + '</div>';
    html += '<div class="tc-meta"><span>' + ((t.questions && t.questions.length) || 0) + ' Q</span>';
    html += '<span>' + (t.type || '').toUpperCase() + '</span>';
    if (t.timeLimit) html += '<span>⏱' + (t.timeLimit / 60) + 'm</span>';
    if (last) html += '<span class="tc-score">Last: ' + Math.round(last.score / last.total * 100) + '%</span>';
    html += '</div></div>';
  });
  el.innerHTML = html;
}

function showCreateTest() {
  S.testSrcType = 'doc';
  var docOpts = S.documents.map(function(d) { return '<option value="' + d.id + '">' + esc(d.title) + '</option>'; }).join('');
  $('ct-doc').innerHTML = docOpts;
  var folderOpts = '<option value="">— Select folder —</option>';
  S.folders.forEach(function(f) { folderOpts += '<option value="' + f.id + '">' + (f.icon || '📁') + ' ' + esc(f.name) + '</option>'; });
  $('ct-folder').innerHTML = folderOpts;
  $('ct-name').value = '';
  $('ct-doc-wrap').style.display = 'block'; $('ct-folder-wrap').style.display = 'none';
  ['doc','folder'].forEach(function(x) { var el = $('ct-src-' + x); if (el) el.classList.toggle('active', x === 'doc'); });
  S.testType = 'mcq';
  ['mcq','fill','fc'].forEach(function(x) { var el = $('ct-' + x); if (el) el.classList.toggle('active', x === 'mcq'); });
  $('create-test-ov').classList.add('open');
}
function closeCreateTest() { $('create-test-ov').classList.remove('open'); }

function shuffleArr(a) {
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

function confirmCreateTest() {
  var title = ($('ct-name').value || '').trim();
  var timeLimit = parseInt($('ct-time').value) || 0;
  if (!title) { toast('Enter a test name'); return; }
  var items = [], srcLabel = '';
  if (S.testSrcType === 'folder') {
    var fid = $('ct-folder').value;
    if (!fid) { toast('Select a folder'); return; }
    var f = null; for (var i = 0; i < S.folders.length; i++) { if (S.folders[i].id === fid) { f = S.folders[i]; break; } }
    srcLabel = f ? f.name : 'Folder';
    items = getFolderCards(fid);
  } else {
    var docId = $('ct-doc').value;
    var doc = null; for (var i = 0; i < S.documents.length; i++) { if (S.documents[i].id === docId) { doc = S.documents[i]; break; } }
    if (!doc) { toast('Select a document'); return; }
    srcLabel = doc.title;
    items = (doc.items || []).filter(function(i) { return i.content.trim(); }).map(function(i) { return Object.assign({}, i, { _d: docId, _dn: doc.title }); });
  }
  if (!items.length) { toast('No content found'); return; }
  var fcItems = items.filter(isFC);
  var questions = [];
  if (S.testType === 'mcq' || S.testType === 'fc') {
    if (!fcItems.length) { toast('No flashcards found — add Q >> A items'); return; }
    fcItems.forEach(function(it) {
      var pfc2 = parseFC(it.content);
      if (S.testType === 'mcq') {
        var others = fcItems.filter(function(x) { return x.id !== it.id; }).map(function(x) { return parseFC(x.content).a; }).filter(Boolean);
        var opts = shuffleArr([pfc2.a].concat(others.slice(0, 3)));
        questions.push({ id: gid(), type: 'mcq', question: pfc2.q, answer: pfc2.a, options: opts.length >= 2 ? opts : [pfc2.a, 'Other A', 'Other B'], sourceId: it.id });
      } else {
        questions.push({ id: gid(), type: 'fill', question: pfc2.q, answer: pfc2.a, sourceId: it.id });
      }
    });
  } else {
    items.slice(0, 20).forEach(function(it) {
      var parts = it.content.split(' ');
      var blank = Math.floor(parts.length / 2);
      var answer = parts[blank];
      parts[blank] = '_____';
      questions.push({ id: gid(), type: 'fill', question: parts.join(' '), answer: answer, sourceId: it.id });
    });
  }
  var test = { id: gid(), title: title, sourceLabel: srcLabel, type: S.testType, timeLimit: timeLimit, questions: questions, scores: [], createdAt: now() };
  S.tests.push(test); cloudSave(); closeCreateTest(); toast('✅ Test created!'); renderTestList();
}

function testBack() {
  clearInterval(S.testTimer); renderTestList();
  $('test-back-btn').style.display = 'none'; $('create-test-btn').style.display = 'flex'; $('test-hdr').textContent = 'Practice Tests';
}

function takeTest(testId) {
  var test = null; for (var i = 0; i < S.tests.length; i++) { if (S.tests[i].id === testId) { test = S.tests[i]; break; } }
  if (!test) return;
  S.curTest = test;
  $('test-back-btn').style.display = 'flex'; $('create-test-btn').style.display = 'none'; $('test-hdr').textContent = test.title;
  if (test.folderId) {
    $('test-mode-ov').classList.add('open');
    return;
  }
  S.curTestQ = 0; S.testAnswers = []; S.testStartTime = Date.now();
  if (test.timeLimit) {
    var rem = test.timeLimit;
    clearInterval(S.testTimer);
    S.testTimer = setInterval(function() {
      rem--;
      var el = $('q-timer'); if (el) el.textContent = '⏱ ' + Math.floor(rem / 60) + ':' + String(rem % 60).padStart(2, '0');
      if (rem <= 0) { clearInterval(S.testTimer); finishTest(); }
    }, 1000);
  }
  renderTestQ();
}

function renderTestQ() {
  var test = S.curTest; if (!test) return;
  var q = test.questions[S.curTestQ];
  var pct = Math.round((S.curTestQ / test.questions.length) * 100);
  var html = '<div style="padding:0 0 6px"><div class="prog-bar"><div class="prog-fill" style="width:' + pct + '%"></div></div></div>';
  html += '<div style="padding:14px">';
  if (test.timeLimit) html += '<div id="q-timer" style="font-size:11px;font-family:var(--mono);color:var(--yellow);margin-bottom:8px">⏱</div>';
  html += '<div style="font-size:9px;font-family:var(--mono);color:var(--t3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px">Q' + (S.curTestQ + 1) + ' of ' + test.questions.length + '</div>';
  html += '<div style="font-family:var(--head);font-size:17px;font-weight:600;color:var(--text);line-height:1.5;margin-bottom:18px">' + esc(q.question) + '</div>';
  if (q.type === 'mcq') {
    q.options.forEach(function(o, i) {
      html += '<div class="mcq-opt" id="opt-' + i + '" onclick="selectOpt(' + i + ',\'' + esc(o).replace(/'/g, "\\'") + '\')">';
      html += '<div class="opt-letter">' + 'ABCD'[i] + '</div><div>' + esc(o) + '</div></div>';
    });
  } else {
    html += '<input class="fill-inp" id="fill-ans" placeholder="Your answer…" onkeydown="if(event.key===\'Enter\')checkFill()"/>';
  }
  html += '<div id="q-feedback" style="margin-top:10px"></div></div>';
  html += '<div style="display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border)">';
  if (S.curTestQ > 0) html += '<button class="sbtn ghost" style="margin:0;width:auto;padding:10px 14px;font-size:12px" onclick="prevQ()">← Prev</button>';
  if (q.type === 'fill') html += '<button class="sbtn primary" style="margin:0;flex:1;font-size:12px" onclick="checkFill()">Check</button>';
  html += '<button class="sbtn ghost" style="margin:0;width:auto;padding:10px 14px;font-size:12px" onclick="nextQ()">Skip →</button></div>';
  $('test-content').innerHTML = html;
  if (q.type === 'fill') setTimeout(function() { var el = $('fill-ans'); if (el) el.focus(); }, 100);
}

function selectOpt(idx, val) {
  var q = S.curTest.questions[S.curTestQ];
  document.querySelectorAll('.mcq-opt').forEach(function(el) { el.classList.remove('selected'); });
  var sel = document.querySelectorAll('.mcq-opt')[idx]; if (sel) sel.classList.add('selected');
  var correct = val.trim().toLowerCase() === q.answer.trim().toLowerCase();
  S.testAnswers[S.curTestQ] = { answered: true, correct: correct, selected: val };
  setTimeout(function() {
    document.querySelectorAll('.mcq-opt').forEach(function(el, i) {
      if (q.options[i] && q.options[i].trim().toLowerCase() === q.answer.trim().toLowerCase()) el.classList.add('correct');
      else if (i === idx && !correct) el.classList.add('wrong');
    });
    setTimeout(nextQ, 700);
  }, 200);
}

function checkFill() {
  var el = $('fill-ans'); var val = (el && el.value || '').trim();
  var q = S.curTest.questions[S.curTestQ];
  var correct = val.toLowerCase() === q.answer.trim().toLowerCase();
  S.testAnswers[S.curTestQ] = { answered: true, correct: correct, selected: val };
  var fb = $('q-feedback');
  if (fb) fb.innerHTML = correct ? '<div style="color:var(--acc);font-weight:600;font-family:var(--mono)">✓ Correct!</div>' : '<div style="color:var(--red);font-family:var(--mono)">✗ Answer: <strong>' + esc(q.answer) + '</strong></div>';
  setTimeout(nextQ, 1100);
}
function nextQ() { if (S.curTestQ < S.curTest.questions.length - 1) { S.curTestQ++; renderTestQ(); } else finishTest(); }
function prevQ() { if (S.curTestQ > 0) { S.curTestQ--; renderTestQ(); } }

function finishTest() {
  clearInterval(S.testTimer);
  var test = S.curTest;
  var score = S.testAnswers.filter(function(a) { return a && a.correct; }).length;
  var total = test.questions.length;
  var pct = Math.round(score / total * 100);
  var time = Math.round((Date.now() - S.testStartTime) / 1000);
  S.tests = S.tests.map(function(t) {
    if (t.id !== test.id) return t;
    return Object.assign({}, t, { scores: (t.scores || []).concat([{ date: now(), score: score, total: total, pct: pct, time: time }]) });
  });
  S.progress.testScores = (S.progress.testScores || []).concat([{ date: now(), score: score, total: total, pct: pct, testTitle: test.title }]);
  cloudSave();
  var deg = Math.round(pct / 100 * 360);
  var msg = pct >= 80 ? 'Excellent! 🎉' : pct >= 60 ? 'Good job! 👍' : 'Keep practicing! 💪';
  $('test-content').innerHTML = '<div class="result-wrap">'
    + '<div class="score-ring" style="background:conic-gradient(var(--acc) ' + deg + 'deg, var(--s3) ' + deg + 'deg)">' + pct + '%</div>'
    + '<div style="font-family:var(--head);font-size:20px;font-weight:700;color:var(--text)">' + msg + '</div>'
    + '<div style="font-size:13px;color:var(--t2)"><strong style="color:var(--acc)">' + score + '</strong> of <strong>' + total + '</strong> correct</div>'
    + '<div style="font-size:11px;color:var(--t3);font-family:var(--mono)">Time: ' + Math.floor(time / 60) + 'm ' + (time % 60) + 's</div>'
    + '<button onclick="takeTest(\'' + test.id + '\')" style="background:var(--acc);border:none;border-radius:11px;color:var(--bg);padding:12px 24px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--head)">Retry</button>'
    + '<button onclick="testBack()" style="background:transparent;border:1px solid var(--border);border-radius:11px;color:var(--t2);padding:10px 20px;font-size:12px;cursor:pointer;font-family:var(--mono)">All Tests</button>'
    + '</div>';
}

// ── SETTINGS ─────────────────────────────────────────────
function renderSettings() {
  var s = S.settings;
  function seg(key, opts) {
    var html = '<div class="seg-ctrl">';
    opts.forEach(function(o) { html += '<button class="seg-opt' + (s[key] === o.v ? ' active' : '') + '" onclick="setSetting(\'' + key + '\',\'' + o.v + '\');applyTheme();renderSettings()">' + o.l + '</button>'; });
    html += '</div>';
    return html;
  }
  var html = '<div class="sg"><div class="sg-hdr">Appearance</div>'
    + '<div class="sg-row"><div class="sg-ico" style="background:var(--s3)">🌙</div><div class="sg-info"><strong>Theme</strong><span>Interface color</span></div>' + seg('theme', [{v:'dark',l:'Dark'},{v:'light',l:'Light'}]) + '</div>'
    + '<div class="sg-row"><div class="sg-ico" style="background:var(--s3)">🔤</div><div class="sg-info"><strong>Font Size</strong></div>' + seg('fontSize', [{v:'small',l:'S'},{v:'medium',l:'M'},{v:'large',l:'L'}]) + '</div></div>'
    + '<div class="sg"><div class="sg-hdr">Study Goals</div><div class="sg-row"><div class="sg-ico" style="background:#0d1828">🎯</div><div class="sg-info"><strong>Daily Card Goal</strong></div>'
    + '<select class="sg-select" onchange="setSetting(\'dailyGoal\',parseInt(this.value))">'
    + [5,10,20,30,50,100].map(function(n) { return '<option value="' + n + '"' + (s.dailyGoal === n ? ' selected' : '') + '>' + n + '</option>'; }).join('')
    + '</select></div></div>'
    + '<div class="sg"><div class="sg-hdr">Data & Sync</div>'
    + '<div class="sg-row"><div class="sg-ico" style="background:#0d1828">🔒</div><div class="sg-info"><strong>Account</strong><span>' + (S.user ? (S.user.email || S.user.displayName || 'User') : 'Offline — local only') + '</span></div>'
    + (S.user ? '<button style="background:var(--s3);border:1px solid var(--border);border-radius:7px;padding:5px 10px;color:var(--t2);font-size:10px;cursor:pointer;font-family:var(--mono)" onclick="signOut()">Sign Out</button>' : '<button style="background:var(--acc-glow);border:1px solid var(--border2);border-radius:7px;padding:5px 10px;color:var(--acc);font-size:10px;cursor:pointer;font-family:var(--mono)" onclick="showScreen(\'auth\');showAuthView(\'login\')">Sign In</button>')
    + '</div>'
    + '<div class="sg-row"><div class="sg-ico" style="background:#0a1e16">🔄</div><div class="sg-info"><strong>Manual Sync</strong><span>Force push data to cloud</span></div><button style="background:var(--acc-glow);border:1px solid var(--border2);border-radius:7px;padding:5px 10px;color:var(--acc);font-size:10px;cursor:pointer;font-family:var(--mono)" onclick="manualSync()">Sync Now</button></div>'
    + '<div class="sg-row"><div class="sg-ico" style="background:#0d1828">💾</div><div class="sg-info"><strong>Export All Data</strong><span>Full backup as JSON</span></div><button style="background:#0d1840;border:1px solid #1a3060;border-radius:7px;padding:5px 10px;color:var(--blue);font-size:10px;cursor:pointer;font-family:var(--mono)" onclick="exportAllJson()">Export</button></div>'
    + '<div class="sg-row"><div class="sg-ico" style="background:#1a0c0c">🗑</div><div class="sg-info"><strong style="color:var(--red)">Delete All Data</strong><span>Permanent</span></div><button style="background:#1a0c0c;border:1px solid #3a1818;border-radius:7px;padding:5px 10px;color:var(--red);font-size:10px;cursor:pointer;font-family:var(--mono)" onclick="confirmDeleteAll()">Delete</button></div>'
    + '</div><div style="height:16px"></div>';
  $('settings-content').innerHTML = html;
}

function setSetting(k, v) { S.settings[k] = v; saveLS(); }

function confirmDeleteAll() {
  showConfirm('🗑 Delete Everything', 'Deletes ALL notes, folders, and progress permanently. This cannot be undone.', function() {
    S.documents = []; S.folders = []; S.tests = [];
    S.progress = { currentStreak: 0, longestStreak: 0, lastStudyDate: '', totalReviewed: 0, totalCreated: 0, dailyReviewed: {}, testScores: [], dailyMinutes: {}, totalMinutes: 0 };
    saveLS();
    if (S.user && S.user.uid && db) {
      var path = 'users/' + S.user.uid + '/data';
      db.collection(path).doc('main').set({
        documents: [], folders: [], tests: [], progress: S.progress, updatedAt: now()
      }).then(function() { setSyncDot('on'); }).catch(function() { setSyncDot('off'); });
    }
    renderSettings(); renderDashboard(); toast('🗑 All data deleted');
  }, 'Delete All', 'var(--red)');
}

// ── STREAK ───────────────────────────────────────────────
function checkStreak() {
  var p = S.progress, last = p.lastStudyDate, t = today();
  if (last === t) return;
  var yd = new Date(); yd.setDate(yd.getDate() - 1);
  var yds = yd.toISOString().split('T')[0];
  if (last === yds) p.currentStreak = (p.currentStreak || 0) + 1;
  else if (last && last < yds) p.currentStreak = 0;
  p.longestStreak = Math.max(p.longestStreak || 0, p.currentStreak || 0);
  saveLS();
}
function updateStreak() {
  var p = S.progress;
  p.lastStudyDate = today();
  p.currentStreak = Math.max(1, p.currentStreak || 1);
  p.longestStreak = Math.max(p.longestStreak || 0, p.currentStreak);
  cloudSave();
}

// ── CONFIRM DIALOG ────────────────────────────────────────
var confirmCb = null;
function showConfirm(title, sub, cb, okLabel, okColor) {
  $('confirm-ico').textContent = '⚠️';
  $('confirm-h').textContent = title;
  $('confirm-s').textContent = sub;
  var btn = $('confirm-ok-btn');
  btn.textContent = okLabel || 'Delete';
  btn.style.background = okColor || 'var(--red)';
  btn.style.border = 'none';
  confirmCb = cb;
  $('confirm-ov').classList.add('open');
}
function closeConfirm() { $('confirm-ov').classList.remove('open'); confirmCb = null; }
$('confirm-ok-btn').addEventListener('click', function() { var cb = confirmCb; closeConfirm(); if (cb) cb(); });

// ── PROFILE ──────────────────────────────────────────────
function showProfile() {
  var u = S.user;
  var html = '';
  if (u) {
    html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 0 14px;border-bottom:1px solid var(--border);margin-bottom:10px">';
    html += '<div style="width:40px;height:40px;border-radius:50%;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:18px;overflow:hidden">';
    html += u.photoURL ? '<img src="' + u.photoURL + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">' : '👤';
    html += '</div><div><div style="font-size:13px;font-weight:600;color:var(--text)">' + esc(u.displayName || 'User') + '</div>';
    html += '<div style="font-size:10px;color:var(--t3);font-family:var(--mono)">' + esc(u.email || '') + '</div></div></div>';
    html += '<div style="font-size:10px;color:var(--t3);font-family:var(--mono);line-height:1.9;padding:9px 12px;background:var(--bg);border-radius:9px;border:1px solid var(--border);margin-bottom:10px">🔒 Data private to your account<br>☁ Auto-synced<br>📴 Offline-first</div>';
    html += '<button class="sbtn danger" onclick="signOut()">Sign Out</button>';
  } else {
    html += '<div style="text-align:center;padding:18px 0;color:var(--t2);font-size:12px">Not signed in<br>Data saved locally</div>';
    html += '<button class="sbtn primary" onclick="closeProfile();showScreen(\'auth\');showAuthView(\'login\')">Sign In / Register</button>';
  }
  $('profile-body').innerHTML = html;
  $('profile-ov').classList.add('open');
}
function closeProfile() { $('profile-ov').classList.remove('open'); }

// ── BACK BUTTON ──────────────────────────────────────────
window.addEventListener('popstate', function() {
  var overlays = ['new-folder-ov','new-doc-ov','ed-menu-ov','confirm-ov','import-ov','create-test-ov','profile-ov','rv-mode-ov'];
  for (var i = 0; i < overlays.length; i++) {
    var el = $(overlays[i]);
    if (el && el.classList.contains('open')) { el.classList.remove('open'); return; }
  }
  if (S.currentScreen === 'editor') { closeEditor(); return; }
  if (S.currentScreen !== 'dashboard') nav('dashboard');
});
history.pushState(null, null, location.href);

document.addEventListener('keydown', function(e) {
  if (S.currentScreen !== 'editor') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); tbUndo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); tbRedo(); }
  if (e.key === 'Escape') {
    hideFT();
    if (S.settings.focusMode) { S.settings.focusMode = false; $('ed-toolbar').style.display = 'flex'; var tb2 = $('ed-toolbar-2'); if (tb2) tb2.style.display = 'flex'; var fb = $('focus-btn'); if (fb) fb.classList.remove('on'); }
  }
});

// ── SAVE (TOOLBAR) ───────────────────────────────────────
function tbSave() {
  var doc = getDoc(); if (!doc) return;
  saveDoc(doc.items);
  toast('✓ Saved');
}

// ── MANUAL SYNC ──────────────────────────────────────────
function manualSync() {
  saveLS();
  if (!S.user || !S.user.uid || !db) { toast('✓ Saved locally'); return; }
  setSyncDot('busy');
  var path = 'users/' + S.user.uid + '/data';
  db.collection(path).doc('main').set({
    documents: S.documents, folders: S.folders, tests: S.tests,
    progress: S.progress, updatedAt: now()
  }).then(function() { setSyncDot('on'); toast('☁ Synced to cloud'); })
    .catch(function() { setSyncDot('off'); toast('Sync failed'); });
}

// ── DELETE NOTE ───────────────────────────────────────────
function deleteNote() {
  var doc = getDoc(); if (!doc) return;
  showConfirm('🗑 Delete Note', 'Delete "' + esc(doc.title || 'Untitled') + '"? Cannot be undone.', function() {
    S.documents = S.documents.filter(function(d) { return d.id !== S.curDocId; });
    cloudSave(); closeEditor(); toast('Note deleted');
  }, 'Delete', 'var(--red)');
}

// ── UNARCHIVE FOLDER ──────────────────────────────────────
function unarchiveFolder(id) {
  S.folders = S.folders.map(function(f) { return f.id === id ? Object.assign({}, f, { archived: false, updatedAt: now() }) : f; });
  cloudSave(); renderFolderTree(); renderNotesList(); toast('📂 Folder unarchived');
}

// ── TEST MODE SELECTOR ────────────────────────────────────
function closeTestModeOv() {
  $('test-mode-ov').classList.remove('open');
  testBack();
}

function startTestMode(mode) {
  var test = S.curTest; if (!test) return;
  S.testType = mode;
  $('test-mode-ov').classList.remove('open');
  if (mode === 'fc') {
    testBack();
    if (test.folderId) showRvModeSelector(test.folderId, null);
    return;
  }
  generateSmartQuestions(mode);
  if (!test.questions || !test.questions.length) { toast('No flashcards in this folder yet — add Q >> A items'); return; }
  S.curTestQ = 0; S.testAnswers = []; S.testStartTime = Date.now();
  renderTestQ();
}

function generateSmartQuestions(mode) {
  var test = S.curTest; if (!test || !test.folderId) return;
  var cards = getFolderCards(test.folderId).filter(isFC);
  if (!cards.length) return;
  var questions = [];
  cards.forEach(function(card) {
    var p = parseFC(card.content);
    if (!p.q || !p.a) return;
    if (mode === 'mcq') {
      var opts = generateDistractors(p.a, cards);
      questions.push({ id: gid(), type: 'mcq', question: p.q, answer: p.a, options: opts, sourceId: card.id });
    } else {
      questions.push({ id: gid(), type: 'fill', question: p.q, answer: p.a, sourceId: card.id });
    }
  });
  shuffleArr(questions);
  test.questions = questions.slice(0, 20);
}

function generateDistractors(correct, allCards) {
  var opts = [correct];
  var stripped = String(correct).trim().replace('%','').replace(/,/g,'');
  var num = parseFloat(stripped);
  var isNum = !isNaN(num) && String(correct).trim().match(/^-?[\d,]+(\.\d+)?%?$/);
  if (isNum) {
    var isPct = correct.indexOf('%') >= 0;
    var fmt = function(v) {
      var rounded = parseFloat(v.toFixed(2));
      return isPct ? rounded + '%' : String(rounded);
    };
    var candidates = [num*-1, num+1, num-1, num*2, Math.round(num/2),
      parseFloat((num*1.1).toFixed(2)), parseFloat((num*0.9).toFixed(2)),
      num+10, num-10];
    candidates = candidates.filter(function(c) { return c !== num; });
    shuffleArr(candidates);
    for (var i = 0; i < candidates.length && opts.length < 4; i++) {
      var d = fmt(candidates[i]);
      if (opts.indexOf(d) < 0) opts.push(d);
    }
  } else {
    var others = allCards.map(function(c) { return parseFC(c.content).a; })
      .filter(function(a) { return a && a.trim() && a !== correct; });
    shuffleArr(others);
    for (var i = 0; i < others.length && opts.length < 4; i++) opts.push(others[i]);
    if (opts.length < 4 && correct.length >= 3) {
      var variants = [
        correct.replace(/[aeiou]/gi, function(m) { return m === m.toLowerCase() ? m.toUpperCase() : m.toLowerCase(); }).slice(0,correct.length),
        correct.split(' ').reverse().join(' '),
        correct.slice(0,1).toUpperCase() + correct.slice(1).split('').reverse().join('').slice(0,correct.length-1)
      ];
      variants.forEach(function(v) { if (opts.length < 4 && v !== correct && opts.indexOf(v) < 0) opts.push(v); });
    }
  }
  return shuffleArr(opts).slice(0, 4);
}

// ── GLOBAL SHORTCUTS ─────────────────────────────────────
function setupGlobalShortcuts() {
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && S.currentScreen !== 'editor') {
      e.preventDefault(); manualSync();
    }
  });
}
