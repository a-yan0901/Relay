import { randomUUID } from 'node:crypto';

import type { SyncPreview, SyncResolution, WorkspaceState } from '../../shared/core/models.js';
import { AppError } from '../../shared/errors.js';
import {
  snippetSchema,
  workspaceStateSchema
} from '../../shared/validation.js';
import type { SqliteDatabase } from '../db/database.js';
import { GroupRepository, HostRepository, IdentityRepository, SnippetRepository } from '../db/repositories.js';
import { VaultService } from '../vault/vault-service.js';
import { VaultBundleService, parsePayload, type BundlePayload } from '../workspace/vault-bundle-service.js';
import { WorkspaceRepository } from '../workspace/workspace-repository.js';
import { WorkspaceService } from '../workspace/workspace-service.js';

export const SYNC_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface SyncSnapshotSnippet {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  command: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SyncSnapshot extends BundlePayload {
  schemaVersion: typeof SYNC_SNAPSHOT_SCHEMA_VERSION;
  snippets: SyncSnapshotSnippet[];
  workspace: WorkspaceState;
}

export interface SyncSnapshotSummary {
  hostCount: number;
  groupCount: number;
  identityCount: number;
  snippetCount: number;
  workspaceIncluded: boolean;
}

export interface SyncSnapshotServiceOptions {
  ownerId: string;
  database: SqliteDatabase;
  bundleService: VaultBundleService;
  workspaceService: WorkspaceService;
  workspaceRepository: WorkspaceRepository;
  snippetService: {
    list(): Promise<readonly { id: string }[]>;
    get(id: string, vaultKey: Buffer): Promise<{
      id: string;
      name: string;
      description: string | null;
      tags: readonly string[];
      command: string;
      variables: readonly string[];
      createdAt: string;
      updatedAt: string;
    }>;
  };
  snippetRepository: SnippetRepository;
  hostRepository: HostRepository;
  groupRepository: GroupRepository;
  identityRepository: IdentityRepository;
  vaultService: VaultService;
}

const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SNAPSHOT_KEYS = new Set(['schemaVersion', 'groups', 'hosts', 'identities', 'snippets', 'workspace']);
const SNIPPET_KEYS = new Set(['id', 'name', 'description', 'tags', 'command', 'variables', 'createdAt', 'updatedAt']);

const assertOwner = (ownerId: string): void => {
  if (typeof ownerId !== 'string' || !SAFE_OWNER.test(ownerId)) throw new AppError('SYNC_PAYLOAD_INVALID');
};

const failSnapshot = (): never => {
  throw new AppError('SYNC_PAYLOAD_INVALID');
};

const asString = (value: unknown): string => typeof value === 'string' ? value : failSnapshot();

const parseJson = (plaintext: Buffer): Record<string, unknown> => {
  if (!Buffer.isBuffer(plaintext) || plaintext.length > 32 * 1024 * 1024) failSnapshot();
  try {
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) failSnapshot();
    return parsed as Record<string, unknown>;
  } catch {
    return failSnapshot();
  }
};

const parseSnapshotSnippet = (value: unknown): SyncSnapshotSnippet => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failSnapshot();
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== SNIPPET_KEYS.size || keys.some((key) => !SNIPPET_KEYS.has(key))) failSnapshot();
  if (
    typeof candidate.id !== 'string' ||
    !SAFE_ID.test(candidate.id) ||
    typeof candidate.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.updatedAt))
  ) failSnapshot();
  const parsed = snippetSchema.safeParse({
    name: candidate.name,
    description: candidate.description,
    tags: candidate.tags,
    command: candidate.command,
    variables: candidate.variables
  });
  const parsedData = parsed.success && parsed.data !== undefined ? parsed.data : failSnapshot();
  const id = asString(candidate.id);
  const createdAt = asString(candidate.createdAt);
  const updatedAt = asString(candidate.updatedAt);
  return {
    id,
    name: parsedData.name,
    description: parsedData.description ?? null,
    tags: [...parsedData.tags],
    command: parsedData.command,
    variables: [...parsedData.variables],
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString()
  };
};

const toSnapshotBundle = (snapshot: SyncSnapshot): BundlePayload => ({
  groups: snapshot.groups,
  hosts: snapshot.hosts,
  identities: snapshot.identities
});

const snippetAad = (id: string): string => `snippet:${id}:payload:v1`;

export class SyncSnapshotService {
  constructor(private readonly options: SyncSnapshotServiceOptions) {}

  async create(ownerId: string, vaultKey: Buffer): Promise<Buffer> {
    this.assertOwner(ownerId);
    const bundle = await this.options.bundleService.createPayload(vaultKey);
    const metadata = await this.options.snippetService.list();
    const snippets: SyncSnapshotSnippet[] = [];
    for (const item of metadata) {
      const snippet = await this.options.snippetService.get(item.id, vaultKey);
      snippets.push({
        id: snippet.id,
        name: snippet.name,
        description: snippet.description,
        tags: [...snippet.tags],
        command: snippet.command,
        variables: [...snippet.variables],
        createdAt: snippet.createdAt,
        updatedAt: snippet.updatedAt
      });
    }
    const workspace = this.options.workspaceService.load(ownerId);
    return Buffer.from(JSON.stringify({
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      ...bundle,
      snippets,
      workspace
    } satisfies SyncSnapshot), 'utf8');
  }

  validate(plaintext: Buffer): SyncSnapshot {
    const candidate = parseJson(plaintext);
    const keys = Object.keys(candidate);
    if (keys.length !== SNAPSHOT_KEYS.size || keys.some((key) => !SNAPSHOT_KEYS.has(key))) failSnapshot();
    const snippetValues: unknown[] = candidate.schemaVersion === SYNC_SNAPSHOT_SCHEMA_VERSION && Array.isArray(candidate.snippets)
      ? candidate.snippets
      : failSnapshot();
    if (snippetValues.length > 10_000) failSnapshot();
    const bundle = (() => {
      try {
        return parsePayload({
          groups: candidate.groups,
          hosts: candidate.hosts,
          identities: candidate.identities
        });
      } catch {
        return failSnapshot();
      }
    })();
    const workspaceResult = workspaceStateSchema.safeParse(candidate.workspace);
    const workspace = workspaceResult.success && workspaceResult.data !== undefined ? workspaceResult.data : failSnapshot();
    const snippets = snippetValues.map((snippet) => parseSnapshotSnippet(snippet));
    if (new Set(snippets.map((snippet) => snippet.id)).size !== snippets.length) failSnapshot();
    return {
      schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
      ...bundle,
      snippets,
      workspace
    };
  }

  describe(plaintext: Buffer): SyncSnapshotSummary {
    const snapshot = this.validate(plaintext);
    return {
      hostCount: snapshot.hosts.length,
      groupCount: snapshot.groups.length,
      identityCount: snapshot.identities?.length ?? 0,
      snippetCount: snapshot.snippets.length,
      workspaceIncluded: true
    };
  }

  async previewApply(ownerId: string, _vaultKey: Buffer, plaintext: Buffer): Promise<SyncPreview> {
    this.assertOwner(ownerId);
    const snapshot = this.validate(plaintext);
    const localHosts = new Map(this.options.hostRepository.listForBundle().map((host) => [host.id, host]));
    const localGroups = new Map(this.options.groupRepository.list().map((group) => [group.id, group]));
    const localIdentities = new Map(this.options.identityRepository.list().map((identity) => [identity.id, identity]));
    const localSnippets = new Map(this.options.snippetRepository.list().map((snippet) => [snippet.id, snippet]));
    const conflictTypes = new Set<SyncPreview['conflictTypes'][number]>();
    for (const host of snapshot.hosts) {
      const local = localHosts.get(host.id);
      if (local) {
        conflictTypes.add('host');
        if (local.hostKeyFingerprint !== host.hostKeyFingerprint || local.hostKeyAlgorithm !== host.hostKeyAlgorithm) conflictTypes.add('host-key');
      }
    }
    if (snapshot.groups.some((group) => localGroups.has(group.id))) conflictTypes.add('group');
    if (snapshot.identities?.some((identity) => localIdentities.has(identity.id))) conflictTypes.add('identity');
    if (snapshot.snippets.some((snippet) => localSnippets.has(snippet.id))) conflictTypes.add('snippet');
    const localWorkspace = this.options.workspaceRepository.get(ownerId);
    if (localWorkspace && localWorkspace.version !== snapshot.workspace.version) conflictTypes.add('workspace');
    const localRevision = localWorkspace?.version ?? 0;
    return {
      conflictId: randomUUID(),
      localRevision,
      remoteRevision: snapshot.workspace.version,
      conflictTypes: [...conflictTypes],
      localBackupRevision: localRevision
    };
  }

  async apply(ownerId: string, vaultKey: Buffer, plaintext: Buffer, resolution: SyncResolution, afterApply?: () => void): Promise<void> {
    this.assertOwner(ownerId);
    const snapshot = this.validate(plaintext);
    if (resolution === 'keep-local' || resolution === 'export-both') return;

    const encryptedSnippets = await Promise.all(snapshot.snippets.map(async (snippet) => ({
      ...snippet,
      commandCiphertext: JSON.stringify(await this.options.vaultService.encryptJson(vaultKey, snippetAad(snippet.id), {
        command: snippet.command,
        variables: snippet.variables
      } satisfies { command: string; variables: string[] }))
    })));
    const localSnippetIds = new Set(this.options.snippetRepository.list().map((snippet) => snippet.id));
    await this.options.bundleService.applyPayload(
      vaultKey,
      toSnapshotBundle(snapshot),
      { hostConflicts: 'replace', groupConflicts: 'replace', identityConflicts: 'replace' },
      () => {
        for (const id of localSnippetIds) {
          if (!snapshot.snippets.some((snippet) => snippet.id === id)) this.options.snippetRepository.delete(id);
        }
        for (const snippet of encryptedSnippets) {
          const current = this.options.snippetRepository.get(snippet.id);
          const row = {
            ownerId,
            id: snippet.id,
            name: snippet.name,
            description: snippet.description,
            tags: [...snippet.tags],
            commandCiphertext: snippet.commandCiphertext,
            variables: [...snippet.variables],
            createdAt: snippet.createdAt,
            updatedAt: snippet.updatedAt
          };
          if (current) this.options.snippetRepository.update(snippet.id, row);
          else this.options.snippetRepository.create(row);
        }
        this.options.workspaceRepository.replaceWithinTransaction(ownerId, snapshot.workspace);
        afterApply?.();
      }
    );
  }

  private assertOwner(ownerId: string): void {
    assertOwner(ownerId);
    if (ownerId !== this.options.ownerId) throw new AppError('SYNC_PAYLOAD_INVALID');
  }
}
