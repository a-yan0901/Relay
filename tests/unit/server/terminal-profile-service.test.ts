import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { TerminalProfileService } from '../../../src/server/terminal/terminal-profile-service.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

const appearance = {
  foreground: '#d9e7f7', background: '#07111f', cursor: '#73b7ff', cursorAccent: '#07111f', selectionBackground: '#33577f', selectionForeground: '#ffffff',
  black: '#07111f', red: '#ff7d7d', green: '#52d39a', yellow: '#f6c66a', blue: '#5da8ff', magenta: '#c59bff', cyan: '#6ad9d1', white: '#d9e7f7',
  brightBlack: '#5e7490', brightRed: '#ffacac', brightGreen: '#83e9ba', brightYellow: '#ffe3a2', brightBlue: '#8bc7ff', brightMagenta: '#ddc5ff', brightCyan: '#9af3ec', brightWhite: '#ffffff',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 1.25, cursorStyle: 'bar' as const, cursorBlink: true, scrollback: 5_000
};

describe('TerminalProfileService', () => {
  it('uses midnight by default and prevents deletion of the configured default', () => {
    const database = openDatabase(':memory:'); databases.push(database); migrate(database);
    const service = new TerminalProfileService({ database });
    expect(service.getDefault('default').id).toBe('builtin:midnight');
    const created = service.create('default', { name: 'Ops', appearance });
    service.setDefault('default', created.id);
    expect(() => service.delete('default', created.id)).toThrow(expect.objectContaining<AppError>({ code: 'TERMINAL_PROFILE_IN_USE' }));
  });
});
