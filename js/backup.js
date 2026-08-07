// ── DAILY BACKUP (bkp) ───────────────────────────────────────────────
// A server-side, rolling 7-day safety net — separate from the vault's own
// live document (users/{uid}) so a bug that corrupts or deletes data today
// can't also erase yesterday's known-good snapshot the way overwriting a
// single document would. One snapshot per calendar day, taken client-side
// (there's no Cloud Functions/cron here — see notifications.js's own notes
// on why true server-side scheduling is out of scope), so it only happens
// for accounts that actually open the app that day, on whichever device
// they open it on.
//
// Rollback deliberately reuses the EXISTING Import flow (index.html's
// "Import Data" section -> triggerImport()/confirmImport() in app-core.js)
// instead of a new one-click restore: downloadBackup() below just produces
// a plain .nvault file in the exact same {version,exportedAt,folders,
// documents,images} shape buildExport() already produces, so picking
// "Replace" in that already-existing, already-tested UI IS the rollback.
const BACKUP_RETENTION_DAYS = 7;

// Failures used to be console.error-only, so a persistent problem (offline,
// rules mismatch, quota) looked identical from the user's side to "just
// hasn't run yet" — the Sync tab's list stayed on "No backups yet" forever
// with no indication anything had even been attempted. lastBackupError +
// the toast below make a failed attempt visible; retrying on every Sync-tab
// visit (see switchTab in app-core.js) gives it a natural retry path instead
// of waiting a full day for the date guard to allow another attempt.
let lastBackupError = null;

async function runDailyBackup(){
  if(!D || !window.currentUser || !window.fb) return;
  const t = today();
  if(D.lastBackupDate === t) return;
  try{
    await window.fb.setDoc(window.fb.doc(window.db,'users',window.currentUser.uid,'backups',t), {
      createdAt: new Date().toISOString(),
      folders: D.folders || [],
      documents: D.documents || [],
      images: D.images || {}
    });
    D.lastBackupDate = t;
    lastBackupError = null;
    saveLS();
    pruneOldBackups();
    renderBackupList();
  }catch(e){
    console.error('Daily backup failed', e);
    lastBackupError = e;
    toast('⚠️ Today\'s backup failed — will retry next time you open Sync');
    renderBackupList();
  }
}
window.runDailyBackup = runDailyBackup;

// Count-based, not calendar-time-based — deliberately. A cutoff like
// "delete anything more than 7 days before today" breaks exactly the case
// this feature exists for: someone backs up for a week (days 1-7), then
// doesn't open the app for a month. The moment they finally reopen it,
// EVERY one of those 7 backups is now "more than 7 days old" relative to
// the new today — a calendar-time cutoff would wipe out the whole week
// right as the new backup is created, right when they're most likely to
// actually need it. Keeping "the newest 7 that exist" instead means that
// week survives intact no matter how long the gap was — a doc only gets
// dropped once an 8th, newer one pushes it out.
async function pruneOldBackups(){
  if(!window.currentUser || !window.fb || !window.fb.getDocs) return;
  try{
    const snap = await window.fb.getDocs(window.fb.collection(window.db,'users',window.currentUser.uid,'backups'));
    const sorted = snap.docs.sort((a,b)=>b.id.localeCompare(a.id)); // newest date first
    const toDelete = sorted.slice(BACKUP_RETENTION_DAYS); // keep the newest N, drop anything beyond that
    await Promise.all(toDelete.map(d=>window.fb.deleteDoc(d.ref)));
  }catch(e){ console.error('Failed to prune old backups', e); }
}

// ── Sync tab: list + per-date download ───────────────────────────────
function backupStatusRow(){
  if(lastBackupError){
    return `<div class="sync-row">
      <div class="sync-ico" style="background:#1a0d0d">⚠️</div>
      <div class="sync-info"><strong>Today's backup failed</strong><span>Will retry automatically next time you open Sync</span></div>
    </div>`;
  }
  if(D && D.lastBackupDate === today()){
    return `<div class="sync-row">
      <div class="sync-ico" style="background:#0d1a0d">✅</div>
      <div class="sync-info"><strong>Backed up today</strong><span>Last snapshot: ${esc(today())}</span></div>
    </div>`;
  }
  return '';
}

async function renderBackupList(){
  const el = document.getElementById('backup-list');
  if(!el || !window.currentUser || !window.fb) return;
  el.innerHTML = '<div class="sync-row"><div class="sync-info"><span>Loading…</span></div></div>';
  try{
    const snap = await window.fb.getDocs(window.fb.collection(window.db,'users',window.currentUser.uid,'backups'));
    const backups = snap.docs.map(d=>({date:d.id, ...d.data()})).sort((a,b)=>b.date.localeCompare(a.date));
    if(!backups.length){
      el.innerHTML = backupStatusRow() + `<div class="sync-row">
        <div class="sync-ico" style="background:#1a1a0d">🗄️</div>
        <div class="sync-info"><strong>No backups yet</strong><span>One is taken automatically each day you use the app</span></div>
      </div>`;
      return;
    }
    el.innerHTML = backupStatusRow() + backups.map(b=>{
      const cardCount = (b.documents||[]).reduce((n,d)=>n+(d.items||[]).filter(i=>i.srs).length,0);
      const dateLabel = new Date(b.date+'T00:00:00').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
      return `<div class="sync-row">
        <div class="sync-ico" style="background:#1a1a0d">🗄️</div>
        <div class="sync-info"><strong>${esc(dateLabel)}</strong><span>${(b.folders||[]).length} folder(s) · ${(b.documents||[]).length} file(s) · ${cardCount} card(s)</span></div>
        <button class="sync-btn btn-export" onclick="downloadBackup('${b.date}')" title="Download this day's backup as a .nvault file">⬇ Download</button>
      </div>`;
    }).join('');
  }catch(e){
    console.error('Failed to load backups', e);
    el.innerHTML = '<div class="sync-row"><div class="sync-info"><span>⚠️ Failed to load backups</span></div></div>';
  }
}
window.renderBackupList = renderBackupList;

async function downloadBackup(date){
  if(!window.currentUser || !window.fb) return;
  try{
    const snap = await window.fb.getDoc(window.fb.doc(window.db,'users',window.currentUser.uid,'backups',date));
    if(!snap.exists()){ toast('⚠️ Backup not found'); return; }
    const b = snap.data();
    const content = JSON.stringify({
      version: 4, exportedAt: b.createdAt,
      folders: b.folders||[], documents: b.documents||[], images: b.images||{}
    }, null, 2);
    if(window.dlFile) dlFile(content, `notevault-backup-${date}.nvault`);
    toast(`💾 Backup from ${date} downloaded — use Import Data → Replace to roll back to it`);
  }catch(e){
    console.error('Failed to download backup', e);
    toast('⚠️ Failed to download backup');
  }
}
window.downloadBackup = downloadBackup;

window.addEventListener('nv-auth-changed', e=>{
  if(e.detail && e.detail.user) runDailyBackup();
});
