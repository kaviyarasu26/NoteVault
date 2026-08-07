// ── FOLDER SHARE (per-folder, read-only for the recipient) ──────
// Replaces the old whole-vault Master/Slave system. A folder owner shares
// ONE folder with someone by email (⋮ menu → Share Folder). If accepted,
// the recipient gets a read-only copy in their OWN vault with every
// card's SRS reset to brand-new (due today) — their own personal
// progress from then on, never touching the owner's copy or each other's.
// Further edits/additions by the owner sync in automatically, with a
// notification. The recipient can Review/Test it but never edit it.
//
// Data model:
//   folder_shares/{id}      — one pending/accepted/rejected invite
//   folder_links/{ownerUid}_{folderId}_{recipientUid} — deterministic
//     "accepted" marker; also what Firestore rules check for read access
//   shared_folders/{ownerUid}_{folderId} — the owner's mirror of just
//     that one folder's data (encrypted the same weak-but-consistent way
//     as the rest of this app), so a recipient never needs to read the
//     owner's whole vault — only the one folder they were actually given.
//
// NOTE: requires Firestore Security Rules for these three collections —
// see the rules block shared alongside this feature. Console change only,
// client code can't do it.

let contextFolderIdForShare = null;
let incomingFolderShare = null;
let folderShareListenerUnsub = null;
let myShareLinksUnsub = null;
let mySharedFolderIds = new Set();
let receivedFolderWatchers = {}; // "ownerUid_folderId" -> unsub
let reviewReportDebounce = {};

function openFolderShareOv(){
  if(!window.currentUser){ toast('⚠️ Sign in first to share a folder'); closeFolderMenu(); return; }
  contextFolderIdForShare = contextFolderId;
  const folder = D.folders.find(f=>f.id===contextFolderIdForShare);
  closeFolderMenu();
  document.getElementById('fs-share-msg').textContent = folder ? `Share "${folder.name}" with someone by email.` : '';
  document.getElementById('folder-share-ov').classList.add('open');
}
window.openFolderShareOv = openFolderShareOv;

function closeFolderShareOv(){
  document.getElementById('folder-share-ov').classList.remove('open');
  document.getElementById('fs-email-inp').value='';
}
window.closeFolderShareOv = closeFolderShareOv;

async function sendFolderShare(){
  const email = document.getElementById('fs-email-inp').value.trim().toLowerCase();
  const folder = D.folders.find(f=>f.id===contextFolderIdForShare);
  if(!folder){ toast('⚠️ Folder not found'); return; }
  if(folder.readOnly){ toast("⚠️ You can't re-share a folder that isn't yours"); return; }
  if(!email || !email.includes('@')){ toast('⚠️ Enter a valid email address'); return; }
  if(email === (window.currentUser.email||'').toLowerCase()){ toast('⚠️ You cannot share with yourself'); return; }
  try{
    await window.fb.addDoc(window.fb.collection(window.db,'folder_shares'), {
      ownerUid: window.currentUser.uid,
      ownerEmail: window.currentUser.email,
      folderId: folder.id,
      folderName: folder.name,
      toEmail: email,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    toast('📤 Invite sent to '+email);
    closeFolderShareOv();
  }catch(e){
    console.error('Failed to send folder share', e);
    toast('⚠️ Failed to send invite');
  }
}
window.sendFolderShare = sendFolderShare;

// ── RECIPIENT: incoming invites ──────────────────────────────────
function initFolderShareListener(){
  if(folderShareListenerUnsub){ folderShareListenerUnsub(); folderShareListenerUnsub=null; }
  if(!window.currentUser || !window.fb) return;
  const q = window.fb.query(
    window.fb.collection(window.db,'folder_shares'),
    window.fb.where('toEmail','==',(window.currentUser.email||'').toLowerCase()),
    window.fb.where('status','==','pending')
  );
  folderShareListenerUnsub = window.fb.onSnapshot(q, snap=>{
    snap.docChanges().forEach(ch=>{
      if(ch.type==='added') promptIncomingFolderShare({id:ch.doc.id, ...ch.doc.data()});
    });
  }, err=>console.error('Folder share listener error', err));
}

function promptIncomingFolderShare(req){
  incomingFolderShare = req;
  document.getElementById('fs-incoming-msg').textContent = `${req.ownerEmail} wants to share the folder "${req.folderName}" with you.`;
  document.getElementById('fs-incoming-ov').classList.add('open');
  if(window.playShareChime) playShareChime();
  // pushNotification() already calls notifyUser() internally — a second,
  // direct notifyUser() call here used to fire alongside it, producing two
  // native notifications per invite. action metadata lets the
  // notification-panel entry (renderNotifPanel, notifications.js) render its
  // own Accept/Reject buttons — resolved through resolveNotifShareInvite()
  // there, which calls back into acceptFolderShare(req)/rejectFolderShare(req)
  // below with a reconstructed req, same shape as this popup uses. opts
  // routes this to the distinct 'nv_share' notification channel/sound with a
  // single "Open" action, instead of the default channel.
  if(window.pushNotification) window.pushNotification('📥','Folder Share Invite',`${req.ownerEmail} wants to share "${req.folderName}" with you.`,
    { type:'folder_share_invite', shareId:req.id, ownerUid:req.ownerUid, ownerEmail:req.ownerEmail, folderId:req.folderId, folderName:req.folderName, resolved:null },
    { channelId:'nv_share', actionTypeId:'OPEN_ACTION' });
}

function closeIncomingFolderShare(){
  incomingFolderShare=null;
  document.getElementById('fs-incoming-ov').classList.remove('open');
}
window.closeIncomingFolderShare = closeIncomingFolderShare;

// req is optional — omitted, it falls back to whatever invite the popup
// overlay currently has open (its own Accept/Reject buttons call these with
// no args, unchanged). Passed explicitly, it lets the notification panel's
// buttons resolve an invite directly without that overlay ever opening.
function rejectFolderShare(req){
  const r = req || incomingFolderShare;
  if(!r) return;
  window.fb.updateDoc(window.fb.doc(window.db,'folder_shares',r.id), {status:'rejected'}).catch(e=>console.error(e));
  if(r===incomingFolderShare) closeIncomingFolderShare();
  toast('🚫 Invite declined');
}
window.rejectFolderShare = rejectFolderShare;

function decryptSharedFolder(docData, ownerUid){
  const secretKey = ownerUid + '-nv-secret';
  const bytes = CryptoJS.AES.decrypt(docData.payload, secretKey);
  return JSON.parse(bytes.toString(CryptoJS.enc.Utf8)); // {folder:{name}, documents:[...]}
}

// Creates the recipient's local placeholder for a shared folder (readOnly +
// sharedFrom pointer) up front, independent of whether the owner's copy has
// actually been mirrored to shared_folders yet. This is what lets
// resubscribeReceivedFolders() find and re-watch the folder after a reload —
// without it, an invite accepted while the owner is offline (so
// shared_folders/{ownerUid}_{folderId} doesn't exist yet) would leave no
// local trace to resume from, and the folder would never appear even once
// the owner comes online and mirrors it later.
function ensureLocalSharedFolder(req, folderName){
  let localFolder = D.folders.find(f=>f.sharedFrom && f.sharedFrom.ownerUid===req.ownerUid && f.sharedFrom.folderId===req.folderId);
  if(!localFolder){
    localFolder = { id: gid(), name: folderName || req.folderName, createdAt: new Date().toISOString(), favorite:false,
      readOnly: true, sharedFrom: { ownerUid: req.ownerUid, ownerEmail: req.ownerEmail, folderId: req.folderId } };
    D.folders.push(localFolder);
  } else if(folderName && localFolder.name !== folderName){
    D.folders = D.folders.map(f=>f.id===localFolder.id?{...f,name:folderName}:f);
  }
  return localFolder;
}

// Creates (first time) or refreshes (later syncs) the recipient's local,
// read-only mirror of one shared folder. New cards start at zero/due
// today; existing cards keep the recipient's own SRS progress and only
// have their content text refreshed.
function importSharedFolder(req, data, isInitial){
  const localFolder = ensureLocalSharedFolder(req, data.folder.name);
  // Marks that this folder has received real synced content at least once
  // — watchSharedFolderUpdates below only trusts a later "doesn't exist" as
  // a genuine deletion once this is true (see its comment for why).
  if(!localFolder.everSynced) D.folders = D.folders.map(f=>f.id===localFolder.id?{...f,everSynced:true}:f);

  let newCardCount = 0;
  data.documents.forEach(srcDoc=>{
    const localDoc = D.documents.find(d=>d.id===srcDoc.id && d.folderId===localFolder.id);
    const items = srcDoc.items.map(it=>{
      const existingItem = localDoc ? localDoc.items.find(li=>li.id===it.id) : null;
      if(existingItem){
        const merged = { ...existingItem, content: it.content, richText: it.richText };
        // The owner can turn an existing item into a flashcard later (typing
        // `>>` into text that was previously plain, or "+ Card") — same id,
        // so it lands here rather than the "brand new item" branch below.
        // Without this check it would keep the recipient's carried-over
        // srs:null forever: isFC() only looks at content, so the item would
        // still render with a flashcard badge, but isDue() requires srs to
        // exist — so it would silently never show up in Review.
        if(isFC(it) && !merged.srs){
          merged.srs = { repetitions:0, easeFactor:2.5, interval:0, dueDate: today() };
          newCardCount++;
        }
        return merged;
      }
      if(isFC(it)) newCardCount++;
      return { ...it, srs: isFC(it) ? { repetitions:0, easeFactor:2.5, interval:0, dueDate: today() } : null };
    });
    if(localDoc){
      D.documents = D.documents.map(d=>(d.id===localDoc.id && d.folderId===localFolder.id)?{...d, title:srcDoc.title, items, updatedAt:new Date().toISOString()}:d);
    } else {
      D.documents.push({ id: srcDoc.id, folderId: localFolder.id, title: srcDoc.title,
        createdAt: srcDoc.createdAt||new Date().toISOString(), updatedAt: new Date().toISOString(), items });
    }
  });

  saveLS();
  renderHome();
  if(!isInitial && newCardCount>0 && window.pushNotification){
    window.pushNotification('➕','New card added', `${newCardCount} new card${newCardCount>1?'s':''} added to "${localFolder.name}".`);
  }
}

async function acceptFolderShare(req){
  req = req || incomingFolderShare;
  if(!req) return;
  const openedFromPopup = req===incomingFolderShare;
  try{
    // Deterministic link doc FIRST — the shared_folders read rule depends
    // on this existing before the folder data can be read.
    await window.fb.setDoc(window.fb.doc(window.db,'folder_links',req.ownerUid+'_'+req.folderId+'_'+window.currentUser.uid), {
      ownerUid: req.ownerUid, ownerEmail: req.ownerEmail,
      folderId: req.folderId, folderName: req.folderName,
      recipientUid: window.currentUser.uid, recipientEmail: window.currentUser.email,
      createdAt: new Date().toISOString()
    });

    const snap = await window.fb.getDoc(window.fb.doc(window.db,'shared_folders',req.ownerUid+'_'+req.folderId));
    if(snap.exists()){
      const data = decryptSharedFolder(snap.data(), req.ownerUid);
      importSharedFolder(req, data, true);
      toast('✅ Folder added — starts today, ready to review');
    } else {
      // Owner hasn't mirrored this folder yet (e.g. they're offline). Leave a
      // local placeholder so watchSharedFolderUpdates below — and, after any
      // reload, resubscribeReceivedFolders() — keep listening for it instead
      // of losing track of the invite once folder_shares is marked accepted.
      ensureLocalSharedFolder(req);
      saveLS();
      renderHome();
      toast('📥 Invite accepted — folder will appear once the owner is next online');
    }

    await window.fb.updateDoc(window.fb.doc(window.db,'folder_shares',req.id), {status:'accepted'});
    watchSharedFolderUpdates(req);
  }catch(e){
    console.error('Failed to accept folder share', e);
    toast('⚠️ Failed to accept invite');
  }
  // Only close the popup if it was actually showing THIS invite — resolving
  // a different one from the notification panel while the popup happens to
  // be open for another invite shouldn't dismiss that unrelated popup.
  if(openedFromPopup) closeIncomingFolderShare();
}
window.acceptFolderShare = acceptFolderShare;

function watchSharedFolderUpdates(req){
  const key = req.ownerUid+'_'+req.folderId;
  if(receivedFolderWatchers[key]) receivedFolderWatchers[key]();
  receivedFolderWatchers[key] = window.fb.onSnapshot(window.fb.doc(window.db,'shared_folders',key), snap=>{
    if(!snap.exists()){
      // Firestore's onSnapshot always delivers the CURRENT state immediately
      // on subscribe — so if the owner simply hasn't mirrored this folder
      // yet (they were offline when the invite was accepted, or still are),
      // THIS callback's very first delivery legitimately has exists:false,
      // milliseconds after acceptFolderShare's own getDoc() found the same
      // thing and left a placeholder folder waiting (ensureLocalSharedFolder).
      // Treating that as "the owner deleted it" wiped the placeholder the
      // instant it was created — every single accept of an invite from an
      // offline owner self-destructed, and every reload
      // (resubscribeReceivedFolders) re-triggered it for any folder still
      // waiting on its first sync. Only trust "doesn't exist" as a REAL
      // deletion once this folder has actually received synced content
      // before (localFolder.everSynced, set by importSharedFolder) —
      // otherwise this is just "still waiting," not "was removed."
      // "Has synced before" also counts folders synced before this fix
      // existed (no everSynced flag yet, but real documents already there)
      // — no data migration needed, this just recognizes it retroactively.
      const localFolder = D && D.folders.find(f=>f.sharedFrom && f.sharedFrom.ownerUid===req.ownerUid && f.sharedFrom.folderId===req.folderId);
      const hasSyncedBefore = localFolder && (localFolder.everSynced || D.documents.some(d=>d.folderId===localFolder.id));
      if(hasSyncedBefore){
        delete receivedFolderWatchers[key];
        removeLocalSharedFolder(req.ownerUid, req.folderId, req.folderName);
      }
      return;
    }
    try{
      const data = decryptSharedFolder(snap.data(), req.ownerUid);
      importSharedFolder(req, data, false);
    }catch(e){ console.error('Shared folder update merge failed', e); }
  }, err=>console.error('Shared folder watch error', err));
}

function resubscribeReceivedFolders(){
  Object.values(receivedFolderWatchers).forEach(unsub=>unsub());
  receivedFolderWatchers = {};
  if(!D || !D.folders) return;
  D.folders.filter(f=>f.readOnly && f.sharedFrom).forEach(f=>{
    watchSharedFolderUpdates({ ownerUid: f.sharedFrom.ownerUid, folderId: f.sharedFrom.folderId, ownerEmail: f.sharedFrom.ownerEmail });
  });
}

// Removes a recipient's local read-only copy of a shared folder. The single
// place both "I left it myself" (leaveSharedFolder) and "the owner
// unshared/deleted it" (watchSharedFolderUpdates's !snap.exists() branch,
// below) route through — previously NEITHER path touched D.folders/
// D.documents, so a shared folder the recipient saw once stayed in their
// vault forever (just frozen, disconnected from live updates), which is the
// "I removed it but it's still showing" bug.
function removeLocalSharedFolder(ownerUid, folderId, folderName){
  if(!D) return;
  const localFolder = D.folders.find(f=>f.sharedFrom && f.sharedFrom.ownerUid===ownerUid && f.sharedFrom.folderId===folderId);
  if(!localFolder) return;
  D.documents = D.documents.filter(d=>d.folderId!==localFolder.id);
  D.folders = D.folders.filter(f=>f.id!==localFolder.id);
  if(typeof curFolder!=='undefined' && curFolder===localFolder.id) curFolder=null;
  saveLS();
  if(window.renderHome) renderHome();
  if(window.pushNotification) pushNotification('📪','Folder removed', `"${folderName||localFolder.name}" was unshared and removed from your vault.`);
}
window.removeLocalSharedFolder = removeLocalSharedFolder;

function leaveSharedFolder(folder){
  if(!folder.sharedFrom || !window.currentUser) return;
  const key = folder.sharedFrom.ownerUid+'_'+folder.sharedFrom.folderId;
  if(receivedFolderWatchers[key]){ receivedFolderWatchers[key](); delete receivedFolderWatchers[key]; }
  window.fb.deleteDoc(window.fb.doc(window.db,'folder_links',key+'_'+window.currentUser.uid)).catch(e=>console.error(e));
  removeLocalSharedFolder(folder.sharedFrom.ownerUid, folder.sharedFrom.folderId, folder.name);
}
window.leaveSharedFolder = leaveSharedFolder;

// Lets the OWNER see that a shared folder is actually being used — the
// recipient's own review count (already tracked on their local folder copy,
// same as any other folder's f.reviewCount) is mirrored onto the
// folder_links doc they already own from acceptFolderShare(), so the
// owner's existing watchMyShareLinks() listener picks it up for free with
// no new collection. Debounced the same way mirrorSharedFolder() is, so a
// review session doesn't spam Firestore with one write per card.
// NOTE: this assumes the folder_links security rule permits the recipient
// to UPDATE their own link doc (not just create it during accept) — if the
// rule only allows create, this write will silently fail (caught below)
// and would need a console-only rule change to enable.
function reportSharedFolderReview(folder){
  if(!window.currentUser || !folder.sharedFrom) return;
  const key = folder.sharedFrom.ownerUid+'_'+folder.sharedFrom.folderId+'_'+window.currentUser.uid;
  clearTimeout(reviewReportDebounce[key]);
  reviewReportDebounce[key] = setTimeout(async ()=>{
    try{
      await window.fb.updateDoc(window.fb.doc(window.db,'folder_links',key), {
        reviewCount: folder.reviewCount||0,
        lastReviewedAt: new Date().toISOString()
      });
    }catch(e){ console.error('Failed to report shared folder review activity (may need a Firestore rule update)', e); }
  }, 2000);
}
window.reportSharedFolderReview = reportSharedFolderReview;

// Called when the OWNER deletes a folder that was (or still is) shared.
// Without this, a still-pending invite is never cancelled — it just sits in
// folder_shares with status:'pending' forever, and initFolderShareListener's
// onSnapshot re-reports it as a fresh "added" doc on every single login (a
// brand-new subscription has no prior snapshot to diff against), so the
// recipient keeps getting the "Folder Share Invite" popup for a folder that
// no longer exists. Also tears down any already-accepted links + the mirror
// so nothing keeps referencing a folder that's gone.
async function cancelSharesForFolder(folderId){
  if(!window.currentUser || !window.fb || !window.fb.getDocs) return;
  try{
    const sharesQ = window.fb.query(
      window.fb.collection(window.db,'folder_shares'),
      window.fb.where('ownerUid','==',window.currentUser.uid),
      window.fb.where('folderId','==',folderId)
    );
    const sharesSnap = await window.fb.getDocs(sharesQ);
    await Promise.all(sharesSnap.docs
      .filter(d=>d.data().status==='pending')
      .map(d=>window.fb.deleteDoc(d.ref)));

    // shared_folders BEFORE folder_links, deliberately — per your Firestore
    // rules, a recipient's read access to shared_folders/{ownerUid}_{folderId}
    // is authorized by exists(folder_links/{...}). Deleting folder_links
    // first would revoke that access while shared_folders still exists,
    // which turns the recipient's live onSnapshot listener into a
    // permission-denied error instead of a clean "document deleted" event —
    // and removeLocalSharedFolder() only runs on the clean path (see
    // watchSharedFolderUpdates). This order keeps their read valid for the
    // instant that matters, so they get the real deletion event.
    await window.fb.deleteDoc(window.fb.doc(window.db,'shared_folders',window.currentUser.uid+'_'+folderId)).catch(()=>{});

    const linksQ = window.fb.query(
      window.fb.collection(window.db,'folder_links'),
      window.fb.where('ownerUid','==',window.currentUser.uid),
      window.fb.where('folderId','==',folderId)
    );
    const linksSnap = await window.fb.getDocs(linksQ);
    await Promise.all(linksSnap.docs.map(d=>window.fb.deleteDoc(d.ref)));
  }catch(e){ console.error('Failed to cancel shares for deleted folder', e); }
}
window.cancelSharesForFolder = cancelSharesForFolder;

// ── OWNER: mirror shared folders so recipients see updates ──────
// Keyed by folderId+recipientUid, remembered across snapshots purely so the
// callback below can tell "a recipient who was here is now gone" from "this
// is just the first load" — Firestore's onSnapshot hands us the full
// current list each time, not a diff, so the diffing has to happen here.
let prevShareLinksByKey = new Map();

function watchMyShareLinks(){
  if(myShareLinksUnsub){ myShareLinksUnsub(); myShareLinksUnsub=null; }
  mySharedFolderIds = new Set();
  prevShareLinksByKey = new Map();
  if(!window.currentUser || !window.fb) return;
  const q = window.fb.query(window.fb.collection(window.db,'folder_links'), window.fb.where('ownerUid','==',window.currentUser.uid));
  myShareLinksUnsub = window.fb.onSnapshot(q, snap=>{
    const links = snap.docs.map(d=>d.data());
    const nowByKey = new Map(links.map(l=>[l.folderId+'::'+l.recipientUid, l]));

    // A recipient present last snapshot but missing now just revoked their
    // own access (leaveSharedFolder deletes their own link doc) — notify
    // the owner locally. No server/push infra needed: this device already
    // holds a live Firestore listener on exactly this data.
    if(prevShareLinksByKey.size){
      prevShareLinksByKey.forEach((oldLink,key)=>{
        if(!nowByKey.has(key) && window.pushNotification){
          pushNotification('🔓','Access removed', `${oldLink.recipientEmail} removed their access to "${oldLink.folderName}".`);
        }
      });
    }
    prevShareLinksByKey = nowByKey;

    mySharedFolderIds = new Set(links.map(l=>l.folderId));
    renderSharedFoldersStatus(links);
    mirrorAllSharedFolders();
  }, err=>console.error('My share links watch error', err));
}

function mirrorAllSharedFolders(){
  if(!window.currentUser || !mySharedFolderIds.size) return;
  mySharedFolderIds.forEach(folderId=>mirrorSharedFolder(folderId));
}

async function mirrorSharedFolder(folderId){
  const folder = D.folders.find(f=>f.id===folderId);
  if(!folder || !window.currentUser) return;
  const docs = D.documents.filter(d=>d.folderId===folderId);
  const payloadObj = { folder: { name: folder.name }, documents: docs };
  const secretKey = window.currentUser.uid + '-nv-secret';
  const payload = CryptoJS.AES.encrypt(JSON.stringify(payloadObj), secretKey).toString();
  try{
    await window.fb.setDoc(window.fb.doc(window.db,'shared_folders',window.currentUser.uid+'_'+folderId), {
      ownerUid: window.currentUser.uid, folderId, payload, updatedAt: new Date().toISOString()
    });
  }catch(e){ console.error('Failed to mirror shared folder', folderId, e); }
}

function renderSharedFoldersStatus(links){
  const el = document.getElementById('shared-folders-status');
  if(!el) return;
  if(!links || !links.length){
    el.innerHTML = `<div class="sync-row">
      <div class="sync-ico" style="background:#0d1a3a">📤</div>
      <div class="sync-info"><strong>Share a Folder</strong><span>Use the ⋮ menu on any folder to share it by email</span></div>
    </div>`;
    return;
  }
  const byFolder = {};
  links.forEach(l=>{
    if(!byFolder[l.folderId]) byFolder[l.folderId] = { name: l.folderName, recipients: [] };
    byFolder[l.folderId].recipients.push({ email: l.recipientEmail, reviewCount: l.reviewCount||0 });
  });
  el.innerHTML = Object.values(byFolder).map(f=>`<div class="sync-row">
    <div class="sync-ico" style="background:#0d1a1a">📁</div>
    <div class="sync-info"><strong>${esc(f.name)}</strong><span>Shared with ${f.recipients.map(r=>`${esc(r.email)}${r.reviewCount?` (${r.reviewCount} review${r.reviewCount>1?'s':''})`:''}`).join(', ')}</span></div>
  </div>`).join('');
}
window.renderSharedFoldersStatus = renderSharedFoldersStatus;

// Owner's edits need to reach shared_folders too — debounced alongside
// the normal save, same pattern firebase-init.js uses for cloud sync.
// Wrapped lazily on the first nv-auth-changed event rather than at script
// load: firebase-init.js is a deferred `type="module"` script, so it runs
// (and replaces window.saveLS with its own Firestore-syncing version) AFTER
// every plain <script> — including this file — has already executed. Wrapping
// at load time here would just get silently discarded by that later
// assignment, which only falls back to the previous saveLS in its signed-out
// branch.
let mirrorDebounce = null;
function wrapSaveLSForMirroring(){
  if(window.__nvShareSaveWrapped) return;
  window.__nvShareSaveWrapped = true;
  const baseSaveLSForShare = window.saveLS;
  window.saveLS = function(){
    baseSaveLSForShare();
    if(window.currentUser && mySharedFolderIds.size){
      clearTimeout(mirrorDebounce);
      mirrorDebounce = setTimeout(()=>{ mirrorAllSharedFolders(); }, 1600);
    }
  };
}

window.addEventListener('nv-auth-changed', ()=>{
  wrapSaveLSForMirroring();
  initFolderShareListener();
  watchMyShareLinks();
  resubscribeReceivedFolders();
});
