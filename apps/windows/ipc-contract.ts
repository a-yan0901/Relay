import { z } from 'zod';

import { AppError, type AppErrorCode } from '../../src/shared/errors.js';
import { hostCredentialSchema } from '../../src/shared/validation.js';

export const DESKTOP_IPC_VERSION = 1 as const;
export const DESKTOP_IPC_MAX_FRAME_BYTES = 64 * 1024;
export const DESKTOP_IPC_MAX_HANDLERS = 96;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const localPathPattern = /^[A-Za-z]:[\\/]/u;

const safeId = z.string().regex(SAFE_ID);
const boundedText = z.string().max(4096);
const emptyPayload = z.object({}).strict();
const idPayload = z.object({ id: safeId }).strict();
const sessionIdPayload = z.object({ sessionId: safeId }).strict();
const transferIdPayload = z.object({ transferId: safeId }).strict();
const writerIdPayload = z.object({ writerId: safeId }).strict();
const runIdPayload = z.object({ runId: safeId }).strict();
const transferResume = z.object({
  transferId: safeId,
  expectedOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  checksum: z.string().regex(/^[a-f0-9]{64}$/iu).nullable()
}).strict();
const remotePath = z.string().min(1).max(4096).refine((value) => (
  !value.includes('\0') && !localPathPattern.test(value)
), 'invalid remote path');
const hostPathPayload = z.object({ hostId: safeId, path: remotePath }).strict();
const sftpListPagePayload = z.object({
  hostId: safeId,
  path: remotePath,
  cursor: z.string().regex(/^(?:0|[1-9]\d*)$/u).max(16).optional(),
  limit: z.number().int().min(1).max(256).optional(),
  filter: z.string().max(128).optional()
}).strict();
const boundedObject = z.record(z.string().max(96), z.unknown()).superRefine((value, context) => {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > DESKTOP_IPC_MAX_FRAME_BYTES / 2) context.addIssue({ code: 'custom', message: 'payload too large' });
  } catch {
    context.addIssue({ code: 'custom', message: 'payload invalid' });
  }
});
const inputPayload = z.object({ input: boundedObject }).strict();

export const DESKTOP_IPC_OPERATIONS = [
  'vault.status',
  'vault.setup',
  'vault.unlock',
  'vault.lock',
  'system.clipboard.readText',
  'system.clipboard.writeText',
  'system.confirm',
  'system.openExternal',
  'system.fileSave.open',
  'system.fileSave.write',
  'system.fileSave.seek',
  'system.fileSave.close',
  'system.fileSave.cancel',
  'connection.test',
  'hosts.list',
  'hosts.get',
  'hosts.listProfiles',
  'hosts.getProfile',
  'hosts.create',
  'hosts.update',
  'hosts.delete',
  'hosts.clearHostKey',
  'identities.list',
  'identities.get',
  'identities.create',
  'identities.update',
  'identities.delete',
  'groups.list',
  'groups.get',
  'groups.create',
  'groups.update',
  'groups.delete',
  'workspace.load',
  'workspace.save',
  'workspace.listTemplates',
  'workspace.createTemplate',
  'workspace.deleteTemplate',
  'terminalProfiles.list',
  'terminalProfiles.getDefault',
  'terminalProfiles.create',
  'terminalProfiles.setDefault',
  'terminalProfiles.delete',
  'sessions.openShell',
  'sessions.reconnect',
  'sessions.write',
  'sessions.resize',
  'sessions.hostKeyDecision',
  'sessions.credential',
  'sessions.close',
  'files.list',
  'files.listPage',
  'files.createDirectory',
  'files.rename',
  'files.remove',
  'files.createTransfer',
  'files.listTransfers',
  'files.getTransfer',
  'files.upload',
  'files.download',
  'files.pauseTransfer',
  'files.cancelTransfer',
  'files.retryTransfer',
  'commands.start',
  'commands.get',
  'commands.cancel',
  'snippets.list',
  'snippets.get',
  'snippets.create',
  'snippets.update',
  'snippets.delete',
  'activity.list',
  'imports.previewExternalImport',
  'imports.applyExternalImport',
  'imports.exportOpenSshConfig',
  'imports.exportCsv',
  'imports.exportVaultBundle',
  'imports.readVaultBundleChunk',
  'imports.releaseVaultBundle',
  'imports.beginVaultImport',
  'imports.writeVaultImportChunk',
  'imports.finishVaultImport',
  'imports.cancelVaultImport',
  'imports.previewVaultImport',
  'imports.applyVaultImport'
] as const;

export type DesktopIpcOperation = (typeof DESKTOP_IPC_OPERATIONS)[number];

const operationSet = new Set<string>(DESKTOP_IPC_OPERATIONS);
const operationPayloadSchemas: Record<DesktopIpcOperation, z.ZodTypeAny> = {
  'vault.status': emptyPayload,
  'vault.setup': z.object({ masterPassword: z.string().min(1).max(4096) }).strict(),
  'vault.unlock': z.object({ masterPassword: z.string().min(1).max(4096) }).strict(),
  'vault.lock': emptyPayload,
  'system.clipboard.readText': emptyPayload,
  'system.clipboard.writeText': z.object({ text: z.string().max(64 * 1024) }).strict(),
  'system.confirm': z.object({ message: z.string().min(1).max(4096) }).strict(),
  'system.openExternal': z.object({ url: z.string().url().max(2048).refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'external URL is not allowed') }).strict(),
  'system.fileSave.open': z.object({
    name: z.string().min(1).max(255).refine((value) => !value.includes('\0') && !/[\\/]/u.test(value), 'invalid file name'),
    mimeType: z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u)
  }).strict(),
  'system.fileSave.write': z.object({ writerId: safeId, data: z.string().max(48 * 1024) }).strict(),
  'system.fileSave.seek': z.object({ writerId: safeId, position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  'system.fileSave.close': writerIdPayload,
  'system.fileSave.cancel': writerIdPayload,
  'connection.test': z.object({ hostId: safeId }).strict(),
  'hosts.list': z.object({ query: boundedText.optional(), groupId: safeId.nullable().optional(), favorite: z.boolean().optional(), tags: z.array(boundedText).max(32).optional() }).strict(),
  'hosts.get': idPayload,
  'hosts.listProfiles': emptyPayload,
  'hosts.getProfile': z.object({ hostId: safeId }).strict(),
  'hosts.create': inputPayload,
  'hosts.update': z.object({ id: safeId, input: boundedObject }).strict(),
  'hosts.delete': idPayload,
  'hosts.clearHostKey': idPayload,
  'identities.list': emptyPayload,
  'identities.get': idPayload,
  'identities.create': inputPayload,
  'identities.update': z.object({ id: safeId, input: boundedObject }).strict(),
  'identities.delete': idPayload,
  'groups.list': emptyPayload,
  'groups.get': idPayload,
  'groups.create': inputPayload,
  'groups.update': z.object({ id: safeId, input: boundedObject }).strict(),
  'groups.delete': idPayload,
  'workspace.load': emptyPayload,
  'workspace.save': z.object({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), state: z.unknown() }).strict(),
  'workspace.listTemplates': emptyPayload,
  'workspace.createTemplate': inputPayload,
  'workspace.deleteTemplate': idPayload,
  'terminalProfiles.list': emptyPayload,
  'terminalProfiles.getDefault': emptyPayload,
  'terminalProfiles.create': inputPayload,
  'terminalProfiles.setDefault': idPayload,
  'terminalProfiles.delete': idPayload,
  'sessions.openShell': z.object({ request: boundedObject }).strict(),
  'sessions.reconnect': sessionIdPayload,
  'sessions.write': z.object({ sessionId: safeId, data: z.string().min(1).max(48 * 1024) }).strict(),
  'sessions.resize': z.object({ sessionId: safeId, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(500) }).strict(),
  'sessions.hostKeyDecision': z.object({ sessionId: safeId, decision: z.enum(['trust', 'reject']), fingerprint: z.string().min(1).max(255).regex(/^SHA256:[A-Za-z0-9+/=_-]+$/u) }).strict(),
  'sessions.credential': z.object({ sessionId: safeId, hostId: safeId, credential: hostCredentialSchema }).strict(),
  'sessions.close': sessionIdPayload,
  'files.list': hostPathPayload,
  'files.listPage': sftpListPagePayload,
  'files.createDirectory': hostPathPayload,
  'files.rename': z.object({ hostId: safeId, from: remotePath, to: remotePath }).strict(),
  'files.remove': hostPathPayload,
  'files.createTransfer': z.object({ request: boundedObject }).strict(),
  'files.listTransfers': emptyPayload,
  'files.getTransfer': transferIdPayload,
  'files.upload': z.object({ transferId: safeId, data: z.string().max(48 * 1024), resume: transferResume, nextChecksum: z.string().regex(/^[a-f0-9]{64}$/iu), final: z.boolean() }).strict(),
  'files.download': z.object({ transferId: safeId, resume: transferResume.optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  'files.pauseTransfer': transferIdPayload,
  'files.cancelTransfer': transferIdPayload,
  'files.retryTransfer': transferIdPayload,
  'commands.start': z.object({ request: boundedObject }).strict(),
  'commands.get': runIdPayload,
  'commands.cancel': runIdPayload,
  'snippets.list': emptyPayload,
  'snippets.get': idPayload,
  'snippets.create': inputPayload,
  'snippets.update': z.object({ id: safeId, input: boundedObject }).strict(),
  'snippets.delete': idPayload,
  'activity.list': z.object({ filter: boundedObject.optional() }).strict(),
  'imports.previewExternalImport': z.object({ files: z.array(z.object({ filename: boundedText, content: z.string().max(DESKTOP_IPC_MAX_FRAME_BYTES), encoding: z.enum(['text', 'base64']) }).strict()).max(16), formatHint: z.enum(['openssh-config', 'ssh-csv', 'mobaxterm', 'xshell', 'securecrt']).optional() }).strict(),
  'imports.applyExternalImport': z.object({ previewId: safeId, input: boundedObject }).strict(),
  'imports.exportOpenSshConfig': emptyPayload,
  'imports.exportCsv': z.object({ options: boundedObject.optional() }).strict(),
  'imports.exportVaultBundle': z.object({ exportPassword: z.string().min(1).max(4096) }).strict(),
  'imports.readVaultBundleChunk': z.object({ bundleId: safeId, cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict(),
  'imports.releaseVaultBundle': z.object({ bundleId: safeId }).strict(),
  'imports.beginVaultImport': z.object({ exportPassword: z.string().min(1).max(4096) }).strict(),
  'imports.writeVaultImportChunk': z.object({ importId: safeId, data: z.string().min(1).max(48 * 1024) }).strict(),
  'imports.finishVaultImport': z.object({ importId: safeId }).strict(),
  'imports.cancelVaultImport': z.object({ importId: safeId }).strict(),
  'imports.previewVaultImport': z.object({ exportPassword: z.string().min(1).max(4096), bundle: z.string().min(1).max(DESKTOP_IPC_MAX_FRAME_BYTES) }).strict(),
  'imports.applyVaultImport': z.object({ previewId: safeId, resolution: boundedObject }).strict()
};

const requestSchema = z.object({
  version: z.literal(DESKTOP_IPC_VERSION),
  requestId: safeId,
  operation: z.string().min(1).max(96),
  payload: z.unknown()
}).strict();

export interface DesktopIpcRequest {
  version: typeof DESKTOP_IPC_VERSION;
  requestId: string;
  operation: DesktopIpcOperation;
  payload: unknown;
}

export type DesktopIpcResponse<T = unknown> =
  | { version: typeof DESKTOP_IPC_VERSION; requestId: string; ok: true; result: T }
  | { version: typeof DESKTOP_IPC_VERSION; requestId: string; ok: false; error: { code: AppErrorCode; message: string } };

const assertFrameBytes = (value: unknown): void => {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
  } catch {
    throw new Error('invalid desktop IPC request');
  }
  if (bytes > DESKTOP_IPC_MAX_FRAME_BYTES) throw new Error('desktop IPC request too large');
};

export const isDesktopIpcOperation = (value: string): value is DesktopIpcOperation => operationSet.has(value);

export const parseDesktopIpcRequest = (value: unknown): DesktopIpcRequest => {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid desktop IPC request');
  if (!isDesktopIpcOperation(parsed.data.operation)) throw new Error('operation not allowed');
  const payload = operationPayloadSchemas[parsed.data.operation].safeParse(parsed.data.payload);
  if (!payload.success) throw new Error('invalid desktop IPC request');
  const request = { ...parsed.data, operation: parsed.data.operation, payload: payload.data };
  assertFrameBytes(request);
  return request;
};

export const encodeDesktopIpcRequest = (value: unknown): DesktopIpcRequest => parseDesktopIpcRequest(value);

const requestIdFrom = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('requestId' in value)) return 'invalid';
  const requestId = value.requestId;
  return typeof requestId === 'string' && SAFE_ID.test(requestId) ? requestId : 'invalid';
};

const errorResponse = (requestId: string, error: unknown): DesktopIpcResponse => {
  if (error instanceof AppError) return { version: DESKTOP_IPC_VERSION, requestId, ok: false, error: { code: error.code, message: error.message } };
  return {
    version: DESKTOP_IPC_VERSION,
    requestId,
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: new AppError('INTERNAL_ERROR').message }
  };
};

export type DesktopIpcHandler = (payload: unknown) => unknown | Promise<unknown>;

export class DesktopIpcRouter {
  private readonly handlers = new Map<DesktopIpcOperation, DesktopIpcHandler>();

  get handlerCount(): number { return this.handlers.size; }
  get handlerLimit(): number { return DESKTOP_IPC_MAX_HANDLERS; }

  register(operation: DesktopIpcOperation, handler: DesktopIpcHandler): void {
    if (!isDesktopIpcOperation(operation)) throw new Error('operation not allowed');
    if (typeof handler !== 'function') throw new Error('invalid desktop IPC handler');
    if (!this.handlers.has(operation) && this.handlers.size >= DESKTOP_IPC_MAX_HANDLERS) throw new Error('desktop IPC handler limit reached');
    this.handlers.set(operation, handler);
  }

  async dispatch(value: unknown): Promise<DesktopIpcResponse> {
    const requestId = requestIdFrom(value);
    let request: DesktopIpcRequest;
    try {
      request = parseDesktopIpcRequest(value);
    } catch (error) {
      return errorResponse(requestId, new AppError('PROTOCOL_INVALID_MESSAGE', error instanceof Error ? error.message : undefined));
    }
    const handler = this.handlers.get(request.operation);
    if (!handler) return errorResponse(request.requestId, new AppError('CAPABILITY_UNAVAILABLE'));
    try {
      return { version: DESKTOP_IPC_VERSION, requestId: request.requestId, ok: true, result: await handler(request.payload) };
    } catch (error) {
      return errorResponse(request.requestId, error);
    }
  }
}
