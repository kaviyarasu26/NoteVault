// Rebuilds the debug APK end to end: copy web assets -> sync into the
// Capacitor Android project -> run the Gradle wrapper. Each step runs with
// an explicit `cwd` via child_process (rather than chaining `cd`/`&&` through
// a single shell string), since gradlew.bat must be invoked with android/ as
// the working directory and nested cmd.exe `cd`/`call` chains proved
// unreliable in some sandboxed shells.
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');

function run(cmd, args, cwd) {
  console.log(`\n> ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
}

run('node', ['scripts/copy-web.js'], ROOT);
run('npx', ['cap', 'sync', 'android'], ROOT);
run('gradlew.bat', ['assembleDebug'], ANDROID_DIR);

console.log('\nAPK: android/app/build/outputs/apk/debug/app-debug.apk');
