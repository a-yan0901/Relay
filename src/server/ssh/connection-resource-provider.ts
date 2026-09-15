import { AppError } from '../../shared/errors.js';
import type { HostCredentialInput } from '../../shared/validation.js';
import type { HostRepository } from '../db/repositories.js';
import { VaultService } from '../vault/vault-service.js';
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
  hostId: string
): Promise<SshConnectConfig> => {
  const row = repository.getForConnection(hostId);
  if (!row) throw new AppError('HOST_NOT_FOUND');
  const auth = await vaultService.decryptJson<HostCredentialInput>(sessionKey, credentialAad(row.id), parseEncryptedCredential(row.credentialCiphertext));
  return {
    hostId: row.id,
    address: row.address,
    port: row.port,
    username: row.username,
    auth,
    hostKeyAlgorithm: row.hostKeyAlgorithm,
    hostKeyFingerprint: row.hostKeyFingerprint,
    keepaliveInterval: row.connectionProfile?.keepaliveIntervalMs,
    keepaliveCountMax: row.connectionProfile?.keepaliveCountMax,
    reconnect: row.connectionProfile?.reconnect
  };
};

export const createConnectionResourceProvider = (options: ConnectionResourceProviderOptions) => ({
  async open(hostId: string, sessionKey?: Buffer): Promise<ConnectionResourceLease> {
    if (!sessionKey || !Buffer.isBuffer(sessionKey)) throw new AppError('SESSION_INVALID');
    const path = options.connectionPathResolver.resolve(hostId, options.ownerId);
    const configs: SshConnectConfig[] = [];
    for (const hop of path.hops) configs.push(await toConfig(options.hostRepository, options.vaultService, sessionKey, hop.id));
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
