import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const electronPackage = resolve(process.cwd(), 'node_modules/electron');
const packageJsonPath = resolve(electronPackage, 'package.json');
if (!existsSync(packageJsonPath)) throw new Error(`Electron package not found: ${electronPackage}`);

const electronVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
const executablePath = process.platform === 'win32'
  ? resolve(electronPackage, 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? resolve(electronPackage, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : resolve(electronPackage, 'dist', 'electron');

if (!existsSync(executablePath)) {
  const installer = resolve(electronPackage, 'install.js');
  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron ${electronVersion} download failed with status ${result.status ?? 'unknown'}`);
}

if (!existsSync(executablePath)) throw new Error(`Electron ${electronVersion} distribution is missing: ${executablePath}`);
console.log(`Electron ${electronVersion} distribution ready: ${executablePath}`);
