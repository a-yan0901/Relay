import { describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors';
import { parseTerminalClientMessage, parseTerminalEnvelope } from '@shared/protocol';

describe('parseTerminalClientMessage', () => {
  it('parses the versioned cross-platform terminal envelope', () => {
    expect(parseTerminalEnvelope({
      protocolVersion: 1,
      message: { type: 'ping' }
    })).toEqual({ protocolVersion: 1, message: { type: 'ping' } });
  });

  it('parses a terminal open message', () => {
    expect(parseTerminalClientMessage({
      type: 'open',
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      requestId: 'open-1'
    })).toEqual({
      type: 'open',
      hostId: 'host-1',
      cols: 120,
      rows: 36,
      requestId: 'open-1'
    });
  });

  it('parses resize, input, ping, and close messages', () => {
    expect(parseTerminalClientMessage({ type: 'resize', cols: 80, rows: 24 })).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(parseTerminalClientMessage({ type: 'input', data: 'ls\n' })).toEqual({ type: 'input', data: 'ls\n' });
    expect(parseTerminalClientMessage({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(parseTerminalClientMessage({ type: 'close' })).toEqual({ type: 'close' });
  });

  it('parses a connection-time credential message', () => {
    expect(parseTerminalClientMessage({
      type: 'credential',
      hostId: 'host-1',
      credential: { type: 'password', password: 'filled-at-connect' }
    })).toEqual({
      type: 'credential',
      hostId: 'host-1',
      credential: { type: 'password', password: 'filled-at-connect' }
    });
  });

  it('requires a matching pending fingerprint before trusting a host key', () => {
    const message = { type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:good' } as const;

    expect(() => parseTerminalClientMessage(message, { pendingFingerprint: 'SHA256:bad' })).toThrow(AppError);
    expect(parseTerminalClientMessage(message, { pendingFingerprint: 'SHA256:good' })).toEqual(message);
  });

  it.each([
    { type: 'resize', cols: 0, rows: 24 },
    { type: 'resize', cols: 80, rows: -1 },
    { type: 'open', hostId: '', cols: 80, rows: 24, requestId: 'open' },
    { type: 'unknown' },
    { type: 'input', data: 'x'.repeat(65537) },
    { type: 'host-key-decision', decision: 'ignore', fingerprint: 'SHA256:key' }
  ])('rejects invalid control message %#', (message) => {
    expect(() => parseTerminalClientMessage(message)).toThrow(AppError);
  });
});
