import { AppError } from '../../shared/errors.js';
import { storedHostCredentialSchema, type HostCredentialInput } from '../../shared/validation.js';
import { resolveConnectionConfiguration } from '../../shared/core/connection-resolution.js';
import type { GroupNode } from '../../shared/core/models.js';
import type { HostRepository } from '../db/repositories.js';
import type { GroupRepository } from '../db/repositories.js';
import { VaultService } from '../vault/vault-service.js';
import type { IdentityService } from '../identity/identity-service.js';
import type { ConnectionPathResolver } from './connection-path.js';
import type { SshConnectConfig, SshConnectionResource, SshHostKeyChallenge, SshResourceAdapter } from './types.js';

export interface ConnectionResourceLease {
  resource: SshConnectionResource;
  close(): void | Promise<void>;
}

export interface ConnectionResourceProviderOptions {
  ownerId: string;
  hostRepository: HostRepository;
  connectionPathResolver: ConnectionPathResolver;
  vaultService: VaultService;
  groupRepository?: GroupRepository;
  identityService?: IdentityService;
  adapter: SshResourceAdapter;
}

const credentialAad = (id: string): string => `host:${id}:credentials:v1`;

const parseEncryptedCredential = (value: string): Parameters<VaultService['decryptJson']>[2] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('credential blob expected');
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || typeof candidate.nonce !== 'string' || typeof candidate.ciphertext !== 'string' || typeof candidate.authTag !== 'string' || typeof candidate.aad !== 'string') throw new Error('invalid credential blob');
    return candidate as unknown as Parameters<VaultService['decryptJson']>[2];
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const toConfig = async (
  repository: HostRepository,
  vaultService: VaultService,
  sessionKey: Buffer,
  hostId: string,
  ownerId: string,
  identityService?: IdentityService,
  groups: readonly GroupNode[] = []
): Promise<SshConnectConfig> => {
  const row = repository.getForConnection(hostId);
  if (!row) throw new AppError('HOST_NOT_FOUND');
  const resolved = resolveConnectionConfiguration(row, groups);
  let auth: HostCredentialInput;
  const identityId = row.credentialSource?.type === 'identity'
    ? row.identityId
    : row.credentialSource?.type === 'group' ? resolved.identityId : null;
  if (identityId) {
    if (!identityService || !ownerId) throw new AppError('IDENTITY_NOT_FOUND');
    const credential = await identityService.getCredential(ownerId, identityId, sessionKey);
    if (credential.type === 'pending') throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
    auth = credential;
  } else {
    if (row.credentialSource?.type === 'group') throw new AppError('IDENTITY_NOT_FOUND');
    if (row.credentialCiphertext === null) throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
    const stored = await vaultService.decryptJson<unknown>(sessionKey, credentialAad(row.id), parseEncryptedCredential(row.credentialCiphertext));
    const parsed = storedHostCredentialSchema.safeParse(stored);
    if (!parsed.success || parsed.data.type === 'pending') throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
    auth = parsed.data;
  }
  return {
    hostId: row.id,
    address: row.address,
    port: row.port,
    username: row.username,
    auth,
    hostKeyAlgorithm: row.hostKeyAlgorithm,
    hostKeyFingerprint: row.hostKeyFingerprint,
    keepaliveInterval: resolved.profile.keepaliveIntervalMs,
    keepaliveCountMax: resolved.profile.keepaliveCountMax,
    reconnect: resolved.profile.reconnect
  };
};

export const createConnectionResourceProvider = (options: ConnectionResourceProviderOptions) => ({
  async open(hostId: string, sessionKey?: Buffer): Promise<ConnectionResourceLease> {
    if (!sessionKey || !Buffer.isBuffer(sessionKey)) throw new AppError('SESSION_INVALID');
    const path = options.connectionPathResolver.resolve(hostId, options.ownerId);
    const groups = options.groupRepository?.list() ?? [];
    const configs: SshConnectConfig[] = [];
    for (const hop of path.hops) configs.push(await toConfig(options.hostRepository, options.vaultService, sessionKey, hop.id, options.ownerId, options.identityService, groups));
    const target = configs.at(-1);
    if (!target) throw new AppError('HOST_NOT_FOUND');
    const connection = await options.adapter.connect({
      ...target,
      ...(configs.length > 1 ? { jumpHosts: configs.slice(0, -1) } : {})
    }, {
      onHostKey: async (challenge: SshHostKeyChallenge): Promise<boolean> => {
        const row = options.hostRepository.getForConnection(challenge.hostId ?? hostId);
        return Boolean(row?.hostKeyFingerprint && row.hostKeyFingerprint === challenge.fingerprint);
      }
    });
    return { resource: connection, close: () => connection.close() };
  }
});
