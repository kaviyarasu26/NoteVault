// ── ACHIEVEMENTS / BADGES ────────────────────────────────────────
// Small milestone system layered on data that's already tracked (D.tracker
// via currentStreak(), D.perfectStreak, D.totalReviewed) — checkAchievements()
// is called from rate() in app-core.js right after those fields update.

const BADGES = [
  { id:'first_review', icon:'🌱', name:'First Steps',   desc:'Complete your first review',        check:()=>(D.totalReviewed||0)>=1 },
  { id:'century',      icon:'💯', name:'Century',        desc:'Review 100 cards total',             check:()=>(D.totalReviewed||0)>=100 },
  { id:'streak_7',     icon:'🔥', name:'Week Warrior',   desc:'Reach a 7-day streak',                check:()=>(window.currentStreak?currentStreak():0)>=7 },
  { id:'streak_30',    icon:'🏆', name:'Unstoppable',    desc:'Reach a 30-day streak',               check:()=>(window.currentStreak?currentStreak():0)>=30 },
  { id:'perfect_10',   icon:'⭐', name:'Perfectionist',  desc:'Rate 10 cards perfect in a row',      check:()=>(D.perfectStreak||0)>=10 },
];
window.BADGES = BADGES;

// Returns the list of newly-earned badges (empty if none) and persists them.
function checkAchievements(){
  if(!D) return [];
  if(!Array.isArray(D.badges)) D.badges=[];
  const earnedIds = new Set(D.badges.map(b=>b.id));
  const newly=[];
  BADGES.forEach(b=>{
    if(!earnedIds.has(b.id) && b.check()){
      D.badges.push({ id:b.id, earnedAt:new Date().toISOString() });
      newly.push(b);
    }
  });
  if(newly.length) saveLS();
  return newly;
}
window.checkAchievements = checkAchievements;

function announceBadge(badge){
  if(window.pushNotification) pushNotification(badge.icon, `Achievement unlocked: ${badge.name}`, badge.desc);
  toast(`${badge.icon} Achievement unlocked — ${badge.name}`);
  if(window.renderSyncScreenExtras) renderSyncScreenExtras();
}
window.announceBadge = announceBadge;

// Fills the "Achievements" section on the Sync screen — this implements the
// renderSyncScreenExtras() hook that switchTab() already calls (app-core.js)
// but was previously undefined.
function renderSyncScreenExtras(){
  const el=document.getElementById('achievements-list');
  if(!el || !D) return;
  const earned=new Map((D.badges||[]).map(b=>[b.id,b]));
  el.innerHTML = BADGES.map(b=>{
    const got=earned.get(b.id);
    return `<div class="sync-row${got?'':' ach-locked'}">
      <div class="sync-ico" style="background:${got?'#0d1a3a':'#12141c'}">${got?b.icon:'🔒'}</div>
      <div class="sync-info"><strong>${esc(b.name)}</strong><span>${esc(b.desc)}${got?` · earned ${new Date(got.earnedAt).toLocaleDateString()}`:''}</span></div>
    </div>`;
  }).join('');
}
window.renderSyncScreenExtras = renderSyncScreenExtras;
