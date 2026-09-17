import { Sha256 } from '../crypto/sha256.js';
import { createCapabilitySet } from '../core/capabilities.js';
import type { Capability, ClientPlatform, ConnectionProfile, HostListFilter, SftpEntry, TransferJob, TransferRequest, TransferResumeRequest, CommandRun, CommandRunRequest, ActivityFilter, ActivityPage, IdentityMetadata, GroupNode, WorkspaceState, WorkspaceTemplate, WorkspaceTemplateInput, VaultStatus, ConnectionTestResult, Snippet, SnippetMetadata } from '../core/models.js';
import type { HostMetadata } from '../validation.js';
import type { AccountSessionPort, ActivityStore, BinarySource, CommandTransport, ConnectionProbe, DeviceTrustPort, FileTransport, GroupStore, HostStore, IdentityStore, ImportExportPort, PlatformServices, SecretRef, SecretStore, SessionEvent, SessionHandle, SessionTransport, SnippetStore, SyncPort, TerminalProfileStore, VaultSessionPort, WorkspaceStore, OpenShellRequest } from '../core/ports.js';
import type { CoreRuntime } from '../core/runtime.js';
import type { ImportApplyRequest, ImportApplyResult, ImportFormat, ImportPreview, ImportSourceFile, ExportOptions, VaultBundleApplyResult, VaultBundlePreview, VaultBundleResolution } from '../import/types.js';
import type { TerminalProfile } from '../terminal-appearance.js';
import { AppError } from '../errors.js';
import { type NativeEventFrame } from './bridge.js';

export const NATIVE_TRANSFER_CHUNK_BYTES = 32 * 1024;
export const NATIVE_MAX_SESSION_HANDLERS = 16;
export const NATIVE_MAX_SESSIONS = 32;
export const NATIVE_MAX_PENDING_WRITES = 8;
export const NATIVE_MAX_PENDING_WRITE_BYTES = 64 * 1024;

const createTextDecoder = (): globalThis.TextDecoder => new globalThis.TextDecoder();
type NativeTextDecoder = ReturnType<typeof createTextDecoder>;

export interface NativeOperationPort {
  invoke<T = unknown>(operation: string, payload: unknown): Promise<T>;
  subscribe(listener: (event: NativeEventFrame) => void): () => void;
}

export interface NativeCoreRuntimeOptions {
  platform: Extract<ClientPlatform, 'desktop' | 'android'>;
  port: NativeOperationPort;
  capabilities?: readonly Capability[];
  platformServices?: PlatformServices;
  account?: AccountSessionPort;
  devices?: DeviceTrustPort;
  sync?: SyncPort;
}

const NATIVE_CAPABILITIES: readonly Capability[] = [
  'workspace.persistence',
  'workspace.templates',
  'workspace.multi-pane',
  'workspace.max-panes',
  'terminal.broadcast',
  'transfer.resume',
  'sftp.local-files',
  'session.reattach',
  'vault.bundle',
  'vault.identities',
  'ssh.shell',
  'ssh.reconnect',
  'ssh.proxy-jump',
  'sftp.browse',
  'sftp.transfer',
  'sftp.entry-mutations',
  'automation.snippets',
  'automation.snippet-manager',
  'automation.batch-exec',
  'automation.target-picker',
  'audit.activity',
  'session.lifecycle-status'
];

/**
 * Android only advertises the operations backed by the current native slice.
 * Keeping this list explicit prevents the UI from exposing identities,
 * snippets, templates or other unsupported automation while their native
 * ports are not present.
 */
export const ANDROID_LOCAL_CAPABILITIES: readonly Capability[] = [
  'workspace.persistence',
  'ssh.shell',
  'ssh.reconnect',
  'ssh.proxy-jump',
  'sftp.browse',
  'sftp.transfer',
  'transfer.resume',
  'sftp.local-files',
  'sftp.entry-mutations',
  'session.lifecycle-status'
];

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const asText = (value: unknown): string | null => typeof value === 'string' ? value : null;

const toBase64Url = (value: Uint8Array): string => {
  if (typeof globalThis.btoa !== 'function') throw new Error('base64 encoder unavailable');
  let binary = '';
  for (const byte of value) binary += String.fromCodePoint(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > 48 * 1024) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  if (typeof globalThis.atob !== 'function') throw new Error('base64 decoder unavailable');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = globalThis.atob(padded);
  if (binary.length > NATIVE_TRANSFER_CHUNK_BYTES) throw new AppError('FILE_TOO_LARGE');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
};

const bytesFromResult = (value: unknown): Uint8Array => {
  const record = asRecord(value);
  const encoded = record ? asText(record.data) : asText(value);
  if (encoded === null) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return fromBase64Url(encoded);
};

const jobFromResult = (value: unknown): TransferJob => {
  const record = asRecord(value);
  const job = asRecord(record?.job ?? value);
  if (!job || typeof job.id !== 'string' || typeof job.status !== 'string') throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return job as unknown as TransferJob;
};

class NativeVaultSession implements VaultSessionPort {
  constructor(private readonly port: NativeOperationPort) {}
  status(): Promise<VaultStatus> { return this.port.invoke('vault.status', {}); }
  setup(masterPassword: string): Promise<VaultStatus> { return this.port.invoke('vault.setup', { masterPassword }); }
  unlock(masterPassword: string): Promise<VaultStatus> { return this.port.invoke('vault.unlock', { masterPassword }); }
  async lock(): Promise<void> { await this.port.invoke('vault.lock', {}); }
}

class NativeConnectionProbe implements ConnectionProbe {
  constructor(private readonly port: NativeOperationPort) {}
  test(hostId: string): Promise<ConnectionTestResult> { return this.port.invoke('connection.test', { hostId }); }
}

class NativeHostStore implements HostStore {
  constructor(private readonly port: NativeOperationPort) {}
  list(filter: HostListFilter = {}): Promise<readonly HostMetadata[]> { return this.port.invoke('hosts.list', filter); }
  async get(id: string): Promise<HostMetadata | null> {
    try { return await this.port.invoke('hosts.get', { id }); } catch (error) {
      if (error instanceof AppError && error.code === 'HOST_NOT_FOUND') return null;
      throw error;
    }
  }
  listProfiles(): Promise<readonly ConnectionProfile[]> { return this.port.invoke('hosts.listProfiles', {}); }
  async getProfile(hostId: string): Promise<ConnectionProfile | null> {
    try { return await this.port.invoke('hosts.getProfile', { hostId }); } catch (error) {
      if (error instanceof AppError && error.code === 'HOST_NOT_FOUND') return null;
      throw error;
    }
  }
  create(input: unknown): Promise<HostMetadata> { return this.port.invoke('hosts.create', { input }); }
  update(id: string, input: unknown): Promise<HostMetadata> { return this.port.invoke('hosts.update', { id, input }); }
  async delete(id: string): Promise<void> { await this.port.invoke('hosts.delete', { id }); }
  async clearHostKey(id: string): Promise<void> { await this.port.invoke('hosts.clearHostKey', { id }); }
}

class NativeIdentityStore implements IdentityStore {
  constructor(private readonly port: NativeOperationPort) {}
  list(): Promise<readonly IdentityMetadata[]> { return this.port.invoke('identities.list', {}); }
  async get(id: string): Promise<IdentityMetadata | null> {
    try { return await this.port.invoke('identities.get', { id }); } catch (error) {
      if (error instanceof AppError && error.code === 'IDENTITY_NOT_FOUND') return null;
      throw error;
    }
  }
  create(input: unknown): Promise<IdentityMetadata> { return this.port.invoke('identities.create', { input }); }
  update(id: string, input: unknown): Promise<IdentityMetadata> { return this.port.invoke('identities.update', { id, input }); }
  async delete(id: string): Promise<void> { await this.port.invoke('identities.delete', { id }); }
}

class NativeGroupStore implements GroupStore {
  constructor(private readonly port: NativeOperationPort) {}
  list(): Promise<readonly GroupNode[]> { return this.port.invoke('groups.list', {}); }
  async get(id: string): Promise<GroupNode | null> {
    try { return await this.port.invoke('groups.get', { id }); } catch (error) {
      if (error instanceof AppError && error.code === 'GROUP_NOT_FOUND') return null;
      throw error;
    }
  }
  create(input: unknown): Promise<GroupNode> { return this.port.invoke('groups.create', { input }); }
  update(id: string, input: unknown): Promise<GroupNode> { return this.port.invoke('groups.update', { id, input }); }
  async delete(id: string): Promise<void> { await this.port.invoke('groups.delete', { id }); }
}

class NativeWorkspaceStore implements WorkspaceStore {
  constructor(private readonly port: NativeOperationPort) {}
  load(): Promise<WorkspaceState> { return this.port.invoke('workspace.load', {}); }
  save(expectedVersion: number, state: WorkspaceState): Promise<WorkspaceState> { return this.port.invoke('workspace.save', { expectedVersion, state }); }
  listTemplates(): Promise<readonly WorkspaceTemplate[]> { return this.port.invoke('workspace.listTemplates', {}); }
  createTemplate(input: WorkspaceTemplateInput): Promise<WorkspaceTemplate> { return this.port.invoke('workspace.createTemplate', { input }); }
  async deleteTemplate(templateId: string): Promise<void> { await this.port.invoke('workspace.deleteTemplate', { id: templateId }); }
}

class NativeTerminalProfileStore implements TerminalProfileStore {
  constructor(private readonly port: NativeOperationPort) {}
  async list(): Promise<readonly TerminalProfile[]> { return this.port.invoke('terminalProfiles.list', {}); }
  getDefault(): Promise<TerminalProfile> { return this.port.invoke('terminalProfiles.getDefault', {}); }
  create(input: unknown): Promise<TerminalProfile> { return this.port.invoke('terminalProfiles.create', { input }); }
  setDefault(profileId: string): Promise<TerminalProfile> { return this.port.invoke('terminalProfiles.setDefault', { id: profileId }); }
  async delete(profileId: string): Promise<void> { await this.port.invoke('terminalProfiles.delete', { id: profileId }); }
}

interface NativeSessionRecord {
  id: string;
  hostId: string;
  listeners: Set<(event: SessionEvent) => void>;
  earlyEvents: SessionEvent[];
  stdoutDecoder: NativeTextDecoder;
  stderrDecoder: NativeTextDecoder;
  pendingWrites: number;
  writeQueue: string[];
  writeQueueBytes: number;
  writePumpActive: boolean;
  writeBackpressureNotified: boolean;
  closed: boolean;
}

const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > 48 * 1024 || typeof globalThis.atob !== 'function') return null;
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = globalThis.atob(padded);
    if (binary.length > NATIVE_TRANSFER_CHUNK_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
    return bytes;
  } catch {
    return null;
  }
};

const sessionEventFromNative = (event: NativeEventFrame, record: NativeSessionRecord): SessionEvent | null => {
  const payload = asRecord(event.payload);
  if (event.kind === 'terminal.output' && payload) {
    const data = asText(payload.data) ?? asText(payload.text);
    if (data === null) return null;
    if (payload.encoding === 'base64url') {
      const bytes = decodeBase64Url(data);
      if (bytes === null) return null;
      const decoder = payload.stream === 'stderr' ? record.stderrDecoder : record.stdoutDecoder;
      return { type: payload.stream === 'stderr' ? 'stderr' : 'data', data: decoder.decode(bytes, { stream: true }) };
    }
    return { type: payload.stream === 'stderr' ? 'stderr' : 'data', data };
  }
  if (event.kind === 'terminal.exit' && payload) {
    return { type: 'exit', code: typeof payload.code === 'number' ? payload.code : null, ...(typeof payload.signal === 'string' ? { signal: payload.signal } : {}) };
  }
  if (event.kind === 'terminal.diagnostic' && payload?.diagnostic) return { type: 'diagnostic', diagnostic: payload.diagnostic as SessionEvent['diagnostic'] };
  if (event.kind === 'terminal.close') return { type: 'close' };
  return null;
};

class NativeSessionTransport implements SessionTransport {
  private readonly sessions = new Map<string, NativeSessionRecord>();
  private stopEvents: (() => void) | undefined;

  private publish(record: NativeSessionRecord, event: SessionEvent): void {
    if (record.listeners.size === 0) {
      if (record.earlyEvents.length < 16) record.earlyEvents.push(event);
      return;
    }
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch {
        // A renderer listener must not interrupt native event delivery.
      }
    }
  }

  private reportWriteBackpressure(record: NativeSessionRecord): void {
    if (record.writeBackpressureNotified) return;
    record.writeBackpressureNotified = true;
    const at = new Date().toISOString();
    this.publish(record, {
      type: 'diagnostic',
      diagnostic: {
        operationId: record.id,
        hostId: record.hostId,
        kind: 'terminal',
        stage: 'pty',
        state: 'interrupted',
        retryable: true,
        nextAction: 'reopen',
        errorCode: 'NATIVE_WRITE_BACKPRESSURE',
        requestId: record.id,
        startedAt: at,
        endedAt: at
      }
    });
  }

  private reportWriteFailure(record: NativeSessionRecord): void {
    const at = new Date().toISOString();
    this.publish(record, {
      type: 'diagnostic',
      diagnostic: {
        operationId: record.id,
        hostId: record.hostId,
        kind: 'terminal',
        stage: 'pty',
        state: 'interrupted',
        retryable: true,
        nextAction: 'reopen',
        errorCode: 'NATIVE_WRITE_FAILED',
        requestId: record.id,
        startedAt: at,
        endedAt: at
      }
    });
  }

  private async drainWrites(record: NativeSessionRecord): Promise<void> {
    if (record.writePumpActive) return;
    record.writePumpActive = true;
    try {
      while (!record.closed && record.writeQueue.length > 0) {
        const data = record.writeQueue.shift();
        if (data === undefined) break;
        record.writeQueueBytes -= data.length;
        record.pendingWrites += 1;
        try {
          await this.port.invoke('sessions.write', { sessionId: record.id, data });
        } catch {
          this.reportWriteFailure(record);
        } finally {
          record.pendingWrites = Math.max(0, record.pendingWrites - 1);
        }
      }
    } finally {
      record.writePumpActive = false;
    }
  }

  constructor(private readonly port: NativeOperationPort) {}

  private ensureEvents(): void {
    if (this.stopEvents) return;
    this.stopEvents = this.port.subscribe((event) => {
      if (!event.sessionId) return;
      const record = this.sessions.get(event.sessionId);
      if (!record) return;
      const sessionEvent = sessionEventFromNative(event, record);
      if (!sessionEvent) return;
      if (sessionEvent.type === 'close') record.closed = true;
      this.publish(record, sessionEvent);
    });
  }

  private stopEventsIfIdle(): void {
    if (this.sessions.size !== 0) return;
    this.stopEvents?.();
    this.stopEvents = undefined;
  }

  private handle(record: NativeSessionRecord): SessionHandle {
    return {
      id: record.id,
      hostId: record.hostId,
      write: (data) => {
        if (record.closed || data.length === 0) return;
        if (data.length > NATIVE_TRANSFER_CHUNK_BYTES || record.pendingWrites + record.writeQueue.length >= NATIVE_MAX_PENDING_WRITES || record.writeQueueBytes + data.length > NATIVE_MAX_PENDING_WRITE_BYTES) {
          this.reportWriteBackpressure(record);
          return;
        }
        record.writeQueue.push(data);
        record.writeQueueBytes += data.length;
        record.writeBackpressureNotified = false;
        void this.drainWrites(record);
      },
      resize: (cols, rows) => {
        if (record.closed) return;
        void this.port.invoke('sessions.resize', { sessionId: record.id, cols, rows }).catch(() => undefined);
      },
      close: () => { void this.close(record.id); },
      subscribe: (listener) => {
        if (record.listeners.size >= NATIVE_MAX_SESSION_HANDLERS) throw new Error('native session listener limit reached');
        record.listeners.add(listener);
        if (record.earlyEvents.length > 0) {
          const earlyEvents = record.earlyEvents.splice(0, record.earlyEvents.length);
          for (const event of earlyEvents) {
            try {
              listener(event);
            } catch {
              // A renderer listener must not interrupt subscription setup.
            }
          }
        }
        return () => record.listeners.delete(listener);
      }
    };
  }

  async openShell(request: OpenShellRequest): Promise<SessionHandle> {
    await this.close(request.sessionId);
    if (this.sessions.size >= NATIVE_MAX_SESSIONS) throw new AppError('SSH_SESSION_LIMIT');
    this.ensureEvents();
    const record: NativeSessionRecord = { id: request.sessionId, hostId: request.profile.hostId, listeners: new Set(), earlyEvents: [], stdoutDecoder: createTextDecoder(), stderrDecoder: createTextDecoder(), pendingWrites: 0, writeQueue: [], writeQueueBytes: 0, writePumpActive: false, writeBackpressureNotified: false, closed: false };
    this.sessions.set(record.id, record);
    let result: { sessionId?: string; hostId?: string };
    try {
      result = await this.port.invoke<{ sessionId?: string; hostId?: string }>('sessions.openShell', { request });
    } catch (error) {
      this.sessions.delete(record.id);
      this.stopEventsIfIdle();
      throw error;
    }
    const id = result.sessionId ?? request.sessionId;
    if (id !== record.id) {
      this.sessions.delete(record.id);
      record.id = id;
      this.sessions.set(id, record);
    }
    record.hostId = result.hostId ?? request.profile.hostId;
    this.ensureEvents();
    return this.handle(record);
  }

  async reconnect(sessionId: string): Promise<SessionHandle> {
    this.ensureEvents();
    const existing = this.sessions.get(sessionId);
    const record = existing ?? { id: sessionId, hostId: '', listeners: new Set(), earlyEvents: [], stdoutDecoder: createTextDecoder(), stderrDecoder: createTextDecoder(), pendingWrites: 0, writeQueue: [], writeQueueBytes: 0, writePumpActive: false, writeBackpressureNotified: false, closed: false };
    if (!existing) this.sessions.set(record.id, record);
    let result: { sessionId?: string; hostId?: string };
    try {
      result = await this.port.invoke<{ sessionId?: string; hostId?: string }>('sessions.reconnect', { sessionId });
    } catch (error) {
      if (!existing) this.sessions.delete(record.id);
      this.stopEventsIfIdle();
      throw error;
    }
    if (result.sessionId !== undefined && result.sessionId !== record.id) {
      this.sessions.delete(record.id);
      record.id = result.sessionId;
      this.sessions.set(record.id, record);
    }
    record.hostId = result.hostId ?? record.hostId;
    record.closed = false;
    this.ensureEvents();
    return this.handle(record);
  }

  async close(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.sessions.delete(sessionId);
    record.closed = true;
    record.writeQueue.length = 0;
    record.writeQueueBytes = 0;
    record.listeners.clear();
    await this.port.invoke('sessions.close', { sessionId }).catch(() => undefined);
    this.stopEventsIfIdle();
  }
}

const copyBytes = (value: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
};

class NativeFileTransport implements FileTransport {
  constructor(private readonly port: NativeOperationPort) {}

  list(hostId: string, path: string): Promise<readonly SftpEntry[]> { return this.port.invoke('files.list', { hostId, path }); }
  async createDirectory(hostId: string, path: string): Promise<void> { await this.port.invoke('files.createDirectory', { hostId, path }); }
  async rename(hostId: string, from: string, to: string): Promise<void> { await this.port.invoke('files.rename', { hostId, from, to }); }
  async remove(hostId: string, path: string): Promise<void> { await this.port.invoke('files.remove', { hostId, path }); }
  createTransfer(request: TransferRequest): Promise<TransferJob> { return this.port.invoke('files.createTransfer', { request }); }
  listTransfers(): Promise<readonly TransferJob[]> { return this.port.invoke('files.listTransfers', {}); }
  getTransfer(transferId: string): Promise<TransferJob | null> { return this.port.invoke('files.getTransfer', { transferId }); }

  async upload(transferId: string, source: BinarySource, resume?: TransferResumeRequest): Promise<TransferJob> {
    const iterator = source.stream()[Symbol.asyncIterator]();
    const hash = new Sha256();
    const initialOffset = resume?.expectedOffset ?? 0;
    const expectedChecksum = resume?.checksum ?? null;
    let sourceOffset = 0;
    let serverOffset = initialOffset;
    let pending = new Uint8Array(0);
    let sourceChunk: Uint8Array | null = null;
    let sourceChunkOffset = 0;
    let ended = false;

    const read = async (): Promise<void> => {
      while (!ended && pending.byteLength < NATIVE_TRANSFER_CHUNK_BYTES) {
        if (sourceChunk === null || sourceChunkOffset >= sourceChunk.byteLength) {
          const next = await iterator.next();
          if (next.done) { ended = true; return; }
          sourceChunk = next.value;
          sourceChunkOffset = 0;
          if (sourceChunk.byteLength === 0) {
            sourceChunk = null;
            continue;
          }
        }
        const take = Math.min(NATIVE_TRANSFER_CHUNK_BYTES - pending.byteLength, sourceChunk.byteLength - sourceChunkOffset);
        const merged = new Uint8Array(pending.byteLength + take);
        merged.set(pending);
        merged.set(sourceChunk.subarray(sourceChunkOffset, sourceChunkOffset + take), pending.byteLength);
        sourceChunkOffset += take;
        pending = merged;
      }
    };

    try {
      for (;;) {
        await read();
        if (pending.byteLength === 0 && ended) {
          const checksum = hash.digestHex();
          const result = await this.port.invoke('files.upload', { transferId, data: '', resume: { transferId, expectedOffset: serverOffset, checksum: serverOffset === 0 ? null : expectedChecksum }, nextChecksum: checksum, final: true });
          return jobFromResult(result);
        }
        if (pending.byteLength === 0) continue;

        if (sourceOffset < initialOffset) {
          const skip = Math.min(pending.byteLength, initialOffset - sourceOffset);
          hash.update(pending.subarray(0, skip));
          sourceOffset += skip;
          pending = pending.subarray(skip);
          if (sourceOffset < initialOffset) continue;
          if (expectedChecksum !== null && hash.digestHex() !== expectedChecksum.toLowerCase()) throw new AppError('TRANSFER_RESUME_INVALID');
          if (pending.byteLength === 0) continue;
        }

        const take = Math.min(NATIVE_TRANSFER_CHUNK_BYTES, pending.byteLength);
        const chunk = copyBytes(pending.subarray(0, take));
        pending = pending.subarray(take);
        const checksumBefore = hash.digestHex();
        hash.update(chunk);
        const final = ended && pending.byteLength === 0;
        const result = await this.port.invoke('files.upload', {
          transferId,
          data: toBase64Url(chunk),
          resume: { transferId, expectedOffset: serverOffset, checksum: serverOffset === 0 ? null : checksumBefore },
          nextChecksum: hash.digestHex(),
          final
        });
        serverOffset += chunk.byteLength;
        if (final) return jobFromResult(result);
      }
    } finally {
      await iterator.return?.();
    }
  }

  async download(transferId: string, resume?: TransferResumeRequest): Promise<AsyncIterable<Uint8Array>> {
    return (async function* (port: NativeOperationPort): AsyncGenerator<Uint8Array> {
      let offset = resume?.expectedOffset ?? 0;
      let first = true;
      for (;;) {
        const result = await port.invoke<{ data: string; done: boolean }>('files.download', {
          transferId,
          offset,
          ...(first && resume ? { resume } : {})
        });
        const chunk = fromBase64Url(result.data);
        if (chunk.byteLength > 0) {
          offset += chunk.byteLength;
          yield chunk;
        }
        if (result.done) return;
        if (chunk.byteLength === 0) throw new AppError('SFTP_TRANSFER_FAILED');
        first = false;
      }
    })(this.port);
  }

  async pauseTransfer(transferId: string): Promise<void> { await this.port.invoke('files.pauseTransfer', { transferId }); }
  async cancelTransfer(transferId: string): Promise<void> { await this.port.invoke('files.cancelTransfer', { transferId }); }
  retryTransfer(transferId: string): Promise<TransferJob> { return this.port.invoke('files.retryTransfer', { transferId }); }
}

class NativeCommandTransport implements CommandTransport {
  constructor(private readonly port: NativeOperationPort) {}
  start(request: CommandRunRequest): Promise<CommandRun> { return this.port.invoke('commands.start', { request }); }
  get(runId: string): Promise<CommandRun | null> { return this.port.invoke('commands.get', { runId }); }
  async cancel(runId: string): Promise<void> { await this.port.invoke('commands.cancel', { runId }); }
}

class NativeSnippetStore implements SnippetStore {
  constructor(private readonly port: NativeOperationPort) {}
  list(): Promise<readonly SnippetMetadata[]> { return this.port.invoke('snippets.list', {}); }
  async get(id: string): Promise<Snippet | null> {
    try { return await this.port.invoke('snippets.get', { id }); } catch (error) {
      if (error instanceof AppError && error.code === 'SNIPPET_NOT_FOUND') return null;
      throw error;
    }
  }
  create(input: unknown): Promise<Snippet> { return this.port.invoke('snippets.create', { input }); }
  update(id: string, input: unknown): Promise<Snippet> { return this.port.invoke('snippets.update', { id, input }); }
  async delete(id: string): Promise<void> { await this.port.invoke('snippets.delete', { id }); }
}

class NativeActivityStore implements ActivityStore {
  constructor(private readonly port: NativeOperationPort) {}
  list(filter: ActivityFilter = {}): Promise<ActivityPage> { return this.port.invoke('activity.list', { filter }); }
}

class NativeImportExport implements ImportExportPort {
  constructor(private readonly port: NativeOperationPort) {}

  previewExternalImport(files: readonly ImportSourceFile[], formatHint?: ImportFormat): Promise<ImportPreview> {
    const encoded = files.map((file) => ({ filename: file.filename, content: typeof file.content === 'string' ? file.content : toBase64Url(file.content), encoding: typeof file.content === 'string' ? 'text' : 'base64' }));
    return this.port.invoke('imports.previewExternalImport', { files: encoded, ...(formatHint === undefined ? {} : { formatHint }) });
  }
  applyExternalImport(previewId: string, input: ImportApplyRequest): Promise<ImportApplyResult> { return this.port.invoke('imports.applyExternalImport', { previewId, input }); }
  async exportOpenSshConfig(): Promise<Uint8Array> { return bytesFromResult(await this.port.invoke('imports.exportOpenSshConfig', {})); }
  async exportCsv(options?: ExportOptions): Promise<Uint8Array> { return bytesFromResult(await this.port.invoke('imports.exportCsv', { ...(options === undefined ? {} : { options }) })); }
  async exportVaultBundle(exportPassword: string): Promise<string> { const result = await this.port.invoke<{ bundle?: string }>('imports.exportVaultBundle', { exportPassword }); if (!result.bundle) throw new AppError('PROTOCOL_INVALID_MESSAGE'); return result.bundle; }
  previewVaultImport(exportPassword: string, bundle: string): Promise<VaultBundlePreview> { return this.port.invoke('imports.previewVaultImport', { exportPassword, bundle }); }
  applyVaultImport(previewId: string, resolution: VaultBundleResolution): Promise<VaultBundleApplyResult> { return this.port.invoke('imports.applyVaultImport', { previewId, resolution }); }
}

class NativeSecretStore implements SecretStore {
  async get(_ref: SecretRef): Promise<null> { return null; }
  async set(): Promise<void> { throw new AppError('CAPABILITY_UNAVAILABLE', '原生客户端不通过渲染层读取凭据'); }
  async remove(): Promise<void> { throw new AppError('CAPABILITY_UNAVAILABLE', '原生客户端不通过渲染层删除凭据'); }
}

export interface NativeCoreRuntime extends CoreRuntime {
  refreshCapabilities(): Promise<CoreRuntime['capabilities']>;
}

export const createNativeCoreRuntime = (options: NativeCoreRuntimeOptions): NativeCoreRuntime => {
  const baseCapabilities = options.capabilities ?? NATIVE_CAPABILITIES;
  const runtime: NativeCoreRuntime = {
    platform: options.platform,
    capabilities: createCapabilitySet(options.platform, baseCapabilities),
    negotiateCapabilities: async () => runtime.capabilities,
    refreshCapabilities: async () => runtime.capabilities,
    platformServices: options.platformServices,
    vault: new NativeVaultSession(options.port),
    connection: new NativeConnectionProbe(options.port),
    hosts: new NativeHostStore(options.port),
    identities: new NativeIdentityStore(options.port),
    groups: new NativeGroupStore(options.port),
    workspace: new NativeWorkspaceStore(options.port),
    terminalProfiles: new NativeTerminalProfileStore(options.port),
    sessions: new NativeSessionTransport(options.port),
    files: new NativeFileTransport(options.port),
    commands: new NativeCommandTransport(options.port),
    snippets: new NativeSnippetStore(options.port),
    activity: new NativeActivityStore(options.port),
    imports: new NativeImportExport(options.port),
    secrets: new NativeSecretStore(),
    account: options.account,
    devices: options.devices,
    sync: options.sync
  };
  return runtime;
};
