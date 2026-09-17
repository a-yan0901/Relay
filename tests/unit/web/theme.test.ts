// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPreferences,
  bootstrapPreferences,
  loadPreferences,
  savePreferences,
  getThemeDefinition,
  themeOptions,
  type UiPreferences
} from '../../../src/web/theme';

const preferences: UiPreferences = { theme: 'termius-light', fontSize: 16, serverViewMode: 'grid' };

describe('UI preferences', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-relay-theme');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--terminal-font-size');
    document.documentElement.style.removeProperty('--panel');
    document.documentElement.style.removeProperty('--panel-active');
    document.documentElement.style.removeProperty('color-scheme');
    document.head.querySelector('meta[name="theme-color"]')?.remove();
  });

  it('loads valid preferences and falls back from malformed values', () => {
    expect(loadPreferences()).toEqual({ theme: 'termius', fontSize: 13, serverViewMode: 'list' });
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify(preferences));
    expect(loadPreferences()).toEqual(preferences);
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify({ theme: 'tokyo-day', fontSize: 14 }));
    expect(loadPreferences()).toEqual({ theme: 'tokyo-day', fontSize: 14, serverViewMode: 'list' });
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify({ theme: 'unknown', fontSize: 14 }));
    expect(loadPreferences()).toEqual({ theme: 'termius', fontSize: 13, serverViewMode: 'list' });
    window.localStorage.setItem('relay.ui.preferences.v1', '{bad json');
    expect(loadPreferences()).toEqual({ theme: 'termius', fontSize: 13, serverViewMode: 'list' });
  });

  it('applies and persists only visual preferences', () => {
    applyPreferences(preferences);
    savePreferences(preferences);

    expect(document.documentElement.dataset.relayTheme).toBe('termius-light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px');
    expect(JSON.parse(window.localStorage.getItem('relay.ui.preferences.v1') ?? '{}')).toEqual(preferences);
    expect(window.localStorage.getItem('relay.ui.preferences.v1')).not.toContain('password');
  });

  it('exposes modern theme presets with semantic UI and terminal definitions', () => {
    expect(themeOptions.map((option) => option.value)).toEqual([
      'termius', 'termius-light', 'everforest-dark', 'tokyo-day', 'monokai'
    ]);
    expect(getThemeDefinition('everforest-dark').tokens.panelActive).not.toBe('');
    expect(getThemeDefinition('tokyo-day').terminal.background).toBe('#e1e2e7');
    expect(getThemeDefinition('monokai').terminal.green).toBe('#a6e22e');
    expect(getThemeDefinition('termius').terminal.foreground).toBe('#5cc97c');
    expect(getThemeDefinition('termius-light').terminal.foreground).toBe('#333649');
  });

  it('applies semantic tokens for a selected preset without touching data-theme', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);

    applyPreferences({ theme: 'everforest-dark', fontSize: 14 });

    expect(document.documentElement.dataset.relayTheme).toBe('everforest-dark');
    expect(document.documentElement.style.getPropertyValue('--panel')).not.toBe('');
    expect(document.documentElement.style.getPropertyValue('--panel-active')).not.toBe('');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
    expect(meta.content).toBe(getThemeDefinition('everforest-dark').themeColor);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('keeps Relay theme isolated from third-party data-theme attributes', () => {
    const contrastPreferences: UiPreferences = { theme: 'monokai', fontSize: 16 };
    applyPreferences(contrastPreferences);
    document.documentElement.setAttribute('data-theme', 'light');

    expect(document.documentElement.dataset.relayTheme).toBe('monokai');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('bootstraps the saved theme before the app renders', () => {
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify(preferences));
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);

    expect(bootstrapPreferences()).toEqual(preferences);
    expect(document.documentElement.dataset.relayTheme).toBe('termius-light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px');
    expect(meta.content).toBe('#d6dde0');
  });

  it('falls back to list view when a saved server view mode is invalid', () => {
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify({ theme: 'tokyo-day', fontSize: 14, serverViewMode: 'invalid' }));

    expect(loadPreferences()).toEqual({ theme: 'tokyo-day', fontSize: 14, serverViewMode: 'list' });
  });
});
