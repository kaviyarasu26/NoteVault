// ── APP LOCK (PIN, Android only) ────────────────────────────────────
// A device-local re-lock layered on top of the existing Firebase sign-in —
// for "someone picks up my already-unlocked phone", not "someone doesn't
// know my account password" (that's what sign-in already covers). Stored in
// localStorage, deliberately NOT in D: D is Firestore-synced account data
// (see firebase-init.js's saveLS) shared across every device signed into
// the account, and a PIN protecting THIS device shouldn't propagate to all
// of them. Native-only (isNative(), notifications.js) — on the web PWA,
// localStorage is trivially readable via devtools, so a "lock" there
// wouldn't mean much; the packaged Android app doesn't have that same
// casual exposure.
const PIN_KEY = 'nv-lock-pin-hash';
const PIN_ENABLED_KEY = 'nv-lock-enabled';
const LOCK_GRACE_MS = 30000; // quick app-switches (share sheet, copy/paste) don't demand the PIN again

function hashPin(pin){ return CryptoJS.SHA256(pin).toString(); }
function isLockEnabled(){ return localStorage.getItem(PIN_ENABLED_KEY)==='1' && !!localStorage.getItem(PIN_KEY); }

function renderAppLockStatus(){
  const section = document.getElementById('app-lock-section');
  const el = document.getElementById('app-lock-status');
  if(!section || !el) return;
  if(!isNative()){ section.style.display='none'; return; }
  section.style.display='block';
  const enabled = isLockEnabled();
  el.innerHTML = `<div class="sync-row">
    <div class="sync-ico" style="background:#1a1a0d">🔒</div>
    <div class="sync-info"><strong>PIN Lock</strong><span>${enabled?'Enabled — re-locks after 30s in the background':'Off — set a PIN to re-lock the app'}</span></div>
    ${enabled
      ? `<button class="sync-btn btn-danger" onclick="removeAppLockPin()">Remove</button>`
      : `<button class="sync-btn btn-import" onclick="openPinSetup()">Set PIN</button>`}
  </div>`;
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
  closePinSetup();
  renderAppLockStatus();
  toast('🔒 App lock enabled');
}
window.confirmPinSetup = confirmPinSetup;

function removeAppLockPin(){
  localStorage.removeItem(PIN_KEY);
  localStorage.removeItem(PIN_ENABLED_KEY);
  renderAppLockStatus();
  toast('🔓 App lock removed');
}
window.removeAppLockPin = removeAppLockPin;

// True once the correct PIN has been entered for the CURRENT foreground
// session — reset on every re-lock (see the appStateChange listener below),
// so it's never persisted anywhere.
let appLockUnlocked = false;

function showAppLockGate(){
  document.getElementById('app-lock-error').style.display='none';
  document.getElementById('app-lock-pin-inp').value='';
  document.getElementById('app-lock-gate-ov').classList.add('open');
}

function checkAppLockPin(){
  const val = document.getElementById('app-lock-pin-inp').value.trim();
  if(val && hashPin(val) === localStorage.getItem(PIN_KEY)){
    appLockUnlocked = true;
    document.getElementById('app-lock-gate-ov').classList.remove('open');
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
  document.getElementById('app-lock-gate-ov').classList.remove('open');
  if(window.logOutFromProfile) window.logOutFromProfile();
}
window.forgotPinSignOut = forgotPinSignOut;

function initAppLock(){
  renderAppLockStatus();
  if(!isNative() || !isLockEnabled()) return;
  if(!appLockUnlocked) showAppLockGate();
}
window.addEventListener('nv-auth-changed', e=>{
  if(e.detail && e.detail.user) initAppLock();
});

let lockBackgroundedAt = null;
if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App){
  window.Capacitor.Plugins.App.addListener('appStateChange', state=>{
    if(!isLockEnabled()) return;
    if(!state.isActive){ lockBackgroundedAt = Date.now(); return; }
    if(lockBackgroundedAt && (Date.now()-lockBackgroundedAt) > LOCK_GRACE_MS){
      appLockUnlocked = false;
      showAppLockGate();
    }
    lockBackgroundedAt = null;
  });
}
