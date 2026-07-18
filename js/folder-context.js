// ── FOLDER CONTEXT MENU ─────────────────────────────────────────
// ⋮ button on each folder card (rendered in renderHome, app-core.js)
// opens an overlay with Test / Favorite / Share / Delete. Renaming happens
// by double-clicking the folder name on its card (see dblclick handler in
// folderCardHTML, app-core.js), not from this menu.
// Delete cascades to every document whose folderId matches (D.documents).
// Folders received via folder-share are read-only for their recipient —
// readOnly:true hides Share and disables editing/renaming inside them.
let contextFolderId = null;

function openFolderMenu(folderId, event) {
  if(event) event.stopPropagation(); // Prevent opening the folder
  contextFolderId = folderId;
  const folder = D.folders.find(f => f.id === folderId);
  document.getElementById('folder-menu-h').textContent = folder.name;
  const favBtn = document.getElementById('folder-fav-btn');
  if(favBtn) favBtn.innerHTML = folder.favorite ? `${starIcon(true)} Remove from Favorites` : `${starIcon(false)} Add to Favorites`;
  const shareBtn = document.getElementById('folder-share-btn');
  if(shareBtn) shareBtn.style.display = folder.readOnly ? 'none' : '';
  const deleteBtn = document.getElementById('folder-delete-btn');
  if(deleteBtn) deleteBtn.textContent = folder.readOnly ? '🗑 Remove Shared Folder' : '🗑 Delete Folder';
  openAnchoredMenu('folder-context-ov', event);
}

function closeFolderMenu() {
  closeAnchoredMenu('folder-context-ov');
}

function toggleFavoriteFolder() {
  if (!contextFolderId) return;
  let nowFav = false;
  D.folders = D.folders.map(f => {
    if (f.id !== contextFolderId) return f;
    nowFav = !f.favorite;
    return { ...f, favorite: nowFav };
  });
  saveLS();
  closeFolderMenu();
  renderHome();
  toast(nowFav ? '⭐ Added to Favorites' : 'Removed from Favorites');
}

function startRenameFolder(folderId) {
  const folder = D.folders.find(f => f.id === folderId);
  if(!folder) return;
  if(folder.readOnly){ toast("⚠️ This folder was shared with you — you can't rename it"); return; }
  contextFolderId = folderId;
  openRenameOv('folder', folder.name);
}
window.startRenameFolder = startRenameFolder;

function requestDeleteFolder() {
  closeFolderMenu();
  const folder = D.folders.find(f => f.id === contextFolderId);
  const msg = folder && folder.readOnly
    ? "Remove this shared folder from your account? You'll stop receiving updates from it."
    : "Delete this folder and ALL files inside it? This cannot be undone.";
  openDeleteConfirm(msg, ()=>{
    if(folder && folder.readOnly && window.leaveSharedFolder) window.leaveSharedFolder(folder);
    else if(folder && window.cancelSharesForFolder) window.cancelSharesForFolder(folder.id);
    // Cascade delete: Remove the folder AND all documents matching its folderId
    D.folders = D.folders.filter(f => f.id !== contextFolderId);
    D.documents = D.documents.filter(d => d.folderId !== contextFolderId);
    saveLS();
    renderHome();
    toast(folder && folder.readOnly ? '🗑️ Shared folder removed' : '🗑️ Folder and contents deleted');
  });
}

function testFolderFromMenu(){
  if(!contextFolderId) return;
  const id = contextFolderId;
  closeFolderMenu();
  if(window.testFolder) testFolder(id);
}
