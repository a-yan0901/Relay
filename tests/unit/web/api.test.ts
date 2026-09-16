import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAccountSession, getSetupStatus, getSyncState, signIn } from '../../../src/web/api';

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

  it('uses same-origin credentials for account calls and keeps the session opaque', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ account: {
      accountId: 'account-1',
      deviceId: 'device-1',
      state: 'signed-in',
      expiresAt: '2026-09-17T00:00:00.000Z'
    } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await signIn('user@example.com', 'one-time-password', '办公室浏览器');
    expect(response.account.accountId).toBe('account-1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/account/session');
    expect(init).toEqual(expect.objectContaining({ credentials: 'same-origin', method: 'POST' }));
    expect(JSON.parse((init as { body?: string }).body as string)).toEqual({ email: 'user@example.com', password: 'one-time-password', deviceLabel: '办公室浏览器' });
    expect(JSON.stringify(response)).not.toContain('one-time-password');
    expect(JSON.stringify(response)).not.toMatch(/token|privateKey|passphrase/iu);
  });

  it('rejects account and sync response fields outside the declared DTOs', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/account/session') return new Response(JSON.stringify({ account: {
        accountId: 'account-1',
        deviceId: 'device-1',
        state: 'signed-in',
        expiresAt: '2026-09-17T00:00:00.000Z',
        token: 'must-not-cross-boundary'
      } }), { status: 200 });
      return new Response(JSON.stringify({ sync: 'synced', head: null, pendingCount: 0, command: 'must-not-cross-boundary' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccountSession()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    await expect(getSyncState()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
  });
});
