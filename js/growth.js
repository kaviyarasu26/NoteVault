// ── GROWTH GARDEN ────────────────────────────────────────────────
// A long-horizon reward layered on top of the existing daily XP ring and
// one-shot achievement badges (achievements.js) — same shape (a threshold
// list plus a checkX()/announceX() pair called from rate() in app-core.js),
// but keyed off D.xp (lifetime, never resets — see app-core.js's
// defaultData/migrateDataIfNeeded) instead of a single boolean condition,
// since this is meant to be a months-long arc: seed -> sprout -> sapling ->
// young tree -> mature tree -> grove -> forest -> evergreen forest (max).
const GROWTH_STAGES = [
  { id:'seed',      name:'Seed',             xp:0,    trees:0, evergreen:false, blurb:'Every forest starts with a single seed.' },
  { id:'sprout',    name:'Sprout',           xp:50,   trees:0, evergreen:false, blurb:'The first leaves break through.' },
  { id:'sapling',   name:'Sapling',          xp:150,  trees:1, evergreen:false, blurb:'A young sapling, reaching for the light.' },
  { id:'young',     name:'Young Tree',       xp:400,  trees:1, evergreen:false, blurb:'Sturdy roots — a real tree at last.' },
  { id:'mature',    name:'Mature Tree',      xp:900,  trees:1, evergreen:false, blurb:"Fully grown. Time to start another." },
  { id:'grove',     name:'Grove',            xp:2000, trees:3, evergreen:false, blurb:'One tree became a grove.' },
  { id:'forest',    name:'Forest',           xp:4500, trees:6, evergreen:false, blurb:'A whole forest, grown one review at a time.' },
  { id:'evergreen', name:'Evergreen Forest', xp:9000, trees:9, evergreen:true,  blurb:'The ultimate canopy — evergreen, unstoppable.' }
];
window.GROWTH_STAGES = GROWTH_STAGES;

function stageIndexForXp(xp){
  let idx = 0;
  for(let i=0;i<GROWTH_STAGES.length;i++){ if(xp>=GROWTH_STAGES[i].xp) idx=i; }
  return idx;
}

function singleTreeSVG(cx, baseY, scale, evergreen, color){
  const trunkW=7*scale, trunkH=26*scale;
  let s = `<rect x="${(cx-trunkW/2).toFixed(1)}" y="${(baseY-trunkH).toFixed(1)}" width="${trunkW.toFixed(1)}" height="${trunkH.toFixed(1)}" rx="${(trunkW/3).toFixed(1)}" fill="#6b4a2f"/>`;
  if(evergreen){
    for(let i=0;i<3;i++){
      const w=(30-i*7)*scale, h=22*scale, y=baseY-trunkH-i*13*scale;
      s += `<path d="M${cx.toFixed(1)} ${(y-h).toFixed(1)} L${(cx-w/2).toFixed(1)} ${y.toFixed(1)} L${(cx+w/2).toFixed(1)} ${y.toFixed(1)} Z" fill="${color}"/>`;
    }
  } else {
    s += `<circle cx="${cx.toFixed(1)}" cy="${(baseY-trunkH-16*scale).toFixed(1)}" r="${(19*scale).toFixed(1)}" fill="${color}"/>`;
  }
  return s;
}

// Deterministic per-index variation (NOT Math.random()) — this renders on
// every card rated during a review session (see rate(), app-core.js), so a
// random layout would visibly reshuffle the trees on every single render
// instead of holding still.
function renderGrowthSVG(stageIdx, w, h){
  const stage = GROWTH_STAGES[stageIdx];
  const baseY = h-10;
  let inner = `<ellipse cx="${(w/2).toFixed(1)}" cy="${(baseY+4).toFixed(1)}" rx="${(w*0.42).toFixed(1)}" ry="5" fill="var(--border)"/>`;

  if(stage.id==='seed'){
    inner += `<ellipse cx="${(w/2).toFixed(1)}" cy="${(baseY-6).toFixed(1)}" rx="9" ry="12" fill="#8a6a3f"/>`;
  } else if(stage.id==='sprout'){
    const cx=(w/2).toFixed(1);
    inner += `<path d="M${cx} ${baseY} q0 -22 0 -30" stroke="var(--green)" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    inner += `<path d="M${cx} ${(baseY-18).toFixed(1)} q-14 -6 -18 4" stroke="var(--green)" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    inner += `<path d="M${cx} ${(baseY-24).toFixed(1)} q14 -6 18 4" stroke="var(--green)" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  } else if(stage.trees<=1){
    const scale = stage.id==='sapling'?0.6:stage.id==='young'?0.85:1.15;
    inner += singleTreeSVG(w/2, baseY, scale, false, 'var(--green)');
  } else {
    const colors = ['var(--green)','#25b58c','#39c79e'];
    for(let i=0;i<stage.trees;i++){
      const t = stage.trees===1 ? 0.5 : i/(stage.trees-1);
      const cx = w*0.12 + t*(w*0.76);
      const scale = 0.5 + 0.5*Math.abs(Math.sin(i*2.4+1));
      inner += singleTreeSVG(cx, baseY, scale, stage.evergreen, colors[i%colors.length]);
    }
    if(stage.evergreen){
      // A few fixed sparkle accents mark this as the max/prestige stage —
      // distinguishes it from the plain Forest stage at a glance.
      [[0.2,0.28],[0.5,0.16],[0.78,0.32]].forEach(([sx,sy])=>{
        const x=w*sx, y=h*sy;
        inner += `<path d="M${x} ${y-6} L${x+2} ${y-2} L${x+6} ${y} L${x+2} ${y+2} L${x} ${y+6} L${x-2} ${y+2} L${x-6} ${y} L${x-2} ${y-2} Z" fill="var(--yellow)" opacity="0.85"/>`;
      });
    }
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${inner}</svg>`;
}
window.renderGrowthSVG = renderGrowthSVG;

// ── Growth card — rendered on both Home and the Sync tab's "Garden"
// section (same content, two mount points; see index.html) ──────────
function renderGrowthCard(containerId){
  if(!D) return;
  const el = document.getElementById(containerId);
  if(!el) return;
  if(typeof D.gardenStage !== 'number') D.gardenStage = 0;
  const idx = stageIndexForXp(D.xp||0);
  const stage = GROWTH_STAGES[idx];
  const next = GROWTH_STAGES[idx+1];
  const svg = renderGrowthSVG(idx, 96, 70);

  let progressHTML;
  if(next){
    const span = next.xp - stage.xp;
    const have = Math.max(0,(D.xp||0) - stage.xp);
    const pct = Math.max(0,Math.min(100, Math.round((have/span)*100)));
    progressHTML = `<div class="growth-bar"><div class="growth-bar-fg" style="width:${pct}%"></div></div>
      <div class="growth-progress-label">${(D.xp||0).toLocaleString()} / ${next.xp.toLocaleString()} XP to ${esc(next.name)}</div>`;
  } else {
    progressHTML = `<div class="growth-progress-label growth-maxed">🏆 Max stage reached — ${(D.xp||0).toLocaleString()} lifetime XP</div>`;
  }

  el.innerHTML = `<div class="growth-card" onclick="openGrowthDetail()" role="button" tabindex="0" title="View your garden">
    <div class="growth-illustration">${svg}</div>
    <div class="growth-info">
      <div class="growth-stage-name">${esc(stage.name)}</div>
      ${progressHTML}
    </div>
  </div>`;
}
function renderGrowthSection(){ renderGrowthCard('growth-section'); }
window.renderGrowthSection = renderGrowthSection;
function renderSyncGrowthSection(){ renderGrowthCard('sync-growth-section'); }
window.renderSyncGrowthSection = renderSyncGrowthSection;

// ── Detail/timeline overlay ──────────────────────────────────────────
function openGrowthDetail(){
  renderGrowthDetail();
  document.getElementById('growth-detail-ov').classList.add('open');
}
window.openGrowthDetail = openGrowthDetail;

function closeGrowthDetail(){
  document.getElementById('growth-detail-ov').classList.remove('open');
}
window.closeGrowthDetail = closeGrowthDetail;

// Achievements (achievements.js's BADGES/D.badges) used to have their own
// Sync-tab list — that section is now this Garden card instead (see
// index.html), so badges are folded in here rather than dropped: same
// "locked until earned" treatment, just one screen instead of two.
function renderGrowthDetail(){
  const el = document.getElementById('growth-detail-list');
  if(!el || !D) return;
  const idx = stageIndexForXp(D.xp||0);
  let html = GROWTH_STAGES.map((stage,i)=>{
    const reached = i<=idx;
    return `<div class="growth-tl-item${reached?'':' ach-locked'}">
      <div class="growth-tl-ico">${reached?renderGrowthSVG(i,56,56):'<span class="growth-tl-lock">🔒</span>'}</div>
      <div class="growth-tl-info">
        <strong>${esc(stage.name)}</strong>
        <span>${reached?esc(stage.blurb):`Reach ${stage.xp.toLocaleString()} lifetime XP`}</span>
      </div>
    </div>`;
  }).join('');

  if(Array.isArray(window.BADGES) && Array.isArray(D.badges)){
    const earned = new Map(D.badges.map(b=>[b.id,b]));
    html += `<div class="growth-tl-divider">Achievements</div>`;
    html += window.BADGES.map(b=>{
      const got = earned.get(b.id);
      return `<div class="growth-tl-item${got?'':' ach-locked'}">
        <div class="growth-tl-ico" style="font-size:26px">${got?b.icon:'🔒'}</div>
        <div class="growth-tl-info">
          <strong>${esc(b.name)}</strong>
          <span>${esc(b.desc)}${got?` · earned ${new Date(got.earnedAt).toLocaleDateString()}`:''}</span>
        </div>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;
}
window.renderGrowthDetail = renderGrowthDetail;

// ── Checks + announcements (called from rate(), app-core.js) ────────
// Persistence rides along for free: rate() calls saveLS() right after these
// run, same as it does for checkAchievements() — no separate save needed
// here (mirrors that D.gardenStage/D.lastGoalCelebrationDate are plain D
// fields, see app-core.js's defaultData/migrateDataIfNeeded).
function checkGrowthStage(){
  if(!D) return null;
  if(typeof D.gardenStage !== 'number') D.gardenStage = 0;
  const idx = stageIndexForXp(D.xp||0);
  if(idx > D.gardenStage){
    D.gardenStage = idx;
    return GROWTH_STAGES[idx];
  }
  return null;
}
window.checkGrowthStage = checkGrowthStage;

function announceGrowthStage(stage){
  if(window.pushNotification) pushNotification('🌳', `Your garden grew — ${stage.name}!`, stage.blurb);
  toast(`🌳 ${stage.name} unlocked!`);
  if(window.burstPerfectConfetti) burstPerfectConfetti();
  renderGrowthSection();
}
window.announceGrowthStage = announceGrowthStage;

// One notification per calendar day, the first time today's XP crosses the
// daily goal — same once-per-day guard idiom as D.lastReminderDate
// (notifications.js/app-core.js), just scoped to this feature's own field
// so the two don't interfere with each other.
function checkDailyGoalComplete(){
  if(!D) return false;
  const goal = D.dailyGoal||30;
  if((D.todayXp||0) < goal) return false;
  const t = today();
  if(D.lastGoalCelebrationDate === t) return false;
  D.lastGoalCelebrationDate = t;
  return true;
}
window.checkDailyGoalComplete = checkDailyGoalComplete;

function announceGoalComplete(){
  if(window.pushNotification) pushNotification('🎯','Daily goal complete!', `You hit your ${D.dailyGoal||30} XP goal for today — your garden is thriving.`);
  toast('🎯 Daily goal complete!');
}
window.announceGoalComplete = announceGoalComplete;
