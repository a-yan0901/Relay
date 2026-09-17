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

export const BUILTIN_TERMINAL_PROFILE_ID = 'builtin:termius';

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
  builtin('termius', 'Termius Dark', { background: '#141728', foreground: '#5cc97c', cursor: '#92a0a7', black: '#141728', brightBlack: '#333649', blue: '#225388', brightBlue: '#346baf', green: '#5cc97c', brightGreen: '#5cc97c', red: '#e05b57', brightRed: '#e16866', yellow: '#e7ebed', brightYellow: '#ffffff', cyan: '#478fef', brightCyan: '#5d9fef', magenta: '#ee7b79', brightMagenta: '#ee7b79', white: '#d6dde0', brightWhite: '#ffffff' }),
  builtin('termius-light', 'Termius Light', { background: '#d6dde0', foreground: '#333649', cursor: '#92a0a7', black: '#141728', brightBlack: '#333649', blue: '#1c4774', brightBlue: '#1c4774', green: '#57b26f', brightGreen: '#57b26f', red: '#c24c48', brightRed: '#e05b57', yellow: '#346baf', brightYellow: '#346baf', cyan: '#3166a6', brightCyan: '#346baf', magenta: '#e16866', brightMagenta: '#e16866', white: '#a7b2b9', brightWhite: '#f8f9fa' }),
  builtin('everforest-dark', 'Everforest Dark', { background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', black: '#475258', brightBlack: '#859289', red: '#e67e80', brightRed: '#e69875', green: '#a7c080', brightGreen: '#a7c080', yellow: '#dbbc7f', brightYellow: '#dbbc7f', blue: '#7fbbb3', brightBlue: '#7fbbb3', magenta: '#d699b6', brightMagenta: '#d699b6', cyan: '#83c092', brightCyan: '#83c092', white: '#d3c6aa', brightWhite: '#d3c6aa' }),
  builtin('tokyo-day', 'Tokyo Day', { background: '#e1e2e7', foreground: '#3760bf', cursor: '#3760bf', black: '#0f0f14', brightBlack: '#4c505e', red: '#8c4351', brightRed: '#a33c43', green: '#33635c', brightGreen: '#485e30', yellow: '#8f5e15', brightYellow: '#8f5e15', blue: '#34548a', brightBlue: '#34548a', magenta: '#5a4a78', brightMagenta: '#5a4a78', cyan: '#0f4b6e', brightCyan: '#0f4b6e', white: '#828594', brightWhite: '#4c505e' }),
  builtin('monokai', 'Monokai', { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', black: '#272822', brightBlack: '#75715e', red: '#f92672', brightRed: '#f92672', green: '#a6e22e', brightGreen: '#a6e22e', yellow: '#f4bf75', brightYellow: '#f4bf75', blue: '#66d9ef', brightBlue: '#66d9ef', magenta: '#ae81ff', brightMagenta: '#ae81ff', cyan: '#a1efe4', brightCyan: '#a1efe4', white: '#f8f8f2', brightWhite: '#f9f8f5' })
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
