// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPreferences,
  bootstrapPreferences,
  loadPreferences,
  savePreferences,
  type UiPreferences
} from '../../../src/web/theme';

const preferences: UiPreferences = { theme: 'light', fontSize: 16 };

describe('UI preferences', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-relay-theme');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--terminal-font-size');
    document.documentElement.style.removeProperty('color-scheme');
    document.head.querySelector('meta[name="theme-color"]')?.remove();
  });

  it('loads valid preferences and falls back from malformed values', () => {
    expect(loadPreferences()).toEqual({ theme: 'midnight', fontSize: 13 });
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify(preferences));
    expect(loadPreferences()).toEqual(preferences);
    window.localStorage.setItem('relay.ui.preferences.v1', '{bad json');
    expect(loadPreferences()).toEqual({ theme: 'midnight', fontSize: 13 });
  });

  it('applies and persists only visual preferences', () => {
    applyPreferences(preferences);
    savePreferences(preferences);

    expect(document.documentElement.dataset.relayTheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px');
    expect(JSON.parse(window.localStorage.getItem('relay.ui.preferences.v1') ?? '{}')).toEqual(preferences);
    expect(window.localStorage.getItem('relay.ui.preferences.v1')).not.toContain('password');
  });

  it('keeps Relay theme isolated from third-party data-theme attributes', () => {
    const contrastPreferences: UiPreferences = { theme: 'contrast', fontSize: 16 };
    applyPreferences(contrastPreferences);
    document.documentElement.setAttribute('data-theme', 'light');

    expect(document.documentElement.dataset.relayTheme).toBe('contrast');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('bootstraps the saved theme before the app renders', () => {
    window.localStorage.setItem('relay.ui.preferences.v1', JSON.stringify(preferences));
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);

    expect(bootstrapPreferences()).toEqual(preferences);
    expect(document.documentElement.dataset.relayTheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px');
    expect(meta.content).toBe('#eef3f9');
  });
});
