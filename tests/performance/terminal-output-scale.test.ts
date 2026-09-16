import { describe, expect, it } from 'vitest';

import { TERMINAL_SCROLLBACK_LINES } from '../../src/web/terminal-output.js';

describe('terminal output scale baseline', () => {
  it('keeps the terminal DOM scrollback budget finite', () => {
    expect(TERMINAL_SCROLLBACK_LINES).toBeGreaterThan(0);
    expect(TERMINAL_SCROLLBACK_LINES).toBeLessThanOrEqual(5_000);
  });
});
