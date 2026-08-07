// ── CODE BLOCKS (CodeMirror 6) — /xml, /lin, /sql ──────────────────
// CodeMirror 6 via esm.sh, matching firebase-init.js's existing CDN-import
// pattern exactly — no build step, no npm dependency added. The one
// deliberate exception to the rest of the app's "no external libraries"
// convention: hand-building a syntax highlighter/IntelliSense engine from
// scratch would realistically take weeks to reach what a mature editor
// already does reliably. Started as XML-only (hence the filename); /lin
// (shell) and /sql share the same mount/lifecycle/theme infrastructure
// below, each bringing its own CodeMirror language package.
//
// This is a `type="module"` script (see index.html, same as firebase-init.js)
// — module scripts never join the shared global lexical environment that
// app-core.js's classic <script> tags use for `let`/`const` (D, curDoc,
// docModeOn, ...), so this file can only reach the rest of the app through
// functions already exposed on `window` — plain top-level `function`
// declarations in a classic, non-strict script (getDoc, isEditingBlocked,
// toast, saveLS, ...) are automatically `window` properties, unlike `let`/
// `const`, so calling window.getDoc() etc. below is intentional, not a
// workaround for missing exports.
import {EditorState, Compartment} from 'https://esm.sh/@codemirror/state@6';
import {EditorView, keymap, lineNumbers} from 'https://esm.sh/@codemirror/view@6';
import {defaultKeymap, history, historyKeymap, indentWithTab} from 'https://esm.sh/@codemirror/commands@6';
import {searchKeymap} from 'https://esm.sh/@codemirror/search@6';
import {foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, StreamLanguage} from 'https://esm.sh/@codemirror/language@6';
import {autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap} from 'https://esm.sh/@codemirror/autocomplete@6';
import {xml, xmlLanguage, autoCloseTags} from 'https://esm.sh/@codemirror/lang-xml@6';
import {sql, StandardSQL} from 'https://esm.sh/@codemirror/lang-sql@6';
import {shell as shellMode} from 'https://esm.sh/@codemirror/legacy-modes@6/mode/shell';
import {linter, lintGutter, lintKeymap} from 'https://esm.sh/@codemirror/lint@6';
import {tags} from 'https://esm.sh/@lezer/highlight@1';

// A standalone code block (blockType xml/lin/sql, no fcCodeSide) keys by the
// item's bare persistent id -> {view, roCompartment, blockType}. A code-side
// flashcard (it.fcCodeSide set) can have EITHER or BOTH sides be code (see
// app-core.js's it.fcOtherBlockType), so those use a compound key instead:
// `${itemId}:primary` for the it.fcCodeSide-designated side (it.blockType/
// it.content), `${itemId}:other` for the opposite side once IT'S also been
// converted (it.fcOtherBlockType/it.fcOtherText). Bare id, never the
// transient array index — an index would desync from the wrong item the
// moment anything is inserted/deleted above it in the outline (every
// existing item's index shifts on a full renderEditor() rebuild) — id
// doesn't, so "reuse the live instance for an untouched item" (the whole
// point of this map) stays correct across reorders, not just same-position
// re-renders.
const codeViews = new Map();

// ── Theme — built from the app's own CSS custom properties (css/base.css)
// so the editor already matches the app's dark palette instead of shipping
// CodeMirror's own default look. Shared across all three languages.
const codeEditorTheme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--acc2)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--acc2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--acc-glow)' },
  '.cm-gutters': { backgroundColor: 'var(--s2)', color: 'var(--t3)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--s2)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--s3)' },
  '.cm-foldGutter, .cm-lineNumbers': { fontSize: '11px' },
  '.cm-tooltip': { backgroundColor: 'var(--s2)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--acc)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--s2)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--acc-glow)', outline: '1px solid var(--acc)' },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--acc)' }
}, {dark: true});

// One shared HighlightStyle mapped from lezer's generic tag vocabulary — all
// three languages' grammars tag their tokens against this same vocabulary
// (tagName/attributeName for XML; keyword/typeName/operator for SQL;
// keyword/string/comment for shell), so one style covers all of them.
const codeHighlightStyle = HighlightStyle.define([
  {tag: tags.angleBracket, color: 'var(--t2)'},
  {tag: tags.tagName, color: 'var(--acc2)', fontWeight: '600'},
  {tag: tags.attributeName, color: 'var(--green)'},
  {tag: tags.attributeValue, color: 'var(--yellow)'},
  {tag: tags.keyword, color: 'var(--acc2)', fontWeight: '600'},
  {tag: tags.typeName, color: 'var(--green)'},
  {tag: tags.operator, color: 'var(--orange)'},
  {tag: tags.number, color: 'var(--orange)'},
  {tag: tags.string, color: 'var(--yellow)'},
  {tag: tags.comment, color: 'var(--t3)', fontStyle: 'italic'},
  {tag: tags.processingInstruction, color: 'var(--orange)'},
  {tag: tags.meta, color: 'var(--orange)'},
  {tag: tags.variableName, color: 'var(--text)'},
  {tag: tags.content, color: 'var(--text)'},
  {tag: tags.punctuation, color: 'var(--t2)'}
]);

// ── Validation — the browser's own DOMParser detects malformed XML (a
// <parsererror> node appears on failure), wired into @codemirror/lint's
// diagnostic display. DOMParser's error text format isn't standardized
// across browsers; the line-number regex below is a best-effort extraction
// (Chromium/WebView embeds "Line Number N" in the message) — falling back to
// flagging the whole document when no line can be parsed out of it. SQL/shell
// have no equivalent browser-native parser to validate against, so they ship
// without a lint source rather than a fake one.
function xmlLintSource(view){
  const text = view.state.doc.toString();
  if(!text.trim()) return [];
  const parsed = new DOMParser().parseFromString(text, 'application/xml');
  const errorNode = parsed.querySelector('parsererror');
  if(!errorNode) return [];
  const message = (errorNode.textContent || 'Malformed XML').trim();
  const lineMatch = message.match(/line\s*(?:number)?\s*[:\s]*?(\d+)/i);
  let from = 0, to = Math.min(text.length, 1);
  if(lineMatch){
    const lineNum = Math.min(Math.max(1, +lineMatch[1]), view.state.doc.lines);
    const line = view.state.doc.line(lineNum);
    from = line.from;
    to = Math.max(line.to, line.from + 1);
  } else {
    to = text.length || 1;
  }
  return [{from, to: Math.min(to, text.length || 1), severity: 'error', message}];
}

// ── IntelliSense — layered on top of lang-xml's own schema-aware completion
// (added via extra `xmlLanguage.data.of({autocomplete: ...})` entries, not
// `autocompletion({override:...})`, so the built-in one keeps working too).
// SQL gets the same treatment via @codemirror/lang-sql's own
// keywordCompletionSource, wired the same additive way (see StandardSQL
// below) — no XSLT-style custom list needed since the dialect already ships
// its full keyword set.
const XSLT_ELEMENTS = ['xsl:stylesheet','xsl:template','xsl:value-of','xsl:if','xsl:choose','xsl:when',
  'xsl:otherwise','xsl:for-each','xsl:apply-templates','xsl:call-template','xsl:with-param','xsl:param',
  'xsl:variable','xsl:sort','xsl:import','xsl:include','xsl:output','xsl:attribute','xsl:element',
  'xsl:copy-of','xsl:copy','xsl:text','xsl:comment','xsl:key','xsl:number'];

function xsltCompletionSource(context){
  const word = context.matchBefore(/<[\w:-]*/);
  if(!word || (word.from === word.to && !context.explicit)) return null;
  const typed = word.text.replace(/^</, '');
  const options = XSLT_ELEMENTS.filter(e => !typed || e.startsWith(typed)).map(e => ({label: e, type: 'keyword', apply: e}));
  return options.length ? {from: word.from + 1, options} : null;
}

// Tags already typed elsewhere in this same document — "previously used
// tags" suggests correctly without any external schema.
function tagScanCompletionSource(context){
  const word = context.matchBefore(/<[\w:-]*/);
  if(!word || (word.from === word.to && !context.explicit)) return null;
  const typed = word.text.replace(/^</, '');
  const found = new Set();
  const re = /<([a-zA-Z_][\w:.-]*)/g;
  let m; while((m = re.exec(context.state.doc.toString()))) found.add(m[1]);
  const options = [...found].filter(t => !typed || t.startsWith(typed)).map(t => ({label: t, type: 'type', apply: t}));
  return options.length ? {from: word.from + 1, options} : null;
}

// xmlns:prefix="..." declarations found anywhere in the document feed
// prefix completions at the same tag-open position.
function namespaceCompletionSource(context){
  const word = context.matchBefore(/<[\w:-]*/);
  if(!word || (word.from === word.to && !context.explicit)) return null;
  const typed = word.text.replace(/^</, '');
  const found = new Set();
  const re = /xmlns:([\w.-]+)\s*=/g;
  let m; while((m = re.exec(context.state.doc.toString()))) found.add(m[1] + ':');
  const options = [...found].filter(p => !typed || p.startsWith(typed)).map(p => ({label: p, type: 'namespace', apply: p}));
  return options.length ? {from: word.from + 1, options} : null;
}

// ── Pretty-print (on-demand, toolbar button) — XML only: a small
// indent-based formatter, not a full XML parser. CDATA/comment bodies are
// stashed out before re-indenting (their internal `<`/`>` aren't real tag
// boundaries) and restored verbatim afterward. SQL/shell have no equally
// simple bracket-nesting structure to key an indent pass off of, so they
// don't get a Format button rather than shipping a formatter that's really
// just a guess.
function prettyPrintXml(xmlText){
  const PAD = '  ';
  const stashed = [];
  const work = xmlText
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, m => ` ${stashed.push(m) - 1} `)
    .replace(/<!--[\s\S]*?-->/g, m => ` ${stashed.push(m) - 1} `);
  const collapsed = work.replace(/>\s*</g, '><').trim();
  const restore = s => s.replace(/ (\d+) /g, (m, idx) => stashed[+idx]);
  let indent = 0;
  const lines = collapsed.split(/(<[^>]+>)/g).filter(t => t.trim()).map(tokRaw => {
    const stashedWhole = /^ \d+ $/.test(tokRaw);
    const tok = restore(tokRaw);
    let line;
    if(stashedWhole || /^<\?/.test(tok)){ line = PAD.repeat(indent) + tok; }
    else if(/^<\//.test(tok)){ indent = Math.max(0, indent - 1); line = PAD.repeat(indent) + tok; }
    else if(/\/>$/.test(tok.trim())){ line = PAD.repeat(indent) + tok; }
    else if(/^</.test(tok)){ line = PAD.repeat(indent) + tok; indent++; }
    else { line = PAD.repeat(indent) + tok.trim(); }
    return line;
  });
  return lines.join('\n');
}
window.prettyPrintXml = prettyPrintXml; // exposed for the harness/tests, not called directly by the app UI

// side: 'solo' (default) | 'primary' | 'other' — which mount to format, per
// the compound-key scheme codeViews now uses (see above).
window.formatXmlBlock = function(i, side='solo'){
  const doc = window.getDoc();
  if(!doc) return;
  const it = doc.items[i];
  if(!it) return;
  const blockType = side==='other' ? it.fcOtherBlockType : it.blockType;
  if(blockType !== 'xml') return;
  const key = side==='solo' ? it.id : `${it.id}:${side}`;
  const entry = codeViews.get(key);
  if(!entry) return;
  const pretty = prettyPrintXml(entry.view.state.doc.toString());
  entry.view.dispatch({changes: {from: 0, to: entry.view.state.doc.length, insert: pretty}});
  window.toast('🧩 XML formatted');
};

// ── Per-language config — the one place that determines what a given
// blockType actually gets: which CodeMirror language package, which extra
// completion sources (layered onto the language's own, not replacing it),
// and whether it has a lint source at all.
const CODE_BLOCK_TYPES = {
  xml: {
    lang: () => xml(),
    extraExtensions: () => [autoCloseTags],
    languageData: () => xmlLanguage.data,
    extraCompletions: [xsltCompletionSource, tagScanCompletionSource, namespaceCompletionSource],
    lint: xmlLintSource
  },
  sql: {
    lang: () => sql({dialect: StandardSQL, upperCaseKeywords: true}),
    extraExtensions: () => [],
    languageData: () => StandardSQL.language.data,
    extraCompletions: [],
    lint: null
  },
  lin: {
    lang: () => StreamLanguage.define(shellMode),
    extraExtensions: () => [],
    languageData: null,
    extraCompletions: [],
    lint: null
  }
};

// Direct, non-rerendering write-back — called from the updateListener below
// on every keystroke. Deliberately does NOT go through window.updItems()
// (which would both tear down every code block's live EditorView on every
// character typed via a full renderEditor(), and push a new non-coalesced
// undo snapshot per keystroke instead of per structural edit). CodeMirror
// keeps its own undo history while focused; the app-level undo stack only
// needs to capture this content at structural-edit boundaries, which it
// already does as part of each item's normal snapshot.
function writeBackCodeContent(itemId, content, side){
  if(window.writeXmlBlockContent) window.writeXmlBlockContent(itemId, content, side);
}

// Plain Enter always means "newline within this code" — there's no
// keystroke inside a code editor that could safely double as "leave the
// block," so exiting needs its own explicit affordance: Ctrl/Cmd+Enter here.
// Resolves the item's CURRENT index by id (not whatever index was true when
// this editor was created) since structural edits elsewhere can have
// shifted it since then.
function continueOutlineAfterBlock(itemId){
  const doc=window.getDoc();
  if(!doc) return true;
  const idx=doc.items.findIndex(it=>it.id===itemId);
  if(idx>=0 && window.tbNewAt) window.tbNewAt(idx);
  return true;
}
window.continueOutlineAfterBlock=continueOutlineAfterBlock;

// Ctrl+Space — "make this a flashcard" / "go to the other side," bound
// inside every code mount regardless of side. On a standalone code block
// (no it.fcCodeSide yet) this PROMOTES it into a flashcard question (same
// conversion the ⚡ hover button does, app-core.js's
// convertCodeBlockToFlashcard) and focuses the now-visible blank answer
// field below — matches the app's existing plain-item flashcard shortcut
// (onKey, app-core.js: Ctrl+Space/Alt+/ already means "make this a
// flashcard" outside code blocks; this is the same shortcut's meaning
// inside one). On a side that's already part of a flashcard, it just moves
// focus to the other side (its own code mount if that side has ALSO been
// converted, otherwise the plain text field).
function focusOrCreateOtherSide(itemId){
  const doc=window.getDoc();
  if(!doc) return true;
  const idx=doc.items.findIndex(it=>it.id===itemId);
  if(idx<0) return true;
  const it=doc.items[idx];
  if(!it.fcCodeSide){
    if(window.convertCodeBlockToFlashcard) window.convertCodeBlockToFlashcard(idx);
    return true;
  }
  if(window.focusCodeBlock) window.focusCodeBlock(itemId,'other');
  return true;
}

// Exposed for app-core.js's updItems() to call after a slash-trigger
// conversion re-renders the editor — the freshly-created element (a
// CodeMirror mount, or the plain other-side field) needs actual keyboard
// focus, not just to exist in the DOM, or the user's typing flow breaks.
// 'other' tries a live code mount first (both-sides-code case), then falls
// back to the plain field (the far more common single-code-side case).
window.focusCodeBlock = function(itemId, side){
  if(side==='solo'||side==='primary'){
    const entry=codeViews.get(side==='solo'?itemId:`${itemId}:primary`);
    if(entry){ entry.view.focus(); return true; }
    return false;
  }
  const otherEntry=codeViews.get(`${itemId}:other`);
  if(otherEntry){ otherEntry.view.focus(); return true; }
  // Far more common case: the other side is still the plain field, not a
  // code mount — .xml-block-fc-text is keyed by the item's current array
  // INDEX (data-i), not its id, so that has to be resolved first.
  const doc=window.getDoc();
  const idx=doc ? doc.items.findIndex(it=>it.id===itemId) : -1;
  if(idx<0) return false;
  const otherField=document.querySelector(`.xml-block-fc-text[data-i="${idx}"]`);
  if(otherField && window.placeCursorAtEnd){ otherField.focus(); window.placeCursorAtEnd(otherField); return true; }
  return false;
};

// side: 'solo' (standalone code block, default) | 'primary' (the
// it.fcCodeSide-designated side of a flashcard) | 'other' (the opposite
// side, once it's ALSO been converted to code) — threads through to
// writeBackCodeContent's app-core.js call so it writes to the right field,
// and gates the Ctrl-Space binding (only meaningful once a `side` is
// actually resolvable to an item, i.e. always — see focusOrCreateOtherSide).
function buildCodeExtensions(itemId, roCompartment, readOnly, blockType, side='solo'){
  const cfg = CODE_BLOCK_TYPES[blockType] || CODE_BLOCK_TYPES.xml;
  const exts = [
    keymap.of([
      {key:'Mod-Enter', run: () => continueOutlineAfterBlock(itemId)},
      // Same literal shortcut app-core.js's onKey already uses outside code
      // blocks (Ctrl+Space -> "make this a flashcard") — deliberately
      // 'Ctrl-Space', not 'Mod-Space': matches that existing e.ctrlKey-only
      // check exactly, on every platform (an app-wide convention, not this
      // binding's own choice). This DOES shadow @codemirror/autocomplete's
      // own Ctrl-Space "manually re-open completions" binding from
      // completionKeymap below — accepted tradeoff, since this keymap is
      // declared first and CodeMirror checks keymaps in declaration order.
      // Completions still pop up automatically while typing either way;
      // only the manual re-trigger is unreachable.
      // Deferred to a fresh tick: on a standalone block this re-keys the
      // CURRENT item (bare id -> `${id}:primary`), which makes
      // mountXmlBlocks() destroy THIS very view as stale — doing that
      // synchronously, still inside this view's own keymap dispatch, is the
      // kind of self-destruction CodeMirror was never asked to tolerate.
      // Mod-Enter above never hits this: it only ever inserts a new sibling
      // item, so the current item's own view/key is untouched.
      {key:'Ctrl-Space', run: () => { setTimeout(()=>focusOrCreateOtherSide(itemId),0); return true; }}
    ]),
    lineNumbers(),
    history(),
    foldGutter(),
    indentOnInput(),
    closeBrackets(),
    ...cfg.extraExtensions(),
    syntaxHighlighting(codeHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    codeEditorTheme,
    autocompletion(),
    roCompartment.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, indentWithTab, ...historyKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
    cfg.lang()
  ];
  if(cfg.lint) exts.push(lintGutter(), linter(cfg.lint, {delay: 400}));
  if(cfg.languageData){
    const data = cfg.languageData();
    cfg.extraCompletions.forEach(src => exts.push(data.of({autocomplete: src})));
  }
  exts.push(EditorView.updateListener.of(update => {
    if(update.docChanged) writeBackCodeContent(itemId, update.state.doc.toString(), side);
  }));
  return exts;
}

// Called by renderEditor() (app-core.js) right after it assigns the item
// list's innerHTML — walks every .xml-block-mount placeholder (used for all
// three code-block types, not just XML — see the CSS class comment in
// css/base.css) and mounts/re-mounts a live EditorView into each, from the
// mount's own side's current content string. A CodeMirror EditorView is a
// stateful JS object that can't survive being serialized into that innerHTML
// string, which is exactly why renderEditor renders an empty mount div
// instead of trying to. Each mount carries a data-side attribute ('solo' |
// 'primary' | 'other', defaulting to 'solo' if absent) that determines which
// of the item's fields/keys it's backed by — see codeViews' own comment,
// above, for the full keying scheme.
function mountXmlBlocks(){
  const doc = window.getDoc();
  if(!doc) return;
  const readOnly = !!(window.isEditingBlocked && window.isEditingBlocked(doc));

  const liveKeys = new Set();
  doc.items.forEach(it=>{
    if(it.fcCodeSide){
      if(CODE_BLOCK_TYPES[it.blockType]) liveKeys.add(`${it.id}:primary`);
      if(it.fcOtherBlockType && CODE_BLOCK_TYPES[it.fcOtherBlockType]) liveKeys.add(`${it.id}:other`);
    } else if(CODE_BLOCK_TYPES[it.blockType]){
      liveKeys.add(it.id);
    }
  });
  for(const [key, entry] of codeViews){
    if(!liveKeys.has(key)){ entry.view.destroy(); codeViews.delete(key); }
  }

  document.querySelectorAll('.xml-block-mount').forEach(mountEl => {
    const i = +mountEl.dataset.i;
    const side = mountEl.dataset.side || 'solo';
    const it = doc.items[i];
    if(!it) return;

    let blockType, content, key;
    if(side==='other'){
      if(!it.fcOtherBlockType || !CODE_BLOCK_TYPES[it.fcOtherBlockType]) return;
      blockType=it.fcOtherBlockType; content=it.fcOtherText; key=`${it.id}:other`;
    } else if(side==='primary'){
      if(!it.fcCodeSide || !CODE_BLOCK_TYPES[it.blockType]) return;
      blockType=it.blockType; content=it.content; key=`${it.id}:primary`;
    } else {
      if(!CODE_BLOCK_TYPES[it.blockType]) return;
      blockType=it.blockType; content=it.content; key=it.id;
    }

    let entry = codeViews.get(key);
    // A structural edit can convert an item/side to a DIFFERENT code-block
    // type in place (unlikely today since conversion always starts from a
    // plain item/side, but cheap to guard) — a stale view built for the old
    // language must be torn down and rebuilt, not reused across a type change.
    if(entry && entry.blockType !== blockType){
      entry.view.destroy();
      codeViews.delete(key);
      entry = null;
    }
    if(!entry){
      const roCompartment = new Compartment();
      const view = new EditorView({
        state: EditorState.create({doc: content || '', extensions: buildCodeExtensions(it.id, roCompartment, readOnly, blockType, side)}),
        parent: mountEl
      });
      entry = {view, roCompartment, lastReadOnly: readOnly, blockType};
      codeViews.set(key, entry);
      return;
    }
    if(entry.view.dom.parentElement !== mountEl) mountEl.appendChild(entry.view.dom);
    // Read-only status (shared-folder lock, Document Mode) can change
    // without the EditorView itself being torn down and recreated —
    // reconfigure the compartment instead of baking it in once at creation.
    if(entry.lastReadOnly !== readOnly){
      entry.view.dispatch({effects: entry.roCompartment.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)])});
      entry.lastReadOnly = readOnly;
    }
    // A reused view's own document is normally already in sync with its
    // backing field (every keystroke writes straight into it — see the
    // updateListener below) — except when that field changed through some
    // path that never went through this view at all: undo/redo restoring
    // older content, a remote sync pulling in someone else's edit, or a full
    // item-array replace. Re-render is exactly the moment to reconcile that
    // drift.
    if(typeof content === 'string' && entry.view.state.doc.toString() !== content){
      entry.view.dispatch({changes: {from: 0, to: entry.view.state.doc.length, insert: content}});
    }
  });
}
window.mountXmlBlocks = mountXmlBlocks;

// Destroys every live code-block EditorView — called when navigating away
// from the editor screen entirely (see showTab(), app-core.js), so a
// document's code blocks don't sit around detached-but-alive in memory for
// the rest of the session once the user leaves it. Re-entering any document
// with code blocks afterward just mounts fresh instances (same
// already-accepted trade-off as any other full renderEditor() rebuild
// losing CodeMirror's own undo history).
function destroyAllXmlBlocks(){
  for(const entry of codeViews.values()) entry.view.destroy();
  codeViews.clear();
}
window.destroyAllXmlBlocks = destroyAllXmlBlocks;
