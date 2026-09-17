import { z } from 'zod';

const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
});

const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/iu).transform((value) => value.toLowerCase());
const fontFamilySchema = z.string().min(1).max(160).refine((value) => !hasControlCharacter(value));

export const terminalAppearanceSchema = z.object({
  foreground: hexColorSchema,
  background: hexColorSchema,
  cursor: hexColorSchema,
  cursorAccent: hexColorSchema,
  selectionBackground: hexColorSchema,
  selectionForeground: hexColorSchema,
  black: hexColorSchema,
  red: hexColorSchema,
  green: hexColorSchema,
  yellow: hexColorSchema,
  blue: hexColorSchema,
  magenta: hexColorSchema,
  cyan: hexColorSchema,
  white: hexColorSchema,
  brightBlack: hexColorSchema,
  brightRed: hexColorSchema,
  brightGreen: hexColorSchema,
  brightYellow: hexColorSchema,
  brightBlue: hexColorSchema,
  brightMagenta: hexColorSchema,
  brightCyan: hexColorSchema,
  brightWhite: hexColorSchema,
  fontFamily: fontFamilySchema,
  fontSize: z.number().int().min(10).max(24),
  lineHeight: z.number().min(1).max(2),
  cursorStyle: z.enum(['block', 'bar', 'underline']),
  cursorBlink: z.boolean(),
  scrollback: z.number().int().min(500).max(20_000)
}).strict();

export type TerminalAppearance = z.infer<typeof terminalAppearanceSchema>;

export const terminalProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(120).refine((value) => !hasControlCharacter(value)),
  appearance: terminalAppearanceSchema
}).strict();

export type TerminalProfileInput = z.infer<typeof terminalProfileInputSchema>;

export interface TerminalProfile extends TerminalProfileInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const BUILTIN_TERMINAL_PROFILE_ID = 'builtin:midnight';

const defaults = {
  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  cursorStyle: 'bar' as const,
  cursorBlink: true,
  scrollback: 5_000
};

type Palette = Pick<TerminalAppearance,
  'foreground' | 'background' | 'cursor' | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'>;

const appearance = (palette: Palette): TerminalAppearance => ({
  ...palette,
  cursorAccent: palette.background,
  selectionBackground: palette.blue,
  selectionForeground: palette.brightWhite,
  ...defaults
});

const builtin = (id: string, name: string, palette: Palette): TerminalProfile => ({
  id: 'builtin:' + id,
  name,
  appearance: appearance(palette),
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z'
});

export const BUILTIN_TERMINAL_PROFILES: readonly TerminalProfile[] = Object.freeze([
  builtin('midnight', '深夜蓝', { background: '#07111f', foreground: '#d9e7f7', cursor: '#73b7ff', black: '#07111f', brightBlack: '#5e7490', blue: '#5da8ff', brightBlue: '#8bc7ff', green: '#52d39a', brightGreen: '#83e9ba', red: '#ff7d7d', brightRed: '#ffacac', yellow: '#f6c66a', brightYellow: '#ffe3a2', cyan: '#6ad9d1', brightCyan: '#9af3ec', magenta: '#c59bff', brightMagenta: '#ddc5ff', white: '#d9e7f7', brightWhite: '#ffffff' }),
  builtin('light', '浅色', { background: '#f5f8fc', foreground: '#1f2f46', cursor: '#1f6fc7', black: '#1f2f46', brightBlack: '#71829a', blue: '#1f6fc7', brightBlue: '#15549e', green: '#087f57', brightGreen: '#056443', red: '#b52828', brightRed: '#8d1717', yellow: '#936100', brightYellow: '#765000', cyan: '#087b82', brightCyan: '#055c62', magenta: '#7047a4', brightMagenta: '#563182', white: '#eef3f9', brightWhite: '#ffffff' }),
  builtin('contrast', '高对比', { background: '#000000', foreground: '#ffffff', cursor: '#ffffff', black: '#000000', brightBlack: '#aaaaaa', blue: '#66b3ff', brightBlue: '#b3dcff', green: '#63e6be', brightGreen: '#b5f5df', red: '#ff7b7b', brightRed: '#ffc1c1', yellow: '#ffda75', brightYellow: '#fff0b8', cyan: '#74e6e0', brightCyan: '#bffaf6', magenta: '#d2a8ff', brightMagenta: '#ecd8ff', white: '#eeeeee', brightWhite: '#ffffff' }),
  builtin('nord', 'Nord 极光', { background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', black: '#2e3440', brightBlack: '#4c566a', blue: '#5e81ac', brightBlue: '#81a1c1', green: '#a3be8c', brightGreen: '#b8d49b', red: '#bf616a', brightRed: '#d5777f', yellow: '#ebcb8b', brightYellow: '#f0d49f', cyan: '#8fbcbb', brightCyan: '#a3d6d4', magenta: '#b48ead', brightMagenta: '#c49cbe', white: '#d8dee9', brightWhite: '#eceff4' }),
  builtin('dracula', 'Dracula 紫夜', { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', black: '#21222c', brightBlack: '#6272a4', blue: '#8be9fd', brightBlue: '#a4ffff', green: '#50fa7b', brightGreen: '#69ff94', red: '#ff5555', brightRed: '#ff6e6e', yellow: '#f1fa8c', brightYellow: '#ffffa5', cyan: '#8be9fd', brightCyan: '#a4ffff', magenta: '#bd93f9', brightMagenta: '#d6acff', white: '#f8f8f2', brightWhite: '#ffffff' }),
  builtin('solarized-dark', 'Solarized 暗色', { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', black: '#073642', brightBlack: '#586e75', blue: '#268bd2', brightBlue: '#839496', green: '#859900', brightGreen: '#b4c400', red: '#dc322f', brightRed: '#f05b58', yellow: '#b58900', brightYellow: '#d7ad22', cyan: '#2aa198', brightCyan: '#69d1c8', magenta: '#d33682', brightMagenta: '#e56ca5', white: '#eee8d5', brightWhite: '#fdf6e3' }),
  builtin('oled', 'OLED 纯黑', { background: '#000000', foreground: '#f5f5f5', cursor: '#ffffff', black: '#000000', brightBlack: '#666666', blue: '#6cb6ff', brightBlue: '#9dccff', green: '#56d364', brightGreen: '#7ee787', red: '#ff7b72', brightRed: '#ffa198', yellow: '#e3b341', brightYellow: '#f2cc60', cyan: '#76e3ea', brightCyan: '#b3f5f7', magenta: '#d2a8ff', brightMagenta: '#e2c5ff', white: '#f0f0f0', brightWhite: '#ffffff' })
]);

export const isBuiltinTerminalProfileId = (id: string): boolean => BUILTIN_TERMINAL_PROFILES.some((profile) => profile.id === id);

export const resolveTerminalProfile = (
  assignedProfileId: string | null | undefined,
  customProfiles: readonly TerminalProfile[],
  defaultProfileId: string | null | undefined
): TerminalProfile => {
  const lookup = (id: string | null | undefined): TerminalProfile | undefined => {
    if (!id) return undefined;
    return customProfiles.find((profile) => profile.id === id) ?? BUILTIN_TERMINAL_PROFILES.find((profile) => profile.id === id);
  };
  return lookup(assignedProfileId) ?? lookup(defaultProfileId) ?? BUILTIN_TERMINAL_PROFILES[0];
};
