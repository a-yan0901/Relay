import { describe, it } from 'vitest';

import { assertCoreRuntimeContract } from '../../fixtures/core-runtime-contract.js';
import { createNativeLikeRuntime } from '../../fixtures/native-runtime.js';

describe('native-like adapter contract', () => {
  it.each(['desktop', 'android'] as const)('satisfies the shared contract on %s', async (platform) => {
    await assertCoreRuntimeContract(createNativeLikeRuntime(platform), { platform });
  });
});
