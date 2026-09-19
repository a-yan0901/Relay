import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../../src/web/styles.css', import.meta.url), 'utf8');

describe('mobile terminal Vault lock affordance', () => {
  it('keeps the compact terminal lock action visible at narrow widths', () => {
       expect(styles).toMatch(/\.terminal-topbar \.app-header-embedded \.secure-pill\s*\{[^}]*display:\s*flex/u);
    expect(styles).toMatch(/\.terminal-topbar \.app-header-embedded \.secure-pill\s*\{[^}]*min-width:\s*28px/u);
  });

  it('keeps the main workspace lock action visible at narrow widths', () => {
    expect(styles).toMatch(/\.app-header:not\(\.app-header-embedded\) \.secure-pill\s*\{[^}]*display:\s*flex/u);
    expect(styles).toMatch(/\.app-header:not\(\.app-header-embedded\) \.secure-pill\s*\{[^}]*min-width:\s*28px/u);
  });
});
