// ── NOTIFICATIONS ────────────────────────────────────────────────
// Three layers:
// 1. Native notifications (@capacitor/local-notifications, APK build only) —
//    two different uses of the same plugin:
//      a) Scheduled: the daily task reminder + streak warning, registered
//         with Android's AlarmManager so they fire at their set time whether
//         NoteVault is open, backgrounded, or fully closed. See
//         scheduleRecurringReminders() below.
//      b) Ad-hoc/instant (notifyUser): fired the moment something happens —
//         a folder-share invite arrives, the owner adds cards, an
//         achievement unlocks. These only fire while NoteVault's JS is
//         actually running (foreground or backgrounded-but-alive), same
//         ceiling as the old browser-Notification behavior — Firestore's
//         onSnapshot listeners that trigger these can't wake up a fully
//         closed app, so true closed-app push would need a server (Firebase
//         Cloud Messaging + a Cloud Function), which is out of scope here.
// 2. Browser Notification API (notifyUser) — web build fallback, fires only
//    while NoteVault is open in a tab.
// 3. In-app inbox (D.notifications, persisted) — the 🔔 bell shown on
//    Home/Search/Sync. Every event below goes through pushNotification()
//    so it lands in every layer at once.

// True only inside the compiled Android app (window.Capacitor is injected by
// the native WebView bridge at runtime — it doesn't exist in a browser tab),
// never assume it's present without this check.
function isNative(){ return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
function LN(){ return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications; }

const TASK_REMINDER_ID = 1001;
const STREAK_WARNING_ID = 1002;
const SNOOZE_ID_BASE = 5000;
const ADHOC_ID_BASE = 9000; // notifyUser()'s instant native notifications — kept out of the fixed reminder/snooze id ranges above
const REMINDER_HOUR = 20;   // 8pm local daily task reminder
const STREAK_HOUR = 21;     // 9pm local streak-warning check

let adhocNotifId = ADHOC_ID_BASE;

function notifyUser(title, body, opts={}){
  if(isNative()){
    const plugin = LN();
    if(!plugin || !window.__nvNotifGranted) return;
    adhocNotifId = ADHOC_ID_BASE + ((adhocNotifId - ADHOC_ID_BASE + 1) % 1000);
    plugin.schedule({ notifications: [{
      id: adhocNotifId,
      title, body,
      schedule: { at: new Date(Date.now() + 300) },
      smallIcon: 'ic_stat_notify'
    }] }).catch(e=>console.error('Native notification failed', e));
    return;
  }
  if(!('Notification' in window)) return;
  if(Notification.permission !== 'granted') return;
  try{ new Notification(title, {body, ...opts}); }
  catch(e){ console.error('Notification failed', e); }
}
window.notifyUser = notifyUser;

// ── Permission (web) ─────────────────────────────────────────────
async function requestNotifyPermission(){
  if(!('Notification' in window)){ toast('⚠️ Notifications not supported on this device'); return; }
  const perm = await Notification.requestPermission();
  renderNotificationSettings();
  if(perm==='granted'){ toast('🔔 Notifications enabled'); checkDailyReminder(); }
  else if(perm==='denied') toast('🔕 Notifications blocked — enable in browser settings');
}
window.requestNotifyPermission = requestNotifyPermission;

function renderNotificationSettings(){
  const el = document.getElementById('notif-status-row');
  if(!el) return;
  const supported = isNative() || ('Notification' in window);
  const perm = isNative() ? (window.__nvNotifGranted ? 'granted' : 'default') : (supported ? Notification.permission : 'unsupported');
  const labels = {granted:'Enabled', denied:'Blocked — allow notifications for this site in your browser settings', default:'Requesting permission…', unsupported:'Not supported on this browser'};
  el.innerHTML = `<div class="sync-row">
    <div class="sync-ico" style="background:#1a1a0d">🔔</div>
    <div class="sync-info"><strong>Daily Review Reminders</strong><span><span class="notif-dot ${perm}"></span>${labels[perm]}</span></div>
  </div>`;
}
window.renderNotificationSettings = renderNotificationSettings;

// ── Mandatory permission gate (#notif-gate-ov in index.html) ───────
// Notifications are this app's core feature (daily reminders + streak
// warnings), so — same pattern as the mandatory sign-in gate in
// firebase-init.js's attemptCloseAuthDismiss — a signed-in user can't
// dismiss this and use the app underneath without granting the permission.
async function checkNotifPermissionGranted(){
  if(isNative()){
    const plugin = LN();
    if(!plugin) return false;
    const status = await plugin.checkPermissions();
    return status.display === 'granted';
  }
  if(!('Notification' in window)) return true; // unsupported platform: don't block
  return Notification.permission === 'granted';
}

async function openNotifGateIfNeeded(){
  const granted = await checkNotifPermissionGranted();
  window.__nvNotifGranted = granted;
  if(granted){
    document.getElementById('notif-gate-ov')?.classList.remove('open');
    return true;
  }
  document.getElementById('notif-gate-ov')?.classList.add('open');
  return false;
}

async function requestNotifyGate(){
  let perm;
  if(isNative()){
    const plugin = LN();
    if(!plugin){ toast('⚠️ Notifications unavailable'); return; }
    const status = await plugin.requestPermissions();
    perm = status.display;
  } else if('Notification' in window){
    perm = await Notification.requestPermission();
  } else {
    perm = 'granted'; // unsupported platform: don't block the app on it
  }
  if(perm === 'granted'){
    window.__nvNotifGranted = true;
    document.getElementById('notif-gate-ov')?.classList.remove('open');
    toast('🔔 Notifications enabled');
    renderNotificationSettings();
    checkDailyReminder();
    scheduleRecurringReminders();
  } else {
    // Android only shows the system permission dialog once; after a denial
    // the OS silently no-ops future requestPermissions() calls, so the only
    // way forward is the user granting it from Settings themselves — swap
    // to a "check again" button instead of re-prompting into a dead end.
    document.getElementById('notif-gate-sub').textContent = 'Notifications are blocked. Open Settings → Apps → NoteVault → Notifications, enable them, then come back and tap below.';
    document.getElementById('notif-gate-btn').style.display = 'none';
    document.getElementById('notif-gate-recheck-btn').style.display = 'block';
  }
}
window.requestNotifyGate = requestNotifyGate;

async function recheckNotifyGate(){
  const granted = await checkNotifPermissionGranted();
  if(granted){
    window.__nvNotifGranted = true;
    document.getElementById('notif-gate-ov')?.classList.remove('open');
    toast('🔔 Notifications enabled');
    renderNotificationSettings();
    checkDailyReminder();
    scheduleRecurringReminders();
  } else {
    toast('🔕 Still blocked — enable notifications in system settings');
  }
}
window.recheckNotifyGate = recheckNotifyGate;

// ── IN-APP NOTIFICATION INBOX ──────────────────────────────────────
// action (optional) lets a notification carry a resolvable task — currently
// only folder-share invites use it, rendered as Accept/Reject buttons by
// renderNotifPanel() below and resolved via resolveNotifShareInvite().
function pushNotification(icon, title, body, action){
  if(!D) return;
  if(!Array.isArray(D.notifications)) D.notifications = [];
  D.notifications.unshift({ id: gid(), icon, title, body, ts: new Date().toISOString(), read: false, action: action||null });
  if(D.notifications.length > 50) D.notifications.length = 50;
  saveLS();
  renderNotificationBell();
  if(document.getElementById('notif-panel-ov')?.classList.contains('open')) renderNotifPanel();
  notifyUser(`${icon} ${title}`, body);
}
window.pushNotification = pushNotification;

function renderNotificationBell(){
  const unread = (D && Array.isArray(D.notifications)) ? D.notifications.filter(n=>!n.read).length : 0;
  document.querySelectorAll('.notif-badge').forEach(b=>{
    if(unread>0){ b.style.display='flex'; b.textContent = unread>9?'9+':String(unread); }
    else b.style.display='none';
  });
}
window.renderNotificationBell = renderNotificationBell;

function openNotifPanel(){
  renderNotifPanel();
  document.getElementById('notif-panel-ov').classList.add('open');
  if(D && Array.isArray(D.notifications) && D.notifications.some(n=>!n.read)){
    D.notifications.forEach(n=>n.read=true);
    saveLS();
    renderNotificationBell();
  }
}
window.openNotifPanel = openNotifPanel;

function closeNotifPanel(){
  document.getElementById('notif-panel-ov').classList.remove('open');
}
window.closeNotifPanel = closeNotifPanel;

function renderNotifPanel(){
  const el = document.getElementById('notif-panel-list');
  if(!el) return;
  const list = (D && D.notifications) || [];
  if(!list.length){
    el.innerHTML = '<div style="padding:30px 14px;text-align:center;font-size:12px;color:var(--t3);font-family:var(--mono)">No notifications yet</div>';
    return;
  }
  el.innerHTML = list.map(n=>{
    let actionHtml = '';
    if(n.action && n.action.type==='folder_share_invite'){
      actionHtml = n.action.resolved
        ? `<div class="notif-item-resolved">${n.action.resolved==='accepted'?'✅ Accepted':'🚫 Declined'}</div>`
        : `<div class="notif-item-actions">
            <button class="notif-act-btn accept" onclick="resolveNotifShareInvite('${n.id}',true)">Accept</button>
            <button class="notif-act-btn reject" onclick="resolveNotifShareInvite('${n.id}',false)">Reject</button>
          </div>`;
    }
    return `<div class="notif-item">
    <div class="notif-item-ico">${n.icon||'🔔'}</div>
    <div class="notif-item-body">
      <strong>${esc(n.title)}</strong>
      <span>${esc(n.body)}</span>
      <small>${new Date(n.ts).toLocaleString()}</small>
      ${actionHtml}
    </div>
  </div>`;
  }).join('');
}
window.renderNotifPanel = renderNotifPanel;

// Resolves a folder-share invite directly from its notification-panel entry
// — an alternative to the #fs-incoming-ov popup (folder-share.js), for when
// that popup was dismissed/missed. Reconstructs the same {id,ownerUid,...}
// shape acceptFolderShare()/rejectFolderShare() already accept, from the
// action metadata pushNotification() stored alongside this notification.
function resolveNotifShareInvite(notifId, accept){
  if(!D || !Array.isArray(D.notifications)) return;
  const n = D.notifications.find(x=>x.id===notifId);
  if(!n || !n.action || n.action.resolved) return;
  const req = { id:n.action.shareId, ownerUid:n.action.ownerUid, ownerEmail:n.action.ownerEmail, folderId:n.action.folderId, folderName:n.action.folderName };
  n.action.resolved = accept ? 'accepted' : 'rejected';
  if(accept){ if(window.acceptFolderShare) window.acceptFolderShare(req); }
  else if(window.rejectFolderShare) window.rejectFolderShare(req);
  saveLS();
  renderNotifPanel();
}
window.resolveNotifShareInvite = resolveNotifShareInvite;

function clearAllNotifications(){
  if(!D) return;
  D.notifications = [];
  saveLS();
  renderNotifPanel();
  renderNotificationBell();
  toast('🗑 Notifications cleared');
}
window.clearAllNotifications = clearAllNotifications;

// ── DAILY REMINDER / STREAK WARNING (feeds the inbox, once per day) ─
function prevDay(ds){ const d=new Date(ds); d.setDate(d.getDate()-1); return d.toISOString().split('T')[0]; }

const TASK_REMINDERS = ['Complete daily task.', 'Do it today.', 'Daily five minute tune your goal.'];
const STREAK_WARNINGS = ["Don't skip for two days.", 'Streak is breaking.'];

// Like pushNotification, but the system notification itself also gets
// Review Now / Snooze 1h action buttons on web — the web equivalent of the
// native scheduled reminders' actionTypeId:'TASK_ACTIONS' (see
// scheduleRecurringReminders). Only used for these two daily reminder
// types; everything else (achievements, growth, folder-share…) still goes
// through the plain pushNotification(), which has no actions.
// Web action buttons only exist on notifications shown via a Service
// Worker's showNotification() (see sw.js's notificationclick handler,
// which posts the pressed action back to this page) — the plain
// `new Notification()` constructor notifyUser() otherwise uses has no
// actions support at all, hence the separate path here instead of just
// passing an `actions` option through notifyUser().
function pushReminderNotification(icon, title, body){
  if(!D) return;
  if(!Array.isArray(D.notifications)) D.notifications = [];
  D.notifications.unshift({ id: gid(), icon, title, body, ts: new Date().toISOString(), read: false, action: null });
  if(D.notifications.length > 50) D.notifications.length = 50;
  saveLS();
  renderNotificationBell();
  if(document.getElementById('notif-panel-ov')?.classList.contains('open')) renderNotifPanel();

  if(isNative()){ notifyUser(`${icon} ${title}`, body); return; }
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  const fallback=()=>{ try{ new Notification(`${icon} ${title}`,{body}); }catch(e){} };
  if('serviceWorker' in navigator){
    navigator.serviceWorker.ready.then(reg=>
      reg.showNotification(`${icon} ${title}`, { body, actions:[{action:'review',title:'Review Now'},{action:'snooze',title:'Snooze 1h'}] }).catch(fallback)
    ).catch(fallback);
  } else fallback();
}

function checkDailyReminder(){
  if(!D) return;
  const t = today();
  if(D.lastReminderDate===t) return;

  const totalDue = D.documents.reduce((n,d)=>n+d.items.filter(i=>isDue(i)&&isFC(i)).length,0);
  if(totalDue>0){
    const hour = new Date().getHours();
    const msg = hour>=22 ? "Last 2hr to complete today's task." : TASK_REMINDERS[Math.floor(Math.random()*TASK_REMINDERS.length)];
    pushReminderNotification('📚','Task Reminder',msg);
    D.lastReminderDate = t;
    saveLS();
    return;
  }

  const streakActive = D.tracker && D.tracker.length && D.tracker.includes(prevDay(t)) && !D.tracker.includes(t);
  if(streakActive){
    const msg = STREAK_WARNINGS[Math.floor(Math.random()*STREAK_WARNINGS.length)];
    pushReminderNotification('🔥','Streak Warning',msg);
    D.lastReminderDate = t;
    saveLS();
  }
}

// Web has no equivalent of Android's AlarmManager-backed scheduling — while
// the tab is open, periodically re-check so a session left open all day
// still gets today's reminder around the usual times, instead of only ever
// checking once, immediately, whichever moment sign-in happened to be.
// checkDailyReminder() already no-ops once D.lastReminderDate===today(), so
// calling it repeatedly here is safe — it only actually notifies once.
if(!isNative()){
  setInterval(()=>{ if(D) checkDailyReminder(); }, 5*60*1000);
}

// Handles the Review Now / Snooze 1h buttons on a web notification shown by
// pushReminderNotification() above — the service worker itself can't call
// into this page's JS directly (separate execution context), so sw.js's
// notificationclick handler posts the pressed action back here instead.
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message', e=>{
    if(!e.data || e.data.type!=='notification-action') return;
    if(e.data.action==='review'){
      if(typeof reviewTab==='function') reviewTab();
    } else if(e.data.action==='snooze'){
      // No background scheduling on web — best effort: re-check in an hour
      // if this tab is still open (page-lifetime setTimeout only).
      setTimeout(()=>{ if(D) checkDailyReminder(); }, 60*60*1000);
      toast('⏰ Will check again in about an hour if this tab stays open');
    }
  });
}

// ── NATIVE SCHEDULED REMINDERS (APK build — survive app being closed) ──
// Local notifications, once scheduled, are handed off to Android's own
// AlarmManager — they still fire days later even if NoteVault was never
// reopened. That also means their body text is whatever it was at the last
// scheduling call, not computed fresh at fire time, so every app open
// re-schedules (cancel + re-add under the same fixed ID) using the latest
// due-count/streak state. If the condition that justified a reminder no
// longer holds (e.g. today's review already done), the re-schedule just
// cancels it instead of re-adding it.
async function scheduleRecurringReminders(){
  if(!isNative() || !D || !window.__nvNotifGranted) return;
  const plugin = LN();
  if(!plugin) return;

  await plugin.cancel({ notifications: [{id: TASK_REMINDER_ID}, {id: STREAK_WARNING_ID}] });

  const toSchedule = [];
  const totalDue = D.documents.reduce((n,d)=>n+d.items.filter(i=>isDue(i)&&isFC(i)).length,0);
  if(totalDue>0){
    toSchedule.push({
      id: TASK_REMINDER_ID,
      title: '📚 Task Reminder',
      body: `${totalDue} card${totalDue===1?'':'s'} due for review — ${TASK_REMINDERS[Math.floor(Math.random()*TASK_REMINDERS.length)]}`,
      schedule: { on: { hour: REMINDER_HOUR, minute: 0 }, allowWhileIdle: true },
      actionTypeId: 'TASK_ACTIONS',
      smallIcon: 'ic_stat_notify'
    });
  }

  const t = today();
  const streakActive = D.tracker && D.tracker.length && D.tracker.includes(prevDay(t)) && !D.tracker.includes(t);
  if(streakActive){
    toSchedule.push({
      id: STREAK_WARNING_ID,
      title: '🔥 Streak Warning',
      body: STREAK_WARNINGS[Math.floor(Math.random()*STREAK_WARNINGS.length)],
      schedule: { on: { hour: STREAK_HOUR, minute: 0 }, allowWhileIdle: true },
      actionTypeId: 'TASK_ACTIONS',
      smallIcon: 'ic_stat_notify'
    });
  }

  if(toSchedule.length) await plugin.schedule({ notifications: toSchedule });
}
window.scheduleRecurringReminders = scheduleRecurringReminders;

// Quick actions on the reminder notification itself — "Review Now" jumps
// straight into the review session, "Snooze 1h" reschedules a one-off copy
// without touching the recurring daily slot.
function registerNotifActionHandlers(){
  const plugin = LN();
  if(!plugin || window.__nvActionsRegistered) return;
  window.__nvActionsRegistered = true;

  plugin.registerActionTypes({
    types: [{
      id: 'TASK_ACTIONS',
      actions: [
        { id: 'review', title: 'Review Now' },
        { id: 'snooze', title: 'Snooze 1h' }
      ]
    }]
  });

  plugin.addListener('localNotificationActionPerformed', async e => {
    const actionId = e.actionId;
    const notif = e.notification;
    if(actionId === 'review'){
      if(typeof reviewTab === 'function') reviewTab();
      else if(typeof switchTab === 'function') switchTab('review');
    } else if(actionId === 'snooze'){
      await plugin.schedule({ notifications: [{
        id: SNOOZE_ID_BASE + Math.floor(Math.random()*1000),
        title: notif.title,
        body: notif.body,
        schedule: { at: new Date(Date.now() + 60*60*1000), allowWhileIdle: true },
        actionTypeId: 'TASK_ACTIONS',
        smallIcon: 'ic_stat_notify'
      }] });
      toast('⏰ Snoozed for 1 hour');
    }
  });
}

// D stays null until Firebase auth resolves AND the user manually signs in
// (routinely much slower than a fixed post-`load` delay), so this is driven
// off nv-auth-changed's verified case — dispatched in firebase-init.js right
// after loadUserData() finishes, same pattern folder-share.js already uses
// for its own post-sign-in setup — instead of a timer race against D.
async function initNotifications(){
  if(!D) return;
  renderNotificationBell();

  if(isNative()) registerNotifActionHandlers();

  const granted = await openNotifGateIfNeeded();
  renderNotificationSettings();
  if(!granted) return; // gate overlay is up; rest resumes from requestNotifyGate()/recheckNotifyGate()

  checkDailyReminder();
  if(isNative()) scheduleRecurringReminders();
  else if('Notification' in window && Notification.permission==='default') requestNotifyPermission();
}
window.addEventListener('nv-auth-changed', e=>{
  if(e.detail && e.detail.user) initNotifications();
});

// Local notifications are scheduled once per app-open with whatever due
// count was true at that moment (see scheduleRecurringReminders' own
// comment) — re-run on resume so a session left open across midnight, or
// a review completed after backgrounding, refreshes the still-pending alarm
// instead of it firing with yesterday's stale numbers.
if(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App){
  window.Capacitor.Plugins.App.addListener('appStateChange', state => {
    if(state.isActive && D && window.__nvNotifGranted) scheduleRecurringReminders();
  });
}
