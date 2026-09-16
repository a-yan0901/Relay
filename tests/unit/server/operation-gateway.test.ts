import { describe, expect, it, vi } from 'vitest';

import { OperationEventBus } from '../../../src/server/ws/operation-gateway.js';

describe('OperationEventBus', () => {
  it('publishes sanitized lifecycle diagnostics only to the matching owner', () => {
    const bus = new OperationEventBus();
    const ownerListener = vi.fn();
    const otherListener = vi.fn();
    bus.subscribe('owner-a', ownerListener);
    bus.subscribe('owner-b', otherListener);

    bus.publishDiagnostic('owner-a', {
      operationId: 'transfer-1',
      hostId: 'host-1',
      kind: 'transfer',
      stage: 'sftp',
      state: 'interrupted',
      retryable: true,
      nextAction: 'retry',
      errorCode: 'SERVICE_RESTARTED',
      startedAt: '2026-09-16T00:00:00.000Z',
      endedAt: '2026-09-16T00:00:01.000Z'
    });

    expect(ownerListener).toHaveBeenCalledWith(expect.objectContaining({ type: 'diagnostic', diagnostic: expect.objectContaining({ nextAction: 'retry' }) }));
    expect(otherListener).not.toHaveBeenCalled();
  });
});
