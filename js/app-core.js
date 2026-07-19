const gid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const today=()=>new Date().toISOString().split('T')[0];
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const STAR_PATH='M12 2.5l2.97 6.31 6.86.86-5.06 4.86 1.36 6.8L12 17.9l-6.13 3.43 1.36-6.8-5.06-4.86 6.86-.86z';
const starIcon=(on,size=13)=>`<svg viewBox="0 0 24 24" width="${size}" height="${size}" class="fav-star ${on?'on':'off'}"><path d="${STAR_PATH}"/></svg>`;

// ── ANCHORED CONTEXT MENUS (folder/file ⋮) ──────────────────────
// Pins the overlay's sheet near the button that opened it (like a right-click
// context menu) instead of dead-centering it on screen, then clamps it back
// inside the viewport if that would push it off an edge.
function openAnchoredMenu(overlayId, anchorEvent){
  const overlay=document.getElementById(overlayId);
  const sheet=overlay.querySelector('.sheet');
  const anchorEl=anchorEvent&&(anchorEvent.currentTarget||anchorEvent.target);
  overlay.classList.add('anchored');
  sheet.style.visibility='hidden';
  overlay.classList.add('open');
  if(!anchorEl){ sheet.style.visibility=''; return; }
  requestAnimationFrame(()=>{
    const rect=anchorEl.getBoundingClientRect();
    const sw=sheet.offsetWidth, sh=sheet.offsetHeight;
    let left=rect.right-sw, top=rect.bottom+6;
    if(left<8) left=8;
    if(left+sw>window.innerWidth-8) left=window.innerWidth-sw-8;
    if(top+sh>window.innerHeight-8) top=rect.top-sh-6;
    if(top<8) top=8;
    sheet.style.left=left+'px';
    sheet.style.top=top+'px';
    sheet.style.visibility='';
  });
}
window.openAnchoredMenu=openAnchoredMenu;

function closeAnchoredMenu(overlayId){
  const overlay=document.getElementById(overlayId);
  overlay.classList.remove('open','anchored');
  const sheet=overlay.querySelector('.sheet');
  sheet.style.left=''; sheet.style.top=''; sheet.style.visibility='';
}
window.closeAnchoredMenu=closeAnchoredMenu;

// ── RICH TEXT EDITOR ─────────────────────────────────────────────
// Items are contenteditable, not plain textareas — content is real HTML
// (bold/italic/underline/highlight spans, inline <img> tags), so it can
// actually be viewed and edited in place instead of showing raw markup.
//
// Because content can now come from other people (a Master's shared vault,
// an imported .nvault file), it MUST be sanitized before ever going into
// innerHTML — sanitizeHtml() is the one chokepoint every path runs through.
//
// Old items (from before this existed) stored plain text, sometimes with
// a lightweight ==highlight== / ![[img:ID]] convention. it.richText marks
// which format an item is in; legacy items get escaped + auto-converted
// on first load/edit, then permanently become richText:true from then on.
const ALLOWED_TAGS=new Set(['B','STRONG','I','EM','U','SPAN','BR','DIV','IMG']);
const ALLOWED_STYLE_PROPS=new Set(['color','font-weight','background-color','background','text-decoration']);
const DANGEROUS_TAGS=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','LINK','META','FORM','SVG']);
const IMG_RE=/!\[\[img:([a-zA-Z0-9]+)\]\]/g;

function sanitizeHtml(html){
  const tpl=document.createElement('template');
  tpl.innerHTML=html;
  const toStrip=[];
  const walker=document.createTreeWalker(tpl.content,NodeFilter.SHOW_ELEMENT,null);
  let node=walker.nextNode();
  while(node){
    const tag=node.tagName;
    if(!ALLOWED_TAGS.has(tag)){
      toStrip.push(node);
    }else{
      [...node.attributes].forEach(attr=>{
        const name=attr.name.toLowerCase();
        if(tag==='IMG'&&name==='src'){ if(!/^data:image\//i.test(attr.value)) node.removeAttribute(attr.name); return; }
        if(tag==='IMG'&&(name==='alt'||name==='class')) return;
        if(name==='style'){
          const clean=[...node.style].filter(p=>ALLOWED_STYLE_PROPS.has(p)).map(p=>`${p}:${node.style.getPropertyValue(p)}`).join(';');
          if(clean) node.setAttribute('style',clean); else node.removeAttribute('style');
          return;
        }
        node.removeAttribute(attr.name);
      });
    }
    node=walker.nextNode();
  }
  toStrip.forEach(n=>{
    if(!n.parentNode) return;
    if(DANGEROUS_TAGS.has(n.tagName)){ n.remove(); }
    else { while(n.firstChild) n.parentNode.insertBefore(n.firstChild,n); n.remove(); }
  });
  return tpl.innerHTML;
}

function htmlToText(html){
  const tpl=document.createElement('template');
  tpl.innerHTML=html;
  return (tpl.content.textContent||'').replace(/\s+/g,' ').trim();
}

// Converts an old plain-text item (possibly using the legacy ==highlight==
// / ![[img:ID]] convention) into safe HTML, one time, on first load.
function legacyResolve(escapedText){
  let html=escapedText.replace(/==(.+?)==/g,'<span style="color:var(--yellow);font-weight:700;">$1</span>');
  html=html.replace(IMG_RE,(m,id)=>{
    const src=D.images&&D.images[id];
    return src?`<img class="nv-img" src="${src}" alt="pasted image">`:m;
  });
  return html;
}

// Single entry point for turning stored item content into safe display
// HTML, used by the editor, Review, and anywhere else content is shown.
function toDisplayHtml(rawContent,richText){
  return richText?sanitizeHtml(rawContent):legacyResolve(esc(rawContent));
}

function placeCursorAtEnd(el){
  el.focus();
  const range=document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Formatting is implemented with plain Range/Selection DOM manipulation,
// not document.execCommand — execCommand is deprecated and, worse, silently
// no-ops in some contexts (no real window focus, some embedded/automated
// contexts) instead of throwing, which makes failures invisible. Manual
// Range manipulation has no such caveat.
function wrapSelectionWith(tagName,styleFn){
  const sel=window.getSelection();
  if(!sel.rangeCount||sel.isCollapsed){ toast('⚠️ Select text first'); return; }
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl) return;
  const wrapper=document.createElement(tagName);
  if(styleFn) styleFn(wrapper);
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  sel.removeAllRanges();
  const after=document.createRange();
  after.selectNodeContents(wrapper);
  after.collapse(false);
  sel.addRange(after);
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}

// Alt+H — wraps the current selection in a bold, yellow span immediately
// (no markup syntax to type or remember).
function applyHighlight(){
  wrapSelectionWith('span',el=>{ el.style.color='var(--yellow)'; el.style.fontWeight='700'; });
}
window.applyHighlight=applyHighlight;


// Inserts a plain text node (used for `>>` and pasted plain text) or a
// <br> (used for Alt+Enter) at the current cursor position, replacing any
// active selection — same manual-Range approach as wrapSelectionWith.
function insertTextAtCursor(text){
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  const range=sel.getRangeAt(0);
  range.deleteContents();
  const node=document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
function insertBreakAtCursor(){
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  const range=sel.getRangeAt(0);
  range.deleteContents();
  const br=document.createElement('br');
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── IMAGES ───────────────────────────────────────────────────────
// Pasted images are stored as base64 data URIs, not real files — there's
// no Firebase Storage in this app. They're inserted as a real <img> right
// into the item's HTML, so they're visible in the editor immediately, not
// only in Review. Everything still rides inside the single encrypted vault
// document, which Firestore caps at 1MiB total — images are resized and
// compressed on paste to keep that budget realistic, but it's still a
// shared, finite budget across all your notes and images combined.
function compressImageBlob(blob, maxDim, quality){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    const url=URL.createObjectURL(blob);
    img.onload=()=>{
      let w=img.width, h=img.height;
      if(w>maxDim || h>maxDim){
        if(w>h){ h=Math.round(h*maxDim/w); w=maxDim; }
        else { w=Math.round(w*maxDim/h); h=maxDim; }
      }
      const canvas=document.createElement('canvas');
      canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg',quality));
    };
    img.onerror=reject;
    img.src=url;
  });
}

async function handleAvatarUpload(input){
  const file=input.files[0]; if(!file) return;
  if(!window.currentUser){ toast('⚠️ Sign in first'); input.value=''; return; }
  try{
    const dataUri=await compressImageBlob(file,240,0.85);
    D.avatar=dataUri;
    saveLS();
    const preview=document.getElementById('profile-avatar-preview');
    if(preview) preview.innerHTML=`<img src="${dataUri}" alt="" class="profile-avatar-thumb">`;
    if(window.updateProfileButtons) updateProfileButtons('verified');
    toast('✅ Profile picture updated');
  }catch(err){
    console.error('Avatar upload failed', err);
    toast('⚠️ Failed to process image');
  }
  input.value='';
}
window.handleAvatarUpload=handleAvatarUpload;

async function onPaste(e,i){
  const cd=e.clipboardData;
  if(!cd) return;
  let imgItem=null;
  if(cd.items){ for(const it of cd.items){ if(it.type&&it.type.startsWith('image/')){ imgItem=it; break; } } }

  if(imgItem){
    e.preventDefault();
    const blob=imgItem.getAsFile();
    if(!blob) return;
    const sel=window.getSelection();
    if(!sel.rangeCount) return;
    const range=sel.getRangeAt(0).cloneRange();
    try{
      const dataUri=await compressImageBlob(blob,900,0.7);
      const img=document.createElement('img');
      img.className='nv-img';
      img.src=dataUri;
      img.alt='pasted image';

      sel.removeAllRanges();
      sel.addRange(range);
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      const el=document.querySelector(`.item-ta[data-i="${i}"]`);
      if(el) onInput(el,i);

      const sizeKB=Math.round(dataUri.length/1024);
      toast(`🖼️ Image added (${sizeKB}KB)`);
      const totalKB=Math.round(JSON.stringify(D).length/1024);
      if(totalKB>850) toast(`⚠️ Vault is ${totalKB}KB — approaching the 1MB cloud sync limit`);
    }catch(err){
      console.error('Image paste failed', err);
      toast('⚠️ Failed to process pasted image');
    }
    return;
  }

  // Never trust pasted HTML from other apps/sites — plain text only.
  e.preventDefault();
  const text=cd.getData('text/plain');
  if(!text) return;
  insertTextAtCursor(text);
  const el=document.querySelector(`.item-ta[data-i="${i}"]`);
  if(el) onInput(el,i);
}

function extractImageIds(items){
  const ids=new Set();
  items.forEach(it=>{
    for(const m of it.content.matchAll(IMG_RE)) ids.add(m[1]);
  });
  return ids;
}

// Password Toggle Utility
const EYE_OPEN_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-7-11-7a20.5 20.5 0 015.06-5.94M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 7 11 7a20.5 20.5 0 01-3.22 4.44M14.12 14.12a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function togglePassVisibility(inputId, btnId) {
  const inp = document.getElementById(inputId || 'signin-pass');
  const btn = document.getElementById(btnId || 'signin-pass-toggle-btn');
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    if(btn){ btn.innerHTML=EYE_OFF_SVG; btn.title='Hide password'; btn.setAttribute('aria-label','Hide password'); }
  } else {
    inp.type = 'password';
    if(btn){ btn.innerHTML=EYE_OPEN_SVG; btn.title='Show password'; btn.setAttribute('aria-label','Show password'); }
  }
}

// ── AUTH MODAL VIEWS ─────────────────────────────────────────────
// Sign In / Sign Up / Verify-Pending are three separate views inside
// the one auth-ov overlay; only one is visible at a time.
function showAuthView(view){
  ['signin','signup','pending'].forEach(v=>{
    const el=document.getElementById('auth-view-'+v);
    if(el) el.classList.toggle('active', v===view);
  });
}
window.showAuthView = showAuthView;

function openAuthOverlay(view){
  showAuthView(view||'signin');
  document.getElementById('auth-ov').classList.add('open');
}
window.openAuthOverlay = openAuthOverlay;

// Clears the Sign In / Sign Up forms — called whenever the auth modal
// closes, whether by Cancel/✕/outside-click or after a successful
// login/signup/verification.
function resetAuthFields(){
  ['signin-email','signin-pass','signup-name','signup-email','signup-pass'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  ['signin-pass','signup-pass'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.type='password';
  });
  ['signin-pass-toggle-btn','signup-pass-toggle-btn'].forEach(id=>{
    const btn=document.getElementById(id);
    if(btn){ btn.innerHTML=EYE_OPEN_SVG; btn.title='Show password'; btn.setAttribute('aria-label','Show password'); }
  });
  showAuthView('signin');
}
window.resetAuthFields = resetAuthFields;

// SM-2 Algorithm
function sm2(q, {repetitions:r=0, easeFactor:ef=2.5, interval:iv=0} = {}) {
  let nr = r, nef = ef, ni = iv;
  if (q >= 3) {
    nr = r + 1;
    if (r === 0) ni = 1;
    else if (r === 1) ni = 6;
    else ni = Math.round(iv * ef);
    if (ni > 5) {
      const fuzz = Math.round(ni * ((Math.random() * 0.1) - 0.05));
      ni = Math.max(ni + fuzz, ni);
    }
  } else {
    nr = 0;
    ni = 1;
  }
  nef = Math.max(1.3, ef + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  const d = new Date(); d.setDate(d.getDate() + ni);
  return { repetitions: nr, easeFactor: nef, interval: ni, dueDate: d.toISOString().split('T')[0] };
}

// Rich-text (contenteditable) content round-trips through el.innerHTML,
// which HTML-entity-encodes a literal ">" back to "&gt;" — so a stored
// ">>" separator shows up as either raw ">>" (legacy plain-text items) or
// "&gt;&gt;" (richText items). Both forms have to count as the separator.
const FC_SEP_RE=/>>|&gt;&gt;/;
const isFC=it=>FC_SEP_RE.test(it.content);
const isDue=it=>it.srs&&it.srs.dueDate<=today();
const parseFC=c=>{
  const m=c.match(FC_SEP_RE);
  if(!m) return {q:c.trim(),a:''};
  return {q:c.slice(0,m.index).trim(),a:c.slice(m.index+m[0].length).trim()};
};

let D, curFolder=null, curDoc, focIdx=-1, rvCards=[], rvIdx=0, rvShowAns=false, importPending=null, mergeMode='merge', contextFileId=null, homeFolderFilter='', folderFileFilter='', rvTestMode=false;
// Session-local rating tally (again/hard/good/easy/perfect) — reset at the
// start of every review/test session, shown on the end-of-session summary.
// Never persisted: it's a per-session UI stat, not vault data.
let rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};
// Blocks rate() from re-entering while a rating is already mid-flight (flash
// + delayed advance) — without this, a fast double key-press/click during
// that window could schedule two overlapping advance()s racing on the same
// rvIdx and desync the session.
let rvBusy=false;
// D.perfectStreak is persisted (not a session variable) — it only resets on
// an actual non-perfect rating, so it survives across sessions and days:
// 10 perfect today + 5 perfect tomorrow reads as "15 in a row", not "5".

// Real implementation is attached by firebase-init.js (Firestore-only). This
// placeholder only exists to guard the brief window before that deferred
// module script runs.
window.saveLS=()=>{};

function defaultData(){
  const t=today();
  const now=new Date().toISOString();
  return{
    version:4,
    folders: [{ id: 'f_default', name: 'General', createdAt: now, favorite: false }],
    documents:[{
      id:'doc_welcome', folderId: 'f_default', title:'My Flashcards',createdAt:now,updatedAt:now,
      items:[
        {id:gid(),content:'Write flashcards using the format below',level:0,srs:null},
        {id:gid(),content:'What is spaced repetition? >> A technique that schedules reviews at increasing intervals to move info into long-term memory',level:1,srs:{repetitions:0,easeFactor:2.5,interval:0,dueDate:t}},
        {id:gid(),content:'Capital of Japan >> Tokyo — largest metropolitan area on Earth (~37 million people)',level:0,srs:{repetitions:0,easeFactor:2.5,interval:0,dueDate:t}},
      ]
    }],
    tracker: [],
    perfectStreak: 0,
    notifications: [],
    images: {},
    avatar: null,
    lastReminderDate: null,
    xp: 0,
    todayXp: 0,
    todayXpDate: null,
    dailyGoal: 30,
    totalReviewed: 0,
    badges: []
  };
}

function migrateDataIfNeeded() {
    if(!D) return;
    if(D.version === 3) {
        D.version = 4;
        D.folders = [{ id: 'f_legacy', name: 'Imported Files' }];
        D.documents.forEach(doc => { doc.folderId = 'f_legacy'; });
        saveLS();
    }
    if(!Array.isArray(D.tracker)) D.tracker = [];
    // Leftover fields from the old whole-vault Master/Slave sync, replaced
    // by per-folder sharing (folders now carry their own sharedFrom/readOnly).
    if('linked_master_id' in D) delete D.linked_master_id;
    if('linked_master_email' in D) delete D.linked_master_email;
    if(typeof D.perfectStreak !== 'number') D.perfectStreak = 0;
    if(!Array.isArray(D.notifications)) D.notifications = [];
    if(!D.images || typeof D.images !== 'object') D.images = {};
    if(D.avatar === undefined) D.avatar = null;
    if(D.lastReminderDate === undefined) D.lastReminderDate = null;
    if(typeof D.xp !== 'number') D.xp = 0;
    if(typeof D.todayXp !== 'number') D.todayXp = 0;
    if(D.todayXpDate === undefined) D.todayXpDate = null;
    if(typeof D.dailyGoal !== 'number') D.dailyGoal = 30;
    if(typeof D.totalReviewed !== 'number') D.totalReviewed = 0;
    if(!Array.isArray(D.badges)) D.badges = [];
    if(D.todayXpDate !== today()){ D.todayXp = 0; D.todayXpDate = today(); }
    D.folders.forEach(f=>{ if(typeof f.reviewCount !== 'number') f.reviewCount = 0; });
}

// D is populated by firebase-init.js's onAuthStateChanged handler once
// Firebase resolves whether anyone is signed in — the app is gated behind
// the auth overlay until then, so there's nothing to load locally here.
window.addEventListener('load',()=>{
  showTab('home');
  // App-shell only (see sw.js) — Firebase Auth/Firestore calls are never
  // intercepted, so this doesn't change sign-in or sync behavior at all.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(e=>console.error('Service worker registration failed',e));
  }
});

window.addEventListener('keydown', e => {
  if (document.getElementById('s-review').classList.contains('active') && rvCards.length > 0) {
    if (!rvShowAns && (e.code === 'Space' || e.key === 'Enter')) {
      e.preventDefault(); revealAns();
    } else if (rvShowAns && e.key >= '1' && e.key <= '5') {
      e.preventDefault(); rate(parseInt(e.key));
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    window.saveLS();
    toast('💾 Triggered sync successfully');
  }
  // Esc closes whichever popup/overlay is currently open, anywhere in the app.
  // With nothing open, Esc from the file editor backs out to the folder view.
  if (e.key === 'Escape') {
    const open = document.querySelector('.overlay.open[data-close]');
    if (open) {
      e.preventDefault();
      const fn = window[open.dataset.close];
      if (typeof fn === 'function') fn();
    } else if (document.getElementById('s-editor').classList.contains('active')) {
      e.preventDefault();
      goHome();
    } else if (curFolder && document.getElementById('s-home').classList.contains('active')) {
      e.preventDefault();
      closeFolder();
    }
  }
  // Alt+N — jumps straight to the name-entry popup (new folder on the
  // top-level Home screen, new file if a folder is open), skipping the
  // intermediate Actions sheet the FAB button shows.
  if (e.altKey && e.code === 'KeyN' && !document.querySelector('.overlay.open') && document.getElementById('s-home').classList.contains('active')) {
    e.preventDefault();
    if(!curFolder) openNewFolderPopup(); else openNewDocPopup();
  }
});

function showTab(tab){
  ['home','editor','review','search','sync'].forEach(s=>document.getElementById('s-'+s).classList.remove('active'));
  ['home','search','review','sync'].forEach(s=>{const b=document.getElementById('bn-'+s);if(b)b.classList.remove('active');});
  document.getElementById('s-'+tab).classList.add('active');
  const b=document.getElementById('bn-'+tab);if(b)b.classList.add('active');
}
function switchTab(tab){
  hideFT();
  if(tab==='home')renderHome();
  if(tab==='search')setTimeout(()=>document.getElementById('srch-inp').focus(),150);
  if(tab==='sync'){
    if(window.renderSyncScreenExtras)renderSyncScreenExtras();
    if(window.renderNotificationSettings)renderNotificationSettings();
  }
  showTab(tab);
}

function openFolder(fId) { curFolder = fId; folderFileFilter=''; renderHome(); }
function closeFolder() { curFolder = null; renderHome(); }
function openEditor(id){curDoc=id;focIdx=-1;renderEditor();showTab('editor');}
function goHome(){hideFT();renderHome();showTab('home');}
function exitReview(){renderHome();showTab('home');}
function reviewTab(){
  const cards=D.documents.flatMap(d=>d.items.filter(i=>isDue(i)&&isFC(i)).map(i=>({...i,_d:d.id})));
  if(!cards.length){toast('🎉 No cards due right now!');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=false;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}

// ── TEST MODE ────────────────────────────────────────────────────
// Same review UI, but rate() skips SM-2 entirely — no srs/dueDate change,
// no perfect-streak counting, no tracker/streak logging. Pure practice,
// against ALL flashcards in the folder/file (not just ones due today).
function testFolder(folderId){
  const docIds=new Set(D.documents.filter(d=>d.folderId===folderId).map(d=>d.id));
  const cards=D.documents.filter(d=>docIds.has(d.id)).flatMap(d=>d.items.filter(isFC).map(i=>({...i,_d:d.id})));
  if(!cards.length){toast('⚠️ No flashcards in this folder');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=true;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}
window.testFolder=testFolder;

function testDoc(docId){
  const doc=D.documents.find(d=>d.id===docId);
  if(!doc) return;
  const cards=doc.items.filter(isFC).map(i=>({...i,_d:docId}));
  if(!cards.length){toast('⚠️ No flashcards in this file');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=true;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}
window.testDoc=testDoc;

// ── HOME / FOLDERS ───────────────────────────────────────────────
function folderLastEdited(f){
  let max = f.createdAt ? new Date(f.createdAt).getTime() : 0;
  D.documents.filter(d=>d.folderId===f.id).forEach(d=>{
    const t = new Date(d.updatedAt||d.createdAt||0).getTime();
    if(t>max) max=t;
  });
  return max;
}

function folderCardHTML(f){
  const docs = D.documents.filter(d => d.folderId === f.id);
  const dueInFolder = docs.reduce((n,d)=>n+d.items.filter(i=>isDue(i)&&isFC(i)).length,0);
  return`<div class="doc-card" onclick="openFolder('${f.id}');showTab('home');" title="Open Folder">
    <div class="dc-hdr">
      <div class="dc-title" onclick="event.stopPropagation()" ondblclick="event.stopPropagation(); startRenameFolder('${f.id}')" title="Double-click to rename">📁 ${f.favorite?starIcon(true)+' ':''}${esc(f.name)}</div>
      <button class="icon-btn dc-menu-btn" style="width:28px;height:28px;margin:-4px -4px 0 0;" onclick="event.stopPropagation(); openFolderMenu('${f.id}', event)" title="Folder Options">⋮</button>
    </div>
    <div class="dc-meta">
      <span>${docs.length} files</span>
      ${dueInFolder?`<span class="dc-due">⚡ ${dueInFolder} due</span>`:''}
      ${f.readOnly&&f.sharedFrom?`<span title="Shared by ${esc(f.sharedFrom.ownerEmail||'someone')}">🔗 ${esc(f.sharedFrom.ownerEmail||'shared')}</span>`:''}
    </div>
  </div>`;
}

function fileCardHTML(doc){
  const due=doc.items.filter(i=>isDue(i)&&isFC(i)).length;
  const cards=doc.items.filter(i=>i.srs).length;
  const newC=doc.items.filter(i=>i.srs&&i.srs.repetitions===0).length;
  const sched=doc.items.filter(i=>i.srs&&!isDue(i)&&i.srs.repetitions>0).length;
  return`<div class="doc-card" onclick="openEditor('${doc.id}')" title="Open File">
    <div class="dc-hdr">
       <div class="dc-title" onclick="event.stopPropagation()" ondblclick="event.stopPropagation(); startRenameFile('${doc.id}')" title="Double-click to rename">📄 ${esc(doc.title)}</div>
       <button class="icon-btn" style="width:28px;height:28px;margin:-4px -4px 0 0;" onclick="event.stopPropagation(); openHomeFileMenu('${doc.id}', event)">⋮</button>
    </div>
    <div class="dc-meta">
      <span>${doc.items.length} items</span>
      ${cards?`<span>${cards} cards</span>`:''}
      ${due?`<span class="dc-due">⚡ ${due} due</span>`:''}
      ${newC?`<span style="color:var(--yellow)">✦ ${newC} new</span>`:''}
      ${sched?`<span style="color:var(--green)">✓ ${sched} sched</span>`:''}
    </div>
  </div>`;
}

function filterHomeFolders(value){
  if(curFolder) folderFileFilter = value;
  else homeFolderFilter = value;
  renderHome();
}
window.filterHomeFolders = filterHomeFolders;

function renderHome(){
  if(!D) return;
  const totalDue=D.documents.reduce((n,d)=>n+d.items.filter(i=>isDue(i)&&isFC(i)).length,0);

  const cta=document.getElementById('review-cta'),badge=document.getElementById('rv-badge');
  if(totalDue>0){cta.style.display='block';document.getElementById('cta-txt').textContent=`Review — ${totalDue} card${totalDue>1?'s':''} due`;badge.style.display='flex';badge.textContent=totalDue;}
  else{cta.style.display='none';badge.style.display='none';}

  const streak=window.currentStreak?currentStreak():0;
  const hdrStreakBadge=document.getElementById('hdr-streak-badge'),hdrStreakNum=document.getElementById('hdr-streak-num');
  if(hdrStreakBadge){ hdrStreakBadge.style.display=streak>0?'flex':'none'; if(hdrStreakNum) hdrStreakNum.textContent=streak; }
  const hdrPerfectBadge=document.getElementById('hdr-perfect-badge'),hdrPerfectNum=document.getElementById('hdr-perfect-num');
  if(hdrPerfectBadge){ hdrPerfectBadge.style.display=(D.perfectStreak>0)?'flex':'none'; if(hdrPerfectNum) hdrPerfectNum.textContent=D.perfectStreak; }
  renderXpRing();
  renderFolderPath();

  const el=document.getElementById('doc-list');
  const bbtn=document.getElementById('back-btn-container');
  const favSection=document.getElementById('fav-section');
  const sharedSection=document.getElementById('shared-section');
  const homeHr=document.getElementById('home-hr');
  const searchInp=document.getElementById('hdr-search-inp');

  if(!curFolder) {
      if(homeHr) homeHr.style.display='';
      if(searchInp){ searchInp.placeholder='Filter folders…'; searchInp.value=homeFolderFilter; }
      bbtn.innerHTML='';

      const favs = D.folders.filter(f=>f.favorite);
      if(favSection){
        if(favs.length){
          favSection.style.display='block';
          document.getElementById('fav-list').innerHTML = favs.map(folderCardHTML).join('');
        } else {
          favSection.style.display='none';
        }
      }

      const sharedByOthers = D.folders.filter(f=>f.readOnly && f.sharedFrom);
      if(sharedSection){
        if(sharedByOthers.length){
          sharedSection.style.display='block';
          document.getElementById('shared-list').innerHTML = sharedByOthers.map(folderCardHTML).join('');
        } else {
          sharedSection.style.display='none';
        }
      }

      if (D.folders.length === 0) {
        el.innerHTML = '<div style="grid-column: 1 / -1; padding:40px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">Your vault is empty.<br><br>Tap the + button to create your first folder.</div>';
      } else {
        const filterText = (homeFolderFilter||'').trim().toLowerCase();
        let folders = filterText ? D.folders.filter(f=>f.name.toLowerCase().includes(filterText)) : D.folders.slice();
        folders.sort((a,b)=>folderLastEdited(b)-folderLastEdited(a));

        if(folders.length === 0){
          el.innerHTML = `<div style="grid-column: 1 / -1; padding:40px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">No folders match "${esc(homeFolderFilter)}"</div>`;
        } else {
          el.innerHTML = folders.map(folderCardHTML).join('');
        }
      }
  } else {
      if(favSection) favSection.style.display='none';
      if(sharedSection) sharedSection.style.display='none';
      if(homeHr) homeHr.style.display='none';
      if(searchInp){ searchInp.placeholder='Filter files…'; searchInp.value=folderFileFilter; }

      const curFolderObj = D.folders.find(f=>f.id===curFolder);
      bbtn.innerHTML = `<div class="folder-view-hdr">
        <button class="btn-back-folder" onclick="closeFolder()" title="Back to Folders">← Back to Folders</button>
        <div class="curr-folder-name">📁 ${esc(curFolderObj?.name||'')}</div>
      </div>`;

      let docs = D.documents.filter(d => d.folderId === curFolder);
      const fileFilterText = (folderFileFilter||'').trim().toLowerCase();
      if(fileFilterText) docs = docs.filter(d=>d.title.toLowerCase().includes(fileFilterText));
      docs = docs.slice().sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0));

      if(docs.length === 0) {
         el.innerHTML = fileFilterText
           ? `<div style="grid-column: 1 / -1; padding:40px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">No files match "${esc(folderFileFilter)}"</div>`
           : '<div style="grid-column: 1 / -1; padding:40px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">This folder is empty.<br><br>Tap the + button to create a new file.</div>';
      } else {
        el.innerHTML = docs.map(fileCardHTML).join('');
      }
  }

  if(window.renderNotificationBell) renderNotificationBell();
}

// ── DAILY XP RING (header, next to the streak badges) ──────────────
// SVG ring circumference for r=9 (see index.html): 2*PI*9 ≈ 56.5.
const XP_RING_CIRC = 56.5;
function renderXpRing(){
  if(!D) return;
  const ring=document.getElementById('hdr-xp-ring');
  const fg=document.getElementById('xp-ring-fg');
  const lbl=document.getElementById('xp-ring-label');
  if(!ring || !fg) return;
  const goal=D.dailyGoal||30;
  const have=D.todayXp||0;
  const pct=Math.max(0,Math.min(1,have/goal));
  fg.style.strokeDashoffset=String(XP_RING_CIRC*(1-pct));
  ring.classList.toggle('xp-ring-complete', have>=goal);
  ring.title=`${have} / ${goal} XP today`;
  if(lbl) lbl.textContent=have>=goal?'✓':String(have);
}
window.renderXpRing=renderXpRing;

// ── STREAK TAP (Home header) ────────────────────────────────────────
const STREAK_HYPE = [
  "Keep it going!",
  "Consistency is your superpower.",
  "Another day, another win.",
  "Don't break the chain now!",
  "Look at you go!",
];
function celebrateStreak(){
  const streak = window.currentStreak?currentStreak():0;
  const badge = document.getElementById('hdr-streak-badge');
  if(badge){
    // Restart the animation even on rapid repeat taps — removing the class
    // and forcing a reflow (offsetWidth read) before re-adding it is the
    // standard trick for replaying a CSS animation on the same element.
    badge.classList.remove('streak-pop');
    void badge.offsetWidth;
    badge.classList.add('streak-pop');
  }
  const msg = streak>0
    ? `🔥 ${streak}-day streak — ${STREAK_HYPE[Math.floor(Math.random()*STREAK_HYPE.length)]}`
    : `Review a card today to start a streak!`;
  toast(msg);
}
window.celebrateStreak = celebrateStreak;

// ── FOLDER "UP NEXT" PATH STRIP ─────────────────────────────────────
// Additive to the existing folder grid — a horizontal-scroll strip of the
// folders with the most due cards, so it's obvious what to review next
// without replacing the normal grid layout underneath it.
function renderFolderPath(){
  if(!D) return;
  const el=document.getElementById('folder-path-list');
  const section=document.getElementById('folder-path-section');
  if(!el || !section) return;
  if(curFolder){ section.style.display='none'; return; }
  const withDue = D.folders.map(f=>{
    const docs=D.documents.filter(d=>d.folderId===f.id);
    const due=docs.reduce((n,d)=>n+d.items.filter(i=>isDue(i)&&isFC(i)).length,0);
    return {f,due};
  }).filter(x=>x.due>0).sort((a,b)=>b.due-a.due).slice(0,8);

  if(!withDue.length){ section.style.display='none'; return; }
  section.style.display='block';
  el.innerHTML = withDue.map(({f,due},i)=>`
    <div class="fp-node" onclick="openFolder('${f.id}');showTab('home');" title="Open ${esc(f.name)}">
      <div class="fp-dot${i===0?' fp-dot-next':''}">${due}</div>
      <div class="fp-name">${esc(f.name)}</div>
    </div>
    ${i<withDue.length-1?'<div class="fp-connector"></div>':''}
  `).join('');
}
window.renderFolderPath=renderFolderPath;

// Expands/collapses the inline filter box that lives in the Home header's
// search icon slot, instead of pointing at a separate box elsewhere on the
// page. Collapsing clears whichever filter (folders or files) is active.
function toggleHeaderSearch(){
  const wrap=document.getElementById('hdr-search-wrap');
  const inp=document.getElementById('hdr-search-inp');
  if(!wrap || !inp) return;
  const isOpen=wrap.classList.toggle('open');
  if(isOpen){
    setTimeout(()=>inp.focus(),160);
  } else {
    inp.value='';
    inp.blur();
    filterHomeFolders('');
  }
}
window.toggleHeaderSearch = toggleHeaderSearch;

function handleFabClick() {
    if(!curFolder) { document.getElementById('home-fab-ov').classList.add('open'); }
    else { openNewDocPopup(); }
}
function closeHomeFab() { document.getElementById('home-fab-ov').classList.remove('open'); }

function openNewFolderPopup(){
  document.getElementById('new-folder-ov').classList.add('open');
  setTimeout(()=>document.getElementById('new-folder-inp').focus(),150);
}
window.openNewFolderPopup = openNewFolderPopup;

function openNewDocPopup(){
  const folder=D.folders.find(f=>f.id===curFolder);
  if(folder && folder.readOnly){ toast("⚠️ This folder was shared with you — you can't add files to it"); return; }
  document.getElementById('new-doc-ov').classList.add('open');
  setTimeout(()=>document.getElementById('new-doc-inp').focus(),150);
}
window.openNewDocPopup = openNewDocPopup;

// ── EDITOR ───────────────────────────────────────────────────────
function getDoc(){return D.documents.find(d=>d.id===curDoc);}
function isDocReadOnly(doc){
  if(!doc) return false;
  const folder=D.folders.find(f=>f.id===doc.folderId);
  return !!(folder && folder.readOnly);
}
function renderEditor(){
  const doc=getDoc();if(!doc)return;
  const folder=D.folders.find(f=>f.id===doc.folderId);
  const readOnly=!!(folder && folder.readOnly);
  const crumb=document.getElementById('ed-folder-crumb');
  if(crumb) crumb.textContent = folder ? folder.name+' \\ ' : '';
  const ti=document.getElementById('ed-title');
  ti.value=doc.title;
  ti.disabled=false;
  ti.readOnly=readOnly;
  ti.oninput=readOnly?null:e=>{D.documents=D.documents.map(d=>d.id===curDoc?{...d,title:e.target.value,updatedAt:new Date().toISOString()}:d);saveLS();};
  ti.onclick=readOnly?()=>toast('🔒 Edit access denied — this file is shared, read-only'):null;

  const banner=document.getElementById('ed-readonly-banner');
  if(banner){
    banner.style.display=readOnly?'flex':'none';
    if(readOnly) banner.textContent=`🔒 Shared by ${folder.sharedFrom?.ownerEmail||'someone'} — read-only. You can Review or Take Test.`;
  }

  const el=document.getElementById('ed-content');
  if(!doc.items.length){el.innerHTML='<div style="padding:32px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">The document is empty.<br><br>Tap here or use the + button to start typing.</div>';return;}
  el.innerHTML=doc.items.map((it,i)=>{
    const fc=isFC(it),due=isDue(it);
    const indent=it.level*22;
    let badge='';
    if(fc){if(due)badge=`<span class="fc-badge fc-due">⚡ due</span>`;else if(it.srs?.repetitions>0)badge=`<span class="fc-badge fc-sched">+${it.srs.interval}d</span>`;else badge=`<span class="fc-badge fc-new">new</span>`;}
    const placeholder=(i===0&&doc.items.length<=1&&!readOnly)?'type a note… Q >> A for flashcard':'';
    const handlers=readOnly?`onclick="toast('🔒 Edit access denied — this file is shared, read-only')"`:`oninput="onInput(this,${i})" onfocus="onFocus(${i})" onkeydown="onKey(event,${i})" onpaste="onPaste(event,${i})"`;
    return`<div class="item-row" style="padding-left:${12+indent}px" data-i="${i}">
      <div class="item-bullet"><div class="bdot${it.level>0?' child':''}"></div></div>
      <div class="item-ta${fc?' fc':''}" data-i="${i}" contenteditable="${readOnly?'false':'true'}" data-placeholder="${esc(placeholder)}" ${handlers}
      >${toDisplayHtml(it.content,it.richText)}</div>
      <div class="fc-bd" data-i="${i}">${badge}</div>
    </div>`;
  }).join('');
}

function onInput(el,i){
  const doc=getDoc();if(!doc)return;
  const clean=sanitizeHtml(el.innerHTML);
  if(clean!==el.innerHTML){
    const hadFocus=document.activeElement===el;
    el.innerHTML=clean;
    if(hadFocus) placeCursorAtEnd(el);
  }
  const items=[...doc.items];
  const it={...items[i],content:clean,richText:true};
  if(FC_SEP_RE.test(clean) && !it.srs){it.srs={repetitions:0,easeFactor:2.5,interval:0,dueDate:today()};toast('⚡ Flashcard created!');}
  items[i]=it;
  D.documents=D.documents.map(d=>d.id===curDoc?{...d,items,updatedAt:new Date().toISOString()}:d);saveLS();
  const bd=document.querySelector(`.fc-bd[data-i="${i}"]`);
  if(bd){
    const fc=isFC(it),due=isDue(it);
    bd.innerHTML=fc?(due?`<span class="fc-badge fc-due">⚡ due</span>`:(it.srs?.repetitions>0?`<span class="fc-badge fc-sched">+${it.srs.interval}d</span>`:`<span class="fc-badge fc-new">new</span>`)):'';
  }
  el.classList.toggle('fc',isFC(it));
}
function onFocus(i){focIdx=i;showFT();}

// Listen for flashcard shortcut (Ctrl+Space or Alt+/), highlight shortcut
// (Alt+H), and multi-line insert (Alt+Enter — e.g. stacked terminal commands)
function onKey(e,i){
  const t=e.target;

  // Alt+Enter inserts a real line break within the SAME item instead of
  // creating a new one (which is what plain Enter does below).
  if(e.key==='Enter'&&e.altKey){
    e.preventDefault();
    insertBreakAtCursor();
    onInput(t,i);
    return;
  }
  if(e.key==='Enter'&&!e.shiftKey){
    e.preventDefault();tbNewAt(i);
    return;
  }
  // Backspace at the very start of an empty item deletes it and merges
  // focus back to the previous item — undoes an accidental Enter.
  if(e.key==='Backspace'){
    const sel=window.getSelection();
    const empty=t.textContent===''||t.innerHTML==='<br>';
    if(empty && sel.rangeCount && sel.getRangeAt(0).collapsed && getDoc().items.length>1){
      e.preventDefault();
      tbDel();
      return;
    }
  }
  // Inject ` >> ` at cursor with keyboard shortcut — skip if the item is
  // already a flashcard, so repeated presses don't stack duplicate `>>`.
  if ((e.ctrlKey && e.code === 'Space') || (e.altKey && e.key === '/')) {
    e.preventDefault();
    if(t.textContent.includes('>>')){ toast('⚡ Already a flashcard'); return; }
    insertTextAtCursor(' >> ');
    onInput(t, i);
    return;
  }
  // Alt+H: highlight the current selection immediately — bold + yellow,
  // visible right away, no markup syntax involved.
  if(e.altKey && e.code==='KeyH'){
    e.preventDefault();
    applyHighlight();
  }
}

function showFT(){document.getElementById('ftoolbar').classList.add('on');}
function hideFT(){document.getElementById('ftoolbar').classList.remove('on');focIdx=-1;}

if(window.visualViewport){
  window.visualViewport.addEventListener('resize',()=>{
    const ft=document.getElementById('ftoolbar');if(!ft.classList.contains('on'))return;
    const kbH=window.innerHeight-window.visualViewport.height-window.visualViewport.offsetTop;
    ft.style.bottom=Math.max(0,kbH)+'px';
  });
}

function tbNew(){tbNewAt(focIdx>=0?focIdx:(getDoc()?.items.length||1)-1);}
function tbNewAt(i){
  const doc=getDoc();if(!doc)return;
  const lv=i>=0&&i<doc.items.length?doc.items[i].level:0;
  const ni={id:gid(),content:'',level:lv,srs:null,richText:true};
  updItems([...doc.items.slice(0,i+1),ni,...doc.items.slice(i+1)],true,i+1);
}
function tbIndent(){
  if(focIdx<0)return;const items=getDoc().items;
  const max=focIdx>0?items[focIdx-1].level+1:0;
  if(items[focIdx].level<max)updItems(items.map((it,i)=>i===focIdx?{...it,level:it.level+1}:it),true,focIdx);
}
function tbOutdent(){
  if(focIdx<0)return;const items=getDoc().items;
  if(items[focIdx].level>0)updItems(items.map((it,i)=>i===focIdx?{...it,level:it.level-1}:it),true,focIdx);
}
function tbCard(){
  if(focIdx<0)return;
  updItems(getDoc().items.map((it,i)=>{
    if(i!==focIdx)return it;
    const content=FC_SEP_RE.test(it.content)?it.content:it.content+(it.content.trim()?'  >>  ':' >>  ');
    return{...it,content,srs:it.srs||{repetitions:0,easeFactor:2.5,interval:0,dueDate:today()}};
  }),true,focIdx);
  toast('⚡ Flashcard created!');
}
function tbDel(){
  if(focIdx<0)return;
  const items=getDoc().items;if(items.length<=1){toast("⚠️ Can't delete last item");return;}
  const idx=focIdx,nf=Math.max(0,idx-1);focIdx=-1;
  updItems(items.filter((_,i)=>i!==idx),true,nf);
}
function updItems(items,rerender=true,refocus=-1){
  D.documents=D.documents.map(d=>d.id===curDoc?{...d,items,updatedAt:new Date().toISOString()}:d);saveLS();
  if(rerender){
    renderEditor();
    if(refocus>=0){
      setTimeout(()=>{const tas=document.querySelectorAll('.item-ta');if(tas[refocus]) placeCursorAtEnd(tas[refocus]);},40);
    }
  }
}

// ── REVIEW ───────────────────────────────────────────────────────
function reviewThisDoc(){
  closeEdMenu();
  const cards=getDoc().items.filter(i=>isDue(i)&&isFC(i)).map(i=>({...i,_d:curDoc}));
  if(!cards.length){toast('⚠️ No due cards in this file');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=false;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}
function renderRv(dir){
  document.getElementById('rv-ctr').textContent=`${rvIdx+1} / ${rvCards.length}`;
  document.getElementById('rv-prog').style.width=`${(rvIdx/rvCards.length)*100}%`;
  const card=rvCards[rvIdx];
  const {q,a}=parseFC(card.content);
  const docName=D.documents.find(d=>d.id===card._d)?.title||'';
  const wrapClass=dir==='in'?'rv-wrap rv-slide-in':'rv-wrap fade-in';
  document.getElementById('rv-content').innerHTML=`
  <div class="${wrapClass}">
    <div class="rv-card${rvShowAns?(rvTestMode?' rv-flip-test':' rv-flip'):''}">
      <div class="rv-chip">▶ ${esc(docName)}${rvTestMode?' · <span class="rv-test-badge">TEST MODE</span>':''}</div>
      <div class="rv-q">${toDisplayHtml(q,card.richText)}</div>
      ${!rvShowAns
        ?`<div class="rv-sep"></div><button class="reveal-btn" onclick="revealAns()" title="Shortcut: Spacebar">Show Answer ↓</button>`
        :`<div class="rv-sep"></div><div class="rv-a-lbl">Answer</div><div class="rv-a">${toDisplayHtml(a||'(no answer defined)',card.richText)}</div>`}
    </div>
    ${rvShowAns?`
    <div style="text-align:center;font-size:11px;color:var(--t3);font-family:var(--mono);margin:-4px 0 2px">Rate your recall to schedule next review</div>
    <div class="rate-grid">
      <button class="rate-btn" onclick="rate(1)" title="Press 1" style="background:#1a0d0d;color:var(--red);border-color:#3a1a1a">Again<br><small style="opacity:.7">forgot</small></button>
      <button class="rate-btn" onclick="rate(2)" title="Press 2" style="background:#1a140d;color:var(--orange);border-color:#3a2a1a">Hard<br><small style="opacity:.7">tough</small></button>
      <button class="rate-btn" onclick="rate(3)" title="Press 3" style="background:#0d1a0d;color:var(--green);border-color:#1a3a1a">Good<br><small style="opacity:.7">ok</small></button>
      <button class="rate-btn" onclick="rate(4)" title="Press 4" style="background:#0d141a;color:#60a5fa;border-color:#1a2a3a">Easy<br><small style="opacity:.7">quick</small></button>
      <button class="rate-btn" onclick="rate(5)" title="Press 5" style="background:#0d1a3a;color:var(--acc2);border-color:#1a2a6e">★<br><small style="opacity:.7">perfect</small></button>
    </div>`:''}
    <button onclick="exitReview()" style="background:transparent;border:none;color:var(--t3);cursor:pointer;font-family:var(--mono);font-size:11px;padding:6px 8px;align-self:center;">← Exit Session</button>
  </div>`;
}
function revealAns(){rvShowAns=true;renderRv();}

function rate(q){
  if(rvBusy) return;
  rvBusy=true;
  const card=rvCards[rvIdx];
  let newBadges=[];

  // Test Mode is pure practice — it must never touch the SM-2 schedule,
  // the perfect-streak counter, XP/badges, or the daily-activity tracker.
  if(!rvTestMode){
    const ns=sm2(q,card.srs);
    D.documents=D.documents.map(d=>{
      if(d.id!==card._d)return d;
      return{...d,items:d.items.map(it=>it.id===card.id?{...it,srs:{...ns,lastReviewed:today()}}:it)};
    });
    D.perfectStreak = q===5 ? (D.perfectStreak||0)+1 : 0;
    D.totalReviewed = (D.totalReviewed||0)+1;

    const xpGain = q>=4?10:q===3?5:2;
    D.todayXp = (D.todayXp||0)+xpGain;
    D.xp = (D.xp||0)+xpGain;
    rvStats.xp += xpGain;

    const owningDoc=D.documents.find(d=>d.id===card._d);
    if(owningDoc){
      D.folders=D.folders.map(f=>f.id===owningDoc.folderId?{...f,reviewCount:(f.reviewCount||0)+1}:f);
      const owningFolder=D.folders.find(f=>f.id===owningDoc.folderId);
      if(owningFolder && owningFolder.readOnly && owningFolder.sharedFrom && window.reportSharedFolderReview){
        window.reportSharedFolderReview(owningFolder);
      }
    }

    if(window.checkAchievements) newBadges=window.checkAchievements();
    if(window.renderXpRing) renderXpRing();
    saveLS();
  }

  rvStats[q]=(rvStats[q]||0)+1;

  // Instant colored feedback (Duolingo-style) before advancing to the next
  // card — one of 5 distinct colors, one per rating level (Again/Hard/Good/
  // Easy/Perfect), matching the rate-btn colors. The flash needs to be
  // visible against the card that was just rated, so it's applied here and
  // advance() is deliberately delayed to outlast the .32s flash animation.
  const cardEl=document.querySelector('.rv-card');
  if(cardEl) cardEl.classList.add('rv-flash','rv-flash-'+q);
  if(q===5) burstPerfectConfetti();

  const advance=()=>{
    rvBusy=false;
    if(rvIdx<rvCards.length-1){rvIdx++;rvShowAns=false;renderRv('in');}
    else{
      document.getElementById('rv-prog').style.width='100%';
      document.getElementById('rv-ctr').textContent='✓ done';
      const correct=rvStats[3]+rvStats[4]+rvStats[5];
      const accuracy=Math.round((correct/rvCards.length)*100);
      const breakdown=`
        <div class="rv-breakdown">
          <div class="rv-bd-item" style="color:var(--red)">${rvStats[1]}<small>Again</small></div>
          <div class="rv-bd-item" style="color:var(--orange)">${rvStats[2]}<small>Hard</small></div>
          <div class="rv-bd-item" style="color:var(--green)">${rvStats[3]}<small>Good</small></div>
          <div class="rv-bd-item" style="color:#60a5fa">${rvStats[4]}<small>Easy</small></div>
          <div class="rv-bd-item" style="color:var(--acc2)">${rvStats[5]}<small>Perfect</small></div>
        </div>`;
      document.getElementById('rv-content').innerHTML=rvTestMode?`<div class="rv-done fade-in">
        <div style="font-size:56px">📝</div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--acc2)">Test complete!</div>
        <div style="font-size:13px;color:var(--t2);line-height:1.6">Practiced ${rvCards.length} card${rvCards.length>1?'s':''} · ${accuracy}% recalled.<br>Nothing was saved — your review schedule is unchanged.</div>
        ${breakdown}
        <button onclick="exitReview()" style="background:transparent;border:1px solid var(--border);border-radius:11px;color:var(--t2);padding:10px 24px;font-size:13px;cursor:pointer;font-family:var(--mono);">Back to Notes</button>
      </div>`:`<div class="rv-done fade-in">
        <div style="font-size:56px">🎉</div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--acc2)">Session complete!</div>
        <div style="font-size:13px;color:var(--t2);line-height:1.6">Reviewed ${rvCards.length} card${rvCards.length>1?'s':''} · ${accuracy}% recalled · +${rvStats.xp} XP.<br>Data synced to cloud backend automatically.</div>
        ${breakdown}
        <button onclick="exitReview()" style="background:transparent;border:1px solid var(--border);border-radius:11px;color:var(--t2);padding:10px 24px;font-size:13px;cursor:pointer;font-family:var(--mono);">Back to Notes</button>
      </div>`;
      if(!rvTestMode && window.logTrackerToday){logTrackerToday();renderHome();}
    }
  };

  setTimeout(()=>{
    // Everything in here besides advance() itself is cosmetic (toasts,
    // notifications, the confetti overlay) — wrapped so a failure in any of
    // it can never silently swallow the advance() call and strand the
    // session on the same card forever.
    try{
      if(!rvTestMode && newBadges.length) newBadges.forEach(b=>window.announceBadge&&window.announceBadge(b));
      if(!rvTestMode && D.perfectStreak>0 && D.perfectStreak%5===0){ showVictoryCelebration(D.perfectStreak,advance); return; }
    }catch(e){ console.error('Post-rating celebration step failed', e); }
    advance();
  },q===5?720:420); // let the Perfect confetti burst (.8s) mostly play out before the card swaps
}

// ── PERFECT-STREAK VICTORY CELEBRATION ────────────────────────────
function renderConfetti(){
  const el=document.getElementById('victory-confetti');
  const colors=['#3d6bff','#2dd4a0','#f0a040','#e0d060','#f06080','#6d8fff'];
  let html='';
  for(let i=0;i<24;i++){
    const left=Math.random()*100;
    const delay=(Math.random()*0.4).toFixed(2);
    const color=colors[Math.floor(Math.random()*colors.length)];
    const rot=Math.round(Math.random()*360);
    html+=`<div class="confetti-piece" style="left:${left}%;background:${color};animation-delay:${delay}s;transform:rotate(${rot}deg);"></div>`;
  }
  el.innerHTML=html;
}

// Party-popper burst for every single Perfect (5) rating — distinct from
// showVictoryCelebration below, which is the bigger every-5th-in-a-row
// overlay. Fixed to the full viewport (not scoped to the card) so it reads
// as a whole-screen celebration, and never blocks/delays advance() — it's
// purely decorative and self-removes.
function burstPerfectConfetti(){
  const colors=['#3d6bff','#2dd4a0','#f0a040','#e0d060','#f06080','#6d8fff'];
  const burst=document.createElement('div');
  burst.className='rv-perfect-burst';
  const vw=window.innerWidth||document.documentElement.clientWidth||360;
  const vh=window.innerHeight||document.documentElement.clientHeight||640;
  const maxDist=Math.max(vw,vh)*0.6;
  let html='';
  for(let i=0;i<48;i++){
    const angle=Math.random()*360;
    const dist=maxDist*0.35+Math.random()*maxDist*0.65;
    const tx=(Math.cos(angle*Math.PI/180)*dist).toFixed(1);
    const ty=(Math.sin(angle*Math.PI/180)*dist).toFixed(1);
    const rot=Math.round(Math.random()*720-360);
    const color=colors[Math.floor(Math.random()*colors.length)];
    const delay=(Math.random()*0.15).toFixed(2);
    const w=(6+Math.random()*5).toFixed(1);
    const h=(w*1.6).toFixed(1);
    html+=`<div class="rv-perfect-piece" style="--tx:${tx}px;--ty:${ty}px;--rot:${rot}deg;background:${color};width:${w}px;height:${h}px;margin:${-h/2}px 0 0 ${-w/2}px;animation-delay:${delay}s;"></div>`;
  }
  burst.innerHTML=html;
  document.body.appendChild(burst);
  setTimeout(()=>burst.remove(),1100);
}

function showVictoryCelebration(count,onDone){
  document.getElementById('victory-msg').textContent=`${count} in a row!`;
  renderConfetti();
  const ov=document.getElementById('victory-ov');
  ov.classList.add('open');
  setTimeout(()=>{
    ov.classList.remove('open');
    onDone();
  },2000);
}

// ── SEARCH ───────────────────────────────────────────────────────
// ── SEARCH QUERY LANGUAGE ─────────────────────────────────────────
// word          → content contains word
// a+b+c         → content contains the exact phrase "a b c"
// A AND B       → both A and B match (uppercase keyword; default between
//                 bare terms with no operator between them)
// A OR B        → either matches
// A NOT B       → A matches and B does not
// f:text        → match against the file title only
// d:text        → match against the folder name only
// *text* / a?b  → glob wildcard, matched against title + content
// Terms chain left-to-right with no operator precedence/parentheses.
const RX_ESC=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function globToRegex(pat){
  const body=pat.split(/([*?])/).map(part=>part==='*'?'.*':part==='?'?'.':RX_ESC(part)).join('');
  return new RegExp('^'+body+'$','i');
}

function compileSearchTerm(raw){
  if(/^f:/i.test(raw)){
    const v=raw.slice(2).toLowerCase();
    return item=>item._dt.toLowerCase().includes(v);
  }
  if(/^d:/i.test(raw)){
    const v=raw.slice(2).toLowerCase();
    return item=>(item._folder||'').toLowerCase().includes(v);
  }
  if(raw.includes('*')||raw.includes('?')){
    const rx=globToRegex(raw);
    return item=>rx.test(item._dt)||rx.test(item.content);
  }
  if(raw.includes('+')){
    const phrase=raw.split('+').filter(Boolean).join(' ').toLowerCase();
    return item=>item.content.toLowerCase().includes(phrase);
  }
  const v=raw.toLowerCase();
  return item=>item.content.toLowerCase().includes(v);
}

function parseSearchQuery(q){
  const tokens=q.trim().split(/\s+/).filter(Boolean);
  const parsed=[];
  let pendingOp=null;
  tokens.forEach(tok=>{
    if(tok==='AND'||tok==='OR'||tok==='NOT'){ pendingOp=tok; return; }
    const type=/^f:/i.test(tok)?'f':/^d:/i.test(tok)?'d':(tok.includes('*')||tok.includes('?'))?'glob':tok.includes('+')?'phrase':'word';
    parsed.push({ op: parsed.length===0?null:(pendingOp||'AND'), raw:tok, type, predicate:compileSearchTerm(tok) });
    pendingOp=null;
  });
  return parsed;
}

function evalSearchQuery(parsed,item){
  if(!parsed.length) return false;
  let result=parsed[0].predicate(item);
  for(let i=1;i<parsed.length;i++){
    const {op,predicate}=parsed[i];
    const v=predicate(item);
    if(op==='OR') result=result||v;
    else if(op==='NOT') result=result&&!v;
    else result=result&&v;
  }
  return result;
}

function doSearch(q){
  const el=document.getElementById('srch-res');
  const trimmed=q.trim();
  if(trimmed.length<2){el.innerHTML='<div style="padding:20px 14px;font-size:12px;color:var(--t3);font-family:var(--mono);text-align:center;">Type to search...</div>';return;}

  const parsed=parseSearchQuery(trimmed);
  if(!parsed.length){el.innerHTML='<div style="padding:20px 14px;font-size:12px;color:var(--t3);font-family:var(--mono);text-align:center;">Type to search...</div>';return;}

  const folderNameById=new Map(D.folders.map(f=>[f.id,f.name]));

  // A query made ENTIRELY of f:/d: terms is looking for a folder or file,
  // not content inside one — show folder/file cards (like Home) instead of
  // a flat list of every matching note/flashcard.
  if(parsed.every(p=>p.type==='f'||p.type==='d')){
    const noResults=`<div style="padding:20px 14px;font-size:12px;color:var(--t3);font-family:var(--mono);text-align:center;">No results found for "${esc(q)}"</div>`;
    if(parsed.some(p=>p.type==='f')){
      const matches=D.documents.filter(d=>evalSearchQuery(parsed,{content:'',_dt:d.title,_folder:folderNameById.get(d.folderId)||''}));
      el.innerHTML=matches.length?`<div class="list-container" style="padding:12px">${matches.map(fileCardHTML).join('')}</div>`:noResults;
    } else {
      const matches=D.folders.filter(f=>evalSearchQuery(parsed,{content:'',_dt:'',_folder:f.name}));
      el.innerHTML=matches.length?`<div class="list-container" style="padding:12px">${matches.map(folderCardHTML).join('')}</div>`:noResults;
    }
    return;
  }

  const hits=D.documents.flatMap(d=>{
    const folderName=folderNameById.get(d.folderId)||'';
    return d.items
      .map(i=>({...i, content:i.richText?htmlToText(i.content):i.content, _dt:d.title,_d:d.id,_folder:folderName}))
      .filter(item=>evalSearchQuery(parsed,item));
  }).slice(0,30);

  if(!hits.length){el.innerHTML=`<div style="padding:20px 14px;font-size:12px;color:var(--t3);font-family:var(--mono);text-align:center;">No results found for "${esc(q)}"</div>`;return;}

  const highlightTerms=parsed.filter(p=>p.op!=='NOT'&&(p.type==='word'||p.type==='phrase'))
    .map(p=>p.type==='phrase'?p.raw.split('+').filter(Boolean).join(' '):p.raw)
    .filter(Boolean);
  const rx=highlightTerms.length?new RegExp(`(${highlightTerms.map(RX_ESC).join('|')})`,'gi'):null;

  el.innerHTML='<div style="height:8px"></div>'+hits.map(it=>{
    const escaped=esc(it.content);
    const hi=rx?escaped.replace(rx,'<mark style="background:#1a2a5e;color:var(--acc2);border-radius:2px;padding:0 2px">$1</mark>'):escaped;
    return`<div class="s-hit" onclick="openEditor('${it._d}')">
      <div class="s-doc">${esc(it._dt)}${it._folder?` · ${esc(it._folder)}`:''}</div>
      <div style="font-size:13px;line-height:1.5">${hi}</div>
      ${isFC(it)?'<div style="font-size:10px;color:var(--t3);margin-top:4px;font-family:var(--mono)">🃏 flashcard</div>':''}
    </div>`;
  }).join('');
}

// ── FILE EXPORT / IMPORT ─────────────────────────────────────────
function buildExport(singleDocId = null){
  if(singleDocId) {
      const doc = D.documents.find(d => d.id === singleDocId);
      const folder = D.folders.find(f => f.id === doc.folderId) || {id: doc.folderId, name: 'Exported File'};
      const images = {};
      extractImageIds(doc.items).forEach(id=>{ if(D.images && D.images[id]) images[id]=D.images[id]; });
      return JSON.stringify({
        version: 4, exportedAt: new Date().toISOString(),
        folders: [folder], documents: [doc], images
      }, null, 2);
  }
  return JSON.stringify({
    version: 4, exportedAt: new Date().toISOString(),
    folders: D.folders || [], documents: D.documents, images: D.images || {}
  },null,2);
}

function dlFile(content,name){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type:'application/json'}));
  a.download=name;document.body.appendChild(a);a.click();document.body.removeChild(a);
}

function exportFile(){dlFile(buildExport(null),`notevault-${today()}.nvault`);toast('💾 Exported All Successfully!');}
function exportSingleFile(){
  closeFileMenu();
  if(!contextFileId) return;
  const doc = D.documents.find(d => d.id === contextFileId);
  const safeName = doc.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  dlFile(buildExport(contextFileId), `${safeName}-${today()}.nvault`);
  toast('💾 File Exported');
}

function triggerImportIntoFile(){
  const doc=D.documents.find(d=>d.id===contextFileId);
  if(isDocReadOnly(doc)){ closeFileMenu(); toast("⚠️ This file was shared with you — you can't modify it"); return; }
  closeFileMenu();
  document.getElementById('file-input-single').click();
}
function handleImportIntoFile(input){
  const file=input.files[0]; if(!file) return;
  const targetId = contextFileId;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const parsed=JSON.parse(e.target.result);
      if(!parsed.documents||!Array.isArray(parsed.documents)||!parsed.documents.length) throw new Error("Invalid format");
      const doc = D.documents.find(d=>d.id===targetId);
      if(!doc){ toast('⚠️ File not found'); return; }
      const incomingItems = parsed.documents.flatMap(d=>d.items||[]);
      const lm = new Map(doc.items.map(i=>[i.id,i]));
      let added=0;
      for(const fi of incomingItems){
        if(lm.has(fi.id)){
          const li=lm.get(fi.id);
          let merged={...li,content:fi.content};
          if(fi.srs&&li.srs){
            const fd2=(fi.srs.lastReviewed||fi.srs.dueDate||'0');
            const ld2=(li.srs.lastReviewed||li.srs.dueDate||'0');
            merged.srs=fd2>ld2?fi.srs:li.srs;
          }else if(fi.srs&&!li.srs){merged.srs=fi.srs;}
          lm.set(fi.id,merged);
        }else{ lm.set(fi.id,fi); added++; }
      }
      D.documents = D.documents.map(d=>d.id===targetId?{...d, items:[...lm.values()], updatedAt:new Date().toISOString()}:d);
      D.images = {...(D.images||{}), ...(parsed.images||{})};
      saveLS();
      if(curDoc===targetId) renderEditor();
      renderHome();
      toast(`📥 Imported ${added} new item${added===1?'':'s'} into file`);
    }catch(err){
      toast('❌ Invalid or corrupted file format');
      console.error(err);
    }
  };
  reader.readAsText(file);
  input.value='';
}

function triggerImport(){document.getElementById('file-input').click();}
function handleImport(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const parsed=JSON.parse(e.target.result);
      if(!parsed.documents||!Array.isArray(parsed.documents))throw new Error("Invalid format");

      if (parsed.version === 3 || !parsed.folders) {
          parsed.folders = [{ id: gid(), name: 'Imported Files' }];
          parsed.documents.forEach(doc => { doc.folderId = parsed.folders[0].id; });
      }

      importPending=parsed;
      const ts=parsed.exportedAt?new Date(parsed.exportedAt).toLocaleString():'unknown date';
      const cards=parsed.documents.reduce((n,d)=>n+d.items.filter(i=>i.srs).length,0);
      document.getElementById('import-info').innerHTML=
        `File from <strong>${ts}</strong><br>${parsed.folders.length} folder(s) · ${parsed.documents.length} file(s) · ${cards} flashcards`;
      document.getElementById('import-ov').classList.add('open');
    }catch (err){
        toast('❌ Invalid or corrupted file format');
        console.error(err);
    }
  };
  reader.readAsText(file);
  input.value='';
}
function selMerge(mode){
  mergeMode=mode;
  document.getElementById('mo-merge').classList.toggle('sel',mode==='merge');
  document.getElementById('mo-replace').classList.toggle('sel',mode==='replace');
}

function confirmImport(){
  if(!importPending)return;
  if(mergeMode==='replace'){
    D={...D, folders: importPending.folders, documents: importPending.documents, images: importPending.images||{}};
    saveLS();
    toast(`✅ Replaced — Data loaded into account`);
  }else{
    const fMap = new Map((D.folders||[]).map(f=>[f.id,f]));
    for(const incF of importPending.folders) { fMap.set(incF.id, incF); }

    const map=new Map(D.documents.map(d=>[d.id,d]));
    for(const fd of importPending.documents){
      if(map.has(fd.id)){
        const ld=map.get(fd.id);
        const lm=new Map(ld.items.map(i=>[i.id,i]));
        for(const fi of fd.items){
          if(lm.has(fi.id)){
            const li=lm.get(fi.id);
            let merged={...li,content:fi.content};
            if(fi.srs&&li.srs){
              const fd2=(fi.srs.lastReviewed||fi.srs.dueDate||'0');
              const ld2=(li.srs.lastReviewed||li.srs.dueDate||'0');
              merged.srs=fd2>ld2?fi.srs:li.srs;
            }else if(fi.srs&&!li.srs){merged.srs=fi.srs;}
            lm.set(fi.id,merged);
          }else{lm.set(fi.id,fi);}
        }
        map.set(fd.id,{...ld, folderId: fd.folderId || ld.folderId, title:fd.title, items:[...lm.values()]});
      }else{map.set(fd.id,fd);}
    }

    D={...D, folders: [...fMap.values()], documents:[...map.values()], images: {...(D.images||{}), ...(importPending.images||{})}};
    saveLS();
    toast(`✅ Merged — Data synced safely`);
  }

  closeImport();importPending=null;renderHome();
}
function closeImport(){document.getElementById('import-ov').classList.remove('open');mergeMode='merge';selMerge('merge');}

// ── FOLDER / DOC MANAGEMENT ───────────────────────────────────────────────
function closeNewFolder(){document.getElementById('new-folder-ov').classList.remove('open');document.getElementById('new-folder-inp').value='';}
function confirmNewFolder(){
  const t=document.getElementById('new-folder-inp').value.trim()||'New Folder';
  if(D.folders.some(f=>f.name.toLowerCase()===t.toLowerCase())){
    toast('⚠️ A folder named "'+t+'" already exists');
    return;
  }
  D.folders.push({ id: gid(), name: t, createdAt: new Date().toISOString(), favorite: false });
  saveLS(); closeNewFolder(); renderHome(); toast('📁 Folder created');
}

function closeNewDoc(){document.getElementById('new-doc-ov').classList.remove('open');document.getElementById('new-doc-inp').value='';}
function confirmNewDoc(){
  const t=document.getElementById('new-doc-inp').value.trim()||'Untitled File';
  if(D.documents.some(d=>d.folderId===curFolder&&d.title.toLowerCase()===t.toLowerCase())){
    toast('⚠️ A file named "'+t+'" already exists in this folder');
    return;
  }
  const now=new Date().toISOString();
  const nd={id:gid(), folderId: curFolder, title:t,createdAt:now,updatedAt:now,items:[{id:gid(),content:'',level:0,srs:null,richText:true}]};
  D.documents.push(nd);saveLS();closeNewDoc();openEditor(nd.id); toast('📄 File created');
}

function showEdMenu(){document.getElementById('ed-menu-h').textContent=getDoc()?.title||'';document.getElementById('ed-menu-ov').classList.add('open');}
function closeEdMenu(){document.getElementById('ed-menu-ov').classList.remove('open');}

// File Menu Actions (from Home Screen)
function openHomeFileMenu(docId, event) {
  contextFileId = docId;
  const doc = D.documents.find(d => d.id === docId);
  document.getElementById('fc-menu-h').textContent = doc.title;
  const folder = D.folders.find(f => f.id === doc.folderId);
  const readOnly = !!(folder && folder.readOnly);
  const importBtn = document.getElementById('fc-import-btn');
  if(importBtn) importBtn.style.display = readOnly ? 'none' : '';
  const delBtn = document.getElementById('fc-delete-btn');
  if(delBtn) delBtn.style.display = readOnly ? 'none' : '';
  openAnchoredMenu('file-context-ov', event);
}
function closeFileMenu() { closeAnchoredMenu('file-context-ov'); }

function testFileFromMenu(){
  if(!contextFileId) return;
  const id = contextFileId;
  closeFileMenu();
  if(window.testDoc) testDoc(id);
}

// Renaming a file happens by double-clicking its title on the card (not
// from the ⋮ menu), same pattern as folders — see startRenameFolder.
function startRenameFile(docId) {
  const doc = D.documents.find(d => d.id === docId);
  if(!doc) return;
  if(isDocReadOnly(doc)){ toast("⚠️ This file was shared with you — you can't rename it"); return; }
  contextFileId = docId;
  openRenameOv('file', doc.title);
}
window.startRenameFile = startRenameFile;

function requestDeleteFile() {
  const doc = D.documents.find(d => d.id === contextFileId);
  if(isDocReadOnly(doc)){ closeFileMenu(); toast("⚠️ This file was shared with you — remove the whole folder instead"); return; }
  closeFileMenu();
  openDeleteConfirm(`Are you sure you want to delete <strong>"${esc(doc.title)}"</strong>?<br><br>This action cannot be undone.`, ()=>{
    D.documents = D.documents.filter(d => d.id !== contextFileId);
    saveLS(); renderHome(); toast('🗑 File deleted');
  });
}

// ── GENERIC RENAME POPUP (folders & files) — replaces window.prompt() ──
let renameTarget = null; // 'folder' | 'file'
function openRenameOv(type, currentName){
  renameTarget = type;
  document.getElementById('rename-ov-h').textContent = type==='folder' ? 'Rename Folder' : 'Rename File';
  const inp = document.getElementById('rename-ov-inp');
  inp.value = currentName || '';
  document.getElementById('rename-ov').classList.add('open');
  setTimeout(()=>{ inp.focus(); inp.select(); },150);
}
function closeRenameOv(){
  document.getElementById('rename-ov').classList.remove('open');
  renameTarget = null;
}
function confirmRename(){
  const val = document.getElementById('rename-ov-inp').value;
  if(val==null || !val.trim()){ closeRenameOv(); return; }
  const trimmed = val.trim();
  if(renameTarget==='folder'){
    if(D.folders.some(f=>f.id!==contextFolderId&&f.name.toLowerCase()===trimmed.toLowerCase())){
      toast('⚠️ A folder named "'+trimmed+'" already exists');
      return;
    }
    D.folders = D.folders.map(f => f.id === contextFolderId ? { ...f, name: trimmed } : f);
    saveLS(); renderHome(); toast('📁 Folder Renamed');
  } else if(renameTarget==='file'){
    const doc = D.documents.find(d => d.id === contextFileId);
    if(!doc){ closeRenameOv(); return; }
    if(D.documents.some(d=>d.id!==contextFileId&&d.folderId===doc.folderId&&d.title.toLowerCase()===trimmed.toLowerCase())){
      toast('⚠️ A file named "'+trimmed+'" already exists in this folder');
      return;
    }
    D.documents = D.documents.map(d => d.id === contextFileId ? {...d, title: trimmed, updatedAt: new Date().toISOString()} : d);
    saveLS(); renderHome(); toast('✎ File Renamed');
  }
  closeRenameOv();
}
window.openRenameOv=openRenameOv; window.closeRenameOv=closeRenameOv; window.confirmRename=confirmRename;

// ── GENERIC DELETE CONFIRM POPUP (folders & files) — replaces window.confirm() ──
let pendingDeleteAction = null;
function openDeleteConfirm(message, onConfirm){
  document.getElementById('del-conf-msg').innerHTML = message;
  pendingDeleteAction = onConfirm;
  document.getElementById('delete-confirm-ov').classList.add('open');
}
function closeDeleteConfirm(){
  document.getElementById('delete-confirm-ov').classList.remove('open');
  pendingDeleteAction = null;
}
function runDeleteConfirm(){
  const fn = pendingDeleteAction;
  closeDeleteConfirm();
  if(fn) fn();
}
window.openDeleteConfirm=openDeleteConfirm; window.closeDeleteConfirm=closeDeleteConfirm; window.runDeleteConfirm=runDeleteConfirm;

// ── TOAST ────────────────────────────────────────────────────────
let toastT;
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('on');clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('on'),2600);}

// ── BACK BUTTON ──────────────────────────────────────────────────
// A single pushState() at load only gives the hardware/WebView back button
// ONE entry to consume — after that first back-press, there's nothing left
// to pop, so a WebView wrapper (Kodular, Capacitor, etc.) treats "can't go
// back" as "exit the app." Re-pushing on every popstate keeps one guard
// entry always available, so back never falls through to an accidental exit
// while there's still something on-screen to close.
window.addEventListener('popstate',()=>{
  history.pushState(null,null,location.href);
  const openOv=document.querySelector('.overlay.open[data-close]');
  if(openOv){
    const fn=window[openOv.dataset.close];
    if(typeof fn==='function') fn();
  }
  else if(document.getElementById('s-editor').classList.contains('active'))goHome();
  else if(curFolder && document.getElementById('s-home').classList.contains('active')) closeFolder();
  else if(!document.getElementById('s-home').classList.contains('active'))switchTab('home');
});
history.pushState(null,null,location.href);
document.getElementById('ed-content').addEventListener('touchstart',e=>{if(!e.target.closest('.item-ta'))hideFT();},{passive:true});
