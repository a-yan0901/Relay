import type { FastifyRequest } from 'fastify';

import type { CloudApiClient, CloudWorkspaceDescriptor } from '../../shared/cloud/client.js';
import { CloudKeyManager } from '../../shared/cloud/key-manager.js';
import { CloudLiveRelay, type CloudLiveSocketFactory } from '../../shared/cloud/live-client.js';
import { LiveWorkspaceChannel } from '../../shared/cloud/live-session.js';
import type { LiveFrame } from '../../shared/cloud/live-protocol.js';
import { LiveWorkspaceOwner } from '../live/workspace-owner.js';
import type { SshChannel } from '../ssh/types.js';
import { CLOUD_ACCOUNT_SESSION_COOKIE_NAME } from './cloud-account-routes.js';
import { CloudBrowserSessionStore } from './cloud-session-store.js';
import { createNodeCloudLiveSocketFactory } from './node-cloud-live-socket.js';

export interface CloudLiveOwnerAttachment {
  resize(columns: number, rows: number): void;
  detach(): Promise<void>;
}

interface OwnerEntry {
  key: string;
  workspaceId: string;
  sessionId: string;
  owner: LiveWorkspaceOwner;
  channel: LiveWorkspaceChannel;
  relay: CloudLiveRelay;
  keyManager: CloudKeyManager;
  references: Set<string>;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

export interface CloudLiveOwnerRegistryOptions {
  baseUrl: string;
  sessions: CloudBrowserSessionStore;
  client: Pick<CloudApiClient, 'listWorkspaces' | 'listDevices' | 'listWorkspaceKeys' | 'putWorkspaceKey' | 'listAccountDataKeys' | 'putAccountDataKey'>;
  socketFactory?: CloudLiveSocketFactory;
  maxOwners?: number;
  idleReleaseMs?: number;
  maxPublishQueue?: number;
}

const MAX_WORKSPACE_OWNERS = 8;
const MAX_PUBLISH_QUEUE = 8;
const DEFAULT_IDLE_RELEASE_MS = 30_000;
const workspaceForDevice = (workspaces: readonly CloudWorkspaceDescriptor[], deviceId: string): CloudWorkspaceDescriptor | null => (
  workspaces
    .filter((workspace) => workspace.ownerDeviceId === deviceId && workspace.deletedAt === null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null
);

const sessionCookie = (request: FastifyRequest): string | null => {
  const value = request.cookies[CLOUD_ACCOUNT_SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const ownerKey = (cloudSessionId: string, workspaceId: string): string => `${cloudSessionId}:${workspaceId}`;

/**
 * Keeps one bounded live owner per active Web cloud session/workspace. The
 * registry is intentionally ephemeral: no terminal output is persisted and
 * idle owners release their key, relay and bounded replay state.
 */
export class CloudLiveOwnerRegistry {
  private readonly entries = new Map<string, OwnerEntry>();
  private readonly openings = new Map<string, Promise<OwnerEntry>>();
  private readonly socketFactory: CloudLiveSocketFactory;
  private readonly maxOwners: number;
  private readonly idleReleaseMs: number;
  private readonly maxPublishQueue: number;

  constructor(private readonly options: CloudLiveOwnerRegistryOptions) {
    this.socketFactory = options.socketFactory ?? createNodeCloudLiveSocketFactory();
    this.maxOwners = options.maxOwners ?? MAX_WORKSPACE_OWNERS;
    this.idleReleaseMs = options.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this.maxPublishQueue = options.maxPublishQueue ?? MAX_PUBLISH_QUEUE;
    if (!Number.isInteger(this.maxOwners) || this.maxOwners < 1 || this.maxOwners > MAX_WORKSPACE_OWNERS) throw new Error('invalid cloud live owner limit');
    if (!Number.isInteger(this.idleReleaseMs) || this.idleReleaseMs < 1 || this.idleReleaseMs > 5 * 60 * 1000) throw new Error('invalid cloud live owner idle timeout');
    if (!Number.isInteger(this.maxPublishQueue) || this.maxPublishQueue < 1 || this.maxPublishQueue > 64) throw new Error('invalid cloud live owner queue limit');
  }

  async attach(request: FastifyRequest, input: { sessionId: string; hostId: string; title: string; columns: number; rows: number; channel: SshChannel }): Promise<CloudLiveOwnerAttachment | null> {
    const cloudSessionId = sessionCookie(request);
    if (!cloudSessionId) return null;
    const cloudSession = this.options.sessions.get(cloudSessionId);
    if (!cloudSession?.deviceKeyPair || cloudSession.account.trusted === false) return null;
    const workspace = workspaceForDevice(await this.options.client.listWorkspaces(cloudSession.token), cloudSession.account.deviceId);
    if (!workspace) return null;
    const key = ownerKey(cloudSessionId, workspace.id);
    let entry = this.entries.get(key);
    if (!entry) {
      const opening = this.openings.get(key) ?? this.createEntry(key, cloudSessionId, workspace.id, cloudSession);
      this.openings.set(key, opening);
      try {
        entry = await opening;
      } finally {
        if (this.openings.get(key) === opening) this.openings.delete(key);
      }
    }
    if (this.entries.size > this.maxOwners && !this.entries.has(key)) {
      await entry.channel.close();
      entry.relay.close();
      entry.keyManager.clear();
      throw new Error('cloud live owner limit reached');
    }
    if (entry.releaseTimer !== null) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.references.add(input.sessionId);
    entry.owner.attachTerminal({
      sessionId: input.sessionId,
      hostId: input.hostId,
      title: input.title,
      status: 'connected',
      columns: input.columns,
      rows: input.rows,
      channel: input.channel
    });
    entry.owner.publishSnapshot();
    return {
      resize: (columns, rows) => entry?.owner.updateTerminal(input.sessionId, columns, rows),
      detach: async () => {
        if (!entry) return;
        entry.owner.detachTerminal(input.sessionId);
        entry.references.delete(input.sessionId);
        if (entry.references.size > 0 || entry.releaseTimer !== null) return;
        entry.releaseTimer = setTimeout(() => { void this.release(key, entry!); }, this.idleReleaseMs);
        entry.releaseTimer.unref?.();
      }
    };
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.openings.clear();
    for (const entry of entries) {
      if (entry.releaseTimer !== null) clearTimeout(entry.releaseTimer);
      await entry.channel.close().catch(() => undefined);
      entry.relay.close();
      entry.keyManager.clear();
    }
  }

  get size(): number { return this.entries.size; }

  private async createEntry(
    key: string,
    cloudSessionId: string,
    workspaceId: string,
    cloudSession: NonNullable<ReturnType<CloudBrowserSessionStore['get']>>
  ): Promise<OwnerEntry> {
    if (this.entries.size >= this.maxOwners) throw new Error('cloud live owner limit reached');
    const keyManager = new CloudKeyManager(this.options.client, {
      token: cloudSession.token,
      accountId: cloudSession.account.accountId,
      deviceId: cloudSession.account.deviceId,
      deviceKeyPair: cloudSession.deviceKeyPair!
    });
    const material = await keyManager.ensureWorkspaceKey(workspaceId);
    let channel: LiveWorkspaceChannel | null = null;
    let relay: CloudLiveRelay | null = null;
    try {
      relay = new CloudLiveRelay({ baseUrl: this.options.baseUrl, token: cloudSession.token, workspaceId, role: 'owner', socketFactory: this.socketFactory });
      const queue: LiveFrame[] = [];
      let draining = false;
      let closed = false;
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          while (!closed && queue.length > 0) {
            const frame = queue.shift();
            if (!frame || !channel) continue;
            await channel.broadcast(frame).catch(() => undefined);
          }
        } finally {
          draining = false;
        }
      };
      const publish = (frame: LiveFrame): void => {
        if (closed) return;
        if (queue.length >= this.maxPublishQueue) {
          const outputIndex = queue.findIndex((candidate) => candidate.type === 'terminal-output');
          if (outputIndex >= 0) queue.splice(outputIndex, 1);
          else return;
        }
        queue.push(frame);
        void drain();
      };
      let owner!: LiveWorkspaceOwner;
      channel = new LiveWorkspaceChannel({
        relay,
        workspaceId,
        localDeviceId: cloudSession.account.deviceId,
        ownerDeviceId: cloudSession.account.deviceId,
        role: 'owner',
        baseKey: material.key,
        onFrame: (frame) => owner.handleFrame(frame),
        onViewerJoin: () => owner.publishSnapshot(),
        onError: () => undefined
      });
      owner = new LiveWorkspaceOwner({ workspaceId, publish, maxOutputBytes: 256 * 1024, maxOutputFrames: 256, maxInputDedupeEntries: 1_024 });
      await channel.connect();
      const entry: OwnerEntry = { key, workspaceId, sessionId: cloudSessionId, owner, channel, relay, keyManager, references: new Set(), releaseTimer: null };
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      channel && await channel.close().catch(() => undefined);
      relay?.close();
      keyManager.clear();
      throw error;
    } finally {
      material.key.fill(0);
    }
  }

  private async release(key: string, entry: OwnerEntry): Promise<void> {
    if (this.entries.get(key) !== entry || entry.references.size > 0) return;
    this.entries.delete(key);
    if (entry.releaseTimer !== null) clearTimeout(entry.releaseTimer);
    await entry.channel.close().catch(() => undefined);
    entry.relay.close();
    entry.keyManager.clear();
  }
}
