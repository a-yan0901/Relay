import { describe, expect, it } from 'vitest';

import { buildVerificationSteps, createSpawnInvocation } from '../../scripts/verify-cross-platform-local.mjs';

describe('cross-platform local verification runner', () => {
  it('runs the supported platform gates in a fixed serial order without device deployment', () => {
    const steps = buildVerificationSteps();

    expect(steps.map((step) => step.name)).toEqual([
      'typecheck',
      'lint',
      'unit and integration tests',
      'web/server/cloud build',
      'Chromium E2E',
      'Windows package',
      'Android local tests',
      'Android debug APK'
    ]);
    expect(steps.every((step) => step.command === 'npm' && step.args[0] === 'run')).toBe(true);
    expect(steps.flatMap((step) => step.args)).not.toContain('adb');
    expect(steps.flatMap((step) => step.args)).not.toContain('install:android:debug');
  });

  it('uses cmd.exe for npm.cmd on Windows instead of spawning a command script directly', () => {
    const invocation = createSpawnInvocation(buildVerificationSteps()[0], 'win32');

    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(invocation.args[3]).toBe('npm.cmd');
    expect(invocation.options.shell).toBe(false);
  });
});
