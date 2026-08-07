// ── SOUND ────────────────────────────────────────────────────────
// Everything here is synthesized on the fly via Web Audio — there are no
// audio asset files anywhere in this repo to draw on. One shared
// AudioContext, created lazily on first use (browsers refuse to start one
// before a user gesture, and every call site here is already inside a
// click/rating handler by the time it fires).
let audioCtx=null;
function getAudioCtx(){
  if(!window.AudioContext && !window.webkitAudioContext) return null;
  if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
  return audioCtx;
}

// One short note: an oscillator through a gain envelope (quick attack, decay
// to silence) so it reads as a soft chime rather than a harsh square blip.
// Every chime funnels through here (playChime -> playTone per note;
// playGenericChime calls it directly), so this is the one place the
// Sync-tab mute setting (D.soundEnabled, default true) needs to be checked.
function playTone(freq,startAt,dur,gain=0.18,type='sine'){
  if(typeof D!=='undefined' && D && D.soundEnabled===false) return;
  const ctx=getAudioCtx();
  if(!ctx) return;
  const osc=ctx.createOscillator(), gn=ctx.createGain();
  osc.type=type; osc.frequency.value=freq;
  osc.connect(gn); gn.connect(ctx.destination);
  const t0=ctx.currentTime+startAt;
  gn.gain.setValueAtTime(0,t0);
  gn.gain.linearRampToValueAtTime(gain,t0+0.015);
  gn.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  osc.start(t0); osc.stop(t0+dur+0.02);
}

// notes: [{freq,dur,gain,type}], played back-to-back in sequence.
function playChime(notes){
  let t=0;
  notes.forEach(n=>{ playTone(n.freq,t,n.dur,n.gain,n.type); t+=n.dur*0.92; });
}

// Ascending major-triad "ta-da" — nothing due today.
window.playNoDueChime=()=>playChime([
  {freq:523.25,dur:0.14,type:'sine'},
  {freq:659.25,dur:0.14,type:'sine'},
  {freq:783.99,dur:0.32,gain:0.22,type:'sine'}
]);

// Bigger ascending arpeggio (adds the octave) — every-5th-perfect-in-a-row
// milestone, meant to read as a step up from the plain no-due chime.
window.playMilestoneChime=()=>playChime([
  {freq:523.25,dur:0.12,type:'triangle'},
  {freq:659.25,dur:0.12,type:'triangle'},
  {freq:783.99,dur:0.12,type:'triangle'},
  {freq:1046.50,dur:0.36,gain:0.24,type:'triangle'}
]);

// Calm two-note confirm — daily streak maintained, next app open.
window.playStreakChime=()=>playChime([
  {freq:659.25,dur:0.16,gain:0.14,type:'sine'},
  {freq:783.99,dur:0.28,gain:0.16,type:'sine'}
]);

// Descending two-note, deliberately the mirror of the ascending chimes above
// — "someone's here" rather than "you achieved something."
window.playShareChime=()=>playChime([
  {freq:783.99,dur:0.14,gain:0.16,type:'triangle'},
  {freq:523.25,dur:0.24,gain:0.16,type:'triangle'}
]);

// Single neutral blip — generic native-notification fallback.
window.playGenericChime=()=>playTone(660,0,0.14,0.14,'sine');

// ── Sync tab settings row ───────────────────────────────────────
function renderSoundSettings(){
  const el=document.getElementById('sound-status-row');
  if(!el || typeof D==='undefined' || !D) return;
  const on=D.soundEnabled!==false;
  el.innerHTML=`<div class="sync-row">
    <div class="sync-ico" style="background:#0d1a3a">${on?'🔊':'🔇'}</div>
    <div class="sync-info"><strong>Chime Sounds</strong><span>${on?'Playing for streaks, milestones, and notifications':'Muted'}</span></div>
    <button class="sync-btn ${on?'btn-import':'btn-danger'}" onclick="toggleSoundEnabled()">${on?'On':'Muted'}</button>
  </div>`;
}
window.renderSoundSettings=renderSoundSettings;

function toggleSoundEnabled(){
  if(typeof D==='undefined' || !D) return;
  D.soundEnabled=!(D.soundEnabled!==false);
  saveLS();
  renderSoundSettings();
  if(D.soundEnabled && window.playGenericChime) playGenericChime();
  toast(D.soundEnabled?'🔊 Sounds on':'🔇 Sounds muted');
}
window.toggleSoundEnabled=toggleSoundEnabled;
