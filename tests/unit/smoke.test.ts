import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs a basic assertion', () => {
    expect('web-ssh').toContain('ssh');
  });
});
