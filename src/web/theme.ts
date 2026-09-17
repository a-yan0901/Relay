export type ThemeName = 'termius' | 'termius-light' | 'everforest-dark' | 'tokyo-day' | 'monokai';
export type TerminalFontSize = 12 | 13 | 14 | 16;
export type ServerViewMode = 'list' | 'grid';

export interface UiPreferences {
  theme: ThemeName;
  fontSize: TerminalFontSize;
  serverViewMode?: ServerViewMode;
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

export interface ThemeTokens {
  bg: string;
  bgRaised: string;
  panel: string;
  panelSoft: string;
  panelHover: string;
  panelActive: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  faint: string;
  blue: string;
  blueStrong: string;
  primaryText: string;
  focusRing: string;
  green: string;
  yellow: string;
  red: string;
  terminalBg: string;
  shadow: string;
}

export interface ThemeDefinition {
  id: ThemeName;
  label: string;
  colorScheme: 'light' | 'dark';
  tokens: ThemeTokens;
  terminal: TerminalTheme;
  themeColor: string;
  swatches: readonly string[];
}

export const UI_PREFERENCES_STORAGE_KEY = 'relay.ui.preferences.v1';

export const DEFAULT_PREFERENCES: UiPreferences = {
  theme: 'termius',
  fontSize: 13,
  serverViewMode: 'list'
};

const themeNames = ['termius', 'termius-light', 'everforest-dark', 'tokyo-day', 'monokai'] as const satisfies readonly ThemeName[];

export const themeOptions: ReadonlyArray<{ value: ThemeName; label: string }> = [
  { value: 'termius', label: 'Termius Dark' },
  { value: 'termius-light', label: 'Termius Light' },
  { value: 'everforest-dark', label: 'Everforest Dark' },
  { value: 'tokyo-day', label: 'Tokyo Day' },
  { value: 'monokai', label: 'Monokai' }
];

export const fontSizeOptions: ReadonlyArray<{ value: TerminalFontSize; label: string }> = [
  { value: 12, label: '小 · 12px' },
  { value: 13, label: '标准 · 13px' },
  { value: 14, label: '大 · 14px' },
  { value: 16, label: '特大 · 16px' }
];

const terminalThemes: Record<ThemeName, TerminalTheme> = {
  termius: {
    background: '#141728', foreground: '#5cc97c', cursor: '#92a0a7', selectionBackground: 'rgba(238, 123, 121, 0.38)',
    black: '#141728', brightBlack: '#333649', blue: '#225388', brightBlue: '#346baf', green: '#5cc97c', brightGreen: '#5cc97c',
    red: '#e05b57', brightRed: '#e16866', yellow: '#e7ebed', brightYellow: '#ffffff', cyan: '#478fef', brightCyan: '#5d9fef',
    magenta: '#ee7b79', brightMagenta: '#ee7b79', white: '#d6dde0', brightWhite: '#ffffff'
  },
  'termius-light': {
    background: '#d6dde0', foreground: '#333649', cursor: '#92a0a7', selectionBackground: 'rgba(238, 123, 121, 0.38)',
    black: '#141728', brightBlack: '#333649', blue: '#1c4774', brightBlue: '#1c4774', green: '#57b26f', brightGreen: '#57b26f',
    red: '#c24c48', brightRed: '#e05b57', yellow: '#346baf', brightYellow: '#346baf', cyan: '#3166a6', brightCyan: '#346baf',
    magenta: '#e16866', brightMagenta: '#e16866', white: '#a7b2b9', brightWhite: '#f8f9fa'
  },
  'everforest-dark': {
    background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', selectionBackground: 'rgba(127, 187, 179, 0.34)',
    black: '#475258', brightBlack: '#859289', red: '#e67e80', brightRed: '#e69875', green: '#a7c080', brightGreen: '#a7c080',
    yellow: '#dbbc7f', brightYellow: '#dbbc7f', blue: '#7fbbb3', brightBlue: '#7fbbb3', magenta: '#d699b6', brightMagenta: '#d699b6',
    cyan: '#83c092', brightCyan: '#83c092', white: '#d3c6aa', brightWhite: '#d3c6aa'
  },
  'tokyo-day': {
    background: '#e1e2e7', foreground: '#3760bf', cursor: '#3760bf', selectionBackground: 'rgba(52, 84, 138, 0.24)',
    black: '#0f0f14', brightBlack: '#4c505e', red: '#8c4351', brightRed: '#a33c43', green: '#33635c', brightGreen: '#485e30',
    yellow: '#8f5e15', brightYellow: '#8f5e15', blue: '#34548a', brightBlue: '#34548a', magenta: '#5a4a78', brightMagenta: '#5a4a78',
    cyan: '#0f4b6e', brightCyan: '#0f4b6e', white: '#828594', brightWhite: '#4c505e'
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: 'rgba(174, 129, 255, 0.34)',
    black: '#272822', brightBlack: '#75715e', red: '#f92672', brightRed: '#f92672', green: '#a6e22e', brightGreen: '#a6e22e',
    yellow: '#f4bf75', brightYellow: '#f4bf75', blue: '#66d9ef', brightBlue: '#66d9ef', magenta: '#ae81ff', brightMagenta: '#ae81ff',
    cyan: '#a1efe4', brightCyan: '#a1efe4', white: '#f8f8f2', brightWhite: '#f9f8f5'
  }
};

const themeDefinitions: Record<ThemeName, ThemeDefinition> = {
  termius: {
    id: 'termius', label: 'Termius Dark', colorScheme: 'dark', themeColor: '#141728',
    tokens: { bg: '#141728', bgRaised: '#202236', panel: '#202236', panelSoft: '#191c2d', panelHover: '#292d43', panelActive: '#333649', border: 'rgba(216, 221, 224, 0.16)', borderStrong: 'rgba(216, 221, 224, 0.3)', text: '#d6dde0', muted: '#a7b2b9', faint: '#737b8e', blue: '#478fef', blueStrong: '#346baf', primaryText: '#ffffff', focusRing: '#5cc97c', green: '#5cc97c', yellow: '#e7ebed', red: '#e05b57', terminalBg: '#141728', shadow: '0 24px 80px rgba(0, 0, 0, 0.4)' },
    terminal: terminalThemes.termius, swatches: ['#141728', '#202236', '#5cc97c', '#478fef']
  },
  'termius-light': {
    id: 'termius-light', label: 'Termius Light', colorScheme: 'light', themeColor: '#d6dde0',
    tokens: { bg: '#d6dde0', bgRaised: '#f8f9fa', panel: '#eef1f3', panelSoft: '#e4e8eb', panelHover: '#ffffff', panelActive: '#c4d0d8', border: 'rgba(51, 54, 73, 0.2)', borderStrong: 'rgba(51, 54, 73, 0.34)', text: '#333649', muted: '#596174', faint: '#737b8e', blue: '#1c4774', blueStrong: '#16395f', primaryText: '#ffffff', focusRing: '#e05b57', green: '#57b26f', yellow: '#346baf', red: '#c24c48', terminalBg: '#d6dde0', shadow: '0 24px 80px rgba(51, 54, 73, 0.16)' },
    terminal: terminalThemes['termius-light'], swatches: ['#d6dde0', '#f8f9fa', '#333649', '#57b26f']
  },
  'everforest-dark': {
    id: 'everforest-dark', label: 'Everforest Dark', colorScheme: 'dark', themeColor: '#2d353b',
    tokens: { bg: '#2d353b', bgRaised: '#343f44', panel: '#343f44', panelSoft: '#2f3a3f', panelHover: '#3d484d', panelActive: '#475258', border: 'rgba(211, 198, 170, 0.16)', borderStrong: 'rgba(211, 198, 170, 0.3)', text: '#d3c6aa', muted: '#a7c080', faint: '#859289', blue: '#7fbbb3', blueStrong: '#83c092', primaryText: '#2d353b', focusRing: '#a7c080', green: '#a7c080', yellow: '#dbbc7f', red: '#e67e80', terminalBg: '#2d353b', shadow: '0 24px 80px rgba(24, 31, 32, 0.42)' },
    terminal: terminalThemes['everforest-dark'], swatches: ['#2d353b', '#343f44', '#a7c080', '#7fbbb3']
  },
  'tokyo-day': {
    id: 'tokyo-day', label: 'Tokyo Day', colorScheme: 'light', themeColor: '#e1e2e7',
    tokens: { bg: '#e1e2e7', bgRaised: '#f7f7f9', panel: '#f7f7f9', panelSoft: '#ebecef', panelHover: '#ffffff', panelActive: '#d3d5dc', border: 'rgba(55, 96, 191, 0.18)', borderStrong: 'rgba(55, 96, 191, 0.32)', text: '#3760bf', muted: '#6172a6', faint: '#7f849c', blue: '#34548a', blueStrong: '#0f4b6e', primaryText: '#ffffff', focusRing: '#34548a', green: '#33635c', yellow: '#8f5e15', red: '#8c4351', terminalBg: '#e1e2e7', shadow: '0 24px 80px rgba(70, 78, 112, 0.18)' },
    terminal: terminalThemes['tokyo-day'], swatches: ['#e1e2e7', '#f7f7f9', '#3760bf', '#33635c']
  },
  monokai: {
    id: 'monokai', label: 'Monokai', colorScheme: 'dark', themeColor: '#272822',
    tokens: { bg: '#272822', bgRaised: '#34352d', panel: '#34352d', panelSoft: '#2d2e27', panelHover: '#3e3f35', panelActive: '#49483e', border: 'rgba(248, 248, 242, 0.15)', borderStrong: 'rgba(248, 248, 242, 0.3)', text: '#f8f8f2', muted: '#c5c5b8', faint: '#9a9a8d', blue: '#66d9ef', blueStrong: '#a1efe4', primaryText: '#272822', focusRing: '#a6e22e', green: '#a6e22e', yellow: '#f4bf75', red: '#f92672', terminalBg: '#272822', shadow: '0 24px 80px rgba(0, 0, 0, 0.46)' },
    terminal: terminalThemes.monokai, swatches: ['#272822', '#34352d', '#a6e22e', '#66d9ef']
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isThemeName = (value: unknown): value is ThemeName => typeof value === 'string' && themeNames.includes(value as ThemeName);

const isFontSize = (value: unknown): value is TerminalFontSize => value === 12 || value === 13 || value === 14 || value === 16;

const isServerViewMode = (value: unknown): value is ServerViewMode => value === 'list' || value === 'grid';

export const loadPreferences = (): UiPreferences => {
  try {
    const raw = globalThis.localStorage?.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isThemeName(parsed.theme) || !isFontSize(parsed.fontSize)) {
      return { ...DEFAULT_PREFERENCES };
    }
    return { theme: parsed.theme, fontSize: parsed.fontSize, serverViewMode: isServerViewMode(parsed.serverViewMode) ? parsed.serverViewMode : 'list' };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
};

export const savePreferences = (preferences: UiPreferences): void => {
  try {
    globalThis.localStorage?.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({ ...preferences, serverViewMode: preferences.serverViewMode ?? 'list' }));
  } catch {
    // Browser storage can be disabled; the current session still uses the in-memory value.
  }
};

export const getThemeDefinition = (theme: ThemeName): ThemeDefinition => themeDefinitions[theme] ?? themeDefinitions[DEFAULT_PREFERENCES.theme];

const cssTokenNames: ReadonlyArray<readonly [keyof ThemeTokens, string]> = [
  ['bg', '--bg'],
  ['bgRaised', '--bg-raised'],
  ['panel', '--panel'],
  ['panelSoft', '--panel-soft'],
  ['panelHover', '--panel-hover'],
  ['panelActive', '--panel-active'],
  ['border', '--border'],
  ['borderStrong', '--border-strong'],
  ['text', '--text'],
  ['muted', '--muted'],
  ['faint', '--faint'],
  ['blue', '--blue'],
  ['blueStrong', '--blue-strong'],
  ['primaryText', '--primary-text'],
  ['focusRing', '--focus-ring'],
  ['green', '--green'],
  ['yellow', '--yellow'],
  ['red', '--red'],
  ['terminalBg', '--terminal-bg'],
  ['shadow', '--shadow']
];

export const applyPreferences = (preferences: UiPreferences): void => {
  if (typeof document === 'undefined') return;
  const definition = getThemeDefinition(preferences.theme);
  const root = document.documentElement;
  root.dataset.relayTheme = definition.id;
  root.style.setProperty('color-scheme', definition.colorScheme);
  root.style.setProperty('--terminal-font-size', `${preferences.fontSize}px`);
  root.style.setProperty('--accent', definition.tokens.blue);
  for (const [token, cssName] of cssTokenNames) root.style.setProperty(cssName, definition.tokens[token]);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', definition.themeColor);
};

export const bootstrapPreferences = (): UiPreferences => {
  const preferences = loadPreferences();
  applyPreferences(preferences);
  return preferences;
};

export const getTerminalTheme = (theme: ThemeName): TerminalTheme => getThemeDefinition(theme).terminal;
