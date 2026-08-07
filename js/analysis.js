// ── ANALYSIS TAB ─────────────────────────────────────────────────
// Two sections, in order: one calendar heatmap (dropdown-switchable between
// Perfect-Answer Rate and Study Time — see ANALYSIS_METRICS below) and Needs
// Attention (neglect list). The heatmap is hand-built inline SVG via
// template strings — same technique as js/growth.js's singleTreeSVG/
// renderGrowthSVG, no charting library.

// ── Needs Attention ─────────────────────────────────────────────
// Neglect Score = sum of overdue-days across a document's due flashcards —
// not "single most-overdue card," which ignores volume (40 cards each 5
// days overdue is worse than one card 40 days overdue; the sum captures
// that). Computed live from data every card already carries (it.srs.dueDate)
// — no new logging needed for this section.
function computeNeglectScores(){
  const t=today();
  const scores=D.documents.map(doc=>{
    let score=0, overdueCount=0;
    doc.items.forEach(it=>{
      if(!it.srs || !it.srs.dueDate || it.srs.dueDate>t) return;
      const days=Math.floor((new Date(t)-new Date(it.srs.dueDate))/86400000);
      if(days>0){ score+=days; overdueCount++; }
    });
    return {doc,score,overdueCount};
  }).filter(x=>x.score>0);
  scores.sort((a,b)=>b.score-a.score);
  return scores.slice(0,5);
}

function renderNeedsAttention(){
  const scores=computeNeglectScores();
  const body=scores.length
    ? scores.map(({doc,score,overdueCount})=>`
      <div class="sync-row" style="cursor:pointer" onclick="openEditor('${doc.id}')" title="Open ${esc(doc.title)}">
        <div class="sync-ico" style="background:#1a0d0d">📄</div>
        <div class="sync-info"><strong>${esc(doc.title)}</strong><span>${overdueCount} card${overdueCount>1?'s':''} overdue · ${score} overdue-day${score>1?'s':''} total</span></div>
      </div>`).join('')
    : `<div class="analysis-empty">🎉 Nothing's overdue — nice work.</div>`;
  return `<div class="sync-section">
    <div class="sync-hdr">Needs Attention</div>
    <div class="sync-body">${body}</div>
  </div>`;
}

// ── GitHub-style heatmap (one calendar, dropdown-switchable between two
// metrics: perfect-rate, study-time — see ANALYSIS_METRICS below) ───────
// 5-step sequential ramp, single hue (green), monotonically increasing
// lightness/chroma from the app's own surface color (no activity) up to
// var(--green) (busiest) — see js/sound.js-adjacent plan notes; validated by
// construction rather than the categorical validator (which doesn't apply to
// a single-hue sequential ramp). Shared across both metrics below — each
// just supplies a different per-date value and tooltip text.
const CAL_LEVEL_COLORS=['var(--s3)','#1f4d50','#247a6b','#28a785','var(--green)'];

// Calendar-year grid (Jan 1 - Dec 31 of `year`), not a rolling trailing
// window — padded back to the nearest Sunday on/before Jan 1 for GitHub-style
// week columns, but those lead-in days (which belong to the PREVIOUS year)
// render as empty spacer cells rather than being colored by that other
// year's data, so the grid unambiguously reads as "this year." getValue(key)
// returns the metric's numeric value for a given yyyy-mm-dd key (0 if none);
// tooltipFormatter(value, dateLabel) returns the <title> text for a cell.
function buildHeatmapSVG(year,getValue,tooltipFormatter){
  year=year||new Date().getFullYear();
  const cell=10, gap=3, colW=cell+gap, rowH=cell+gap;
  const padL=2, padT=16, padB=2, padR=2;

  const yearStart=new Date(year,0,1); yearStart.setHours(0,0,0,0);
  const yearEnd=new Date(year,11,31); yearEnd.setHours(0,0,0,0);
  const start=new Date(yearStart); start.setDate(start.getDate()-start.getDay()); // back up to the Sunday on/before Jan 1

  const days=[];
  for(let d=new Date(start); d<=yearEnd; d.setDate(d.getDate()+1)) days.push(new Date(d));
  const cols=Math.ceil(days.length/7);

  let max=0;
  const values=days.map(d=>{
    if(d.getFullYear()!==year) return -1; // lead-in spacer, not part of this year
    const v=getValue(d.toISOString().split('T')[0])||0;
    if(v>max) max=v;
    return v;
  });
  const levelFor=v=>{
    if(!v || !max) return 0;
    const frac=v/max;
    return frac<=0.25?1:frac<=0.5?2:frac<=0.75?3:4;
  };

  let cellsHtml='';
  days.forEach((d,idx)=>{
    const v=values[idx];
    if(v<0) return; // lead-in day from the previous year — leave blank
    const col=Math.floor(idx/7), row=d.getDay();
    const x=padL+col*colW, y=padT+row*rowH;
    const dateLabel=d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
    cellsHtml+=`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${CAL_LEVEL_COLORS[levelFor(v)]}"><title>${esc(tooltipFormatter(v,dateLabel))}</title></rect>`;
  });

  let monthsHtml='', lastMonth=-1;
  for(let c=0;c<cols;c++){
    const dayIdx=c*7;
    if(dayIdx>=days.length) break;
    const d0=days[dayIdx];
    if(d0.getFullYear()!==year) continue;
    if(d0.getMonth()!==lastMonth){
      lastMonth=d0.getMonth();
      monthsHtml+=`<text x="${padL+c*colW}" y="${padT-5}" font-size="9" font-family="var(--mono)" fill="var(--t3)">${d0.toLocaleDateString(undefined,{month:'short'})}</text>`;
    }
  }

  const w=padL+cols*colW+padR;
  const h=padT+7*rowH+padB;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${monthsHtml}${cellsHtml}</svg>`;
}

function buildPerfectRateHeatmapSVG(dailyActivity,dailyPerfectCount,year){
  dailyActivity=dailyActivity||{}; dailyPerfectCount=dailyPerfectCount||{};
  return buildHeatmapSVG(year, k=>{
    const total=dailyActivity[k]||0, perfect=dailyPerfectCount[k]||0;
    return total>0?Math.round((perfect/total)*100):0;
  }, (rate,label)=>rate?`${rate}% Perfect ratings on ${label}`:`No ratings on ${label}`);
}
function buildStudyTimeHeatmapSVG(dailyStudySeconds,year){
  dailyStudySeconds=dailyStudySeconds||{};
  return buildHeatmapSVG(year, k=>Math.round((dailyStudySeconds[k]||0)/60),
    (mins,label)=>mins?`${mins} min studied on ${label}`:`No study time on ${label}`);
}

// One year-per-section, session-local (not persisted) — always opens back
// on the current year. Only one section exists now ('combined'), but kept
// keyed (rather than a single flat variable) since heatmapBodyHTML/
// changeAnalysisYear already address sections by key.
const analysisYears={};
function getAnalysisYear(key){
  if(!(key in analysisYears)) analysisYears[key]=new Date().getFullYear();
  return analysisYears[key];
}

// Which metric the one combined calendar currently shows — deliberately a
// flat variable, not keyed like analysisYears: there's only ever one section
// that needs a metric choice, so a key dimension here would be unused.
// Independent of analysisYears['combined'] on purpose — switching metric
// must never reset the year the user has navigated to, and vice versa.
const ANALYSIS_METRICS={
  perfect:{label:'Perfect Answer Rate', build:(year)=>buildPerfectRateHeatmapSVG(D.dailyActivity,D.dailyPerfectCount,year)},
  study:{label:'Study Time', build:(year)=>buildStudyTimeHeatmapSVG(D.dailyStudySeconds,year)}
};
let analysisMetric='perfect';

const ANALYSIS_HEATMAPS={
  combined:{
    headerHtml:()=>`<select class="analysis-metric-select" onchange="changeAnalysisMetric(this.value)">
        <option value="perfect"${analysisMetric==='perfect'?' selected':''}>Perfect Answer Rate</option>
        <option value="study"${analysisMetric==='study'?' selected':''}>Study Time</option>
      </select>`,
    body:()=>{
      const y=getAnalysisYear('combined');
      return heatmapBodyHTML('combined',y,ANALYSIS_METRICS[analysisMetric].build(y));
    }
  }
};

function heatmapBodyHTML(key,year,svg){
  const legend=CAL_LEVEL_COLORS.map(c=>`<span class="analysis-legend-sq" style="background:${c}"></span>`).join('');
  const thisYear=new Date().getFullYear();
  return `<div class="analysis-year-picker">
      <button type="button" class="analysis-year-nav" onclick="changeAnalysisYear('${key}',${year-1})" title="Previous year">‹</button>
      <span class="analysis-year-label">${year}</span>
      <button type="button" class="analysis-year-nav" onclick="changeAnalysisYear('${key}',${year+1})" title="Next year" ${year>=thisYear?'disabled':''}>›</button>
    </div>
    <div class="analysis-cal-scroll">${svg}</div>
    <div class="analysis-legend">Less ${legend} More</div>`;
}

function changeAnalysisYear(key,year){
  analysisYears[key]=+year;
  const el=document.getElementById(`analysis-${key}-body`);
  if(!el || !ANALYSIS_HEATMAPS[key]) return;
  el.innerHTML=ANALYSIS_HEATMAPS[key].body();
}
window.changeAnalysisYear=changeAnalysisYear;

// Only patches the body div (same narrow-target pattern as
// changeAnalysisYear, above) — the <select> itself is a live, native form
// control, so the browser already reflects the user's own pick without any
// HTML regeneration; only the chart underneath actually needs to change.
function changeAnalysisMetric(value){
  if(!ANALYSIS_METRICS[value]) return;
  analysisMetric=value;
  const el=document.getElementById('analysis-combined-body');
  if(el) el.innerHTML=ANALYSIS_HEATMAPS.combined.body();
}
window.changeAnalysisMetric=changeAnalysisMetric;

function renderHeatmapSection(key){
  const cfg=ANALYSIS_HEATMAPS[key];
  return `<div class="sync-section">
    <div class="sync-hdr">${cfg.headerHtml?cfg.headerHtml():cfg.title}</div>
    <div class="sync-body" id="analysis-${key}-body">${cfg.body()}</div>
  </div>`;
}

// ── Entry point (called from switchTab('analysis'), app-core.js) ──
function renderAnalysisScreen(){
  if(!D) return;
  const el=document.getElementById('analysis-scroll');
  if(!el) return;
  el.innerHTML = renderHeatmapSection('combined') + renderNeedsAttention();
}
window.renderAnalysisScreen=renderAnalysisScreen;
