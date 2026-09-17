import { describe, expect, it } from 'vitest';

import {
  BUILTIN_TERMINAL_PROFILE_ID,
  BUILTIN_TERMINAL_PROFILES,
  resolveTerminalProfile,
  terminalAppearanceSchema,
  type TerminalAppearance,
  type TerminalProfile
} from '../../../src/shared/terminal-appearance.js';

const appearance = (): TerminalAppearance => ({
  foreground: '#d9e7f7', background: '#07111f', cursor: '#73b7ff', cursorAccent: '#07111f',
  selectionBackground: '#33577f', selectionForeground: '#ffffff',
  black: '#07111f', red: '#ff7d7d', green: '#52d39a', yellow: '#f6c66a', blue: '#5da8ff', magenta: '#c59bff', cyan: '#6ad9d1', white: '#d9e7f7',
  brightBlack: '#5e7490', brightRed: '#ffacac', brightGreen: '#83e9ba', brightYellow: '#ffe3a2', brightBlue: '#8bc7ff', brightMagenta: '#ddc5ff', brightCyan: '#9af3ec', brightWhite: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 1.25, cursorStyle: 'bar', cursorBlink: true, scrollback: 5_000
});

const profile = (id: string): TerminalProfile => ({ id, name: 'Ops', appearance: appearance(), createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' });

describe('terminal appearance profiles', () => {
  it('provides the built-in color schemes as immutable built-ins', () => {
    expect(BUILTIN_TERMINAL_PROFILE_ID).toBe('builtin:midnight');
    expect(BUILTIN_TERMINAL_PROFILES.map((candidate) => candidate.id)).toEqual([
      'builtin:midnight', 'builtin:termius', 'builtin:termius-light', 'builtin:light', 'builtin:contrast', 'builtin:nord', 'builtin:dracula', 'builtin:solarized-dark', 'builtin:oled'
    ]);
  });

  it('resolves an assigned custom profile before the inherited built-in default', () => {
    expect(resolveTerminalProfile('profile-ops', [profile('profile-ops')], BUILTIN_TERMINAL_PROFILE_ID).id).toBe('profile-ops');
    expect(resolveTerminalProfile(null, [], 'builtin:nord').id).toBe('builtin:nord');
    expect(resolveTerminalProfile('missing', [], 'missing-default').id).toBe(BUILTIN_TERMINAL_PROFILE_ID);
  });

  it('rejects unsafe colors, fonts and out-of-range rendering settings', () => {
    expect(terminalAppearanceSchema.safeParse({ ...appearance(), foreground: 'rgba(0,0,0,.2)' }).success).toBe(false);
    expect(terminalAppearanceSchema.safeParse({ ...appearance(), fontFamily: 'mono\nscript' }).success).toBe(false);
    expect(terminalAppearanceSchema.safeParse({ ...appearance(), fontSize: 25 }).success).toBe(false);
    expect(terminalAppearanceSchema.safeParse({ ...appearance(), cursorStyle: 'beam' }).success).toBe(false);
  });
});
