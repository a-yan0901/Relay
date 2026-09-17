import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../../src/web/styles.css', import.meta.url), 'utf8');

describe('terminal layout styles', () => {
  it('keeps enough bottom breathing room for the final xterm row', () => {
    expect(styles).toContain('.terminal-canvas { padding: 7px 9px 12px; }');
  });
});
