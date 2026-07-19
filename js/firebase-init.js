import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, sendEmailVerification, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, deleteDoc, collection, addDoc, query, where, onSnapshot, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAIjry7BPg-novEi-gGiF2nhR9rG11oQGo",
  authDomain: "notevalut-55352.firebaseapp.com",
  projectId: "notevalut-55352",
  storageBucket: "notevalut-55352.firebasestorage.app",
  messagingSenderId: "939190352641",
  appId: "1:939190352641:web:36caddec40c6661a22f900",
  measurementId: "G-327CPG3M1R"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Expose Firestore primitives so classic (non-module) feature scripts
// (master-share.js, etc.) can talk to Firestore without their own imports.
window.db = db;
window.fb = { doc, getDoc, getDocs, setDoc, deleteDoc, collection, addDoc, query, where, onSnapshot, updateDoc };

window.currentUser = null;

// The profile icon (top-right on Home/Search/Sync) replaces the old
// standalone Sign In/Sign Out button — its icon/title reflect auth state,
// and it opens either the auth flow (guest/pending) or the Profile menu
// (verified). Log Out now lives inside that Profile menu.
function personIconSvg(size){
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7"/></svg>`;
}
function envelopeIconSvg(size){
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>`;
}
function updateProfileButtons(state){
  const icons = { signin:personIconSvg(18), pending:envelopeIconSvg(18), verified:personIconSvg(18) };
  const titles = { signin:'Sign In', pending:'Verify Email', verified:'Profile' };
  document.querySelectorAll('.profile-btn-ico').forEach(el=>{
    if(state==='verified' && typeof D!=='undefined' && D && D.avatar){
      el.innerHTML=`<img src="${D.avatar}" alt="" class="profile-avatar-thumb">`;
    } else {
      el.innerHTML = icons[state];
    }
  });
  document.querySelectorAll('.profile-btn').forEach(el=>{ el.title = titles[state]; });
}
window.updateProfileButtons = updateProfileButtons;

window.openProfileOrAuth = () => {
  const user = auth.currentUser;
  if (user && user.emailVerified) {
    window.openProfileMenu();
  } else if (user && !user.emailVerified) {
    const lbl = document.getElementById('pending-email-lbl');
    if (lbl) lbl.textContent = user.email;
    window.openAuthOverlay('pending');
  } else {
    window.openAuthOverlay('signin');
  }
};

window.openProfileMenu = () => {
  const user = auth.currentUser;
  if (!user) return;
  document.getElementById('profile-name-inp').value = user.displayName || '';
  document.getElementById('profile-email-inp').value = user.email || '';
  const avatarPreview = document.getElementById('profile-avatar-preview');
  if (avatarPreview) {
    avatarPreview.innerHTML = (typeof D!=='undefined' && D && D.avatar)
      ? `<img src="${D.avatar}" alt="" class="profile-avatar-thumb">` : personIconSvg(34);
  }
  document.getElementById('profile-ov').classList.add('open');
};

window.closeProfileMenu = () => {
  document.getElementById('profile-ov').classList.remove('open');
};

window.saveProfileName = async () => {
  const name = document.getElementById('profile-name-inp').value.trim();
  if (!name) { toast("⚠️ Name cannot be empty"); return; }
  try {
    await updateProfile(auth.currentUser, { displayName: name });
    toast("✅ Profile updated");
  } catch (e) {
    console.error('Profile update failed', e);
    toast("⚠️ Failed to update profile");
  }
};

window.logOutFromProfile = async () => {
  window.closeProfileMenu();
  try {
    await signOut(auth);
    toast("👋 Signed out successfully");
  } catch (e) {
    toast("⚠️ Sign out failed. Try again.");
  }
};

window.closeAuth = () => {
  document.getElementById('auth-ov').classList.remove('open');
  if (window.resetAuthFields) window.resetAuthFields();
};

// Sign-in is mandatory — the ✕ button and backdrop click (index.html) both
// route through this instead of closeAuth() directly, so a signed-out visitor
// can't dismiss the gate and see an empty, unauthenticated app underneath.
// (closeAuth() itself stays unconditional because the app's own success
// handlers — handleSignIn, checkVerifiedAndContinue — call it at a point
// before window.currentUser has been assigned by onAuthStateChanged.)
window.attemptCloseAuthDismiss = () => {
  if (!window.currentUser) return;
  window.closeAuth();
};

// Firestore is the ONLY source of truth for a signed-in account — this never
// reads localStorage, so switching between accounts on the same device can
// never mix one account's notes into another's.
async function loadUserData(user) {
  const userDocRef = doc(db, "users", user.uid);
  try {
    const snap = await getDoc(userDocRef);
    if (snap.exists() && snap.data().vault) {
      try {
          const secretKey = user.uid + "-nv-secret";
          const bytes = CryptoJS.AES.decrypt(snap.data().vault, secretKey);
          const decryptedData = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
          D = decryptedData;
          migrateDataIfNeeded();
      } catch(decryptError) {
          console.error("Decryption failed:", decryptError);
          toast("⚠️ Warning: Could not decrypt cloud data.");
          D = defaultData();
      }
    } else if (snap.exists() && snap.data().documents) {
      D = snap.data();
      migrateDataIfNeeded();
    } else {
      // Brand-new account — start fresh and push straight to Firestore.
      D = defaultData();
      window.saveLS();
    }
  } catch (e) {
    console.error("Failed to fetch from Firebase", e);
    toast("⚠️ Network error — couldn't load your cloud data. Check your connection and try again.");
    D = defaultData();
  }
}

window.handleSignIn = async () => {
  const email = document.getElementById('signin-email').value.trim();
  const pass = document.getElementById('signin-pass').value;

  if (!email.endsWith('@gmail.com')) {
    toast("⚠️ Please use a valid @gmail.com address");
    return;
  }
  if (!pass) {
    toast("⚠️ Enter your password");
    return;
  }

  try {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    if (!cred.user.emailVerified) {
      const lbl = document.getElementById('pending-email-lbl');
      if (lbl) lbl.textContent = email;
      window.showAuthView('pending');
      toast("⚠️ Please verify your email to continue");
      return;
    }
    closeAuth();
    toast("✅ Signed in successfully!");
  } catch (err) {
    console.error('Sign in failed', err);
    if (err.code === 'auth/user-not-found') toast("⚠️ No account found — tap \"Create an account\" below");
    else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') toast("⚠️ Incorrect password");
    else toast("⚠️ Sign in failed: " + (err.code || 'unknown error'));
  }
};

window.handleSignUp = async () => {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass = document.getElementById('signup-pass').value;

  if (!name) {
    toast("⚠️ Please enter your name");
    return;
  }
  if (!email.endsWith('@gmail.com')) {
    toast("⚠️ Please use a valid @gmail.com address");
    return;
  }
  if (pass.length < 6) {
    toast("⚠️ Password must be at least 6 characters");
    return;
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await sendEmailVerification(cred.user);
    const lbl = document.getElementById('pending-email-lbl');
    if (lbl) lbl.textContent = email;
    window.showAuthView('pending');
    toast("✉️ Verification email sent — check your inbox!");
  } catch (err) {
    console.error('Sign up failed', err);
    if (err.code === 'auth/email-already-in-use') toast("⚠️ That email is already registered — try Sign In instead");
    else if (err.code === 'auth/invalid-email') toast("⚠️ That email address looks invalid");
    else toast("⚠️ Failed to create account. Check your details.");
  }
};

window.resendVerification = async () => {
  const user = auth.currentUser;
  if (!user) { toast("⚠️ Session expired — please sign in again"); window.showAuthView('signin'); return; }
  try {
    await sendEmailVerification(user);
    toast("✉️ Verification email resent!");
  } catch (err) {
    console.error('Resend verification failed', err);
    if (err.code === 'auth/too-many-requests') toast("⚠️ Too many attempts — wait a bit and try again");
    else toast("⚠️ Failed to resend email");
  }
};

window.checkVerifiedAndContinue = async () => {
  const user = auth.currentUser;
  if (!user) { toast("⚠️ Session expired — please sign in again"); window.showAuthView('signin'); return; }
  try {
    await user.reload();
  } catch (e) {
    console.error('Reload failed', e);
  }
  if (auth.currentUser && auth.currentUser.emailVerified) {
    toast("✅ Email verified!");
    closeAuth();
    window.currentUser = auth.currentUser;
    await loadUserData(auth.currentUser);
    updateProfileButtons('verified');
    renderHome();
    window.dispatchEvent(new CustomEvent('nv-auth-changed', { detail: { user: window.currentUser } }));
  } else {
    toast("⚠️ Not verified yet — check your inbox and click the link first");
  }
};

window.signOutPending = async () => {
  try { await signOut(auth); } catch(e) { console.error(e); }
  window.showAuthView('signin');
};

window.handleAuthReset = async () => {
  const email = document.getElementById('signin-email').value.trim();
  if (!email) {
    toast("⚠️ Type your email address above first, then tap Forgot Password?");
    return;
  }
  if (!email.endsWith('@gmail.com')) {
    toast("⚠️ Enter your @gmail.com address first to reset");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    toast("✉️ Password reset email sent! Check your inbox (and spam folder).");
    closeAuth();
  } catch (err) {
    console.error('Password reset failed', err);
    if (err.code === 'auth/user-not-found') toast("⚠️ No account exists for that email");
    else if (err.code === 'auth/invalid-email') toast("⚠️ That email address looks invalid");
    else if (err.code === 'auth/too-many-requests') toast("⚠️ Too many attempts — try again later");
    else toast("⚠️ Reset failed: " + (err.code || 'unknown error'));
  }
};

onAuthStateChanged(auth, async (user) => {
  const verified = !!(user && user.emailVerified);
  const wasSignedIn = !!window.currentUser;
  window.currentUser = verified ? user : null;

  if (user && !verified) {
    updateProfileButtons('pending');
    // Nothing to show until they verify — Firestore is the only source of
    // truth and loadUserData() requires a verified user.
    D = null;
    window.openAuthOverlay('pending');
  } else if (verified) {
    await loadUserData(user);
    updateProfileButtons('verified'); // after loadUserData so D.avatar is available
  } else {
    updateProfileButtons('signin');
    // Leaving a signed-in account — don't leave curFolder pointing at a
    // folder id from that account's (now unloaded) data.
    if (wasSignedIn) curFolder = null;
    // Sign-in is mandatory: no local vault, no guest mode. Force the gate
    // open — this also covers the very first load, before anyone has
    // touched the profile icon.
    D = null;
    window.openAuthOverlay('signin');
  }
  renderHome();
  if (window.renderNotificationBell) renderNotificationBell();
  window.dispatchEvent(new CustomEvent('nv-auth-changed', { detail: { user: window.currentUser } }));
});

let syncTimeout = null;

// Firestore is the only persistence layer — there's no local/guest fallback,
// since the app requires a verified sign-in before D exists at all.
window.saveLS = () => {
  if (!window.currentUser) return;
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      const secretKey = window.currentUser.uid + "-nv-secret";
      const encryptedData = CryptoJS.AES.encrypt(JSON.stringify(D), secretKey).toString();

      await setDoc(doc(db, "users", window.currentUser.uid), {
          vault: encryptedData,
          updatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.error("Cloud synchronisation dropped:", e);
      toast("⚠️ Cloud sync failed. Will retry later.");
    }
  }, 1500);
};
