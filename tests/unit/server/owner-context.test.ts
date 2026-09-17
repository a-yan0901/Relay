import { describe, expect, it } from 'vitest';

import { currentOwnerId, DEFAULT_OWNER_ID, runWithOwnerId } from '../../../src/server/auth/owner-context.js';

describe('request owner context', () => {
  it('keeps account owner selection scoped to the async chain', async () => {
    expect(currentOwnerId()).toBe(DEFAULT_OWNER_ID);
    await runWithOwnerId('account-a', async () => {
      expect(currentOwnerId()).toBe('account-a');
      await Promise.resolve();
      expect(currentOwnerId()).toBe('account-a');
    });
    expect(currentOwnerId()).toBe(DEFAULT_OWNER_ID);
  });
});
