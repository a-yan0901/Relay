import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseSha256sum, shouldInstallDebugApk } from './install-policy.mjs';

const DEFAULT_APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
const PACKAGE_NAME = 'cn.ayan.relay';

const fail = (message) => {
  console.error(message);
  process.exitCode = 2;
};

const runAdb = (serial, args) => {
  const result = spawnSync('adb', ['-s', serial, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`adb exited with status ${result.status ?? 'unknown'}`);
};

const captureAdb = (serial, args) => {
  const result = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
};

const readInstalledApkHash = (serial) => {
  try {
    const packageOutput = captureAdb(serial, ['shell', 'pm', 'path', PACKAGE_NAME]);
    const packagePath = packageOutput
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith('package:'))
      ?.slice('package:'.length);
    if (!packagePath) return null;
    return parseSha256sum(captureAdb(serial, ['shell', 'sha256sum', packagePath]) ?? '');
  } catch {
    return null;
  }
};

const install = (serial, apkPath) => {
  if (!/^[A-Za-z0-9._:-]+$/u.test(serial)) throw new Error('invalid device serial');
  if (!existsSync(apkPath)) throw new Error(`APK not found: ${apkPath}`);

  const localHash = createHash('sha256').update(readFileSync(apkPath)).digest('hex');
  const installedHash = readInstalledApkHash(serial);
  if (!shouldInstallDebugApk(localHash, installedHash)) {
    console.log(`APK already installed on ${serial}; skipping push/install (${localHash})`);
    return;
  }

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
