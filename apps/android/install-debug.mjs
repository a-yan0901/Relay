import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_APK = 'android/app/build/outputs/apk/debug/app-debug.apk';

const fail = (message) => {
  console.error(message);
  process.exitCode = 2;
};

const runAdb = (serial, args) => {
  const result = spawnSync('adb', ['-s', serial, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`adb exited with status ${result.status ?? 'unknown'}`);
};

const install = (serial, apkPath) => {
  if (!/^[A-Za-z0-9._:-]+$/u.test(serial)) throw new Error('invalid device serial');
  if (!existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);

  const remotePath = `/data/local/tmp/relay-debug-${process.pid}.apk`;
  try {
    runAdb(serial, ['push', apkPath, remotePath]);
    // Keep the existing app data and avoid -g/runtime permission prompts. The
    // package manager path also works around devices that reject adb install.
    runAdb(serial, ['shell', 'pm', 'install', '-r', '--user', '0', remotePath]);
  } finally {
    try {
      runAdb(serial, ['shell', 'rm', '-f', remotePath]);
    } catch {
      // A failed cleanup must not hide the install result.
    }
  }
};

const [serial, apkArgument] = process.argv.slice(2);
if (!serial || process.argv.length > 4) {
  fail('Usage: npm run install:android:debug -- <device-serial> [apk-path]');
} else {
  try {
    install(serial, resolve(process.cwd(), apkArgument ?? DEFAULT_APK));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
