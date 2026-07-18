// ── DAILY TRACKER ────────────────────────────────────────────────
// Logs a date into D.tracker whenever a review session is completed
// (called from rate() in app-core.js) and feeds the streak count shown
// in the Home header badge (see renderHome, app-core.js).

function logTrackerToday(){
  if(!D.tracker) D.tracker = [];
  const t = today();
  if(!D.tracker.includes(t)){ D.tracker.push(t); saveLS(); }
}
window.logTrackerToday = logTrackerToday;

function currentStreak(){
  if(!D || !D.tracker || !D.tracker.length) return 0;
  const set = new Set(D.tracker);
  let streak = 0;
  let d = new Date();
  if(!set.has(today())) d.setDate(d.getDate()-1); // today not logged yet — count back from yesterday
  while(true){
    const ds = d.toISOString().split('T')[0];
    if(set.has(ds)){ streak++; d.setDate(d.getDate()-1); } else break;
  }
  return streak;
}
window.currentStreak = currentStreak;
