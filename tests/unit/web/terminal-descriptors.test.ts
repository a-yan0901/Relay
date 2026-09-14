// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearTerminalDescriptors,
  loadTerminalDescriptors,
  saveTerminalDescriptors,
  type TerminalDescriptor
} from '../../../src/web/state/app-state';

describe('terminal workspace descriptors', () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('persists only safe terminal and host identifiers', () => {
    const descriptors: TerminalDescriptor[] = [{ terminalId: 'terminal-1', hostId: 'host-1' }];
    saveTerminalDescriptors(descriptors);

    expect(JSON.parse(window.sessionStorage.getItem('relay.terminal.descriptors.v1') ?? '[]')).toEqual(descriptors);
    expect(loadTerminalDescriptors()).toEqual(descriptors);
    expect(window.sessionStorage.getItem('relay.terminal.descriptors.v1')).not.toContain('password');
  });

  it('drops malformed and duplicate descriptors and clears them explicitly', () => {
    window.sessionStorage.setItem('relay.terminal.descriptors.v1', JSON.stringify([
      { terminalId: 'terminal-1', hostId: 'host-1' },
      { terminalId: 'terminal-1', hostId: 'host-2' },
      { terminalId: '', hostId: 'host-3' },
      { terminalId: 'terminal-4', hostId: 4 }
    ]));

    expect(loadTerminalDescriptors()).toEqual([{ terminalId: 'terminal-1', hostId: 'host-1' }]);
    clearTerminalDescriptors();
    expect(window.sessionStorage.getItem('relay.terminal.descriptors.v1')).toBeNull();
  });
});
