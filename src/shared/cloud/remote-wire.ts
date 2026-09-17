import { z } from 'zod';

import { LIVE_MAX_FRAME_BYTES, LIVE_MAX_PAYLOAD_BYTES, parseLiveFrame, type LiveFrame } from './live-protocol.js';

export const REMOTE_WORKSPACE_WIRE_VERSION = 1 as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    version: z.literal(REMOTE_WORKSPACE_WIRE_VERSION),
    type: z.literal('input'),
    sessionId: z.string().regex(SAFE_ID),
    inputId: z.string().regex(SAFE_ID),
    payload: z.string().min(1)
  }).strict(),
  z.object({
    version: z.literal(REMOTE_WORKSPACE_WIRE_VERSION),
    type: z.literal('resync'),
    sessionId: z.string().regex(SAFE_ID),
    afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  z.object({
    version: z.literal(REMOTE_WORKSPACE_WIRE_VERSION),
    type: z.literal('close')
  }).strict()
]);

const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    version: z.literal(REMOTE_WORKSPACE_WIRE_VERSION),
    type: z.literal('frame'),
    frame: z.unknown()
  }).strict(),
  z.object({
    version: z.literal(REMOTE_WORKSPACE_WIRE_VERSION),
    type: z.literal('state'),
    status: z.enum(['connecting', 'live', 'stale', 'closed', 'offline']),
    ownerDeviceId: z.string().regex(SAFE_ID),
    participantCount: z.number().int().min(0).max(16),
    ownerEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable()
  }).strict(),
  z.object({
    version: z.literal(REMOTE_WORKSPACE_WIRE_VERSION),
    type: z.literal('error'),
    message: z.string().min(1).max(1_024)
  }).strict()
]);

const assertWireBytes = (value: unknown, message: string): void => {
  let bytes: Uint8Array;
  try {
    bytes = new globalThis.TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw new Error(message);
  }
  if (bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error(message);
};

const assertPayloadBytes = (payload: string): void => {
  if (new globalThis.TextEncoder().encode(payload).byteLength > LIVE_MAX_PAYLOAD_BYTES) throw new Error('invalid remote workspace client message');
};

export type RemoteWorkspaceClientMessage =
  | { version: typeof REMOTE_WORKSPACE_WIRE_VERSION; type: 'input'; sessionId: string; inputId: string; payload: string }
  | { version: typeof REMOTE_WORKSPACE_WIRE_VERSION; type: 'resync'; sessionId: string; afterSequence: number }
  | { version: typeof REMOTE_WORKSPACE_WIRE_VERSION; type: 'close' };

export type RemoteWorkspaceServerMessage =
  | { version: typeof REMOTE_WORKSPACE_WIRE_VERSION; type: 'frame'; frame: LiveFrame }
  | { version: typeof REMOTE_WORKSPACE_WIRE_VERSION; type: 'state'; status: 'connecting' | 'live' | 'stale' | 'closed' | 'offline'; ownerDeviceId: string; participantCount: number; ownerEpoch: number | null }
  | { version: typeof REMOTE_WORKSPACE_WIRE_VERSION; type: 'error'; message: string };

export const parseRemoteWorkspaceClientMessage = (value: unknown): RemoteWorkspaceClientMessage => {
  const parsed = clientMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid remote workspace client message');
  if (parsed.data.type === 'input') assertPayloadBytes(parsed.data.payload);
  assertWireBytes(parsed.data, 'invalid remote workspace client message');
  return parsed.data;
};

export const encodeRemoteWorkspaceClientMessage = (value: unknown): RemoteWorkspaceClientMessage => parseRemoteWorkspaceClientMessage(value);

export const parseRemoteWorkspaceServerMessage = (value: unknown): RemoteWorkspaceServerMessage => {
  const parsed = serverMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid remote workspace server message');
  if (parsed.data.type === 'frame') {
    try {
      const frame = parseLiveFrame(parsed.data.frame);
      const result: RemoteWorkspaceServerMessage = { version: 1, type: 'frame', frame };
      assertWireBytes(result, 'invalid remote workspace server message');
      return result;
    } catch {
      throw new Error('invalid remote workspace server message');
    }
  }
  const result = parsed.data as RemoteWorkspaceServerMessage;
  assertWireBytes(result, 'invalid remote workspace server message');
  return result;
};
