export type ThemeName = 'midnight' | 'light' | 'contrast' | 'nord' | 'dracula' | 'solarized-dark' | 'oled';
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
  theme: 'midnight',
  fontSize: 13
};

const themeNames = ['midnight', 'light', 'contrast', 'nord', 'dracula', 'solarized-dark', 'oled'] as const satisfies readonly ThemeName[];

export const themeOptions: ReadonlyArray<{ value: ThemeName; label: string }> = [
  { value: 'midnight', label: '深夜蓝' },
  { value: 'light', label: '浅色' },
  { value: 'contrast', label: '高对比' },
  { value: 'nord', label: 'Nord 极光' },
  { value: 'dracula', label: 'Dracula 紫夜' },
  { value: 'solarized-dark', label: 'Solarized 暗色' },
  { value: 'oled', label: 'OLED 纯黑' }
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
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: 'rgba(136, 192, 208, 0.32)',
    black: '#2e3440', brightBlack: '#4c566a', blue: '#5e81ac', brightBlue: '#81a1c1', green: '#a3be8c', brightGreen: '#b8d49b',
    red: '#bf616a', brightRed: '#d5777f', yellow: '#ebcb8b', brightYellow: '#f0d49f', cyan: '#8fbcbb', brightCyan: '#a3d6d4',
    magenta: '#b48ead', brightMagenta: '#c49cbe', white: '#d8dee9', brightWhite: '#eceff4'
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: 'rgba(189, 147, 249, 0.34)',
    black: '#21222c', brightBlack: '#6272a4', blue: '#8be9fd', brightBlue: '#a4ffff', green: '#50fa7b', brightGreen: '#69ff94',
    red: '#ff5555', brightRed: '#ff6e6e', yellow: '#f1fa8c', brightYellow: '#ffffa5', cyan: '#8be9fd', brightCyan: '#a4ffff',
    magenta: '#bd93f9', brightMagenta: '#d6acff', white: '#f8f8f2', brightWhite: '#ffffff'
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: 'rgba(38, 139, 210, 0.32)',
    black: '#073642', brightBlack: '#586e75', blue: '#268bd2', brightBlue: '#839496', green: '#859900', brightGreen: '#b4c400',
    red: '#dc322f', brightRed: '#f05b58', yellow: '#b58900', brightYellow: '#d7ad22', cyan: '#2aa198', brightCyan: '#69d1c8',
    magenta: '#d33682', brightMagenta: '#e56ca5', white: '#eee8d5', brightWhite: '#fdf6e3'
  },
  oled: {
    background: '#000000', foreground: '#f5f5f5', cursor: '#ffffff', selectionBackground: 'rgba(108, 182, 255, 0.34)',
    black: '#000000', brightBlack: '#666666', blue: '#6cb6ff', brightBlue: '#9dccff', green: '#56d364', brightGreen: '#7ee787',
    red: '#ff7b72', brightRed: '#ffa198', yellow: '#e3b341', brightYellow: '#f2cc60', cyan: '#76e3ea', brightCyan: '#b3f5f7',
    magenta: '#d2a8ff', brightMagenta: '#e2c5ff', white: '#f0f0f0', brightWhite: '#ffffff'
  }
};

const themeDefinitions: Record<ThemeName, ThemeDefinition> = {
  midnight: {
    id: 'midnight', label: '深夜蓝', colorScheme: 'dark', themeColor: '#07111f',
    tokens: {
      bg: '#07111f', bgRaised: '#0b1728', panel: '#102035', panelSoft: '#0e1b2f', panelHover: '#152a45', panelActive: '#1d3555',
      border: 'rgba(154, 181, 215, 0.14)', borderStrong: 'rgba(154, 181, 215, 0.26)', text: '#e9eef7', muted: '#8ea1ba', faint: '#5f748f',
      blue: '#5da8ff', blueStrong: '#3187e8', primaryText: '#ffffff', focusRing: '#8bc7ff', green: '#52d39a', yellow: '#f6c66a', red: '#ff7d7d', terminalBg: '#07111f', shadow: '0 24px 80px rgba(0, 0, 0, 0.28)'
    },
    terminal: terminalThemes.midnight,
    swatches: ['#07111f', '#102035', '#5da8ff', '#52d39a']
  },
  light: {
    id: 'light', label: '浅色', colorScheme: 'light', themeColor: '#eef3f9',
    tokens: {
      bg: '#eef3f9', bgRaised: '#ffffff', panel: '#ffffff', panelSoft: '#f5f8fc', panelHover: '#edf5ff', panelActive: '#e3effb',
      border: 'rgba(61, 88, 121, 0.18)', borderStrong: 'rgba(61, 88, 121, 0.32)', text: '#1f2f46', muted: '#536985', faint: '#7589a3',
      blue: '#1f6fc7', blueStrong: '#15549e', primaryText: '#ffffff', focusRing: '#1f6fc7', green: '#087f57', yellow: '#936100', red: '#b52828', terminalBg: '#f5f8fc', shadow: '0 24px 80px rgba(45, 72, 104, 0.15)'
    },
    terminal: terminalThemes.light,
    swatches: ['#eef3f9', '#ffffff', '#1f6fc7', '#087f57']
  },
  contrast: {
    id: 'contrast', label: '高对比', colorScheme: 'dark', themeColor: '#000000',
    tokens: {
      bg: '#000000', bgRaised: '#090909', panel: '#0a0a0a', panelSoft: '#101010', panelHover: '#1d1d1d', panelActive: '#292929',
      border: 'rgba(255, 255, 255, 0.42)', borderStrong: 'rgba(255, 255, 255, 0.72)', text: '#ffffff', muted: '#e2e2e2', faint: '#bdbdbd',
      blue: '#66b3ff', blueStrong: '#b3dcff', primaryText: '#000000', focusRing: '#ffffff', green: '#63e6be', yellow: '#ffda75', red: '#ff7b7b', terminalBg: '#000000', shadow: '0 24px 80px rgba(0, 0, 0, 0.7)'
    },
    terminal: terminalThemes.contrast,
    swatches: ['#000000', '#1d1d1d', '#66b3ff', '#ffffff']
  },
  nord: {
    id: 'nord', label: 'Nord 极光', colorScheme: 'dark', themeColor: '#2e3440',
    tokens: {
      bg: '#2e3440', bgRaised: '#3b4252', panel: '#434c5e', panelSoft: '#3b4252', panelHover: '#4c566a', panelActive: '#5e81ac',
      border: 'rgba(216, 222, 233, 0.16)', borderStrong: 'rgba(216, 222, 233, 0.3)', text: '#eceff4', muted: '#d8dee9', faint: '#aeb9c8',
      blue: '#88c0d0', blueStrong: '#81a1c1', primaryText: '#2e3440', focusRing: '#8fbcbb', green: '#a3be8c', yellow: '#ebcb8b', red: '#bf616a', terminalBg: '#2e3440', shadow: '0 24px 80px rgba(20, 24, 32, 0.34)'
    },
    terminal: terminalThemes.nord,
    swatches: ['#2e3440', '#434c5e', '#88c0d0', '#a3be8c']
  },
  dracula: {
    id: 'dracula', label: 'Dracula 紫夜', colorScheme: 'dark', themeColor: '#282a36',
    tokens: {
      bg: '#282a36', bgRaised: '#303241', panel: '#343746', panelSoft: '#303241', panelHover: '#44475a', panelActive: '#6272a4',
      border: 'rgba(248, 248, 242, 0.16)', borderStrong: 'rgba(248, 248, 242, 0.3)', text: '#f8f8f2', muted: '#c7c9d9', faint: '#9699ab',
      blue: '#8be9fd', blueStrong: '#bd93f9', primaryText: '#282a36', focusRing: '#ff79c6', green: '#50fa7b', yellow: '#f1fa8c', red: '#ff5555', terminalBg: '#282a36', shadow: '0 24px 80px rgba(16, 16, 24, 0.4)'
    },
    terminal: terminalThemes.dracula,
    swatches: ['#282a36', '#44475a', '#bd93f9', '#50fa7b']
  },
  'solarized-dark': {
    id: 'solarized-dark', label: 'Solarized 暗色', colorScheme: 'dark', themeColor: '#002b36',
    tokens: {
      bg: '#002b36', bgRaised: '#073642', panel: '#0b3b46', panelSoft: '#073642', panelHover: '#124b58', panelActive: '#1f5965',
      border: 'rgba(147, 161, 161, 0.2)', borderStrong: 'rgba(147, 161, 161, 0.34)', text: '#eee8d5', muted: '#93a1a1', faint: '#657b83',
      blue: '#268bd2', blueStrong: '#2aa198', primaryText: '#fdf6e3', focusRing: '#b58900', green: '#859900', yellow: '#b58900', red: '#dc322f', terminalBg: '#002b36', shadow: '0 24px 80px rgba(0, 25, 32, 0.4)'
    },
    terminal: terminalThemes['solarized-dark'],
    swatches: ['#002b36', '#0b3b46', '#268bd2', '#b58900']
  },
  oled: {
    id: 'oled', label: 'OLED 纯黑', colorScheme: 'dark', themeColor: '#000000',
    tokens: {
      bg: '#000000', bgRaised: '#060606', panel: '#0a0a0a', panelSoft: '#050505', panelHover: '#171717', panelActive: '#252525',
      border: 'rgba(255, 255, 255, 0.14)', borderStrong: 'rgba(255, 255, 255, 0.3)', text: '#f5f5f5', muted: '#b9b9b9', faint: '#777777',
      blue: '#6cb6ff', blueStrong: '#1f8fff', primaryText: '#ffffff', focusRing: '#9dccff', green: '#56d364', yellow: '#e3b341', red: '#ff7b72', terminalBg: '#000000', shadow: '0 24px 80px rgba(0, 0, 0, 0.72)'
    },
    terminal: terminalThemes.oled,
    swatches: ['#000000', '#171717', '#6cb6ff', '#56d364']
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isThemeName = (value: unknown): value is ThemeName => typeof value === 'string' && themeNames.includes(value as ThemeName);

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
