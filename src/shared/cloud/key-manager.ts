import type { CloudDeviceDescriptor, CloudKeyGrant } from './protocol.js';
import { AppError } from '../../shared/errors.js';
import { generateCloudDeviceKeyPair, unwrapCloudDataKey, wrapCloudDataKey, type CloudDeviceKeyPair } from './key-crypto.js';

const DATA_KEY_BYTES = 32;
const MAX_CACHED_KEYS = 8;

export interface CloudKeyManagerApi {
  listDevices(token: string): Promise<readonly CloudDeviceDescriptor[]>;
  listAccountDataKeys(token: string): Promise<readonly CloudKeyGrant[]>;
  putAccountDataKey(token: string, recipientDeviceId: string, input: { keyVersion: number; wrappedKey: Record<string, unknown> }): Promise<CloudKeyGrant>;
  listWorkspaceKeys(token: string, workspaceId: string): Promise<readonly CloudKeyGrant[]>;
  putWorkspaceKey(token: string, workspaceId: string, recipientDeviceId: string, input: { keyVersion: number; wrappedKey: Record<string, unknown> }): Promise<CloudKeyGrant>;
}

export interface CloudKeyManagerOptions {
  token: string;
  accountId: string;
  deviceId: string;
  deviceKeyPair: CloudDeviceKeyPair;
}

export interface CloudKeyMaterial {
  key: Uint8Array;
  keyVersion: number;
}

export const cloudKeyGrantAad = (domain: 'account-data' | 'workspace', accountId: string, resourceId: string, keyVersion: number, recipientDeviceId: string): string => (
  `relay-key:v1:${domain}:${accountId}:${resourceId}:${keyVersion}:${recipientDeviceId}`
);

const copyKey = (key: Uint8Array): Uint8Array => {
  if (!(key instanceof Uint8Array) || key.byteLength !== DATA_KEY_BYTES) throw new AppError('VAULT_CRYPTO_FAILED');
  const copy = new Uint8Array(DATA_KEY_BYTES);
  copy.set(key);
  return copy;
};

export class CloudKeyManager {
  private readonly cache = new Map<string, CloudKeyMaterial>();

  constructor(private readonly api: CloudKeyManagerApi, private readonly options: CloudKeyManagerOptions) {}

  getAccountDataKey(): Promise<CloudKeyMaterial> {
    return this.getKey('account-data', this.options.accountId, () => this.api.listAccountDataKeys(this.options.token));
  }

  async ensureAccountDataKey(): Promise<CloudKeyMaterial> {
    try {
      return await this.getAccountDataKey();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SYNC_NOT_FOUND') throw error;
    }
    const material = this.newKey(1);
    const wrappedKey = await wrapCloudDataKey(material.key, this.options.deviceKeyPair.publicKey, cloudKeyGrantAad('account-data', this.options.accountId, this.options.accountId, material.keyVersion, this.options.deviceId));
    await this.api.putAccountDataKey(this.options.token, this.options.deviceId, { keyVersion: material.keyVersion, wrappedKey: wrappedKey as unknown as Record<string, unknown> });
    this.remember('account-data', this.options.accountId, material);
    return this.copyMaterial(material);
  }

  async grantAccountDataKey(recipientDeviceId: string): Promise<void> {
    const material = await this.ensureAccountDataKey();
    await this.grant('account-data', this.options.accountId, recipientDeviceId, material, async (wrappedKey) => {
      await this.api.putAccountDataKey(this.options.token, recipientDeviceId, { keyVersion: material.keyVersion, wrappedKey });
    });
  }

  getWorkspaceKey(workspaceId: string): Promise<CloudKeyMaterial> {
    return this.getKey('workspace', workspaceId, () => this.api.listWorkspaceKeys(this.options.token, workspaceId));
  }

  async ensureWorkspaceKey(workspaceId: string): Promise<CloudKeyMaterial> {
    try {
      return await this.getWorkspaceKey(workspaceId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SYNC_NOT_FOUND') throw error;
    }
    const material = this.newKey(1);
    const wrappedKey = await wrapCloudDataKey(material.key, this.options.deviceKeyPair.publicKey, cloudKeyGrantAad('workspace', this.options.accountId, workspaceId, material.keyVersion, this.options.deviceId));
    await this.api.putWorkspaceKey(this.options.token, workspaceId, this.options.deviceId, { keyVersion: material.keyVersion, wrappedKey: wrappedKey as unknown as Record<string, unknown> });
    this.remember('workspace', workspaceId, material);
    return this.copyMaterial(material);
  }

  async grantWorkspaceKey(workspaceId: string, recipientDeviceId: string): Promise<void> {
    const material = await this.ensureWorkspaceKey(workspaceId);
    await this.grant('workspace', workspaceId, recipientDeviceId, material, async (wrappedKey) => {
      await this.api.putWorkspaceKey(this.options.token, workspaceId, recipientDeviceId, { keyVersion: material.keyVersion, wrappedKey });
    });
  }

  private async getKey(domain: 'account-data' | 'workspace', resourceId: string, loadGrants: () => Promise<readonly CloudKeyGrant[]>): Promise<CloudKeyMaterial> {
    const cached = [...this.cache.entries()].filter(([key]) => key.startsWith(`${domain}:${resourceId}:`)).sort((left, right) => right[1].keyVersion - left[1].keyVersion)[0]?.[1];
    if (cached) return this.copyMaterial(cached);
    const grants = [...await loadGrants()].sort((left, right) => right.keyVersion - left.keyVersion);
    if (grants.length === 0) throw new AppError('SYNC_NOT_FOUND');
    let lastError: unknown;
    for (const grant of grants) {
      if (grant.domain !== domain || grant.accountId !== this.options.accountId || grant.recipientDeviceId !== this.options.deviceId || (domain === 'workspace' ? grant.resourceId !== resourceId : grant.resourceId !== this.options.accountId)) continue;
      try {
        const key = await unwrapCloudDataKey(grant.wrappedKey, this.options.deviceKeyPair.privateKey, cloudKeyGrantAad(domain, this.options.accountId, resourceId, grant.keyVersion, this.options.deviceId));
        const material = { key, keyVersion: grant.keyVersion };
        this.remember(domain, resourceId, material);
        return this.copyMaterial(material);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw new AppError('VAULT_CRYPTO_FAILED');
    throw new AppError('SYNC_NOT_FOUND');
  }

  private async grant(domain: 'account-data' | 'workspace', resourceId: string, recipientDeviceId: string, material: CloudKeyMaterial, put: (wrappedKey: Record<string, unknown>) => Promise<void>): Promise<void> {
    const device = (await this.api.listDevices(this.options.token)).find((candidate) => candidate.id === recipientDeviceId && candidate.revokedAt === null);
    if (!device?.publicKey) throw new AppError('SYNC_NOT_FOUND');
    const wrappedKey = await wrapCloudDataKey(material.key, device.publicKey, cloudKeyGrantAad(domain, this.options.accountId, resourceId, material.keyVersion, recipientDeviceId));
    await put(wrappedKey as unknown as Record<string, unknown>);
  }

  private newKey(keyVersion: number): CloudKeyMaterial {
    return { key: globalThis.crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES)), keyVersion };
  }

  private remember(domain: 'account-data' | 'workspace', resourceId: string, material: CloudKeyMaterial): void {
    const key = `${domain}:${resourceId}:${material.keyVersion}`;
    this.cache.set(key, { key: copyKey(material.key), keyVersion: material.keyVersion });
    while (this.cache.size > MAX_CACHED_KEYS) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest === 'string') this.cache.delete(oldest);
      else break;
    }
  }

  private copyMaterial(material: CloudKeyMaterial): CloudKeyMaterial {
    return { key: copyKey(material.key), keyVersion: material.keyVersion };
  }
}

export { generateCloudDeviceKeyPair };
