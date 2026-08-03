// Decrypts one user's vault from an export-firestore.js dump and prints a
// structural summary (folders, doc/card counts) — same AES scheme the app
// itself uses (secretKey = uid + '-nv-secret', see js/firebase-init.js).
// Usage: node scripts/inspect-vault.js <export.json> <uid>
const fs = require('fs');
const CryptoJS = require('crypto-js');

const [, , exportPath, uid] = process.argv;
if (!exportPath || !uid) {
  console.error('Usage: node scripts/inspect-vault.js <export.json> <uid>');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const userDoc = data.users[uid];
if (!userDoc) { console.error(`No users/${uid} document in this export.`); process.exit(1); }
if (!userDoc.vault) { console.error(`users/${uid} exists but has no 'vault' field.`); process.exit(1); }

const secretKey = uid + '-nv-secret';
const bytes = CryptoJS.AES.decrypt(userDoc.vault, secretKey);
const D = JSON.parse(bytes.toString(CryptoJS.enc.Utf8));

console.log(`updatedAt: ${userDoc.updatedAt}`);
console.log(`Lifetime XP: ${D.xp}, folders: ${D.folders.length}, documents: ${D.documents.length}\n`);
D.folders.forEach(f => {
  const docs = D.documents.filter(d => d.folderId === f.id);
  const cardCount = docs.reduce((n, d) => n + d.items.filter(i => i.srs).length, 0);
  const shared = f.sharedFrom ? ` [shared by ${f.sharedFrom.ownerEmail}]` : (f.readOnly ? ' [readOnly]' : '');
  console.log(`- "${f.name}"${shared} — ${docs.length} file(s), ${cardCount} flashcard(s)`);
});
