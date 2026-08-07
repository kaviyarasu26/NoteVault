const gid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const today=()=>new Date().toISOString().split('T')[0];
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// A small regex-based highlight pass for Document Mode's read-only XML view
// (renderEditor's docModeOn branch) — applied ONLY on top of already-esc()'d
// text (operates on the literal `&lt;`/`&gt;` entities, never raw `<`/`>`),
// so there's no injection risk: nothing here can introduce a real tag,
// it only wraps already-inert text in <span>s for color. Not a real
// tokenizer — good enough to make tag/attribute names visually pop, same
// idea (not the same code) as xml-block.js's CodeMirror HighlightStyle.
function highlightEscapedXml(escaped){
  // Order matters: attribute-name highlighting must run BEFORE tag-name
  // highlighting. Tag-name highlighting injects `<span class="xh-tag">` —
  // if attribute-highlighting ran afterward, its own name="value" pattern
  // would match that injected `class="..."` and mangle it.
  return escaped
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g,'<span class="xh-comment">$1</span>')
    .replace(/([a-zA-Z_][\w:.-]*)(=)(&quot;|")/g,(m,name,eq,q)=>`<span class="xh-attr">${name}</span>${eq}${q}`)
    .replace(/(&lt;\??\/?)([a-zA-Z_][\w:.-]*)/g,(m,open,name)=>`${open}<span class="xh-tag">${name}</span>`);
}
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
const ALLOWED_TAGS=new Set(['B','STRONG','I','EM','U','SPAN','BR','DIV','IMG','UL','LI','TABLE','THEAD','TBODY','TR','TD','TH','H1','H2','H3','A']);
// 'width' is here specifically so a resized <img>'s inline width survives
// sanitizeHtml (which onInput runs on every keystroke) — height is never
// set inline, it stays on the .nv-img CSS class's height:auto so aspect
// ratio is always preserved automatically.
const ALLOWED_STYLE_PROPS=new Set(['color','font-weight','background-color','background','text-decoration','width']);
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
        // Inline base64 is the default; a Firebase Storage download URL is
        // the other legitimate source once uploadImageToStorage succeeds
        // (see storeImage) — anything else (including arbitrary http(s),
        // which could be used for tracking-pixel-style hotlinking) is
        // stripped same as before.
        if(tag==='IMG'&&name==='src'){ if(!/^data:image\//i.test(attr.value) && !/^https:\/\/firebasestorage\.googleapis\.com\//i.test(attr.value)) node.removeAttribute(attr.name); return; }
        if(tag==='IMG'&&(name==='alt'||name==='class')) return;
        // Only http(s)/mailto survive — a javascript: or data: href would
        // execute on click, and this can carry content from other people
        // (shared folders/.nvault imports) same as everything else here.
        if(tag==='A'&&name==='href'){ if(!/^(https?:|mailto:)/i.test(attr.value)) node.removeAttribute(attr.name); return; }
        // Exact-match allowlist, not "any class" — a class can't execute
        // anything, but there's no reason to let arbitrary values through
        // either (this can carry content from other people via shared
        // folders/.nvault imports). nv-hl is the one class format spans use
        // (see applyHighlight) so highlighted text can be colored
        // differently in the editor vs. the Review answer view (.rv-a is
        // already yellow by default — an inline color could never do that).
        if(tag==='SPAN'&&name==='class'&&attr.value==='nv-hl') return;
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
  let html=escapedText.replace(/==(.+?)==/g,'<span class="nv-hl">$1</span>');
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

// Places the caret at a given VISIBLE-TEXT character offset within el (not
// an HTML-string offset — offset 3 always means "after the 3rd visible
// character," regardless of how much markup precedes it). Walks el's own
// text nodes in document order rather than assuming a flat text run, so it
// works the same whether el's content is plain text or rich HTML (bold
// spans, links, a table, ...). Falls back to the end if offset lands past
// all of el's text (e.g. the content actually got shorter) — same behavior
// callers already relied on before this existed.
function placeCursorAtCharOffset(el,offset){
  if(offset==null){ placeCursorAtEnd(el); return; }
  el.focus();
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null);
  let remaining=offset,node;
  while((node=walker.nextNode())){
    const len=node.textContent.length;
    if(remaining<=len){
      const range=document.createRange();
      range.setStart(node,remaining);
      range.collapse(true);
      const sel=window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining-=len;
  }
  placeCursorAtEnd(el);
}

// Captures where the caret is within a flashcard's unfocused colored split
// view (fcColorSplitHtml's .nv-q-live/.nv-a-live spans) — which SIDE it's
// in, and its offset within that side's own visible text — so onFocus
// (below) can restore an equivalent position after swapping back to the
// raw "Q >> A" blob. Deliberately NOT a single whole-element offset: the
// split view's rendered text (q + a, joined by one literal space, no
// separator) and the raw blob's text (q + " >> " + a, WITH the separator)
// are different lengths, so a position captured on one can't be reused
// directly on the other — but a position captured relative to just the q or
// a side's own text IS reusable, since that side's visible text is
// identical in both views.
function getFcCaretPos(el){
  const sel=window.getSelection();
  if(!sel.rangeCount) return null;
  const range=sel.getRangeAt(0);
  const qSpan=el.querySelector('.nv-q-live'), aSpan=el.querySelector('.nv-a-live');
  const span=(qSpan&&qSpan.contains(range.startContainer))?qSpan:(aSpan&&aSpan.contains(range.startContainer))?aSpan:null;
  if(!span) return null;
  const preRange=document.createRange();
  preRange.selectNodeContents(span);
  preRange.setEnd(range.startContainer,range.startOffset);
  return {side:span===qSpan?'q':'a', offset:preRange.toString().length};
}

// The other half of getFcCaretPos — maps a {side,offset} captured on the
// split view onto the equivalent character offset within el's NEW raw-blob
// text (el.textContent, read AFTER the innerHTML swap, so this stays in
// the same "visible text" units as pos.offset regardless of markup on
// either side). Question text starts at/near position 0 either way, so a
// 'q' position needs no adjustment; an 'a' position has to skip past
// wherever the ">>" separator (plus any whitespace right after it) actually
// landed in the rendered text.
function fcPosToRawOffset(el,pos){
  const rawText=el.textContent;
  if(pos.side==='q') return pos.offset;
  const sepMatch=rawText.match(/>>/);
  let aStart=sepMatch?sepMatch.index+2:0;
  while(aStart<rawText.length && /\s/.test(rawText[aStart])) aStart++;
  return aStart+pos.offset;
}

// Formatting is implemented with plain Range/Selection DOM manipulation,
// not document.execCommand — execCommand is deprecated and, worse, silently
// no-ops in some contexts (no real window focus, some embedded/automated
// contexts) instead of throwing, which makes failures invisible. Manual
// Range manipulation has no such caveat.
// Detects whether a DOM element is the exact formatting wrapper tagName
// would produce — used so re-applying the same format to already-formatted
// selected text can toggle it off instead of nesting a redundant wrapper.
function formatMatcher(tagName){
  if(tagName==='span'){
    // The highlight span is the only toggle-able span format today — match
    // on its class specifically so a future color/background span (also a
    // <span>) doesn't get picked up and unwrapped by mistake.
    return el=>el.tagName==='SPAN'&&el.classList.contains('nv-hl');
  }
  const upper=tagName.toUpperCase();
  return el=>el.tagName===upper;
}
function closestFormatAncestor(node,matchFn,boundary){
  let n=node.nodeType===1?node:node.parentElement;
  while(n && n!==boundary){
    if(matchFn(n)) return n;
    n=n.parentElement;
  }
  return null;
}
// Finds the single formatting element (matching matchFn) that contains
// every character `range` actually spans — deliberately NOT just
// range.startContainer/endContainer. A Range boundary sitting exactly at
// a node edge is ambiguous: "end of the preceding text node" and "start
// of the following text node" are the same position, but only one of
// those two nodes is textually inside the format element. Checking every
// text node the range truly intersects (and ignoring a zero-length touch
// at that kind of boundary) avoids being fooled by whichever
// representation the browser happened to produce — this is what was
// causing re-applying a format to already-formatted text to sometimes
// nest a redundant wrapper (plus a stray empty leftover from
// extractContents) instead of removing it.
function findFormatAncestor(range,matchFn,boundary){
  const walker=document.createTreeWalker(boundary,NodeFilter.SHOW_TEXT,{
    acceptNode(n){ return range.intersectsNode(n)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT; }
  });
  let common=null,touched=false,node;
  while((node=walker.nextNode())){
    if(node===range.startContainer && range.startOffset===node.length) continue;
    if(node===range.endContainer && range.endOffset===0) continue;
    touched=true;
    const anc=closestFormatAncestor(node,matchFn,boundary);
    if(!anc) return null;
    if(common===null) common=anc;
    else if(common!==anc) return null;
  }
  return touched?common:null;
}
// Splits fmtEl into up to three pieces around `range` (assumed fully inside
// fmtEl): the parts before/after the selection stay wrapped in a clone of
// fmtEl, the selected part itself is left unwrapped in place. Returns the
// unwrapped nodes so the caller can restore the Selection to them.
function unwrapFormatInRange(range,fmtEl){
  const full=document.createRange();
  full.selectNodeContents(fmtEl);
  const beforeRange=document.createRange();
  beforeRange.setStart(full.startContainer,full.startOffset);
  beforeRange.setEnd(range.startContainer,range.startOffset);
  const afterRange=document.createRange();
  afterRange.setStart(range.endContainer,range.endOffset);
  afterRange.setEnd(full.endContainer,full.endOffset);

  // .collapsed isn't reliable here: a range whose start sits inside a
  // text node's own end and whose end sits at the parent's next child
  // index spans zero real characters but still counts as non-collapsed
  // (they're different (node,offset) representations of ~adjacent tree
  // positions) — extracting it anyway is what left a stray empty clone
  // of fmtEl behind. Checking actual text length sidesteps that.
  const hasContent=r=>r.cloneContents().textContent.length>0;
  let afterWrap=null,beforeWrap=null;
  if(hasContent(afterRange)){ afterWrap=fmtEl.cloneNode(false); afterWrap.appendChild(afterRange.extractContents()); }
  if(hasContent(beforeRange)){ beforeWrap=fmtEl.cloneNode(false); beforeWrap.appendChild(beforeRange.extractContents()); }

  const frag=document.createDocumentFragment();
  while(fmtEl.firstChild) frag.appendChild(fmtEl.firstChild);
  const unwrapped=[...frag.childNodes];

  const parent=fmtEl.parentNode;
  if(beforeWrap) parent.insertBefore(beforeWrap,fmtEl);
  parent.insertBefore(frag,fmtEl);
  if(afterWrap) parent.insertBefore(afterWrap,fmtEl.nextSibling);
  parent.removeChild(fmtEl);
  return unwrapped;
}

// Range.extractContents() can leave an empty husk behind when the
// extracted range only partially overlaps an ancestor element it has to
// clone/split through — e.g. italicizing text that's already bold can
// leave a stray empty <b></b> or <i></i> sitting next to the correctly
// nested result. Pruning after every wrap/unwrap keeps that from
// accumulating in stored content. Never touches an element that still
// holds an <img> even with no text, since that's real content, not a
// leftover shell.
function pruneEmptyFormatTags(container){
  container.querySelectorAll('b,strong,i,em,u,span').forEach(el=>{
    if(!el.textContent && !el.querySelector('img')) el.remove();
  });
}

function wrapSelectionWith(tagName,styleFn){
  // Text is still selectable even with contenteditable="false" (that's a
  // separate browser feature), so this needs its own read-only/Document
  // Mode check — it doesn't inherit one just because typing is disabled.
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount||sel.isCollapsed){ toast('⚠️ Select text first'); return; }
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl){ toast('⚠️ Selection must be inside the note text'); return; }

  // Re-selecting text that's already wrapped in this exact format and
  // applying the same shortcut/button again removes it instead of nesting
  // a redundant wrapper — the only reliable way to back out of an
  // accidental bold/italic/underline/highlight, and the behavior every
  // other editor trains people to expect from pressing the same toggle
  // twice.
  const matchFn=formatMatcher(tagName);
  const fmtEl=findFormatAncestor(range,matchFn,editorEl);
  if(fmtEl){
    pushUndoSnapshot(false);
    const unwrapped=unwrapFormatInRange(range,fmtEl);
    pruneEmptyFormatTags(editorEl);
    sel.removeAllRanges();
    if(unwrapped.length && unwrapped[0].parentNode){
      const after=document.createRange();
      after.setStartBefore(unwrapped[0]);
      after.setEndAfter(unwrapped[unwrapped.length-1]);
      sel.addRange(after);
    }
    onInput(editorEl,parseInt(editorEl.dataset.i,10));
    return;
  }

  pushUndoSnapshot(false);
  const wrapper=document.createElement(tagName);
  if(styleFn) styleFn(wrapper);
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  pruneEmptyFormatTags(editorEl);
  sel.removeAllRanges();
  const after=document.createRange();
  after.selectNodeContents(wrapper);
  after.collapse(false);
  sel.addRange(after);
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}

// ── FORMAT TOGGLE STATE (typing without an active selection) ───────
// Word/Docs-style: with text selected, a format shortcut wraps the
// selection immediately (wrapSelectionWith, above). With no selection —
// just a blinking caret — the same shortcut instead toggles "keep applying
// this format to what I type next": press once, type formatted text, press
// again, drop back to normal. Implemented by inserting an empty inline
// wrapper (holding a zero-width space so the caret has somewhere to sit)
// and leaving the caret inside it — browsers append newly-typed characters
// into the text node the caret already sits inside, so nothing else needs
// to happen on every keystroke. Tracked only as plain JS state, never a
// DOM data-* attribute — sanitizeHtml (onInput, every keystroke) strips any
// attribute it doesn't recognize, which would force a destructive
// innerHTML reset (see onInput) the moment it did, breaking this mid-word.
let activeTypingFormat=null, activeTypingWrapper=null;

// Lights up the matching toolbar button (reusing the same .hi "active"
// look the ⚡+Card button already uses) while its format is the one being
// typed into — the toggle-on/toggle-off state above otherwise has no
// visible indicator at all.
const FORMAT_TOOLBAR_BTN={b:'tb-bold',i:'tb-italic',u:'tb-underline',span:'tb-highlight'};
function updateFormatToolbarState(){
  Object.values(FORMAT_TOOLBAR_BTN).forEach(id=>{
    const btn=document.getElementById(id);
    if(btn) btn.classList.remove('hi');
  });
  const activeId=activeTypingFormat&&FORMAT_TOOLBAR_BTN[activeTypingFormat];
  const activeBtn=activeId&&document.getElementById(activeId);
  if(activeBtn) activeBtn.classList.add('hi');
}

function applyFormat(tagName,styleFn){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  if(sel.isCollapsed) toggleTypingFormat(tagName,styleFn);
  else wrapSelectionWith(tagName,styleFn);
}

function toggleTypingFormat(tagName,styleFn){
  const sel=window.getSelection();
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl) return;

  // Pressing the same shortcut again from inside the still-live wrapper
  // turns it off; pressing it (or a different format) somewhere else starts
  // fresh instead of blindly closing out a wrapper the caret already left.
  const stillInside=activeTypingWrapper && document.contains(activeTypingWrapper) &&
    (activeTypingWrapper===startEl || activeTypingWrapper.contains(startEl));
  if(stillInside && activeTypingFormat===tagName){
    // Just parking a collapsed range "after" the wrapper isn't enough — a
    // caret sitting at that boundary is ambiguous to the browser (inside
    // the wrapper's last text node vs. in the parent right after it), and
    // typing tends to keep extending the wrapper instead of landing outside
    // it. Same fix as starting a format (above): give the caret its own
    // zero-width text node to sit in, this time outside the wrapper.
    const after=document.createRange();
    after.setStartAfter(activeTypingWrapper);
    after.collapse(true);
    const anchor=document.createTextNode('​');
    after.insertNode(anchor);
    after.setStart(anchor,1);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    activeTypingFormat=null; activeTypingWrapper=null;
    updateFormatToolbarState();
    return;
  }

  pushUndoSnapshot(false);
  const wrapper=document.createElement(tagName);
  if(styleFn) styleFn(wrapper);
  wrapper.appendChild(document.createTextNode('​'));
  range.deleteContents();
  range.insertNode(wrapper);
  const inner=document.createRange();
  inner.setStart(wrapper.firstChild,1);
  inner.collapse(true);
  sel.removeAllRanges();
  sel.addRange(inner);
  activeTypingFormat=tagName;
  activeTypingWrapper=wrapper;
  updateFormatToolbarState();
}

// Alt+H — highlight. With a selection, wraps it immediately; with just a
// caret, toggles "everything I type now is highlighted" (see applyFormat).
// Uses a class, not an inline color, specifically so the Review Answer view
// (.rv-a, already yellow+bold by default — see css/base.css) can render a
// highlight in a different color there than the editor does.
function applyHighlight(){
  applyFormat('span', el=>{ el.className='nv-hl'; });
}
window.applyHighlight=applyHighlight;

function applyBold(){ applyFormat('b'); }
window.applyBold=applyBold;
function applyItalic(){ applyFormat('i'); }
window.applyItalic=applyItalic;
function applyUnderline(){ applyFormat('u'); }
window.applyUnderline=applyUnderline;

// List — wraps each line of the selection (or, with no selection, the
// whole item) in <li>/<ul>; toggles back to plain <br>-separated lines if
// the selection is already inside one. Deliberately doesn't make Enter
// create a new <li> — Enter already means "new outline item" everywhere
// else in this editor (see onKey below), so lines go in with Alt+Enter
// first, same as any other multi-line item, and this just wraps what's
// already there.
function applyList(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl){ toast('⚠️ Selection must be inside the note text'); return; }

  const existingList=startEl.closest('ul');
  pushUndoSnapshot(false);

  if(existingList && editorEl.contains(existingList)){
    const lines=[...existingList.querySelectorAll('li')].map(li=>li.innerHTML);
    const frag=document.createRange().createContextualFragment(lines.join('<br>')||'<br>');
    existingList.replaceWith(frag);
  } else {
    let html;
    if(sel.isCollapsed){ html=editorEl.innerHTML; }
    else { const d=document.createElement('div'); d.appendChild(range.cloneContents()); html=d.innerHTML; }
    const lines=html.split(/<br\s*\/?>/i).map(l=>l.trim()).filter(l=>l.length);
    if(!lines.length){ toast('⚠️ Nothing to listify'); return; }
    const ul=document.createElement('ul');
    lines.forEach(l=>{ const li=document.createElement('li'); li.innerHTML=l; ul.appendChild(li); });
    if(sel.isCollapsed){ editorEl.innerHTML=''; editorEl.appendChild(ul); }
    else { range.deleteContents(); range.insertNode(ul); }
  }
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}
window.applyList=applyList;

// Heading — applies to the WHOLE item (not a text selection) since a
// heading is a block-level, one-per-line concept here, same idea as
// applyList above. Pressing the same level again toggles it back to plain
// text; pressing a different level while one is already applied switches
// levels instead of nesting.
function applyHeading(level){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl){ toast('⚠️ Place cursor in a note first'); return; }

  const tag='H'+level;
  const cur=editorEl.firstElementChild;
  const isWholeHeading=editorEl.childNodes.length===1 && cur && /^H[1-3]$/.test(cur.tagName);
  pushUndoSnapshot(false);
  if(isWholeHeading && cur.tagName===tag){
    editorEl.innerHTML=cur.innerHTML;
  } else {
    const inner=isWholeHeading?cur.innerHTML:editorEl.innerHTML;
    const h=document.createElement(tag);
    h.innerHTML=inner;
    editorEl.innerHTML='';
    editorEl.appendChild(h);
  }
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}
window.applyHeading=applyHeading;

// ── TABLES ───────────────────────────────────────────────────────
// Insert goes through a small modal (table-insert-ov) rather than
// window.prompt() — Capacitor's Android WebView doesn't reliably support
// prompt(), and the rest of the app already uses this same sheet-overlay
// pattern for New Folder/New File. Opening the modal moves DOM focus away
// from the contenteditable item, so the caret position has to be saved
// before that happens and restored afterward (same reason the custom
// color picker above does it).
let savedTableRange=null, savedTableEditorIdx=-1;
function openInsertTable(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount){ toast('⚠️ Tap into a note first'); return; }
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl){ toast('⚠️ Tap into a note first'); return; }
  savedTableRange=range.cloneRange();
  savedTableEditorIdx=parseInt(editorEl.dataset.i,10);
  document.getElementById('table-insert-ov').classList.add('open');
}
window.openInsertTable=openInsertTable;

// Toolbar's single "▦ Table ▾" button (index.html #ftoolbar) opens this
// instead of five separate always-visible buttons (Table/+Row/−Row/+Col/
// −Col) — same anchored-menu mechanism the folder/file ⋮ context menus
// already use (openAnchoredMenu, top of this file), just for the table
// toolbar group instead of a folder/file row.
function closeTableMenu(){ closeAnchoredMenu('table-menu-ov'); }
window.closeTableMenu=closeTableMenu;

function closeInsertTable(){
  document.getElementById('table-insert-ov').classList.remove('open');
}
window.closeInsertTable=closeInsertTable;

function buildTableElement(rows,cols){
  const table=document.createElement('table');
  const tbody=document.createElement('tbody');
  for(let r=0;r<rows;r++){
    const tr=document.createElement('tr');
    for(let c=0;c<cols;c++){
      const td=document.createElement('td');
      // Zero-width space so an empty cell still has somewhere for the
      // caret to land instead of collapsing to nothing clickable.
      td.appendChild(document.createTextNode('​'));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function confirmInsertTable(){
  const rows=Math.max(1,Math.min(20,parseInt(document.getElementById('table-rows-inp').value,10)||3));
  const cols=Math.max(1,Math.min(10,parseInt(document.getElementById('table-cols-inp').value,10)||3));
  closeInsertTable();
  if(!savedTableRange) return;
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)){ savedTableRange=null; return; }
  const editorEl=document.querySelector(`.item-ta[data-i="${savedTableEditorIdx}"]`);
  if(!editorEl){ savedTableRange=null; return; }
  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedTableRange);
  pushUndoSnapshot(false);
  const range=sel.getRangeAt(0);
  range.collapse(true);
  range.insertNode(buildTableElement(rows,cols));
  sel.removeAllRanges();
  onInput(editorEl,savedTableEditorIdx);
  // onInput's sanitize pass can rebuild the DOM wholesale (see its own
  // comment on that), so re-find the first cell fresh instead of trusting
  // the node just inserted, then focus the actual contenteditable root —
  // a <td> isn't natively focusable, so calling .focus() on it directly
  // wouldn't move real DOM focus there.
  const firstCell=editorEl.querySelector('td,th');
  if(firstCell){
    editorEl.focus();
    const cellRange=document.createRange();
    cellRange.selectNodeContents(firstCell);
    cellRange.collapse(false);
    const sel2=window.getSelection();
    sel2.removeAllRanges();
    sel2.addRange(cellRange);
  }
  savedTableRange=null;
}
window.confirmInsertTable=confirmInsertTable;

// ── HYPERLINKS ───────────────────────────────────────────────────
// Same save/restore-the-Range pattern as the table modal above — typing
// into the URL input moves focus off the contenteditable, so the
// selection has to be captured before that happens and restored after.
let savedLinkRange=null, savedLinkEditorIdx=-1;
function openInsertLink(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount||sel.isCollapsed){ toast('⚠️ Select text first'); return; }
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl){ toast('⚠️ Selection must be inside the note text'); return; }
  savedLinkRange=range.cloneRange();
  savedLinkEditorIdx=parseInt(editorEl.dataset.i,10);
  const inp=document.getElementById('link-url-inp');
  inp.value='';
  document.getElementById('link-insert-ov').classList.add('open');
  setTimeout(()=>inp.focus(),150);
}
window.openInsertLink=openInsertLink;

function closeInsertLink(){
  document.getElementById('link-insert-ov').classList.remove('open');
}
window.closeInsertLink=closeInsertLink;

function confirmInsertLink(){
  let url=document.getElementById('link-url-inp').value.trim();
  if(!url){ toast('⚠️ Enter a URL'); return; }
  // Same safe-scheme rule as sanitizeHtml's own href allowlist — a bare
  // "example.com" is assumed https, anything already using a scheme is
  // left alone (and will get stripped on save if it isn't http(s)/mailto).
  if(!/^[a-z][a-z0-9+.-]*:/i.test(url)) url='https://'+url;
  closeInsertLink();
  if(!savedLinkRange) return;
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)){ savedLinkRange=null; return; }
  const editorEl=document.querySelector(`.item-ta[data-i="${savedLinkEditorIdx}"]`);
  if(!editorEl){ savedLinkRange=null; return; }
  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedLinkRange);
  const range=sel.getRangeAt(0);
  pushUndoSnapshot(false);
  const a=document.createElement('a');
  a.setAttribute('href',url);
  a.appendChild(range.extractContents());
  range.insertNode(a);
  pruneEmptyFormatTags(editorEl);
  sel.removeAllRanges();
  const after=document.createRange();
  after.selectNodeContents(a);
  after.collapse(false);
  sel.addRange(after);
  onInput(editorEl,savedLinkEditorIdx);
  savedLinkRange=null;
}
window.confirmInsertLink=confirmInsertLink;

// Editing needs a plain click to still place the caret inside link text
// (otherwise you could never edit a link's own words), so opening it only
// fires on Ctrl/Cmd+click there — same convention Docs/Notion use. In any
// read-only rendering (Document Mode, a shared read-only file, Review),
// there's no editing to protect, so a plain click opens it directly.
document.getElementById('ed-content').addEventListener('click',e=>{
  const a=e.target.closest('a[href]');
  if(!a) return;
  const editable=a.closest('.item-ta[contenteditable="true"]');
  if(editable && !(e.ctrlKey||e.metaKey)) return;
  e.preventDefault();
  window.open(a.getAttribute('href'),'_blank','noopener,noreferrer');
});

function findCurrentTable(){
  const sel=window.getSelection();
  if(!sel.rangeCount) return null;
  const node=sel.getRangeAt(0).commonAncestorContainer;
  const el=node.nodeType===1?node:node.parentElement;
  return el&&el.closest('table');
}
function findCurrentCell(){
  const sel=window.getSelection();
  if(!sel.rangeCount) return null;
  const node=sel.getRangeAt(0).commonAncestorContainer;
  const el=node.nodeType===1?node:node.parentElement;
  return el&&el.closest('td,th');
}

function tableAddRow(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const table=findCurrentTable();
  if(!table){ toast('⚠️ Place cursor inside a table first'); return; }
  const editorEl=table.closest('.item-ta');
  if(!editorEl) return;
  const curRow=findCurrentCell()?.closest('tr');
  const cols=(curRow||table.rows[0])?.cells.length||1;
  pushUndoSnapshot(false);
  const newRow=table.insertRow(curRow?curRow.rowIndex+1:table.rows.length);
  for(let c=0;c<cols;c++){ newRow.insertCell(-1).appendChild(document.createTextNode('​')); }
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}
window.tableAddRow=tableAddRow;

function tableRemoveRow(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const table=findCurrentTable();
  if(!table){ toast('⚠️ Place cursor inside a table first'); return; }
  if(table.rows.length<=1){ toast('⚠️ A table needs at least one row'); return; }
  const editorEl=table.closest('.item-ta');
  if(!editorEl) return;
  const curRow=findCurrentCell()?.closest('tr');
  const idx=curRow?curRow.rowIndex:table.rows.length-1;
  pushUndoSnapshot(false);
  table.deleteRow(idx);
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}
window.tableRemoveRow=tableRemoveRow;

function tableAddCol(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const table=findCurrentTable();
  if(!table){ toast('⚠️ Place cursor inside a table first'); return; }
  const editorEl=table.closest('.item-ta');
  if(!editorEl) return;
  const cell=findCurrentCell();
  const colIdx=cell?cell.cellIndex:(table.rows[0]?table.rows[0].cells.length-1:0);
  pushUndoSnapshot(false);
  [...table.rows].forEach(row=>{ row.insertCell(colIdx+1).appendChild(document.createTextNode('​')); });
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}
window.tableAddCol=tableAddCol;

function tableRemoveCol(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const table=findCurrentTable();
  if(!table){ toast('⚠️ Place cursor inside a table first'); return; }
  const firstRowCells=table.rows[0]?table.rows[0].cells.length:0;
  if(firstRowCells<=1){ toast('⚠️ A table needs at least one column'); return; }
  const editorEl=table.closest('.item-ta');
  if(!editorEl) return;
  const cell=findCurrentCell();
  const colIdx=cell?cell.cellIndex:firstRowCells-1;
  pushUndoSnapshot(false);
  [...table.rows].forEach(row=>{ if(row.cells[colIdx]) row.deleteCell(colIdx); });
  onInput(editorEl,parseInt(editorEl.dataset.i,10));
}
window.tableRemoveCol=tableRemoveCol;

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
  // A character-offset position INSIDE the inserted text node (not a
  // parent+childIndex "after this node" boundary) — the latter looks
  // identical via getSelection() right afterward but Chromium's own typing
  // pipeline doesn't reliably honor it for the very next real keystroke
  // (same root cause as insertBreakAtCursor's fix above; confirmed by the
  // same testing).
  const newRange=document.createRange();
  newRange.setStart(node,node.textContent.length);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}
// Word/Docs/web pages use <p> for paragraphs, which isn't in ALLOWED_TAGS
// (sanitizeHtml would unwrap it — dropping the tag but not inserting any
// line separator in its place, running every paragraph's text together).
// <div> already is allowed and is inherently block-level, so normalizing
// <p> to <div> before sanitizing keeps each pasted paragraph on its own
// line without needing a separate allowance just for this.
function normalizeRichPasteHtml(html){
  return html.replace(/<p([ >])/gi,'<div$1').replace(/<\/p>/gi,'</div>');
}
// Same manual-Range approach as insertTextAtCursor, for an HTML fragment
// instead of a plain string — used by rich paste (onPaste) once the
// incoming HTML has already been through sanitizeHtml.
function insertHtmlAtCursor(html){
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  const range=sel.getRangeAt(0);
  range.deleteContents();
  const frag=range.createContextualFragment(html);
  const lastNode=frag.lastChild;
  range.insertNode(frag);
  if(lastNode){
    range.setStartAfter(lastNode);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
function insertBreakAtCursor(){
  const sel=window.getSelection();
  if(!sel.rangeCount) return;
  const startNode=sel.getRangeAt(0).startContainer;
  // execCommand correctly inserts the <br> into the DOM either way, but its
  // own selection bookkeeping is unreliable for the very NEXT real keystroke
  // in Chromium: getSelection() can look right immediately afterward while
  // the browser's internal notion of "where typing goes next" is still the
  // pre-insertion position — so the next character lands BEFORE the break
  // instead of after it. Hence the explicit re-anchor below runs
  // unconditionally after insertion, not only as an execCommand fallback.
  if(!document.execCommand('insertHTML',false,'<br>')){
    const range=sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createElement('br'));
  }
  // startNode is the exact text/element node the break was inserted at (or
  // split from) — the <br> that resulted from that insertion is always its
  // very next sibling once the insertion above completes.
  const br=startNode.nodeType===Node.TEXT_NODE ? startNode.nextSibling : startNode.previousSibling;
  if(!br || br.nodeName!=='BR') return;
  let after=br.nextSibling;
  // A genuinely EMPTY text node isn't a durable anchor here — Chromium's own
  // typing pipeline ignores it for the very next real keystroke even though
  // getSelection() reports it correctly right after this function returns
  // (confirmed by testing: an empty-text-node anchor still let the next
  // character land before the <br>). A zero-width space is real, non-empty
  // text the browser actually tracks — the standard fix contenteditable
  // editors use for this exact "caret after a trailing <br>" quirk.
  if(!after || after.nodeType!==Node.TEXT_NODE || after.textContent===''){
    after=document.createTextNode('​');
    br.parentNode.insertBefore(after,br.nextSibling);
  }
  const newRange=document.createRange();
  newRange.setStart(after,after.textContent.length);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

// ── IMAGES ───────────────────────────────────────────────────────
// Images are inserted as a real <img> right into the item's HTML, so
// they're visible in the editor immediately, not only in Review.
// storeImage() below tries Firebase Storage first (a real file, referenced
// by URL) and only falls back to embedding a base64 data URI directly in
// the item's content — the original, always-available behavior — if that
// upload fails for any reason (Storage not configured yet, offline,
// permission denied). Inline images still ride inside the single
// encrypted vault document, which Firestore caps at 1MiB total, so images
// are resized/compressed on the way in either way to keep that budget
// realistic.
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

// Uploads a compressed data URI as a real file under this user's own
// Storage path and resolves to its download URL. Left to throw on any
// failure — storeImage() below is the one that decides what to do about
// that (fall back to the data URI itself).
async function uploadImageToStorage(dataUri){
  if(!window.storage || !window.storageFns || !window.currentUser) throw new Error('Firebase Storage not available');
  const {ref,uploadString,getDownloadURL}=window.storageFns;
  const path=`users/${window.currentUser.uid}/images/${gid()}.jpg`;
  const r=ref(window.storage,path);
  await uploadString(r,dataUri,'data_url');
  return getDownloadURL(r);
}

// Single entry point every image-insert path (paste, file picker) should
// go through. Tries Firebase Storage first so large images don't eat into
// the 1MiB Firestore document budget; on ANY failure — bucket rules not
// deployed yet, offline, quota, anything — silently falls back to the
// original inline-base64 behavior instead of failing the insert outright.
async function storeImage(dataUri){
  try{
    return await uploadImageToStorage(dataUri);
  }catch(err){
    console.warn('Firebase Storage upload failed, falling back to inline image:',err);
    return dataUri;
  }
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

// Shared by paste-an-image and the file-picker/camera insert below —
// compresses, tries Firebase Storage (storeImage falls back to inline
// base64 on any failure), drops the <img> in at `range`, and moves the
// cursor onto its own line right after it (same as Alt+Enter) instead of
// leaving it crammed inline with whatever text comes next.
async function insertImageAtRange(range,i,blob){
  try{
    const compressed=await compressImageBlob(blob,900,0.7);
    const src=await storeImage(compressed);
    const img=document.createElement('img');
    img.className='nv-img';
    img.src=src;
    img.alt='pasted image';

    const sel=window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    insertBreakAtCursor();

    const el=document.querySelector(`.item-ta[data-i="${i}"]`);
    if(el) onInput(el,i);

    if(src.startsWith('data:')){
      const sizeKB=Math.round(src.length/1024);
      toast(`🖼️ Image added (${sizeKB}KB)`);
      const totalKB=Math.round(JSON.stringify(D).length/1024);
      if(totalKB>850) toast(`⚠️ Vault is ${totalKB}KB — approaching the 1MB cloud sync limit`);
    }else{
      toast('🖼️ Image added');
    }
  }catch(err){
    console.error('Image insert failed', err);
    toast('⚠️ Failed to process image');
  }
}

async function onPaste(e,i){
  const cd=e.clipboardData;
  if(!cd) return;
  pushUndoSnapshot(false);
  let imgItem=null;
  if(cd.items){ for(const it of cd.items){ if(it.type&&it.type.startsWith('image/')){ imgItem=it; break; } } }

  if(imgItem){
    e.preventDefault();
    const blob=imgItem.getAsFile();
    if(!blob) return;
    const sel=window.getSelection();
    if(!sel.rangeCount) return;
    const range=sel.getRangeAt(0).cloneRange();
    await insertImageAtRange(range,i,blob);
    return;
  }

  // Rich paste: run incoming HTML through the same sanitizeHtml allowlist
  // as everything else instead of stripping it to plain text outright —
  // bold/italic/color/links/lists from Word/Docs/a web page survive if
  // the allowlist permits them; anything it doesn't (fonts, layout,
  // scripts) still gets stripped exactly like plain-text paste always did.
  e.preventDefault();
  const html=cd.getData('text/html');
  const el=document.querySelector(`.item-ta[data-i="${i}"]`);
  if(html && el){
    const clean=sanitizeHtml(normalizeRichPasteHtml(html));
    insertHtmlAtCursor(clean);
    onInput(el,i);
    return;
  }
  const text=cd.getData('text/plain');
  if(!text) return;
  insertTextAtCursor(text);
  if(el) onInput(el,i);
}

// ── IMAGE INSERT (file picker / camera) ─────────────────────────────
// Paste-an-image already covers desktop clipboard paste; Android has no
// equivalent "paste an image" gesture from the gallery, so this is the
// only path to inserting one there. A plain <input type=file accept=
// image/*> already gives a "Camera vs Gallery" chooser on Android/iOS —
// no separate camera button needed. Opening the native picker moves focus
// off the contenteditable the same way the native color picker does, so
// the caret position is saved first and restored once a file comes back.
let savedImgRange=null, savedImgEditorIdx=-1;
function openImageFilePicker(){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const sel=window.getSelection();
  if(!sel.rangeCount){ toast('⚠️ Tap into a note first'); return; }
  const range=sel.getRangeAt(0);
  const startEl=(range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement);
  const editorEl=startEl&&startEl.closest('.item-ta');
  if(!editorEl){ toast('⚠️ Tap into a note first'); return; }
  savedImgRange=range.cloneRange();
  savedImgEditorIdx=parseInt(editorEl.dataset.i,10);
  document.getElementById('img-file-inp').click();
}
window.openImageFilePicker=openImageFilePicker;

async function handleImageFileInsert(e){
  const file=e.target.files[0];
  e.target.value='';
  if(!file || !savedImgRange) { savedImgRange=null; return; }
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)){ savedImgRange=null; return; }
  const editorEl=document.querySelector(`.item-ta[data-i="${savedImgEditorIdx}"]`);
  if(!editorEl){ savedImgRange=null; return; }
  pushUndoSnapshot(false);
  await insertImageAtRange(savedImgRange,savedImgEditorIdx,file);
  savedImgRange=null;
}
window.handleImageFileInsert=handleImageFileInsert;

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
// it.fcCodeSide ('q'|'a') marks a flashcard whose question OR answer is a
// live code block — created by promoting a standalone /xml /lin /sql block
// into a flashcard (convertCodeBlockToFlashcard, always fcCodeSide='q';
// 'a' only exists on data from an earlier app version's now-removed
// per-side typing trigger, still rendered/reviewed correctly here). Either
// way it.content then holds ONLY that side's raw code (never a "Q>>A"
// string), so it's a flashcard by this field alone, independent of whatever
// FC_SEP_RE finds in it.content.
// This matters concretely: shell content routinely contains a literal ">>"
// (the append-redirect operator, e.g. `echo x >> file.txt`) which must
// never be mistaken for the Q/A separator once a side is a code block.
const isFC=it=>FC_SEP_RE.test(it.content)||!!it.fcCodeSide;
const isDue=it=>it.srs&&it.srs.dueDate<=today();
const parseFC=c=>{
  const m=c.match(FC_SEP_RE);
  if(!m) return {q:c.trim(),a:''};
  return {q:c.slice(0,m.index).trim(),a:c.slice(m.index+m[0].length).trim()};
};
// Item-aware variant — the one every renderer should call instead of
// parseFC(it.content) directly, since a code-side flashcard's content is
// raw code (never "Q>>A" text) and needs its OTHER side pulled from
// it.fcOtherText instead. Also reports which of q/a is rich text (the
// plain side, already-sanitized HTML) vs raw code (never sanitized, always
// shown via the same esc()-first path as everywhere else code content
// appears) — a single it.richText flag can't describe a card with one rich
// side and one raw-code side.
// qBlockType/aBlockType (undefined unless that side is a live code block)
// let callers (Review's renderRv, fcColorSplitHtml) treat "which side is
// code" uniformly regardless of which one it.fcCodeSide names — a card can
// have EITHER side, or BOTH, be code (see it.fcOtherBlockType, set when the
// non-fcCodeSide side has also been converted via onFcOtherSideInput).
function parseFCItem(it){
  if(it.fcCodeSide==='a') return {q:it.fcOtherText||'',a:it.content||'',qRichText:!it.fcOtherBlockType,aRichText:false,qBlockType:it.fcOtherBlockType||null,aBlockType:it.blockType};
  if(it.fcCodeSide==='q') return {q:it.content||'',a:it.fcOtherText||'',qRichText:false,aRichText:!it.fcOtherBlockType,qBlockType:it.blockType,aBlockType:it.fcOtherBlockType||null};
  const {q,a}=parseFC(it.content);
  return {q,a,qRichText:it.richText,aRichText:it.richText,qBlockType:null,aBlockType:null};
}
window.parseFCItem=parseFCItem;
// Question/answer split shown for a flashcard item once it's not the one
// being edited (see onItemBlur) — colors the two halves differently so
// they read apart at a glance, same idea as Review's rv-q/rv-a but live in
// the outline. Only used while unfocused; editing always shows the plain
// `Q >> A` text as one blob (see onFocus) so typing across the `>>` isn't
// fighting extra <span> wrappers.
// hideQ (it.hideQuestion, only honored while read-only — see renderEditor)
// swaps the ENTIRE card (question and answer both) for a plain "hidden"
// placeholder — the card still quizzes normally in Review (a completely
// separate code path, rvCards/renderRv, that never touches this function),
// and edit mode always passes hideQ=false so both sides stay visible/
// editable there regardless.
function fcColorSplitHtml(it,hideQ){
  if(hideQ) return '<span class="nv-q-hidden">🔒 Hidden</span>';
  const {q,a,qRichText,aRichText}=parseFCItem(it);
  const qHtml=toDisplayHtml(q,qRichText);
  const aHtml=a?toDisplayHtml(a,aRichText):'';
  return `<span class="nv-q-live">${qHtml}</span>${aHtml?' <span class="nv-a-live">'+aHtml+'</span>':''}`;
}

// Toggle button (renderEditor's per-item map) — left of the bullet, only
// shown on flashcard items, default off. Structural change (own undo
// boundary, full re-render), same as convertItemToFlashcard.
function toggleHideQuestion(i){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  updItems(getDoc().items.map((it,idx)=>idx===i?{...it,hideQuestion:!it.hideQuestion}:it),true,i);
}
window.toggleHideQuestion=toggleHideQuestion;

let D, curFolder=null, curDoc, focIdx=-1, rvCards=[], rvIdx=0, rvShowAns=false, importPending=null, mergeMode='merge', contextFileId=null, homeFolderFilter='', folderFileFilter='', rvTestMode=false, rvDone=false;
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
    badges: [],
    gardenStage: 0,
    lastGoalCelebrationDate: null,
    lastBackupDate: null,
    dailyActivity: {},
    lastNoDueSoundDate: null,
    lastStreakSoundDate: null,
    soundEnabled: true,
    dailyPerfectCount: {},
    dailyStudySeconds: {},
    dailyReadingSeconds: {}
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
    if(typeof D.gardenStage !== 'number') D.gardenStage = 0;
    if(D.lastGoalCelebrationDate === undefined) D.lastGoalCelebrationDate = null;
    if(D.lastBackupDate === undefined) D.lastBackupDate = null;
    if(D.todayXpDate !== today()){ D.todayXp = 0; D.todayXpDate = today(); }
    D.folders.forEach(f=>{ if(typeof f.reviewCount !== 'number') f.reviewCount = 0; });
    // First time this field appears on an existing account: seed it from the
    // tracker's existing date list (count=1/day) so returning users see their
    // real streak history in the Analysis heatmap immediately instead of a
    // blank grid — a one-time backfill, never repeated once dailyActivity
    // exists (even as {}), since D.tracker itself isn't per-count data.
    if(D.dailyActivity === undefined || D.dailyActivity === null){
      D.dailyActivity = {};
      (D.tracker||[]).forEach(d=>{ D.dailyActivity[d] = 1; });
    } else if(typeof D.dailyActivity !== 'object'){
      D.dailyActivity = {};
    }
    if(D.lastNoDueSoundDate === undefined) D.lastNoDueSoundDate = null;
    if(D.lastStreakSoundDate === undefined) D.lastStreakSoundDate = null;
    if(typeof D.soundEnabled !== 'boolean') D.soundEnabled = true;
    // Three more Analysis heatmaps, same size-bounded per-date-map pattern
    // as dailyActivity above — none of these can be backfilled from history
    // that was never recorded, so existing accounts start these three at
    // {} and only accumulate from here on.
    if(!D.dailyPerfectCount || typeof D.dailyPerfectCount !== 'object') D.dailyPerfectCount = {};
    if(!D.dailyStudySeconds || typeof D.dailyStudySeconds !== 'object') D.dailyStudySeconds = {};
    if(!D.dailyReadingSeconds || typeof D.dailyReadingSeconds !== 'object') D.dailyReadingSeconds = {};
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
  if (document.getElementById('s-review').classList.contains('active') && rvCards.length > 0 && !rvDone) {
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
  // Ctrl/Cmd+Z / Ctrl/Cmd+Y (or +Shift+Z) — undo/redo, editor screen only.
  // Always preventDefault so the browser's native contenteditable undo (see
  // the comment above the undo/redo stack in app-core.js) never fires
  // alongside our own and produces a confusing double-undo.
  // Skipped entirely while focus is inside a CodeMirror XML block (.cm-editor)
  // — CodeMirror has its own undo/redo history (js/xml-block.js's
  // historyKeymap), and without this guard BOTH it and the app's own
  // undoEdit()/redoEdit() would fire off the same keypress (the keydown
  // reaches CodeMirror's own element handler first, then still bubbles up
  // to this window-level listener).
  if ((e.ctrlKey || e.metaKey) && document.getElementById('s-editor').classList.contains('active') && !(e.target && e.target.closest && e.target.closest('.cm-editor'))) {
    const edDoc = getDoc();
    if (!edDoc || !isEditingBlocked(edDoc)) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoEdit(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redoEdit(); }
    }
  }
  // Esc closes whichever popup/overlay is currently open, anywhere in the app.
  // With nothing open, Esc from the file editor backs out to the folder view.
  // Skipped for that last "back out of the editor" case while focus is
  // inside a CodeMirror block (.cm-editor) — CodeMirror uses Escape itself
  // (closing its search panel, dismissing an open completion list), and
  // without this guard Escape would ALSO immediately leave the whole editor
  // screen out from under whatever CodeMirror was just doing with it. An
  // open app overlay still closes normally either way.
  if (e.key === 'Escape') {
    const open = document.querySelector('.overlay.open[data-close]');
    if (open) {
      e.preventDefault();
      const fn = window[open.dataset.close];
      if (typeof fn === 'function') fn();
    } else if (document.getElementById('s-editor').classList.contains('active') && !(e.target && e.target.closest && e.target.closest('.cm-editor'))) {
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

// Self-toggled "Document Mode" reuses the exact same read-only rendering
// path renderEditor() already has for shared/read-only folders (disables
// contenteditable, shows a banner) — see the sharedReadOnly/readOnly split
// in renderEditor(). #ftoolbar is a separate persistent element outside
// #ed-content, though, so it doesn't get swept up by that re-render — it
// has to be hidden explicitly (hideFT() also clears focIdx, so a stale
// focus index can't be used by the toolbar's own buttons afterward).
// Document Mode: continuous, read-only, flashcard markers hidden (see
// renderEditor()'s docModeOn branch).
let docModeOn=false;
// Timestamp set by openEditor(), consumed and cleared by showTab() the
// moment the editor screen is actually left — feeds the reading-time
// heatmap (Analysis tab, js/daily-tracker.js's logReadingTime).
let editorOpenedAt=null;
function toggleDocumentMode(){
  docModeOn=!docModeOn;
  if(docModeOn) hideFT();
  renderEditor();
}
window.toggleDocumentMode=toggleDocumentMode;

function showTab(tab){
  // Leaving the editor (any way — click, Escape, back button) should never
  // leave the floating image-resize handles/toolbar stuck on screen.
  if(tab!=='editor' && window.deselectImage) deselectImage();
  // Leaving the editor screen destroys any live XML CodeMirror instances
  // (js/xml-block.js) rather than leaving them detached-but-alive in memory
  // for the rest of the session — re-entering any document with XML blocks
  // afterward just mounts fresh ones.
  if(tab!=='editor' && window.destroyAllXmlBlocks) destroyAllXmlBlocks();
  // Reading-time heatmap (Analysis tab) — logs the open-to-close span the
  // moment the editor is actually left, using the timestamp openEditor()
  // recorded when it was opened.
  if(tab!=='editor' && editorOpenedAt){
    if(window.logReadingTime) logReadingTime(editorOpenedAt);
    editorOpenedAt=null;
  }
  ['home','editor','review','search','analysis','sync'].forEach(s=>document.getElementById('s-'+s).classList.remove('active'));
  ['home','search','review','analysis','sync'].forEach(s=>{const b=document.getElementById('bn-'+s);if(b)b.classList.remove('active');});
  document.getElementById('s-'+tab).classList.add('active');
  const b=document.getElementById('bn-'+tab);if(b)b.classList.add('active');
}
function switchTab(tab){
  hideFT();
  if(tab==='home')renderHome();
  if(tab==='search')setTimeout(()=>document.getElementById('srch-inp').focus(),150);
  if(tab==='analysis'){ if(window.renderAnalysisScreen) renderAnalysisScreen(); }
  if(tab==='sync'){
    if(window.renderProfileSection)renderProfileSection();
    if(window.renderSyncGrowthSection)renderSyncGrowthSection();
    if(window.renderNotificationSettings)renderNotificationSettings();
    if(window.renderSoundSettings)renderSoundSettings();
    if(window.renderAppLockStatus)renderAppLockStatus();
    if(window.runDailyBackup)runDailyBackup();
    if(window.renderBackupList)renderBackupList();
    renderAllTodosStatus();
    renderAllTipsStatus();
  }
  showTab(tab);
}

function openFolder(fId) { curFolder = fId; folderFileFilter=''; renderHome(); }
function closeFolder() { curFolder = null; renderHome(); }
// Opening an existing file lands in Document Mode by default (startEditing
// omitted/false); creating a brand-new file passes startEditing=true so you
// land straight in edit mode instead of immediately toggling out of
// Document Mode on an empty file.
// Undo/redo history is per-document (see curUndoStack/curRedoStack) and
// deliberately NOT reset here — leaving this doc and coming back to it
// later in the same session keeps its history intact.
function openEditor(id,startEditing){curDoc=id;focIdx=-1;docModeOn=!startEditing;editorOpenedAt=Date.now();renderEditor();showTab('editor');}
function goHome(){hideFT();renderHome();showTab('home');}
function exitReview(){renderHome();showTab('home');}
function reviewTab(){
  const cards=D.documents.flatMap(d=>d.items.filter(i=>isDue(i)&&isFC(i)).map(i=>({...i,_d:d.id})));
  if(!cards.length){toast('🎉 No cards due right now!');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=false;rvDone=false;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}

// ── TEST MODE ────────────────────────────────────────────────────
// Same review UI, but rate() skips SM-2 entirely — no srs/dueDate change,
// no perfect-streak counting, no tracker/streak logging. Pure practice,
// against ALL flashcards in the folder/file (not just ones due today).
function testFolder(folderId){
  const docIds=new Set(D.documents.filter(d=>d.folderId===folderId).map(d=>d.id));
  const cards=D.documents.filter(d=>docIds.has(d.id)).flatMap(d=>d.items.filter(isFC).map(i=>({...i,_d:d.id})));
  if(!cards.length){toast('⚠️ No flashcards in this folder');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=true;rvDone=false;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}
window.testFolder=testFolder;

function testDoc(docId){
  const doc=D.documents.find(d=>d.id===docId);
  if(!doc) return;
  const cards=doc.items.filter(isFC).map(i=>({...i,_d:docId}));
  if(!cards.length){toast('⚠️ No flashcards in this file');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=true;rvDone=false;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
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
  else{
    cta.style.display='none';badge.style.display='none';
    // Happy "ta-da" the first time Home renders with nothing due on a given
    // day — guarded so it fires once/day, not on every re-render (renderHome
    // runs after every rating, tab switch, etc).
    if(D.lastNoDueSoundDate!==today()){
      D.lastNoDueSoundDate=today();
      saveLS();
      if(window.playNoDueChime) playNoDueChime();
    }
  }

  const streak=window.currentStreak?currentStreak():0;
  document.querySelectorAll('.hdr-streak-badge').forEach(b=>{
    b.style.display=streak>0?'flex':'none';
    const n=b.querySelector('.hdr-streak-num'); if(n) n.textContent=streak;
  });
  document.querySelectorAll('.hdr-perfect-badge').forEach(b=>{
    b.style.display=(D.perfectStreak>0)?'flex':'none';
    const n=b.querySelector('.hdr-perfect-num'); if(n) n.textContent=D.perfectStreak;
  });
  renderXpRing();
  if(window.renderGrowthSection) renderGrowthSection();
  if(window.renderSyncGrowthSection) renderSyncGrowthSection();
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
  const goal=D.dailyGoal||30;
  const have=D.todayXp||0;
  const pct=Math.max(0,Math.min(1,have/goal));
  document.querySelectorAll('.hdr-xp-ring').forEach(ring=>{
    const fg=ring.querySelector('.xp-ring-fg');
    const lbl=ring.querySelector('.xp-ring-label');
    if(!fg) return;
    fg.style.strokeDashoffset=String(XP_RING_CIRC*(1-pct));
    ring.classList.toggle('xp-ring-complete', have>=goal);
    ring.title=`${have} / ${goal} XP today`;
    if(lbl) lbl.textContent=have>=goal?'✓':String(have);
  });
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
  // Every screen carries its own copy of the streak badge now — pop all of
  // them together since they always show the same number in sync.
  document.querySelectorAll('.hdr-streak-badge').forEach(badge=>{
    // Restart the animation even on rapid repeat taps — removing the class
    // and forcing a reflow (offsetWidth read) before re-adding it is the
    // standard trick for replaying a CSS animation on the same element.
    badge.classList.remove('streak-pop');
    void badge.offsetWidth;
    badge.classList.add('streak-pop');
  });
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

// Keyboard Shortcuts / Search Syntax on the Sync tab (.wf-guide) — both
// start collapsed (see index.html) since together they're 22 lines of
// reference text nobody needs open by default; this just toggles it back.
function toggleWfGuide(id){
  const el=document.getElementById(id);
  if(!el) return;
  const collapsed=el.classList.toggle('collapsed');
  const btn=el.querySelector('.wf-toggle');
  if(btn) btn.textContent=collapsed?'▸':'▾';
}
window.toggleWfGuide=toggleWfGuide;

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
// Shared folder read-only or self-toggled Document Mode block editing the
// same way — one place to check both.
function isEditingBlocked(doc){
  return isDocReadOnly(doc) || docModeOn;
}

// ── UNDO / REDO ──────────────────────────────────────────────────
// Every structural edit (new item, indent/outdent, delete) goes through
// updItems() -> renderEditor(), which replaces the entire #ed-content
// innerHTML and destroys every .item-ta node — so the browser's native
// per-element contenteditable undo history gets wiped on essentially every
// Enter press. A small data-level snapshot stack sidesteps that instead of
// rewriting the editor to patch the DOM incrementally.
//
// Keyed by docId (not one flat stack) so leaving a document and coming
// back to it later in the same session — without a full app reload —
// still has its undo history; switching to a DIFFERENT document just
// starts using that document's own (separate) stack, nothing to reset.
// This is session-only, same lifetime as everything else here: a page
// reload/app restart clears it, same as before.
let undoStacksByDoc={}, redoStacksByDoc={};
const UNDO_MAX=60, UNDO_COALESCE_MS=1200;
let lastUndoPushAt=0;
function curUndoStack(){ return undoStacksByDoc[curDoc]||(undoStacksByDoc[curDoc]=[]); }
function curRedoStack(){ return redoStacksByDoc[curDoc]||(redoStacksByDoc[curDoc]=[]); }

function snapshotDoc(){
  const doc=getDoc();
  if(!doc) return null;
  return { docId:doc.id, items:JSON.parse(JSON.stringify(doc.items)) };
}
// coalesce=true groups rapid same-item typing into one undo step (used by
// onInput); coalesce=false always opens a fresh boundary (used by every
// structural op — new item, indent/outdent, delete, flashcard toggle,
// highlight, paste) so those are never silently merged into a typing burst.
function pushUndoSnapshot(coalesce){
  const snap=snapshotDoc();
  if(!snap) return;
  const now=Date.now();
  const stack=curUndoStack();
  const top=stack[stack.length-1];
  if(coalesce && top && top.docId===snap.docId && (now-lastUndoPushAt)<UNDO_COALESCE_MS){
    lastUndoPushAt=now;
    return;
  }
  stack.push(snap);
  if(stack.length>UNDO_MAX) stack.shift();
  redoStacksByDoc[curDoc]=[];
  lastUndoPushAt=now;
}
function restoreSnapshot(snap){
  D.documents=D.documents.map(d=>d.id===snap.docId?{...d,items:JSON.parse(JSON.stringify(snap.items)),updatedAt:new Date().toISOString()}:d);
  saveLS();
  if(curDoc===snap.docId) renderEditor();
}
function undoEdit(){
  if(!curDoc) return;
  const stack=curUndoStack();
  if(!stack.length) return;
  const current=snapshotDoc();
  const prev=stack.pop();
  if(current) curRedoStack().push(current);
  restoreSnapshot(prev);
}
window.undoEdit=undoEdit;
function redoEdit(){
  if(!curDoc) return;
  const stack=curRedoStack();
  if(!stack.length) return;
  const current=snapshotDoc();
  const next=stack.pop();
  if(current) curUndoStack().push(current);
  restoreSnapshot(next);
}
window.redoEdit=redoEdit;
// Word count / reading-time — derived straight from items[].content, no
// separate tracking needed. ~200 wpm is the commonly used average silent
// reading speed estimate.
function updateWordCountBar(doc){
  const bar=document.getElementById('ed-stats-bar');
  if(!bar) return;
  const text=doc.items.map(it=>stripTags(it.content)).join(' ');
  const words=(text.match(/\S+/g)||[]).length;
  const minutes=Math.max(1,Math.round(words/200));
  bar.textContent=words?`${words} word${words===1?'':'s'} · ${minutes} min read`:'';
}

function renderEditor(){
  const doc=getDoc();if(!doc)return;
  updateWordCountBar(doc);
  if(window.deselectImage) deselectImage();
  const folder=D.folders.find(f=>f.id===doc.folderId);
  const sharedReadOnly=!!(folder && folder.readOnly);
  const readOnly=sharedReadOnly||docModeOn;
  const lockMsg=sharedReadOnly?'🔒 Edit access denied — this file is shared, read-only':'📄 Document Mode is on — tap the document icon to resume editing';
  const crumb=document.getElementById('ed-folder-crumb');
  if(crumb) crumb.textContent = folder ? folder.name+' \\ ' : '';
  const ti=document.getElementById('ed-title');
  ti.value=doc.title;
  ti.disabled=false;
  ti.readOnly=readOnly;
  ti.oninput=readOnly?null:e=>{D.documents=D.documents.map(d=>d.id===curDoc?{...d,title:e.target.value,updatedAt:new Date().toISOString()}:d);saveLS();};
  ti.onclick=readOnly?()=>toast(lockMsg):null;

  const docBtn=document.getElementById('doc-mode-btn');
  if(docBtn) docBtn.classList.toggle('active',docModeOn);
  // Document Mode is a clean, continuous reading view — same "no editing
  // chrome" rule that already strips flashcard badges/bullets (below) also
  // means the TODO button (a jump-to-edit affordance) has no place here.
  const todoBtn=document.getElementById('ed-todo-btn');
  if(todoBtn) todoBtn.style.display=docModeOn?'none':'';

  const banner=document.getElementById('ed-readonly-banner');
  if(banner){
    banner.style.display=readOnly?'flex':'none';
    if(readOnly){
      if(sharedReadOnly){
        banner.innerHTML=`🔒 Shared by ${esc(folder.sharedFrom?.ownerEmail||'someone')} — read-only. You can Review or Take Test.`;
      }else{
        // Document Mode's own escape hatch, in addition to the header icon
        // — the spec calls for an explicit "Switch to Edit Mode" control
        // whenever changes are needed, not just the toggle button.
        banner.innerHTML=`📄 Document Mode — continuous, read-only view. <button class="banner-edit-btn" onclick="toggleDocumentMode()">Switch to Edit Mode</button>`;
      }
    }
  }

  const el=document.getElementById('ed-content');
  if(!doc.items.length){el.innerHTML='<div style="padding:32px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">The document is empty.<br><br>Tap here or use the + button to start typing.</div>';renderTodoPanel();return;}

  // Document Mode: flatten the outline into flowing paragraphs — no
  // bullets/indent, no flashcard `>>`/due-badge chrome, nothing
  // contenteditable. parseFC() already degrades to {q:content,a:''} when
  // there's no `>>` separator, so this one pass covers flashcard and
  // plain items alike (same helper Review uses, app-core.js parseFC).
  if(docModeOn){
    const paras=doc.items.map(it=>{
      // Code-side flashcard (one half of a "Q >> A" item is a live code
      // block, see it.fcCodeSide above) — the same "only show the
      // answer" rule as any other flashcard applies first, before the
      // generic code-block rendering below: if the code IS the answer, show
      // it (as code); if the code IS the question, the question is the
      // "just clutter" half here and only the plain-text other side shows.
      if(it.fcCodeSide){
        if(it.hideQuestion) return '';
        const {a,aRichText}=parseFCItem(it);
        if(!a || !a.trim()) return '';
        if(it.fcCodeSide==='a'){
          const highlighted=it.blockType==='xml'?highlightEscapedXml(esc(a)):esc(a);
          return `<pre class="doc-mode-xml doc-mode-answer">${highlighted}</pre>`;
        }
        return `<p class="doc-mode-para doc-mode-answer">${toDisplayHtml(a,aRichText)}</p>`;
      }
      // Code blocks (xml/lin/sql): raw, unsanitized text — always via
      // esc(), never innerHTML'd unescaped (same rule as the editor's
      // xml-block-mount branch above). XML gets the tag/attribute regex
      // highlight pass on top of that escaping; SQL/shell render as plain
      // escaped text in the same monospace box — still fully safe, just
      // without XML-specific tag/attribute coloring, which doesn't apply
      // to either language's syntax.
      if(it.blockType==='xml') return it.content.trim()?`<pre class="doc-mode-xml">${highlightEscapedXml(esc(it.content))}</pre>`:'';
      if(it.blockType==='lin'||it.blockType==='sql') return it.content.trim()?`<pre class="doc-mode-xml">${esc(it.content)}</pre>`:'';
      // it.blockType==='tips': identical wrapper to the editor's tip-board
      // (per the "should display in the document and read view as
      // similarly" requirement) around the same sanitized rich-text pipeline.
      if(it.blockType==='tips') return stripTags(it.content).trim()?`<div class="tip-board doc-mode-tip">${toDisplayHtml(it.content,it.richText)}</div>`:'';
      const {q,a}=parseFC(it.content);
      if(!q.trim() && !a.trim()) return '';
      // Flashcard items show only the answer here — Document Mode is a
      // clean reading view, not a quiz, so the question half of a `>>`
      // item is just clutter. Plain items (no `>>`) have no q/a split to
      // begin with, so they still render as-is. A locked card (hideQuestion)
      // is omitted entirely — Document Mode has no per-item chrome to hang a
      // "hidden" placeholder on, unlike a shared read-only folder's outline
      // rows (fcColorSplitHtml, below).
      if(isFC(it)){
        if(it.hideQuestion) return '';
        return a.trim()?`<p class="doc-mode-para doc-mode-answer">${toDisplayHtml(a,it.richText)}</p>`:'';
      }
      return `<p class="doc-mode-para">${toDisplayHtml(q,it.richText)}</p>`;
    }).filter(Boolean).join('');
    el.innerHTML=`<div class="doc-mode-content">${paras||'<div style="padding:32px 16px;text-align:center;font-size:13px;color:var(--t3);font-family:var(--mono)">Nothing to show yet.</div>'}</div>`;
    renderTodoPanel();
    return;
  }

  el.innerHTML=doc.items.map((it,i)=>{
    // A blockType item is never a flashcard for PLAIN-rendering purposes,
    // regardless of what its content happens to contain (raw XML never has
    // `>>`; a tip's rich text could coincidentally contain it — this keeps
    // that from spuriously flashing flashcard chrome on a tip block). A
    // code-SIDE flashcard (it.fcCodeSide) is the one exception: it DOES have
    // blockType set (that's how its code half gets a CodeMirror mount) but
    // is still a real, quizzable flashcard — isCard (badge/due/hide-toggle)
    // tracks that; fc (the plain item-ta rendering path) deliberately does not.
    const fc=!it.blockType&&isFC(it),isCard=isFC(it),due=isCard&&isDue(it);
    const indent=it.level*22;
    let badge='';
    if(isCard){if(due)badge=`<span class="fc-badge fc-due">⚡ due</span>`;else if(it.srs?.repetitions>0)badge=`<span class="fc-badge fc-sched">+${it.srs.interval}d</span>`;else badge=`<span class="fc-badge fc-new">new</span>`;}
    const placeholder=(i===0&&doc.items.length<=1&&!readOnly)?'type a note… Q >> A for flashcard, /xml /lin /sql or /tips for a block':'';
    const handlers=readOnly?`onclick="toast(${JSON.stringify(lockMsg)})"`:`oninput="onInput(this,${i})" onfocus="onFocus(${i},this)" onblur="onItemBlur(event,${i})" onkeydown="onKey(event,${i})" onpaste="onPaste(event,${i})"`;
    // A checklist item swaps the plain outline dot for a real checkbox —
    // distinct from the freeform `//TODO:` text scan (scanTodos), this is
    // an actual checked flag on the item.
    const bulletInner=it.checklist
      ?`<input type="checkbox" class="item-check" ${it.checked?'checked':''} ${readOnly?'disabled':''} onclick="toggleItemChecked(event,${i})">`
      :`<div class="bdot${it.level>0?' child':''}"></div>`;
    // Drag handle lives on the bullet, not the contenteditable itself —
    // dragging from inside a contenteditable region drags the selected
    // TEXT, not the row. Desktop-only: HTML5 drag-and-drop has no touch
    // equivalent, so this doesn't do anything on a phone yet.
    const dragAttrs=readOnly?'':`draggable="true" ondragstart="onItemDragStart(event,${i})" ondragover="onItemDragOver(event,${i})" ondrop="onItemDrop(event,${i})" ondragend="onItemDragEnd(event)"`;
    // A standalone code block (created via the toolbar's 🧩 Code ▾ dropdown
    // — tbCodeBlock/convertItemToBlock) has no `>>` text to split, so it
    // can't go through convertItemToFlashcard's "append >> " trick. Instead
    // this wires it straight to fcCodeSide/fcOtherText, making the existing
    // code the question and leaving a blank answer field to fill in — the
    // only way to lead with a code QUESTION (see convertCodeBlockToFlashcard).
    const isCodeBlock=!!CODE_BLOCK_META[it.blockType];
    const hoverFcBtn=(!readOnly&&!fc&&(!it.blockType||(isCodeBlock&&!it.fcCodeSide)))?`<button type="button" class="item-fc-hover" onclick="${isCodeBlock?'convertCodeBlockToFlashcard':'convertItemToFlashcard'}(${i})" title="Convert to flashcard" tabindex="-1">⚡</button>`:'';

    // it.blockType==='xml': a CodeMirror EditorView is a stateful JS object
    // that can't be serialized into this innerHTML string and reconstructed
    // — render an empty placeholder container here, then a separate pass
    // AFTER this innerHTML assignment (mountXmlBlocks(), js/xml-block.js)
    // walks .xml-block-mount elements and mounts/re-mounts a live editor
    // into each. it.content is raw, unsanitized XML text — it must never be
    // interpolated into this innerHTML string, which is exactly why this
    // branch renders nothing but an empty mount point instead.
    // The 💡 icon is a CSS ::before on .tip-board (base.css), not markup
    // here — anything placed inside this contenteditable div becomes part
    // of el.innerHTML, which onInput() reads straight back into it.content
    // on every keystroke (see onInput's sanitizeHtml(el.innerHTML) call). An
    // icon span living in here would get baked into the stored content and
    // then rendered a second time by this same branch on the next re-render.
    // Plain Enter inside the code editor always means "newline in the
    // code" — there's no way to overload it as "leave the block" without
    // breaking normal code editing, so exiting needs Ctrl/Cmd+Enter from
    // inside the editor itself (js/xml-block.js's continueOutlineAfterBlock).
    // Format (pretty-print) is XML-only — SQL/shell have no equally simple
    // bracket-nesting structure to key an indent pass off of.
    const codeMeta=CODE_BLOCK_META[it.blockType];
    let contentHtml;
    if(codeMeta && it.fcCodeSide){
      // Code-side flashcard: the code mount IS one side (Q or A); the OTHER
      // side is EITHER a small plain contenteditable field (onFcOtherSideInput
      // writes to it.fcOtherText, never it.content) OR, if it.fcOtherBlockType
      // is set, its OWN separate CodeMirror mount too — always rendered in
      // question-then-answer order regardless of which side(s) are code.
      // fcOtherBlockType can no longer be SET by anything in the current UI
      // (its one creation path, convertFcOtherSideToCode, was removed along
      // with the /xml /lin /sql typing-triggers) — this branch stays only to
      // correctly render/review data that already has it from before that
      // removal. hideQ locks the WHOLE card (both sides), not just whichever
      // side happens to be the question — a single placeholder replaces both.
      const hideQ=readOnly&&!!it.hideQuestion;
      let bodyHtml;
      if(hideQ){
        bodyHtml=`<div class="xml-block-locked-q">🔒 Hidden</div>`;
      }else{
        const otherLabel=it.fcCodeSide==='a'?'Q':'A';
        const otherMeta=it.fcOtherBlockType?CODE_BLOCK_META[it.fcOtherBlockType]:null;
        const otherFieldHtml=otherMeta
          ?`<div class="xml-block-fc-side xml-block-fc-side-code">
              <div class="xml-block-toolbar xml-block-toolbar-sub">
                <span class="xml-block-label">${otherMeta.label} · ${otherLabel==='Q'?'Question':'Answer'}</span>
                ${it.fcOtherBlockType==='xml'?`<button type="button" class="xml-block-fmt-btn" onclick="formatXmlBlock(${i},'other')" title="Pretty-print" ${readOnly?'disabled':''}>Format</button>`:''}
              </div>
              <div class="xml-block-mount" data-i="${i}" data-side="other"></div>
            </div>`
          :`<div class="xml-block-fc-side">
              <span class="xml-block-fc-label">${otherLabel}</span>
              <div class="xml-block-fc-text" data-i="${i}" contenteditable="${readOnly?'false':'true'}" ${readOnly?'':`oninput="onFcOtherSideInput(this,${i})"`}
              >${toDisplayHtml(it.fcOtherText||'',true)}</div>
            </div>`;
        const codeAreaHtml=`<div class="xml-block-mount" data-i="${i}" data-side="primary"></div>`;
        bodyHtml=it.fcCodeSide==='q'?codeAreaHtml+otherFieldHtml:otherFieldHtml+codeAreaHtml;
      }
      contentHtml=`<div class="xml-block-wrap" data-i="${i}">
          <div class="xml-block-toolbar">
            <span class="xml-block-label">${codeMeta.label} · Flashcard</span>
            ${it.blockType==='xml'&&!hideQ?`<button type="button" class="xml-block-fmt-btn" onclick="formatXmlBlock(${i},'primary')" title="Pretty-print" ${readOnly?'disabled':''}>Format</button>`:''}
          </div>
          ${bodyHtml}
        </div>`;
    } else if(codeMeta){
      // it.blockType==='xml': a CodeMirror EditorView is a stateful JS object
      // that can't be serialized into this innerHTML string and reconstructed
      // — render an empty placeholder container here, then a separate pass
      // AFTER this innerHTML assignment (mountXmlBlocks(), js/xml-block.js)
      // walks .xml-block-mount elements and mounts/re-mounts a live editor
      // into each. it.content is raw, unsanitized XML text — it must never be
      // interpolated into this innerHTML string, which is exactly why this
      // branch renders nothing but an empty mount point instead.
      // Plain Enter inside the code editor always means "newline in the
      // code" — there's no way to overload it as "leave the block" without
      // breaking normal code editing, so exiting needs Ctrl/Cmd+Enter from
      // inside the editor itself (js/xml-block.js's continueOutlineAfterBlock).
      // Format (pretty-print) is XML-only — SQL/shell have no equally simple
      // bracket-nesting structure to key an indent pass off of.
      contentHtml=`<div class="xml-block-wrap" data-i="${i}">
          <div class="xml-block-toolbar">
            <span class="xml-block-label">${codeMeta.label}</span>
            ${it.blockType==='xml'?`<button type="button" class="xml-block-fmt-btn" onclick="formatXmlBlock(${i},'solo')" title="Pretty-print" ${readOnly?'disabled':''}>Format</button>`:''}
          </div>
          <div class="xml-block-mount" data-i="${i}" data-side="solo"></div>
        </div>`;
    } else {
      // The 💡 icon is a CSS ::before on .tip-board (base.css), not markup
      // here — anything placed inside this contenteditable div becomes part
      // of el.innerHTML, which onInput() reads straight back into it.content
      // on every keystroke (see onInput's sanitizeHtml(el.innerHTML) call).
      // An icon span living in here would get baked into the stored content
      // and then rendered a second time by this same branch on re-render.
      contentHtml=`<div class="item-ta${fc?' fc':''}${it.blockType==='tips'?' tip-board':''}" data-i="${i}" contenteditable="${readOnly?'false':'true'}" data-placeholder="${esc(placeholder)}" ${handlers}
      >${fc?fcColorSplitHtml(it,readOnly&&!!it.hideQuestion):toDisplayHtml(it.content,it.richText)}</div>`;
    }

    // Left-of-bullet toggle, flashcards only (plain OR code-side), default
    // off — flips it.hideQuestion (honored above, only while readOnly, so
    // edit mode always keeps both sides visible/editable regardless of this
    // setting; Review is a fully separate code path/rvCards and always
    // quizzes the real question either way). Hides the WHOLE card — question
    // AND answer — everywhere outside the editor and Review (Document Mode,
    // shared read-only views).
    const hideQToggle=(isCard&&!readOnly)?`<button type="button" class="item-hideq-toggle${it.hideQuestion?' on':''}" onclick="toggleHideQuestion(${i})" title="${it.hideQuestion?'Card hidden outside Review — tap to show it everywhere':'Card visible everywhere — tap to hide it outside Review'}" tabindex="-1">${it.hideQuestion?'🔒':'🔓'}</button>`:'';

    return`<div class="item-row${it.checked?' item-checked':''}" style="padding-left:${12+indent}px" data-i="${i}">
      ${hideQToggle}
      <div class="item-bullet" ${dragAttrs}>${bulletInner}</div>
      ${contentHtml}
      ${hoverFcBtn}
      <div class="fc-bd" data-i="${i}">${badge}</div>
    </div>`;
  }).join('');
  if(window.mountXmlBlocks) mountXmlBlocks();
  renderTodoPanel();
}

function onInput(el,i){
  const doc=getDoc();if(!doc)return;
  pushUndoSnapshot(true);
  const clean=sanitizeHtml(el.innerHTML);
  if(clean!==el.innerHTML){
    const hadFocus=document.activeElement===el;
    el.innerHTML=clean;
    if(hadFocus) placeCursorAtEnd(el);
  }
  // /tips slash-command — an exact plain-text match converts this item into
  // a dedicated tip block, the same lightweight plain-text-match convention
  // the `>>` flashcard trigger already uses. Routed through
  // convertItemToBlock() (-> updItems()) rather than patched in here, so it
  // gets its own undo boundary and a full re-render instead of a
  // half-updated DOM node. Guarded on !blockType so an already-converted tip
  // whose rich text happens to contain the literal string "/tips" can't
  // re-trigger the conversion (a code block never reaches onInput at all —
  // it has no contenteditable/oninput handler once mounted, see
  // renderEditor).
  // /xml, /lin, /sql typing-triggers (both the whole-item and the
  // per-flashcard-side variants) were deliberately removed — those three
  // block types are created only through the toolbar's 🧩 Code ▾ dropdown
  // now (tbCodeBlock -> convertItemToBlock, the same function this /tips
  // path still uses), not by typing the trigger word.
  if(!doc.items[i].blockType){
    const plainText=stripTags(clean).trim();
    if(plainText==='/tips'){
      convertItemToBlock(i,plainText.slice(1));
      return;
    }
  }
  const items=[...doc.items];
  const it={...items[i],content:clean,richText:true};
  if(!it.blockType && FC_SEP_RE.test(clean) && !it.srs){it.srs={repetitions:0,easeFactor:2.5,interval:0,dueDate:today()};toast('⚡ Flashcard created!');}
  items[i]=it;
  D.documents=D.documents.map(d=>d.id===curDoc?{...d,items,updatedAt:new Date().toISOString()}:d);saveLS();
  updateWordCountBar(getDoc());
  const bd=document.querySelector(`.fc-bd[data-i="${i}"]`);
  if(bd){
    const fc=!it.blockType&&isFC(it),due=fc&&isDue(it);
    bd.innerHTML=fc?(due?`<span class="fc-badge fc-due">⚡ due</span>`:(it.srs?.repetitions>0?`<span class="fc-badge fc-sched">+${it.srs.interval}d</span>`:`<span class="fc-badge fc-new">new</span>`)):'';
  }
  el.classList.toggle('fc',!it.blockType&&isFC(it));
  renderTodoPanel();
}
function onFocus(i,el){
  focIdx=i;
  showFT();
  // Switching items invalidates an in-progress typing-format toggle from
  // whatever item it was started in — otherwise the toolbar could keep
  // showing e.g. Bold as "active" after the caret moved somewhere that
  // isn't actually about to receive bold text.
  if(activeTypingWrapper && !(document.contains(activeTypingWrapper) && activeTypingWrapper.closest(`.item-ta[data-i="${i}"]`))){
    activeTypingFormat=null; activeTypingWrapper=null;
  }
  updateFormatToolbarState();
  // Flashcard items show the colored Q/A split (fcColorSplitHtml) while
  // unfocused — swap back to the plain `Q >> A` text the moment editing
  // resumes, so typing across the separator isn't fighting the extra
  // <span> wrappers. Only touch it if it's actually still in split form,
  // so a plain click-to-focus doesn't needlessly reset the caret. Restores
  // an equivalent caret position across that swap (getFcCaretPos/
  // fcPosToRawOffset, above) instead of always jumping to the end — a click
  // into the question used to always land you at the very end (past the
  // answer) once the raw blob came in, so anything inserted next (a table,
  // a link, ...) went to the wrong place.
  const doc=getDoc();
  const it=doc&&doc.items[i];
  if(el && it && isFC(it) && el.querySelector('.nv-q-live,.nv-a-live')){
    const pos=getFcCaretPos(el);
    el.innerHTML=toDisplayHtml(it.content,it.richText);
    if(pos) placeCursorAtCharOffset(el,fcPosToRawOffset(el,pos));
    else placeCursorAtEnd(el);
  }
}
function onItemBlur(e,i){
  const doc=getDoc();if(!doc)return;
  const it=doc.items[i];if(!it)return;
  if(isFC(it)) e.target.innerHTML=fcColorSplitHtml(it);
}

// Listen for flashcard shortcut (Ctrl+Space or Alt+/), highlight shortcut
// (Alt+H), and multi-line insert (Alt+Enter — e.g. stacked terminal commands)
function onKey(e,i){
  const t=e.target;
  const inCell=e.key==='Enter'&&findCurrentCell();

  // Ctrl/Cmd+Enter inside a table cell — the explicit way OUT of the table,
  // back to the outline. Same "leave this special context, continue the
  // outline below" convention the code-block editor already uses for
  // Mod-Enter (js/xml-block.js's continueOutlineAfterBlock) — needed because
  // every OTHER Enter variant inside a cell means "new line in this cell"
  // (below), so without this there'd be no keyboard way to leave a table
  // once you're in its last cell. Checked first so it wins over that branch.
  if(inCell && (e.ctrlKey||e.metaKey)){
    e.preventDefault();
    tbNewAt(i);
    return;
  }
  // Inside a table cell, any OTHER Enter (plain, Shift, or Alt) means "new
  // line in this cell" — never "new outline item below" (plain Enter's
  // meaning everywhere else, see tbNewAt below), which would otherwise yank
  // the cursor out of the table entirely mid-sentence. Explicit
  // insertBreakAtCursor() rather than letting the browser's own Enter
  // handling run: contenteditable's native block-splitting behavior is
  // unreliable specifically inside <td>/<th> (no well-defined "split a table
  // cell in two" semantics), which is why plain Shift+Enter alone didn't
  // reliably insert a line break there before this check existed.
  if(inCell){
    e.preventDefault();
    insertBreakAtCursor();
    onInput(t,i);
    return;
  }
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
  // Tab / Shift+Tab — indent/outdent the current item, same as the toolbar
  // buttons (tbIndent/tbOutdent already handle refocus after re-render).
  if(e.key==='Tab'){
    e.preventDefault();
    if(e.shiftKey) tbOutdent(); else tbIndent();
    return;
  }
  // Inject ` >> ` at cursor with keyboard shortcut — skip if the item is
  // already a flashcard, so repeated presses don't stack duplicate `>>`.
  // Followed immediately by the same line-break insertion Alt+Enter does,
  // so the answer naturally starts on its own line right after — the
  // question is already finished being typed by the time this fires, there's
  // nothing useful left to type on the `>>` line itself. Also a no-op inside
  // a table cell (findCurrentCell) — a flashcard's `>>` split applies to the
  // WHOLE item's content, not to text inside one cell of a table nested
  // inside it, so honoring the shortcut there would just corrupt the cell
  // with a stray ` >> ` rather than doing anything meaningful.
  if ((e.ctrlKey && e.code === 'Space') || (e.altKey && e.key === '/')) {
    if(findCurrentCell()) return;
    e.preventDefault();
    if(t.textContent.includes('>>')){ toast('⚡ Already a flashcard'); return; }
    insertTextAtCursor(' >> ');
    insertBreakAtCursor();
    onInput(t, i);
    return;
  }
  // Ctrl/Cmd+B/I/U — bold/italic/underline, standard convention. Alt+H —
  // highlight. Alt+L — list. All four: with a selection, wraps it
  // immediately; with just a caret, toggles "everything I type now is
  // formatted" (see applyFormat/toggleTypingFormat above).
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.code==='KeyB'){ e.preventDefault(); applyBold(); return; }
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.code==='KeyI'){ e.preventDefault(); applyItalic(); return; }
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.code==='KeyU'){ e.preventDefault(); applyUnderline(); return; }
  if(e.altKey && e.code==='KeyL'){ e.preventDefault(); applyList(); return; }
  if(e.altKey && e.code==='KeyH'){ e.preventDefault(); applyHighlight(); return; }
}

// showFT leaves the color-swatch row (#ftoolbar-colors) alone if it's the
// one currently open — e.g. selecting new text in another item while
// mid-way through picking a color shouldn't kick you back to the plain
// toolbar (see openColorSwatches/closeColorSwatches below).
function showFT(){
  if(!document.getElementById('ftoolbar-colors').classList.contains('on')){
    document.getElementById('ftoolbar').classList.add('on');
  }
}
function hideFT(){
  document.getElementById('ftoolbar').classList.remove('on');
  document.getElementById('ftoolbar-colors').classList.remove('on');
  focIdx=-1;
}

// ── TEXT / BACKGROUND COLOR ─────────────────────────────────────────
// A second toolbar row (#ftoolbar-colors) swapped in for the main one —
// see showFT/hideFT above — rather than a popover, so there's no viewport-
// clamped positioning logic needed for a small screen. Presets apply
// straight from onmousedown-guarded swatch buttons (selection stays live,
// same trick the format buttons already use); the custom picker below
// saves/restores the Range explicitly since a native <input type=color>
// can take focus in a way a plain button click doesn't.
let colorPickerMode='color';
function openColorSwatches(mode){
  const sel=window.getSelection();
  if(!sel.rangeCount||sel.isCollapsed){ toast('⚠️ Select text first'); return; }
  colorPickerMode=mode;
  document.getElementById('ftoolbar').classList.remove('on');
  document.getElementById('ftoolbar-colors').classList.add('on');
}
window.openColorSwatches=openColorSwatches;
function closeColorSwatches(){
  document.getElementById('ftoolbar-colors').classList.remove('on');
  document.getElementById('ftoolbar').classList.add('on');
}
window.closeColorSwatches=closeColorSwatches;

function applySwatchColor(color){
  if(colorPickerMode==='background-color') wrapSelectionWith('span',el=>{ el.style.backgroundColor=color; });
  else wrapSelectionWith('span',el=>{ el.style.color=color; });
}
window.applySwatchColor=applySwatchColor;

let savedColorRange=null;
function openCustomColorPicker(){
  const sel=window.getSelection();
  savedColorRange=sel.rangeCount?sel.getRangeAt(0).cloneRange():null;
  document.getElementById('custom-color-inp').click();
}
window.openCustomColorPicker=openCustomColorPicker;

function applyCustomColor(color){
  if(savedColorRange){
    const sel=window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedColorRange);
  }
  applySwatchColor(color);
}
window.applyCustomColor=applyCustomColor;

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

// ── DRAG-TO-REORDER ──────────────────────────────────────────────
// Desktop-only for now: plain HTML5 drag-and-drop (dragstart/dragover/
// drop) has no touch equivalent, so this doesn't do anything on a phone —
// a real mobile version needs a separate touch-based long-press-and-drag
// implementation. The handle lives on .item-bullet (see renderEditor),
// not the contenteditable itself, so dragging never fights with dragging
// selected text out of the note.
let dragSrcIdx=-1;
function onItemDragStart(e,i){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)){ e.preventDefault(); return; }
  dragSrcIdx=i;
  e.dataTransfer.effectAllowed='move';
  // Firefox in particular won't start a drag at all without data set here.
  e.dataTransfer.setData('text/plain','');
}
window.onItemDragStart=onItemDragStart;
function onItemDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
}
window.onItemDragOver=onItemDragOver;
function onItemDrop(e,i){
  e.preventDefault();
  const doc=getDoc();
  if(!doc || dragSrcIdx<0 || dragSrcIdx===i || isEditingBlocked(doc)){ dragSrcIdx=-1; return; }
  const items=[...doc.items];
  const [moved]=items.splice(dragSrcIdx,1);
  const insertAt=dragSrcIdx<i?i-1:i;
  items.splice(insertAt,0,moved);
  updItems(items,true,insertAt);
  dragSrcIdx=-1;
}
window.onItemDrop=onItemDrop;
function onItemDragEnd(){ dragSrcIdx=-1; }
window.onItemDragEnd=onItemDragEnd;
function tbCard(){
  if(focIdx<0)return;
  convertItemToFlashcard(focIdx);
}
// Toolbar's "🧩 Code ▾" dropdown (index.html #code-menu-ov) — same
// "focused item -> convertItemToBlock" wiring tbCard uses for
// convertItemToFlashcard, just parameterized over which language, so the
// three menu items (XML/Shell/SQL) can share one function instead of three.
// Equivalent to typing the /xml, /lin, or /sql trigger directly (onInput,
// below) — this is just the toolbar/mouse path to the same conversion.
function tbCodeBlock(type){
  if(focIdx<0)return;
  convertItemToBlock(focIdx,type);
}
window.tbCodeBlock=tbCodeBlock;
function closeCodeMenu(){ closeAnchoredMenu('code-menu-ov'); }
window.closeCodeMenu=closeCodeMenu;
// Same conversion tbCard's toolbar button does, just parameterized so the
// lightweight per-item ⚡ hover button (item-fc-hover, rendered next to
// any non-flashcard item) can convert whichever item it's attached to
// without first requiring that item to be focused.
function convertItemToFlashcard(i){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  updItems(getDoc().items.map((it,idx)=>{
    if(idx!==i)return it;
    const content=FC_SEP_RE.test(it.content)?it.content:it.content+(it.content.trim()?'  >>  ':' >>  ');
    return{...it,content,srs:it.srs||{repetitions:0,easeFactor:2.5,interval:0,dueDate:today()}};
  }),true,i);
  toast('⚡ Flashcard created!');
}
window.convertItemToFlashcard=convertItemToFlashcard;

// Same idea as convertItemToFlashcard, but for a standalone code block
// (blockType xml/lin/sql, no fcCodeSide yet — created via the toolbar's
// 🧩 Code ▾ dropdown, tbCodeBlock/convertItemToBlock). A code block's
// content is raw code, not FC_SEP_RE-splittable text, so there's no `>>`
// to append — instead this wires it straight into the code-side-flashcard
// shape (fcCodeSide/fcOtherText): the existing code becomes the QUESTION,
// with a blank answer field left to fill in via the small text side (see
// renderEditor's fcCodeSide branch). The only remaining way to create a
// code-side flashcard now that the /xml /lin /sql typing-triggers are gone
// — always makes the code the QUESTION (fcCodeSide:'q' below); a code
// ANSWER only exists on data from before that removal.
function convertCodeBlockToFlashcard(i){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  updItems(getDoc().items.map((it,idx)=>{
    if(idx!==i || !CODE_BLOCK_META[it.blockType] || it.fcCodeSide) return it;
    return{...it,fcCodeSide:'q',fcOtherText:it.fcOtherText||'',srs:it.srs||{repetitions:0,easeFactor:2.5,interval:0,dueDate:today()}};
  }),true,i,'other');
  toast('⚡ Flashcard created! Fill in the answer.');
}
window.convertCodeBlockToFlashcard=convertCodeBlockToFlashcard;

// Direct, non-rerendering write-back for code-block content (xml/lin/sql) —
// called from js/xml-block.js's CodeMirror updateListener on every
// keystroke. Deliberately bypasses updItems() (which would both re-render,
// tearing down every code block's live EditorView on every character typed,
// and push a new non-coalesced undo snapshot per keystroke) — CodeMirror
// keeps its own undo history while focused; the app-level undo stack only
// needs to capture this content at structural-edit boundaries, which
// updItems() already does.
// side: 'other' writes to it.fcOtherText (the non-fcCodeSide side, when it's
// ALSO code — only possible on data from before the /xml /lin /sql
// typing-triggers were removed, kept live here so an existing such mount can
// still be edited); anything else (default, including 'solo'/'primary')
// writes to it.content as before.
function writeXmlBlockContent(itemId,content,side){
  const doc=getDoc();
  if(!doc) return;
  const it=doc.items.find(x=>x.id===itemId);
  if(!it) return;
  if(side==='other'){
    if(!it.fcOtherBlockType || it.fcOtherText===content) return;
    D.documents=D.documents.map(d=>d.id===curDoc?{...d,items:d.items.map(x=>x.id===itemId?{...x,fcOtherText:content}:x),updatedAt:new Date().toISOString()}:d);
    saveLS();
    return;
  }
  if(!CODE_BLOCK_META[it.blockType] || it.content===content) return;
  D.documents=D.documents.map(d=>d.id===curDoc?{...d,items:d.items.map(x=>x.id===itemId?{...x,content}:x),updatedAt:new Date().toISOString()}:d);
  saveLS();
}
window.writeXmlBlockContent=writeXmlBlockContent;

// ── SLASH-BLOCKS: /xml, /lin, /sql, and /tips ───────────────────
// it.blockType: 'xml' | 'lin' | 'sql' | 'tips' | undefined. Code-block
// content (xml/lin/sql) is raw text, never sanitized and never inserted via
// innerHTML anywhere it's displayed read-only (see renderEditor's
// xml-block-mount branch and Document Mode's escaped <pre> branch) —
// always via esc() or CodeMirror's own text APIs, since raw code dropped
// into innerHTML unescaped would be a real injection risk. Tips content
// stays normal sanitized rich text; only the surrounding visual frame
// changes.
const CODE_BLOCK_META={
  xml:{label:'🧩 XML',toast:'🧩 XML block created!'},
  lin:{label:'💻 Shell',toast:'💻 Shell block created!'},
  sql:{label:'🗄️ SQL',toast:'🗄️ SQL block created!'}
};
// A code block (xml/lin/sql) swaps .item-ta for a CodeMirror mount, so the
// default 'text' refocus (which only ever looks for .item-ta) would find
// nothing and silently lose the cursor — 'solo' routes through
// window.focusCodeBlock instead. Tips stay a real .item-ta, so the default
// keeps working for them unchanged.
function convertItemToBlock(i,type){
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  const meta=CODE_BLOCK_META[type];
  updItems(getDoc().items.map((it,idx)=>{
    if(idx!==i)return it;
    if(meta) return{...it,blockType:type,content:'',richText:false};
    return{...it,blockType:'tips',content:''};
  }),true,i,meta?'solo':'text');
  toast(meta?meta.toast:'💡 Tip created!');
}
window.convertItemToBlock=convertItemToBlock;

// Input handler for the plain (non-code) side of a code-side flashcard — a
// small text field alongside the code mount (see renderEditor). Writes to
// it.fcOtherText specifically, mirroring onInput's own pattern but never
// touching it.content (reserved for the code) and never running slash-block
// trigger detection — the /xml /lin /sql typing-triggers were removed
// (those block types are created only via the toolbar's 🧩 Code ▾ dropdown
// now), so this side stays plain quizzable text unconditionally.
function onFcOtherSideInput(el,i){
  const doc=getDoc();if(!doc)return;
  pushUndoSnapshot(true);
  const clean=sanitizeHtml(el.innerHTML);
  if(clean!==el.innerHTML){
    const hadFocus=document.activeElement===el;
    el.innerHTML=clean;
    if(hadFocus) placeCursorAtEnd(el);
  }
  const items=[...doc.items];
  items[i]={...items[i],fcOtherText:clean};
  D.documents=D.documents.map(d=>d.id===curDoc?{...d,items,updatedAt:new Date().toISOString()}:d);
  saveLS();
}
window.onFcOtherSideInput=onFcOtherSideInput;

// ── CHECKLIST ITEMS ──────────────────────────────────────────────
// A real `checked` flag on the item — distinct from the freeform
// `//TODO:` text scan (scanTodos/scanAllTodos) — rendered as an actual
// <input type=checkbox> in place of the outline dot (see renderEditor).
function tbToggleChecklist(){
  if(focIdx<0)return;
  updItems(getDoc().items.map((it,i)=>{
    if(i!==focIdx)return it;
    if(it.checklist){ const {checklist,checked,...rest}=it; return rest; }
    return {...it,checklist:true,checked:false};
  }),true,focIdx);
}
window.tbToggleChecklist=tbToggleChecklist;

// Toggling the checkbox itself shouldn't grab text focus/pop the
// keyboard open (unlike the other toolbar-driven item updates, which
// refocus the item's text afterward) — refocus is deliberately skipped.
function toggleItemChecked(e,i){
  e.stopPropagation();
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  updItems(getDoc().items.map((it,idx)=>idx===i?{...it,checked:!it.checked}:it),true);
}
window.toggleItemChecked=toggleItemChecked;
function tbDel(){
  if(focIdx<0)return;
  const items=getDoc().items;if(items.length<=1){toast("⚠️ Can't delete last item");return;}
  const idx=focIdx,nf=Math.max(0,idx-1);focIdx=-1;
  updItems(items.filter((_,i)=>i!==idx),true,nf);
}
// focusMode: 'text' (default, the refocused item is a normal .item-ta) |
// 'solo'/'primary'/'other' (the refocused item is/has a live CodeMirror
// mount — see js/xml-block.js's window.focusCodeBlock — 'solo' for a
// standalone code block, 'primary' for the it.fcCodeSide side of a code-side
// flashcard, 'other' for the opposite side, code or plain). Needed because a
// block conversion (convertItemToBlock/convertCodeBlockToFlashcard) swaps
// the item's .item-ta right out from under the user mid-click — without
// this, focus/cursor just silently vanishes after conversion.
function updItems(items,rerender=true,refocus=-1,focusMode='text'){
  // The floating toolbar (#ftoolbar) is a separate persistent element, not
  // rebuilt by renderEditor() — it doesn't get read-only-ified the way
  // .item-ta's own handlers do just by re-rendering. Its buttons (tbNew/
  // tbIndent/tbOutdent/tbCard/tbDel/tbCodeBlock, the table-menu actions)
  // all funnel through here, so this is the one place needed to block them
  // for a shared read-only folder or a self-toggled Document Mode.
  const doc=getDoc();
  if(doc && isEditingBlocked(doc)) return;
  // Every structural op (new item, indent/outdent, delete, flashcard toggle)
  // funnels through here, so this is the one place needed to give each of
  // them its own undo boundary (never coalesced with typing).
  pushUndoSnapshot(false);
  D.documents=D.documents.map(d=>d.id===curDoc?{...d,items,updatedAt:new Date().toISOString()}:d);saveLS();
  if(rerender){
    renderEditor();
    if(refocus>=0){
      setTimeout(()=>{
        if(focusMode!=='text'){
          const it=getDoc()?.items[refocus];
          if(it && window.focusCodeBlock) window.focusCodeBlock(it.id,focusMode);
          return;
        }
        // data-i attribute lookup, not positional .item-ta[refocus] indexing —
        // an XML block renders as .xml-block-mount instead of .item-ta (see
        // renderEditor), which would desync position from item index for any
        // doc containing one.
        const ta=document.querySelector(`.item-ta[data-i="${refocus}"]`);
        if(ta) placeCursorAtEnd(ta);
      },40);
    }
  }
}

// ── TODO DRAWER (current file only) ─────────────────────────────
// `//TODO: text` (the `//` and `:` are both optional) anywhere in an item's
// content — items are richText/HTML, so this strips tags to plain text
// before matching.
function stripTags(html){
  const d=document.createElement('div');
  d.innerHTML=html||'';
  return d.textContent||'';
}
function scanTodos(){
  const doc=getDoc();
  if(!doc) return [];
  const out=[];
  doc.items.forEach((it,i)=>{
    const plain=stripTags(it.content).replace(/\s+/g,' ').trim();
    const m=plain.match(/(?:\/\/\s*)?TODO:?\s*(.*)/i);
    if(m) out.push({index:i, text:(m[1]||'').trim()||plain});
  });
  return out;
}
function renderTodoPanel(){
  const list=document.getElementById('todo-panel-list');
  const badge=document.getElementById('todo-badge');
  if(!list) return;
  const todos=getDoc()?scanTodos():[];
  if(badge){
    if(todos.length){ badge.style.display='flex'; badge.textContent=todos.length>9?'9+':String(todos.length); }
    else badge.style.display='none';
  }
  list.innerHTML=todos.length?todos.map(t=>`<div class="notif-item todo-item" onclick="jumpToTodoItem(${t.index})">
      <div class="notif-item-ico">📌</div>
      <div class="notif-item-body"><span>${esc(t.text)}</span></div>
    </div>`).join('')
    :'<div style="padding:30px 14px;text-align:center;font-size:12px;color:var(--t3);font-family:var(--mono)">No TODOs in this file</div>';
}
window.renderTodoPanel=renderTodoPanel;

function openTodoPanel(){
  renderTodoPanel();
  document.getElementById('todo-panel-ov').classList.add('open');
}
window.openTodoPanel=openTodoPanel;
function closeTodoPanel(){
  document.getElementById('todo-panel-ov').classList.remove('open');
}
window.closeTodoPanel=closeTodoPanel;

function jumpToTodoItem(i){
  closeTodoPanel();
  const ta=document.querySelector(`.item-ta[data-i="${i}"]`);
  if(ta){
    ta.scrollIntoView({block:'center',behavior:'smooth'});
    ta.focus();
    placeCursorAtEnd(ta);
    onFocus(i);
  }
}
window.jumpToTodoItem=jumpToTodoItem;

// ── TODO DRAWER (all files, from the Sync screen) ───────────────────
// Same `//TODO:` scan as scanTodos() above, just run across every document
// instead of only the one currently open in the editor.
function scanAllTodos(){
  if(!D) return [];
  const out=[];
  D.documents.forEach(doc=>{
    doc.items.forEach((it,i)=>{
      const plain=stripTags(it.content).replace(/\s+/g,' ').trim();
      const m=plain.match(/(?:\/\/\s*)?TODO:?\s*(.*)/i);
      if(m) out.push({docId:doc.id, docTitle:doc.title, index:i, text:(m[1]||'').trim()||plain});
    });
  });
  return out;
}
window.scanAllTodos=scanAllTodos;

function renderAllTodosStatus(){
  const el=document.getElementById('all-todos-status');
  if(!el) return;
  const count=scanAllTodos().length;
  el.innerHTML=`<div class="sync-row">
    <div class="sync-ico" style="background:#1a140d">📌</div>
    <div class="sync-info"><strong>${count} TODO${count===1?'':'s'} across your files</strong><span>Every <code>TODO:</code> note, in one list</span></div>
    <button class="sync-btn btn-import" onclick="openAllTodosPanel()">View All</button>
  </div>`;
}
window.renderAllTodosStatus=renderAllTodosStatus;

function renderAllTodosPanel(){
  const list=document.getElementById('all-todos-list');
  if(!list) return;
  const todos=scanAllTodos();
  list.innerHTML=todos.length?todos.map(t=>`<div class="notif-item todo-item" onclick="jumpToTodoItemInDoc('${t.docId}',${t.index})">
      <div class="notif-item-ico">📌</div>
      <div class="notif-item-body"><strong>${esc(t.docTitle)}</strong><span>${esc(t.text)}</span></div>
    </div>`).join('')
    :'<div style="padding:30px 14px;text-align:center;font-size:12px;color:var(--t3);font-family:var(--mono)">No TODOs across your files</div>';
}
window.renderAllTodosPanel=renderAllTodosPanel;

function openAllTodosPanel(){
  renderAllTodosPanel();
  document.getElementById('all-todos-ov').classList.add('open');
}
window.openAllTodosPanel=openAllTodosPanel;
function closeAllTodosPanel(){
  document.getElementById('all-todos-ov').classList.remove('open');
}
window.closeAllTodosPanel=closeAllTodosPanel;

function jumpToTodoItemInDoc(docId,i){
  closeAllTodosPanel();
  // Document Mode (openEditor's default, no startEditing arg) flattens the
  // outline into prose paragraphs with no per-item DOM nodes at all — force
  // Edit Mode instead so .item-ta[data-i] actually exists to scroll/focus.
  openEditor(docId,true);
  const ta=document.querySelector(`.item-ta[data-i="${i}"]`);
  if(ta){
    ta.scrollIntoView({block:'center',behavior:'smooth'});
    ta.focus();
    placeCursorAtEnd(ta);
    onFocus(i);
  }
}
window.jumpToTodoItemInDoc=jumpToTodoItemInDoc;

// ── TIPS DRAWER (all files, from the Sync screen) ────────────────────
// Same idea as the all-files TODO drawer above, but collecting /tips blocks
// (it.blockType==='tips') instead of freeform `//TODO:` text.
function scanAllTips(){
  if(!D) return [];
  const out=[];
  D.documents.forEach(doc=>{
    doc.items.forEach((it,i)=>{
      if(it.blockType!=='tips') return;
      const plain=stripTags(it.content).replace(/\s+/g,' ').trim();
      if(!plain) return;
      out.push({docId:doc.id, docTitle:doc.title, index:i, text:plain.length>140?plain.slice(0,140)+'…':plain});
    });
  });
  return out;
}
window.scanAllTips=scanAllTips;

function renderAllTipsStatus(){
  const el=document.getElementById('all-tips-status');
  if(!el) return;
  const count=scanAllTips().length;
  el.innerHTML=`<div class="sync-row">
    <div class="sync-ico" style="background:#1a140d">💡</div>
    <div class="sync-info"><strong>${count} Tip${count===1?'':'s'} across your files</strong><span>Every <code>/tips</code> block, in one list</span></div>
    <button class="sync-btn btn-import" onclick="openAllTipsPanel()">View All</button>
  </div>`;
}
window.renderAllTipsStatus=renderAllTipsStatus;

function renderAllTipsPanel(){
  const list=document.getElementById('all-tips-list');
  if(!list) return;
  const tips=scanAllTips();
  list.innerHTML=tips.length?tips.map(t=>`<div class="notif-item todo-item" onclick="jumpToTipItemInDoc('${t.docId}',${t.index})">
      <div class="notif-item-ico">💡</div>
      <div class="notif-item-body"><strong>${esc(t.docTitle)}</strong><span>${esc(t.text)}</span></div>
    </div>`).join('')
    :'<div style="padding:30px 14px;text-align:center;font-size:12px;color:var(--t3);font-family:var(--mono)">No tips across your files</div>';
}
window.renderAllTipsPanel=renderAllTipsPanel;

function openAllTipsPanel(){
  renderAllTipsPanel();
  document.getElementById('all-tips-ov').classList.add('open');
}
window.openAllTipsPanel=openAllTipsPanel;
function closeAllTipsPanel(){
  document.getElementById('all-tips-ov').classList.remove('open');
}
window.closeAllTipsPanel=closeAllTipsPanel;

function jumpToTipItemInDoc(docId,i){
  closeAllTipsPanel();
  // Force Edit Mode, same reason as jumpToTodoItemInDoc above — Document
  // Mode has no per-item DOM node for a /tips block to scroll/focus into.
  openEditor(docId,true);
  const ta=document.querySelector(`.item-ta[data-i="${i}"]`);
  if(ta){
    ta.scrollIntoView({block:'center',behavior:'smooth'});
    ta.focus();
    placeCursorAtEnd(ta);
    onFocus(i);
  }
}
window.jumpToTipItemInDoc=jumpToTipItemInDoc;

// ── REVIEW ───────────────────────────────────────────────────────
// A code-side card's Q/A box, syntax-highlighted the same way Document
// Mode's read-only XML view already is (highlightEscapedXml, reused as-is —
// see its own comment at the top of this file) instead of the plain escaped
// text Review used to dump into a bare monospace box. lin/sql get the same
// boxed chrome but no highlighter exists for them (same limitation Document
// Mode already accepts) — plain escaped text is still safe, just uncolored.
function renderRvCodeBox(code,blockType){
  const meta=CODE_BLOCK_META[blockType]||{label:''};
  const body=blockType==='xml'?highlightEscapedXml(esc(code||'')):esc(code||'');
  return `<div class="rv-code-box">
      <div class="xml-block-toolbar"><span class="xml-block-label">${meta.label}</span></div>
      <pre class="doc-mode-xml rv-code-pre">${body||'<span class="rv-code-empty">(empty)</span>'}</pre>
    </div>`;
}
function reviewThisDoc(){
  const cards=getDoc().items.filter(i=>isDue(i)&&isFC(i)).map(i=>({...i,_d:curDoc}));
  if(!cards.length){toast('⚠️ No due cards in this file');return;}
  rvCards=cards;rvIdx=0;rvShowAns=false;rvTestMode=false;rvDone=false;rvStats={1:0,2:0,3:0,4:0,5:0,xp:0};rvBusy=false;hideFT();renderRv();showTab('review');
}
function renderRv(dir){
  document.getElementById('rv-ctr').textContent=`${rvIdx+1} / ${rvCards.length}`;
  document.getElementById('rv-prog').style.width=`${(rvIdx/rvCards.length)*100}%`;
  const card=rvCards[rvIdx];
  const {q,a,qRichText,aRichText,qBlockType,aBlockType}=parseFCItem(card);
  const docName=D.documents.find(d=>d.id===card._d)?.title||'';
  const wrapClass=dir==='in'?'rv-wrap rv-slide-in':'rv-wrap fade-in';
  // A code-side card quizzes exactly like any other flashcard — same
  // rvCards/rate()/SRS path — just with whichever side(s) are code
  // (qBlockType/aBlockType, either or both) shown as a syntax-highlighted
  // box instead of normal prose (renderRvCodeBox, above).
  const qHtml=qBlockType?renderRvCodeBox(q,qBlockType):toDisplayHtml(q,qRichText);
  const aHtml=aBlockType?renderRvCodeBox(a,aBlockType):toDisplayHtml(a||'(no answer defined)',aRichText);
  document.getElementById('rv-content').innerHTML=`
  <div class="${wrapClass}">
    <div class="rv-card${rvShowAns?(rvTestMode?' rv-flip-test':' rv-flip'):''}">
      <div class="rv-chip">▶ ${esc(docName)}${rvTestMode?' · <span class="rv-test-badge">TEST MODE</span>':''}</div>
      <div class="rv-q">${qHtml}</div>
      ${!rvShowAns
        ?`<div class="rv-sep"></div><button class="reveal-btn" onclick="revealAns()" title="Shortcut: Spacebar">Show Answer ↓</button>`
        :`<div class="rv-sep"></div><div class="rv-a-lbl">Answer</div><div class="rv-a">${aHtml}</div>`}
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
  if(rvBusy || rvDone) return;
  rvBusy=true;
  const card=rvCards[rvIdx];
  let newBadges=[];
  let newStage=null;
  let goalJustCompleted=false;

  // Test Mode is pure practice — it must never touch the SM-2 schedule,
  // the perfect-streak counter, XP/badges, or the daily-activity tracker.
  if(!rvTestMode){
    const ns=sm2(q,card.srs);
    D.documents=D.documents.map(d=>{
      if(d.id!==card._d)return d;
      return{...d,items:d.items.map(it=>{
        if(it.id!==card.id) return it;
        return{...it,srs:{...ns,lastReviewed:today()}};
      })};
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
    if(window.checkGrowthStage) newStage=window.checkGrowthStage();
    if(window.checkDailyGoalComplete) goalJustCompleted=window.checkDailyGoalComplete();
    if(window.renderXpRing) renderXpRing();
    if(window.renderGrowthSection) renderGrowthSection();
  if(window.renderSyncGrowthSection) renderSyncGrowthSection();
    saveLS();
  }

  rvStats[q]=(rvStats[q]||0)+1;
  // Activity/study-time heatmaps (Analysis tab) — count a rating in BOTH
  // review and test mode, deliberately not test-mode-exempt like everything
  // above: these track "cards reviewed today" and "time spent doing it,"
  // not schedule/XP progress.
  if(window.logDailyActivity) logDailyActivity();
  if(window.logStudyTime) logStudyTime();
  // Perfect-answer-rate heatmap — same both-modes rule, so its denominator
  // (dailyActivity) and numerator (this) always describe the same population.
  if(q===5 && window.logDailyPerfect) logDailyPerfect();

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
      rvDone=true;
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
      // Fire-and-forget (toast + confetti burst + notification, no overlay) —
      // deliberately NOT routed through showVictoryCelebration's blocking
      // overlay+callback below, so it can never race/double-call advance()
      // if a stage-up and a 5th-perfect-in-a-row land on the same card.
      if(!rvTestMode && newStage && window.announceGrowthStage) window.announceGrowthStage(newStage);
      if(!rvTestMode && goalJustCompleted && window.announceGoalComplete) window.announceGoalComplete();
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
  if(window.playMilestoneChime) playMilestoneChime();
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
  const nf={ id: gid(), name: t, createdAt: new Date().toISOString(), favorite: false };
  D.folders.push(nf);
  saveLS(); closeNewFolder(); openFolder(nf.id); toast('📁 Folder created');
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
  D.documents.push(nd);saveLS();closeNewDoc();openEditor(nd.id,true); toast('📄 File created');
}

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
