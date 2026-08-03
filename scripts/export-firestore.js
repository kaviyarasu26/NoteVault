// Dumps every document in every collection this app uses (users,
// folder_shares, folder_links, shared_folders) into one JSON file, via the
// Firebase Admin SDK — which bypasses security rules entirely, so this is
// the only way to see ALL accounts' data at once (the app's own client SDK
// can only ever read the signed-in user's own document, per
// firestore.rules). Needs a service account key — see the project's chat
// history / README for how to generate one from the Firebase console.
//
// Usage: node scripts/export-firestore.js [path-to-service-account-key.json]
// firebase-admin v12+ moved to a modular API (no more admin.credential /
// admin.firestore() off a single default export) — cert/initializeApp come
// from 'firebase-admin/app', getFirestore from 'firebase-admin/firestore'.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const keyPath = process.argv[2] || path.join(__dirname, '..', 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error(`Service account key not found at: ${keyPath}`);
  console.error('Usage: node scripts/export-firestore.js [path-to-key.json]');
  process.exit(1);
}

initializeApp({ credential: cert(require(path.resolve(keyPath))) });
const db = getFirestore();

const COLLECTIONS = ['users', 'folder_shares', 'folder_links', 'shared_folders'];

async function exportAll() {
  const out = {};
  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).get();
    out[col] = {};
    snap.forEach(doc => { out[col][doc.id] = doc.data(); });
    console.log(`${col}: ${snap.size} document(s)`);
  }
  const outPath = path.join(__dirname, '..', `firestore-export-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nExported to ${outPath}`);
}

exportAll().catch(e => { console.error('Export failed:', e); process.exit(1); });
