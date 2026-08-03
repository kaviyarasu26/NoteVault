// Copies the static web app (index.html, css/, js/, icons/, manifest.json,
// sw.js) into www/, which is the Capacitor webDir. There's no bundler here —
// this is a plain copy so `npx cap sync` has something to embed into the
// native Android assets.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'www');

const ENTRIES = ['index.html', 'manifest.json', 'sw.js', 'css', 'js', 'icons'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
for (const entry of ENTRIES) {
  const src = path.join(ROOT, entry);
  if (fs.existsSync(src)) copyRecursive(src, path.join(DEST, entry));
}
console.log('Copied web assets to', DEST);
