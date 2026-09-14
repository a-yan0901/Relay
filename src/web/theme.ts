export type ThemeName = 'midnight' | 'light' | 'contrast';
export type TerminalFontSize = 12 | 13 | 14 | 16;

export interface UiPreferences {
  theme: ThemeName;
  fontSize: TerminalFontSize;
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  brightBlack: string;
  blue: string;
  brightBlue: string;
  green: string;
  brightGreen: string;
  red: string;
  brightRed: string;
  yellow: string;
  brightYellow: string;
  cyan: string;
  brightCyan: string;
  magenta: string;
  brightMagenta: string;
  white: string;
  brightWhite: string;
}

export const UI_PREFERENCES_STORAGE_KEY = 'relay.ui.preferences.v1';

export const DEFAULT_PREFERENCES: UiPreferences = {
  theme: 'midnight',
  fontSize: 13
};

export const themeOptions: ReadonlyArray<{ value: ThemeName; label: string }> = [
  { value: 'midnight', label: '深夜蓝' },
  { value: 'light', label: '浅色' },
  { value: 'contrast', label: '高对比' }
];

export const fontSizeOptions: ReadonlyArray<{ value: TerminalFontSize; label: string }> = [
  { value: 12, label: '小 · 12px' },
  { value: 13, label: '标准 · 13px' },
  { value: 14, label: '大 · 14px' },
  { value: 16, label: '特大 · 16px' }
];

const terminalThemes: Record<ThemeName, TerminalTheme> = {
  midnight: {
    background: '#07111f', foreground: '#d9e7f7', cursor: '#73b7ff', selectionBackground: 'rgba(93, 168, 255, 0.35)',
    black: '#07111f', brightBlack: '#5e7490', blue: '#5da8ff', brightBlue: '#8bc7ff', green: '#52d39a', brightGreen: '#83e9ba',
    red: '#ff7d7d', brightRed: '#ffacac', yellow: '#f6c66a', brightYellow: '#ffe3a2', cyan: '#6ad9d1', brightCyan: '#9af3ec',
    magenta: '#c59bff', brightMagenta: '#ddc5ff', white: '#d9e7f7', brightWhite: '#ffffff'
  },
  light: {
    background: '#f5f8fc', foreground: '#1f2f46', cursor: '#1f6fc7', selectionBackground: 'rgba(49, 126, 219, 0.24)',
    black: '#1f2f46', brightBlack: '#71829a', blue: '#1f6fc7', brightBlue: '#15549e', green: '#087f57', brightGreen: '#056443',
    red: '#b52828', brightRed: '#8d1717', yellow: '#936100', brightYellow: '#765000', cyan: '#087b82', brightCyan: '#055c62',
    magenta: '#7047a4', brightMagenta: '#563182', white: '#eef3f9', brightWhite: '#ffffff'
  },
  contrast: {
    background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selectionBackground: 'rgba(255, 255, 255, 0.32)',
    black: '#000000', brightBlack: '#aaaaaa', blue: '#66b3ff', brightBlue: '#b3dcff', green: '#63e6be', brightGreen: '#b5f5df',
    red: '#ff7b7b', brightRed: '#ffc1c1', yellow: '#ffda75', brightYellow: '#fff0b8', cyan: '#74e6e0', brightCyan: '#bffaf6',
    magenta: '#d2a8ff', brightMagenta: '#ecd8ff', white: '#eeeeee', brightWhite: '#ffffff'
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isThemeName = (value: unknown): value is ThemeName => value === 'midnight' || value === 'light' || value === 'contrast';

const isFontSize = (value: unknown): value is TerminalFontSize => value === 12 || value === 13 || value === 14 || value === 16;

export const loadPreferences = (): UiPreferences => {
  try {
    const raw = globalThis.localStorage?.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isThemeName(parsed.theme) || !isFontSize(parsed.fontSize)) {
      return { ...DEFAULT_PREFERENCES };
    }
    return { theme: parsed.theme, fontSize: parsed.fontSize };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

export const savePreferences = (preferences: UiPreferences): void => {
  try {
    globalThis.localStorage?.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Browser storage can be disabled; the current session still uses the in-memory value.
  }
};

export const applyPreferences = (preferences: UiPreferences): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.setProperty('--terminal-font-size', `${preferences.fontSize}px`);
};

export const getTerminalTheme = (theme: ThemeName): TerminalTheme => terminalThemes[theme];
