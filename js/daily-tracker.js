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

// Per-day review/test count (Analysis tab's GitHub-style heatmap) — a
// separate counter from D.tracker's plain yes/no date list above, since the
// heatmap needs "how many," not just "did anything happen." Self-contained
// (saves itself) same as logTrackerToday, so it persists regardless of
// whether the calling rate() is in review or test mode.
function logDailyActivity(){
  if(!D) return;
  if(!D.dailyActivity || typeof D.dailyActivity !== 'object') D.dailyActivity = {};
  const t = today();
  D.dailyActivity[t] = (D.dailyActivity[t]||0)+1;
  pruneDailyActivity();
  saveLS();
}
window.logDailyActivity = logDailyActivity;

// Keeps a per-date map bounded regardless of how long an account's been
// active — trimmed on every write rather than on a timer. ~4 years (not
// just the ~370 days a single trailing-window heatmap would need) so the
// Analysis tab's year selector has more than just the current year to
// actually browse — at this size (~1 short number per date) even 4 years,
// across all four of these maps combined, is a trivial fraction of
// Firestore's 1MiB document budget.
function pruneDateMap(map){
  if(!map) return;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-1460);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  Object.keys(map).forEach(d=>{ if(d<cutoffStr) delete map[d]; });
}

function pruneDailyActivity(){
  if(!D || !D.dailyActivity) return;
  pruneDateMap(D.dailyActivity);
}
window.pruneDailyActivity = pruneDailyActivity;

// Perfect-answer rate heatmap (Analysis tab) — a straight count of Perfect
// (q===5) ratings per day, read alongside dailyActivity's own per-day total
// to compute a rate (perfect / total). Logged in both review and test mode,
// same as dailyActivity, so the two counters share one consistent
// denominator population.
function logDailyPerfect(){
  if(!D) return;
  if(!D.dailyPerfectCount || typeof D.dailyPerfectCount !== 'object') D.dailyPerfectCount = {};
  const t = today();
  D.dailyPerfectCount[t] = (D.dailyPerfectCount[t]||0)+1;
  pruneDateMap(D.dailyPerfectCount);
  saveLS();
}
window.logDailyPerfect = logDailyPerfect;

// Study-time heatmap (Analysis tab) — accumulates the wall-clock gap
// between successive rate() calls into today's total, capped per-gap so a
// tab left open (or a session resumed the next day) can't inflate the
// total: the cap is the ceiling on what any single card-to-card gap can
// contribute, not a session limit. The very first rate() of a "session" (no
// prior timestamp yet) contributes nothing, since there's no real gap to
// measure yet — it still sets the timestamp so the NEXT call measures
// correctly from there.
let lastRateTimestamp = null;
function logStudyTime(){
  if(!D) return;
  const now = Date.now();
  if(lastRateTimestamp){
    const deltaSec = (now - lastRateTimestamp) / 1000;
    const capped = Math.min(Math.max(0, deltaSec), 120); // cap any single gap at 2 minutes
    if(capped > 0){
      if(!D.dailyStudySeconds || typeof D.dailyStudySeconds !== 'object') D.dailyStudySeconds = {};
      const t = today();
      D.dailyStudySeconds[t] = (D.dailyStudySeconds[t]||0) + capped;
      pruneDateMap(D.dailyStudySeconds);
      saveLS();
    }
  }
  lastRateTimestamp = now;
}
window.logStudyTime = logStudyTime;

// Reading-time heatmap (Analysis tab) — called from showTab() (app-core.js)
// with the timestamp openEditor() recorded when a document was opened,
// whenever the user navigates away from the editor screen. Capped at 30
// minutes per open-to-close span (an accidentally-left-open document
// shouldn't read as half a day of reading) and ignores near-instant
// open/close taps (nothing meaningful to log).
function logReadingTime(startedAt){
  if(!D || !startedAt) return;
  const deltaSec = (Date.now() - startedAt) / 1000;
  const capped = Math.min(Math.max(0, deltaSec), 1800);
  if(capped < 1) return;
  if(!D.dailyReadingSeconds || typeof D.dailyReadingSeconds !== 'object') D.dailyReadingSeconds = {};
  const t = today();
  D.dailyReadingSeconds[t] = (D.dailyReadingSeconds[t]||0) + capped;
  pruneDateMap(D.dailyReadingSeconds);
  saveLS();
}
window.logReadingTime = logReadingTime;

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

// Calm 2-note confirm — the streak survived into a new day. Hooked off
// nv-auth-changed (cold-load/sign-in) rather than every foreground-resume,
// so it fires once when the app is actually (re)opened, not on every
// app-switch back-and-forth within the same day.
function checkDailyStreakSound(){
  if(!D) return;
  const t = today();
  if(D.lastStreakSoundDate===t) return;
  if(currentStreak()<=0) return;
  D.lastStreakSoundDate=t;
  saveLS();
  if(window.playStreakChime) playStreakChime();
}
window.checkDailyStreakSound = checkDailyStreakSound;
window.addEventListener('nv-auth-changed', e=>{
  if(e.detail && e.detail.user) checkDailyStreakSound();
});
