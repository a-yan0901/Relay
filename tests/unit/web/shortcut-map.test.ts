// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  filterShortcutDefinitions,
  shortcutCommandForEvent,
  shortcutDefinitions
} from '../../../src/web/state/shortcut-map';

const dispatchKey = (target: HTMLElement, init: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('Shortcut Map', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('does not steal Relay shortcuts from regular editable controls', () => {
    const input = document.createElement('input');
    document.body.append(input);

    expect(shortcutCommandForEvent(dispatchKey(input, { key: 'p', ctrlKey: true, shiftKey: true }), { terminalView: false })).toBeNull();
    expect(shortcutCommandForEvent(dispatchKey(input, { key: 'k', metaKey: true }), { terminalView: false })).toBeNull();
  });

  it('preserves terminal copy/interrupt and terminal-native key semantics', () => {
    const terminalInput = document.createElement('textarea');
    terminalInput.className = 'xterm-helper-textarea';
    document.body.append(terminalInput);

    expect(shortcutCommandForEvent(dispatchKey(terminalInput, { key: 'c', ctrlKey: true }), { terminalView: true })).toBeNull();
    expect(shortcutCommandForEvent(dispatchKey(terminalInput, { key: 'k', ctrlKey: true }), { terminalView: true })).toBeNull();
    expect(shortcutCommandForEvent(dispatchKey(terminalInput, { key: 'w', ctrlKey: true }), { terminalView: true })).toBe('close-tab');
  });

  it('routes workspace shortcuts from non-editable targets', () => {
    const target = document.body;

    expect(shortcutCommandForEvent(dispatchKey(target, { key: 'k', ctrlKey: true }), { terminalView: false })).toBe('quick-switch');
    expect(shortcutCommandForEvent(dispatchKey(target, { key: 'n', metaKey: true }), { terminalView: true })).toBe('new-terminal');
    expect(shortcutCommandForEvent(dispatchKey(target, { key: '2', altKey: true }), { terminalView: true })).toBe('focus-pane');
    expect(shortcutCommandForEvent(dispatchKey(target, { key: 'f', ctrlKey: true, shiftKey: true }), { terminalView: true })).toBe('open-sftp');
  });

  it('filters the centralized definitions by label, scope, or key', () => {
    expect(filterShortcutDefinitions(shortcutDefinitions, 'shift p').map((definition) => definition.id)).toEqual(['open-snippets']);
    expect(filterShortcutDefinitions(shortcutDefinitions, '终端')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'new-terminal' }),
      expect.objectContaining({ id: 'close-tab' })
    ]));
  });
});
