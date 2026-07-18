// ── NOTIFICATIONS ────────────────────────────────────────────────
// Two layers:
// 1. Browser Notification API (notifyUser) — fires only while NoteVault is
//    open in a tab. Real push (arrives with the app closed) needs Firebase
//    Cloud Messaging + Cloud Functions, which isn't wired up yet.
// 2. In-app inbox (D.notifications, persisted) — the 🔔 bell shown on
//    Home/Search/Sync. Every event below goes through pushNotification()
//    so it lands in both layers at once.

function notifyUser(title, body, opts={}){
  if(!('Notification' in window)) return;
  if(Notification.permission !== 'granted') return;
  try{ new Notification(title, {body, ...opts}); }
  catch(e){ console.error('Notification failed', e); }
}
window.notifyUser = notifyUser;

async function requestNotifyPermission(){
  if(!('Notification' in window)){ toast('⚠️ Notifications not supported on this device'); return; }
  const perm = await Notification.requestPermission();
  renderNotificationSettings();
  if(perm==='granted'){ toast('🔔 Notifications enabled'); checkDailyReminder(); }
  else if(perm==='denied') toast('🔕 Notifications blocked — enable in browser settings');
}
window.requestNotifyPermission = requestNotifyPermission;

// Enabled by default, automatically — no manual on/off control in the UI.
// (The one thing genuinely outside the app's control is the browser's own
// native permission prompt itself, which only a user gesture can grant; this
// just means the app requests it proactively on load instead of waiting for
// the user to find and tap an "Enable" button.)
function renderNotificationSettings(){
  const el = document.getElementById('notif-status-row');
  if(!el) return;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const labels = {granted:'Enabled', denied:'Blocked — allow notifications for this site in your browser settings', default:'Requesting permission…', unsupported:'Not supported on this browser'};
  el.innerHTML = `<div class="sync-row">
    <div class="sync-ico" style="background:#1a1a0d">🔔</div>
    <div class="sync-info"><strong>Daily Review Reminders</strong><span><span class="notif-dot ${perm}"></span>${labels[perm]}</span></div>
  </div>`;
}
window.renderNotificationSettings = renderNotificationSettings;

// ── IN-APP NOTIFICATION INBOX ──────────────────────────────────────
function pushNotification(icon, title, body){
  if(!D) return;
  if(!Array.isArray(D.notifications)) D.notifications = [];
  D.notifications.unshift({ id: gid(), icon, title, body, ts: new Date().toISOString(), read: false });
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
  el.innerHTML = list.map(n=>`<div class="notif-item">
    <div class="notif-item-ico">${n.icon||'🔔'}</div>
    <div class="notif-item-body">
      <strong>${esc(n.title)}</strong>
      <span>${esc(n.body)}</span>
      <small>${new Date(n.ts).toLocaleString()}</small>
    </div>
  </div>`).join('');
}
window.renderNotifPanel = renderNotifPanel;

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
const REMINDER_LS_KEY = 'nv_last_reminder';
function prevDay(ds){ const d=new Date(ds); d.setDate(d.getDate()-1); return d.toISOString().split('T')[0]; }

const TASK_REMINDERS = ['Complete daily task.', 'Do it today.', 'Daily five minute tune your goal.'];
const STREAK_WARNINGS = ["Don't skip for two days.", 'Streak is breaking.'];

function checkDailyReminder(){
  if(!D) return;
  const t = today();
  let last = null;
  try{ last = localStorage.getItem(REMINDER_LS_KEY); }catch{}
  if(last===t) return;

  const totalDue = D.documents.reduce((n,d)=>n+d.items.filter(i=>isDue(i)&&isFC(i)).length,0);
  if(totalDue>0){
    const hour = new Date().getHours();
    const msg = hour>=22 ? "Last 2hr to complete today's task." : TASK_REMINDERS[Math.floor(Math.random()*TASK_REMINDERS.length)];
    pushNotification('📚','Task Reminder',msg);
    try{ localStorage.setItem(REMINDER_LS_KEY, t); }catch{}
    return;
  }

  const streakActive = D.tracker && D.tracker.length && D.tracker.includes(prevDay(t)) && !D.tracker.includes(t);
  if(streakActive){
    const msg = STREAK_WARNINGS[Math.floor(Math.random()*STREAK_WARNINGS.length)];
    pushNotification('🔥','Streak Warning',msg);
    try{ localStorage.setItem(REMINDER_LS_KEY, t); }catch{}
  }
}

window.addEventListener('load', ()=>{
  setTimeout(()=>{
    if(D){ renderNotificationSettings(); renderNotificationBell(); checkDailyReminder(); }
    if('Notification' in window && Notification.permission==='default') requestNotifyPermission();
  }, 800);
});
