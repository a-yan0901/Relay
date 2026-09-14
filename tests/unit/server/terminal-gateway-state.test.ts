import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { TerminalGatewayState } from '../../../src/server/ws/terminal-gateway.js';

describe('TerminalGatewayState', () => {
  it('allows one open, forwards control and binary input, and closes terminal state', async () => {
    const messages: unknown[] = [];
    const binary: Buffer[] = [];
    const closes: string[] = [];
    const state = new TerminalGatewayState({
      onMessage: (message) => { messages.push(message); },
      onBinary: (data) => { binary.push(data); },
      onClose: (reason) => { closes.push(reason); }
    });

    await state.receive(JSON.stringify({
      type: 'open',
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      requestId: 'tab-1'
    }), false);
    await state.receive(JSON.stringify({ type: 'input', data: 'ls\n' }), false);
    await state.receive(Buffer.from('raw input'), true);

    expect(state.lifecycle).toBe('open');
    expect(messages).toEqual([
      expect.objectContaining({ type: 'open' }),
      { type: 'input', data: 'ls\n' }
    ]);
    expect(binary[0].toString()).toBe('raw input');

    await state.receive(JSON.stringify({ type: 'close' }), false);
    expect(state.lifecycle).toBe('closed');
    expect(closes).toEqual(['explicit']);
  });

  it('rejects a second open, invalid messages, oversized frames, and frames after close', async () => {
    const state = new TerminalGatewayState({
      onMessage: () => undefined,
      onBinary: () => undefined,
      onClose: () => undefined
    });
    const open = JSON.stringify({ type: 'open', hostId: 'host-1', cols: 80, rows: 24, requestId: 'tab-1' });
    await state.receive(open, false);

    await expect(state.receive(open, false)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    await expect(state.receive(JSON.stringify({ type: 'unknown' }), false))
      .rejects.toBeInstanceOf(AppError);
    await expect(state.receive(Buffer.alloc(65_537), true))
      .rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });

    state.closeExplicit();
    await expect(state.receive(JSON.stringify({ type: 'ping' }), false))
      .rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
  });

  it('passes the pending host fingerprint into protocol validation', async () => {
    let pendingFingerprint: string | undefined = 'SHA256:fixture-key';
    const state = new TerminalGatewayState({
      getPendingFingerprint: () => pendingFingerprint,
      onMessage: (message) => {
        if (message.type === 'host-key-decision') {
          pendingFingerprint = undefined;
        }
      },
      onBinary: () => undefined,
      onClose: () => undefined
    });
    await state.receive(JSON.stringify({ type: 'open', hostId: 'host-1', cols: 80, rows: 24, requestId: 'tab-1' }), false);

    await expect(state.receive(JSON.stringify({
      type: 'host-key-decision',
      decision: 'trust',
      fingerprint: 'SHA256:wrong'
    }), false)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    await state.receive(JSON.stringify({
      type: 'host-key-decision',
      decision: 'trust',
      fingerprint: 'SHA256:fixture-key'
    }), false);
  });
});
