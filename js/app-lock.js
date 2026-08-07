// ── APP LOCK (PIN) ──────────────────────────────────────────────────
// A device-local re-lock layered on top of the existing Firebase sign-in —
// for "someone picks up my already-unlocked device", not "someone doesn't
// know my account password" (that's what sign-in already covers). Stored in
// localStorage, deliberately NOT in D: D is Firestore-synced account data
// (see firebase-init.js's saveLS) shared across every device signed into
// the account, and a PIN protecting THIS device shouldn't propagate to all
// of them.
//
// Available on both the web PWA and the packaged Android app — on the web
// it's a "walked away from an open laptop" screen lock, not a defense
// against someone with devtools access to localStorage; framed to the user
// as convenience/privacy, not unbreakable security.
const PIN_KEY = 'nv-lock-pin-hash';
const PIN_ENABLED_KEY = 'nv-lock-enabled';
const TIMEOUT_KEY = 'nv-lock-timeout-ms';
const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes
const MIN_TIMEOUT_MS = 30000;      // 30 seconds
const MAX_TIMEOUT_MS = 300000;     // 5 minutes
const TIMEOUT_OPTIONS = [
  { ms: 30000,  label: '30 seconds' },
  { ms: 60000,  label: '1 minute' },
  { ms: 120000, label: '2 minutes' },
  { ms: 180000, label: '3 minutes' },
  { ms: 300000, label: '5 minutes' },
];
const IDLE_CHECK_INTERVAL_MS = 5000;

function hashPin(pin){ return CryptoJS.SHA256(pin).toString(); }
function isLockEnabled(){ return localStorage.getItem(PIN_ENABLED_KEY)==='1' && !!localStorage.getItem(PIN_KEY); }

function getLockTimeoutMs(){
  const v = parseInt(localStorage.getItem(TIMEOUT_KEY), 10);
  return (v && v>=MIN_TIMEOUT_MS && v<=MAX_TIMEOUT_MS) ? v : DEFAULT_TIMEOUT_MS;
}
function setLockTimeoutMs(ms){
  ms = parseInt(ms, 10);
  if(!ms || ms<MIN_TIMEOUT_MS || ms>MAX_TIMEOUT_MS) return;
  localStorage.setItem(TIMEOUT_KEY, String(ms));
  markActivity();
  toast('⏱️ Auto-lock timeout updated');
}
window.setLockTimeoutMs = setLockTimeoutMs;

function renderAppLockStatus(){
  const section = document.getElementById('app-lock-section');
  const el = document.getElementById('app-lock-status');
  if(!section || !el) return;
  section.style.display='block';
  const enabled = isLockEnabled();
  let html = `<div class="sync-row">
    <div class="sync-ico" style="background:#1a1a0d">🔒</div>
    <div class="sync-info"><strong>PIN Lock</strong><span>${enabled?'Enabled — re-locks after you\'re idle, or when reopened':'Off — set a PIN to re-lock the app'}</span></div>
    ${enabled
      ? `<button class="sync-btn btn-danger" onclick="removeAppLockPin()">Remove</button>`
      : `<button class="sync-btn btn-import" onclick="openPinSetup()">Set PIN</button>`}
  </div>`;
  if(enabled){
    const timeoutMs = getLockTimeoutMs();
    html += `<div class="sync-row">
      <div class="sync-ico" style="background:#0d1a1a">⏱️</div>
      <div class="sync-info"><strong>Auto-lock after</strong><span>How long you can be idle before the PIN gate reappears</span></div>
      <select class="sync-btn" style="background:var(--s2);color:var(--text);border:1px solid var(--border)" onchange="setLockTimeoutMs(this.value)">
        ${TIMEOUT_OPTIONS.map(o=>`<option value="${o.ms}"${o.ms===timeoutMs?' selected':''}>${o.label}</option>`).join('')}
      </select>
    </div>`;
  }
  el.innerHTML = html;
}
window.renderAppLockStatus = renderAppLockStatus;

function openPinSetup(){
  document.getElementById('pin-setup-inp1').value='';
  document.getElementById('pin-setup-inp2').value='';
  document.getElementById('pin-setup-ov').classList.add('open');
}
window.openPinSetup = openPinSetup;

function closePinSetup(){
  document.getElementById('pin-setup-ov').classList.remove('open');
}
window.closePinSetup = closePinSetup;

function confirmPinSetup(){
  const p1=document.getElementById('pin-setup-inp1').value.trim();
  const p2=document.getElementById('pin-setup-inp2').value.trim();
  if(!/^\d{4,6}$/.test(p1)){ toast('⚠️ PIN must be 4-6 digits'); return; }
  if(p1!==p2){ toast("⚠️ PINs don't match"); return; }
  localStorage.setItem(PIN_KEY, hashPin(p1));
  localStorage.setItem(PIN_ENABLED_KEY, '1');
  if(!localStorage.getItem(TIMEOUT_KEY)) localStorage.setItem(TIMEOUT_KEY, String(DEFAULT_TIMEOUT_MS));
  // Setting the PIN happens while already inside the unlocked app — don't
  // immediately demand it back.
  appLockUnlocked = true;
  startIdleWatch();
  closePinSetup();
  renderAppLockStatus();
  toast('🔒 App lock enabled');
}
window.confirmPinSetup = confirmPinSetup;

function removeAppLockPin(){
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(PIN_ENABLED_KEY);
  stopIdleWatch();
  renderAppLockStatus();
  toast('🔓 App lock removed');
}
window.removeAppLockPin = removeAppLockPin;

// True once the correct PIN has been entered for the CURRENT foreground
// session — reset on every re-lock, so it's never persisted anywhere.
let appLockUnlocked = false;

function showAppLockGate(){
  stopIdleWatch();
  document.getElementById('app-lock-error').style.display='none';
  document.getElementById('app-lock-pin-inp').value='';
  document.getElementById('app-lock-gate-ov').classList.add('open');
}

function checkAppLockPin(){
  const val = document.getElementById('app-lock-pin-inp').value.trim();
  if(val && hashPin(val) === localStorage.getItem(PIN_KEY)){
    appLockUnlocked = true;
    document.getElementById('app-lock-gate-ov').classList.remove('open');
    startIdleWatch();
  } else {
    document.getElementById('app-lock-error').style.display='block';
    document.getElementById('app-lock-pin-inp').value='';
  }
}
window.checkAppLockPin = checkAppLockPin;

// No PIN-recovery flow exists, so a forgotten PIN would otherwise strand a
// legitimate user out of their own (Firestore-safe, never-at-risk) data with
// no way back in. Signing out doesn't need the PIN — falling back to it and
// clearing the local PIN is the escape hatch: getting back in from there
// still requires the real account password, so this isn't a meaningful
// bypass, just a recovery path.
function forgotPinSignOut(){
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(PIN_ENABLED_KEY);
  stopIdleWatch();
  document.getElementById('app-lock-gate-ov').classList.remove('open');
  if(window.logOutFromProfile) window.logOutFromProfile();
}
window.forgotPinSignOut = forgotPinSignOut;

// ── Inactivity tracking ─────────────────────────────────────────────
// Works the same way on the web PWA and inside the Capacitor WebView: any
// real user input resets the clock; a polling interval (throttled/paused
// while the tab/app is hidden, which the visibilitychange handler below
// covers separately) checks whether it's been idle longer than the
// user-configured timeout and, if so, re-shows the PIN gate.
let lastActivityAt = Date.now();
let idleCheckTimer = null;
let hiddenAt = null;

function markActivity(){ lastActivityAt = Date.now(); }
['mousemove','mousedown','keydown','touchstart','scroll','wheel'].forEach(evt=>{
  window.addEventListener(evt, markActivity, { passive:true });
});

function startIdleWatch(){
  stopIdleWatch();
  if(!isLockEnabled()) return;
  markActivity();
  idleCheckTimer = setInterval(()=>{
    if(!isLockEnabled() || !appLockUnlocked) { stopIdleWatch(); return; }
    if(Date.now()-lastActivityAt >= getLockTimeoutMs()){
      appLockUnlocked = false;
      showAppLockGate();
    }
  }, IDLE_CHECK_INTERVAL_MS);
}
function stopIdleWatch(){
  if(idleCheckTimer){ clearInterval(idleCheckTimer); idleCheckTimer=null; }
}

// Catches the case a polling interval can't: the tab/app was hidden (backed
// out to another app, switched tabs, closed the laptop lid) for longer than
// the timeout. setInterval is throttled or fully paused while hidden, so the
// idle check above alone wouldn't notice until well after the user returns.
document.addEventListener('visibilitychange', ()=>{
  if(!isLockEnabled()) return;
  if(document.hidden){
    hiddenAt = Date.now();
  } else {
    if(hiddenAt && appLockUnlocked && (Date.now()-hiddenAt) >= getLockTimeoutMs()){
      appLockUnlocked = false;
      showAppLockGate();
    }
    hiddenAt = null;
    markActivity();
  }
});

function initAppLock(){
  renderAppLockStatus();
  if(!isLockEnabled()) return;
  if(!appLockUnlocked) showAppLockGate();
  else startIdleWatch();
}
window.addEventListener('nv-auth-changed', e=>{
  if(!e.detail || !e.detail.user) { stopIdleWatch(); return; }
  initAppLock();
  // Brand-new account (flagged by firebase-init.js's loadUserData) and no
  // PIN set yet — offer it right at account creation, as requested, rather
  // than leaving it to be discovered later in Settings. Small delay lets the
  // auth overlay's own close transition finish first so the two sheets
  // don't visually collide.
  if(window.nvIsNewAccount && !isLockEnabled()){
    window.nvIsNewAccount = false;
    setTimeout(()=>{ if(!isLockEnabled()) openPinSetup(); }, 450);
  }
});

// Native-only extra signal: Capacitor's own backgrounded/foregrounded event,
// using the same configurable timeout instead of a fixed grace period.
// Harmless alongside visibilitychange above — most WebViews fire both, this
// is just belt-and-suspenders for platforms/versions that don't.
if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App){
  let lockBackgroundedAt = null;
  window.Capacitor.Plugins.App.addListener('appStateChange', state=>{
    if(!isLockEnabled()) return;
    if(!state.isActive){ lockBackgroundedAt = Date.now(); return; }
    if(lockBackgroundedAt && appLockUnlocked && (Date.now()-lockBackgroundedAt) >= getLockTimeoutMs()){
      appLockUnlocked = false;
      showAppLockGate();
    }
    lockBackgroundedAt = null;
  });
}
