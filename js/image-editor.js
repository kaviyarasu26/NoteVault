// ── IMAGE EDITOR (resize + crop) ────────────────────────────────
// Resize is inline, Word/Docs-style: tap an image and drag corner handles
// positioned directly on it (a floating overlay computed from
// getBoundingClientRect(), not children of the <img> itself — images can't
// have child elements). Crop stays in a modal: precise corner-drag cropping
// on a small pasted image is error-prone at inline size on a phone, so it
// gets a full-size stage instead.
//
// Resize sets the real <img>'s inline width (a CSS-only display change —
// see the 'width' entry in ALLOWED_STYLE_PROPS, app-core.js, for why that
// survives sanitizeHtml). Crop actually re-encodes the image data: it draws
// the selected region onto a canvas and replaces the <img>'s src with the
// cropped result, same data-URI approach compressImageBlob() already uses
// for pasted images.

// ── Selection ────────────────────────────────────────────────────
let selectedImgEl=null, selectedItemIndex=-1;
const RH_CORNERS=['tl','tr','bl','br'];

function selectImageForResize(imgEl){
  if(selectedImgEl && selectedImgEl!==imgEl) selectedImgEl.classList.remove('nv-img-selected');
  selectedImgEl=imgEl;
  const itemEl=imgEl.closest('.item-ta');
  selectedItemIndex=itemEl?parseInt(itemEl.dataset.i,10):-1;
  imgEl.classList.add('nv-img-selected');
  positionImageControls();
}

function deselectImage(){
  if(selectedImgEl) selectedImgEl.classList.remove('nv-img-selected');
  selectedImgEl=null; selectedItemIndex=-1;
  RH_CORNERS.forEach(c=>{ const el=document.getElementById('img-rh-'+c); if(el) el.style.display='none'; });
  const tb=document.getElementById('img-inline-toolbar');
  if(tb) tb.style.display='none';
}
window.deselectImage=deselectImage;

function positionImageControls(){
  if(!selectedImgEl) return;
  const r=selectedImgEl.getBoundingClientRect();
  const put=(id,x,y)=>{ const el=document.getElementById(id); el.style.left=(x-8)+'px'; el.style.top=(y-8)+'px'; el.style.display='block'; };
  put('img-rh-tl',r.left,r.top);
  put('img-rh-tr',r.right,r.top);
  put('img-rh-bl',r.left,r.bottom);
  put('img-rh-br',r.right,r.bottom);

  const tb=document.getElementById('img-inline-toolbar');
  tb.style.display='flex';
  const top=r.top>50?r.top-42:r.bottom+8;
  tb.style.left=Math.max(4,r.left)+'px';
  tb.style.top=top+'px';
}

// ── Drag-resize ──────────────────────────────────────────────────
let imgResizeDrag=null;
function imgResizeStart(e,corner){
  if(!selectedImgEl) return;
  e.preventDefault();
  e.stopPropagation();
  pushUndoSnapshot(false);
  const rect=selectedImgEl.getBoundingClientRect();
  const container=selectedImgEl.closest('.item-ta');
  imgResizeDrag={
    corner,
    startX:e.clientX,
    startWidth:rect.width,
    containerWidth:container?container.clientWidth:rect.width
  };
  document.addEventListener('pointermove',imgResizeMove);
  document.addEventListener('pointerup',imgResizeEnd);
}
window.imgResizeStart=imgResizeStart;

function imgResizeMove(e){
  if(!imgResizeDrag||!selectedImgEl) return;
  const dx=e.clientX-imgResizeDrag.startX;
  // Right-side handles (tr/br) grow the image when dragged right; left-side
  // handles (tl/bl) grow it when dragged left — mirrors how Word's corner
  // handles behave. Height is never set inline, so aspect ratio always
  // follows from .nv-img's CSS height:auto.
  const sign=(imgResizeDrag.corner==='tr'||imgResizeDrag.corner==='br')?1:-1;
  let newWidth=imgResizeDrag.startWidth+dx*sign;
  newWidth=Math.max(40,Math.min(imgResizeDrag.containerWidth,newWidth));
  const pct=Math.max(5,Math.round((newWidth/imgResizeDrag.containerWidth)*100));
  selectedImgEl.style.width=pct+'%';
  positionImageControls();
}

function imgResizeEnd(){
  if(!imgResizeDrag) return;
  imgResizeDrag=null;
  document.removeEventListener('pointermove',imgResizeMove);
  document.removeEventListener('pointerup',imgResizeEnd);
  if(selectedImgEl){
    const itemEl=document.querySelector(`.item-ta[data-i="${selectedItemIndex}"]`);
    if(itemEl) onInput(itemEl,selectedItemIndex);
  }
}

// ── Remove ───────────────────────────────────────────────────────
function removeSelectedImage(){
  if(!selectedImgEl) return;
  pushUndoSnapshot(false);
  const idx=selectedItemIndex;
  const itemEl=document.querySelector(`.item-ta[data-i="${idx}"]`);
  selectedImgEl.remove();
  deselectImage();
  if(itemEl) onInput(itemEl,idx);
  toast('🗑 Image removed');
}
window.removeSelectedImage=removeSelectedImage;

// ── Crop (modal) ─────────────────────────────────────────────────
let editingImgEl=null, editingItemIndex=-1;

function openCropForSelected(){
  if(!selectedImgEl) return;
  editingImgEl=selectedImgEl;
  editingItemIndex=selectedItemIndex;
  deselectImage();
  openCropView();
}
window.openCropForSelected=openCropForSelected;

function closeImageEditor(){
  document.getElementById('img-edit-ov').classList.remove('open');
  editingImgEl=null; editingItemIndex=-1; cropState=null;
}
window.closeImageEditor=closeImageEditor;

// cropState is in on-screen DISPLAY pixels (the visible <img>'s rendered
// size) — applyCrop() scales it up to the image's real naturalWidth/Height
// before drawing, so the exported crop is full-resolution, not a crop of
// whatever small preview size happened to be on screen.
let cropState=null;
let cropDrag=null;
const CROP_MIN=40;

function openCropView(){
  if(!editingImgEl) return;
  document.getElementById('img-edit-ov').classList.add('open');
  const dispImg=document.getElementById('crop-display-img');
  dispImg.src=editingImgEl.src;
  const initCropRect=()=>{
    const stage=document.getElementById('crop-stage');
    const w=dispImg.clientWidth, h=dispImg.clientHeight;
    stage.style.width=w+'px';
    const rectW=w*0.7, rectH=h*0.7;
    cropState={x:(w-rectW)/2,y:(h-rectH)/2,w:rectW,h:rectH,stageW:w,stageH:h};
    layoutCropRect();
  };
  dispImg.onload=initCropRect;
  if(dispImg.complete && dispImg.naturalWidth) initCropRect();
}
window.openCropView=openCropView;

function layoutCropRect(){
  const rect=document.getElementById('crop-rect');
  rect.style.left=cropState.x+'px';
  rect.style.top=cropState.y+'px';
  rect.style.width=cropState.w+'px';
  rect.style.height=cropState.h+'px';
}

function cropPointerDown(e,mode){
  if(!cropState) return;
  e.preventDefault();
  e.stopPropagation();
  cropDrag={mode,startX:e.clientX,startY:e.clientY,orig:{...cropState}};
  document.addEventListener('pointermove',cropPointerMove);
  document.addEventListener('pointerup',cropPointerUp);
}
window.cropPointerDown=cropPointerDown;

function cropPointerMove(e){
  if(!cropDrag||!cropState) return;
  const dx=e.clientX-cropDrag.startX, dy=e.clientY-cropDrag.startY;
  const o=cropDrag.orig;
  let x=o.x,y=o.y,w=o.w,h=o.h;
  if(cropDrag.mode==='move'){
    x=Math.max(0,Math.min(cropState.stageW-o.w,o.x+dx));
    y=Math.max(0,Math.min(cropState.stageH-o.h,o.y+dy));
  }else{
    let left=o.x, top=o.y, right=o.x+o.w, bottom=o.y+o.h;
    if(cropDrag.mode.includes('l')) left=Math.min(right-CROP_MIN,Math.max(0,o.x+dx));
    if(cropDrag.mode.includes('r')) right=Math.max(left+CROP_MIN,Math.min(cropState.stageW,o.x+o.w+dx));
    if(cropDrag.mode.includes('t')) top=Math.min(bottom-CROP_MIN,Math.max(0,o.y+dy));
    if(cropDrag.mode.includes('b')) bottom=Math.max(top+CROP_MIN,Math.min(cropState.stageH,o.y+o.h+dy));
    x=left;y=top;w=right-left;h=bottom-top;
  }
  cropState={...cropState,x,y,w,h};
  layoutCropRect();
}

function cropPointerUp(){
  cropDrag=null;
  document.removeEventListener('pointermove',cropPointerMove);
  document.removeEventListener('pointerup',cropPointerUp);
}

function applyCrop(){
  if(!editingImgEl||!cropState) return;
  const dispImg=document.getElementById('crop-display-img');
  const scaleX=dispImg.naturalWidth/cropState.stageW;
  const scaleY=dispImg.naturalHeight/cropState.stageH;
  const sx=cropState.x*scaleX, sy=cropState.y*scaleY;
  const sw=cropState.w*scaleX, sh=cropState.h*scaleY;

  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(sw));
  canvas.height=Math.max(1,Math.round(sh));
  canvas.getContext('2d').drawImage(dispImg,sx,sy,sw,sh,0,0,canvas.width,canvas.height);
  const dataUri=canvas.toDataURL('image/jpeg',0.85);

  pushUndoSnapshot(false);
  editingImgEl.src=dataUri;
  const itemEl=document.querySelector(`.item-ta[data-i="${editingItemIndex}"]`);
  if(itemEl) onInput(itemEl,editingItemIndex);
  toast('✂ Image cropped');
  closeImageEditor();
}
window.applyCrop=applyCrop;

// ── Wiring ───────────────────────────────────────────────────────
// Delegated so it survives every renderEditor() re-render — #ed-content
// itself is never replaced, only its children.
window.addEventListener('load',()=>{
  const ed=document.getElementById('ed-content');
  if(!ed) return;

  ed.addEventListener('click',e=>{
    const img=e.target.closest('img.nv-img');
    if(!img) return;
    const doc=getDoc();
    if(doc && isDocReadOnly(doc)) return; // shared read-only files
    if(docModeOn) return; // self-toggled, continuous read-only Document Mode
    e.preventDefault();
    selectImageForResize(img);
  });

  // Clicking anywhere else (outside the image, its handles, and its
  // toolbar) deselects — checked broadly so it also covers clicks on other
  // screens/overlays, not just inside the editor.
  document.addEventListener('click',e=>{
    if(!selectedImgEl) return;
    if(e.target.closest('.img-rh')) return;
    if(e.target.closest('#img-inline-toolbar')) return;
    if(e.target===selectedImgEl) return;
    deselectImage();
  });

  ed.addEventListener('scroll',()=>{ if(selectedImgEl) positionImageControls(); });
  window.addEventListener('resize',()=>{ if(selectedImgEl) positionImageControls(); });
});
