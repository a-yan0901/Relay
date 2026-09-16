import { describe, it } from 'vitest';

import { assertAccountSyncContract, assertCoreRuntimeContract } from '../../fixtures/core-runtime-contract.js';
import { createInMemoryAccountSyncPorts, createNativeLikeRuntime } from '../../fixtures/native-runtime.js';

describe('native-like adapter contract', () => {
  it.each(['desktop', 'android'] as const)('satisfies the shared contract on %s', async (platform) => {
    await assertCoreRuntimeContract(createNativeLikeRuntime(platform), { platform });
  });

  it.each(['desktop', 'android'] as const)('shares the optional account/sync contract on %s', async (platform) => {
    const runtime = createNativeLikeRuntime(platform, createInMemoryAccountSyncPorts());
    await assertAccountSyncContract(runtime);
  });
});
