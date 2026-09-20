import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const buildVerificationSteps = () => [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  {
    name: 'unit and integration tests',
    command: 'npm',
    args: ['run', 'test', '--', '--testTimeout=15000', '--hookTimeout=15000', '--no-file-parallelism', '--maxWorkers=1', '--reporter=dot']
  },
  { name: 'web/server/cloud build', command: 'npm', args: ['run', 'build'] },
  { name: 'Chromium E2E', command: 'npm', args: ['run', 'test:e2e', '--', '--project=chromium', '--workers=1'] },
  { name: 'Windows package', command: 'npm', args: ['run', 'package:windows'] },
  { name: 'Android local tests', command: 'npm', args: ['run', 'test:android:local'] },
  { name: 'Android debug APK', command: 'npm', args: ['run', 'build:android:debug'] }
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const createSpawnInvocation = (step, platform = process.platform) => {
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    shell: false
  };
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', npmCommand, ...step.args],
      options
    };
  }
  return { command: npmCommand, args: step.args, options };
};

const runStep = (step) => new Promise((resolveStep, rejectStep) => {
  const invocation = createSpawnInvocation(step);
  const child = spawn(invocation.command, invocation.args, invocation.options);
  child.once('error', rejectStep);
  child.once('exit', (code, signal) => {
    if (code === 0) {
      resolveStep();
      return;
    }
    rejectStep(new Error(`${step.name} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}`));
  });
});

export const runVerification = async (steps = buildVerificationSteps()) => {
  for (const step of steps) {
    console.log(`\n[verify:cross-platform:local] ${step.name}`);
    await runStep(step);
  }
};

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  runVerification().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
