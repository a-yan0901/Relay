import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureAndroidSdkEnvironment, configureJavaEnvironment } from './android-environment.mjs';

const androidDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'android');
const gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
configureAndroidSdkEnvironment();
configureJavaEnvironment();
const result = spawnSync(gradleCommand, process.argv.slice(2), {
  cwd: androidDirectory,
  shell: process.platform === 'win32',
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
