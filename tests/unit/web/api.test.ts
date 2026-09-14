import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSetupStatus } from '../../../src/web/api';

describe('web API request lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('converts a stalled request into an actionable timeout error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = getSetupStatus();
    const rejection = expect(pending).rejects.toMatchObject({ message: '请求超时，请稍后重试', statusCode: 408 });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledWith('/api/setup/status', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
