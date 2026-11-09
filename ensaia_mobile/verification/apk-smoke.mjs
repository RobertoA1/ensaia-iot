import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const { ADB = 'adb', ANDROID_SERIAL: serial, ENSAIA_EXPECT_LEGACY_WEBVIEW } = process.env;
if (!/^emulator-\d+$/.test(serial || '')) throw Error('Indica un emulador con ANDROID_SERIAL.');

const apk = process.argv[2];
const adb = (...args) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 });
if (apk) console.log(adb('install', '-r', apk).trim());
adb('shell', 'am', 'force-stop', 'pe.ensaia.mobile');
console.log(adb('shell', 'am', 'start', '-W', '-n', 'pe.ensaia.mobile/.MainActivity').trim());

const expected = ENSAIA_EXPECT_LEGACY_WEBVIEW === '1'
  ? 'Actualiza Android System WebView'
  : 'Qué bueno tenerte aquí';
const dumpPath = '/sdcard/ensaia-replica-qa.xml';
const deadline = Date.now() + 45_000;
let found = false;
while (!found && Date.now() < deadline) {
  adb('shell', 'uiautomator', 'dump', dumpPath);
  const screen = adb('shell', 'cat', dumpPath);
  if (screen.includes('No pudimos abrir ENSAIA')) throw Error('La WebView no pudo cargar ENSAIA.');
  found = screen.includes(expected);
  if (!found) await delay(750);
}
if (!found) throw Error(`El emulador no mostró «${expected}».`);
console.log(`APK verificada en ${serial}: «${expected}».`);
