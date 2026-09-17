import type { AccountSession, ClientPlatform, DeviceDescriptor } from '../core/models.js';
import type { AccountSessionPort, DeviceTrustPort } from '../core/ports.js';
import { AppError } from '../errors.js';
import type { CloudAuthResponse, CloudClientDeviceInput, CloudApiClient } from './client.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

export interface CloudTokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

export type CloudAccountSessionClient = Pick<CloudApiClient, 'getSession' | 'listDevices' | 'revokeDevice' | 'trustDevice'> & Partial<Pick<CloudApiClient, 'register' | 'signIn' | 'refresh' | 'signOut'>>;

export interface CloudAccountSessionOptions {
  client: CloudAccountSessionClient;
  platform: ClientPlatform;
  deviceLabel?: string;
  tokenStore: CloudTokenStore;
}

const invalidSession = (): never => { throw new AppError('ACCOUNT_SESSION_INVALID'); };
const capabilityUnavailable = (): never => { throw new AppError('CAPABILITY_UNAVAILABLE'); };

const authDevice = (platform: ClientPlatform, label: string | undefined): CloudClientDeviceInput => ({
  platform,
  ...(label === undefined ? {} : { label })
});

const isInvalidSessionError = (error: unknown): boolean => error instanceof AppError && error.code === 'ACCOUNT_SESSION_INVALID';

export class CloudAccountSession implements AccountSessionPort, DeviceTrustPort {
  private readonly client: CloudAccountSessionClient;
  private readonly platform: ClientPlatform;
  private readonly deviceLabel?: string;
  private readonly tokenStore: CloudTokenStore;
  private loaded = false;
  private token: string | null = null;
  private loading: Promise<string | null> | null = null;

  constructor(options: CloudAccountSessionOptions) {
    this.client = options.client;
    this.platform = options.platform;
    this.deviceLabel = options.deviceLabel;
    this.tokenStore = options.tokenStore;
  }

  async status(): Promise<AccountSession | null> {
    const token = await this.currentToken();
    if (!token) return null;
    try {
      return (await this.client.getSession(token)).account;
    } catch (error) {
      if (!isInvalidSessionError(error)) throw error;
      await this.clearToken();
      return null;
    }
  }

  async register(email: string, password: string, label = this.deviceLabel): Promise<AccountSession> {
    if (!this.client.register) return capabilityUnavailable();
    return this.acceptAuthResult(await this.client.register(email, password, authDevice(this.platform, label)));
  }

  async signIn(email: string, password: string, label = this.deviceLabel): Promise<AccountSession> {
    if (!this.client.signIn) return capabilityUnavailable();
    return this.acceptAuthResult(await this.client.signIn(email, password, authDevice(this.platform, label)));
  }

  async signOut(): Promise<void> {
    const token = await this.currentToken();
    try {
      if (token && this.client.signOut) await this.client.signOut(token);
    } finally {
      await this.clearToken();
    }
  }

  async refresh(): Promise<AccountSession> {
    const token = await this.requireToken();
    if (!this.client.refresh) return capabilityUnavailable();
    try {
      return await this.acceptAuthResult(await this.client.refresh(token));
    } catch (error) {
      if (isInvalidSessionError(error)) await this.clearToken();
      throw error;
    }
  }

  async listDevices(): Promise<readonly DeviceDescriptor[]> {
    return this.client.listDevices(await this.requireToken());
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.client.revokeDevice(await this.requireToken(), deviceId);
  }

  async trustDevice(deviceId: string): Promise<void> {
    await this.client.trustDevice(await this.requireToken(), deviceId);
  }

  private async acceptAuthResult(result: CloudAuthResponse): Promise<AccountSession> {
    if (!TOKEN_PATTERN.test(result.token)) throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务返回的登录凭据无效');
    await this.tokenStore.save(result.token);
    this.token = result.token;
    this.loaded = true;
    return result.account;
  }

  private async requireToken(): Promise<string> {
    const token = await this.currentToken();
    return token ?? invalidSession();
  }

  private async currentToken(): Promise<string | null> {
    if (this.loaded) return this.token;
    if (!this.loading) {
      this.loading = this.tokenStore.load().then((stored) => {
        this.token = typeof stored === 'string' && TOKEN_PATTERN.test(stored) ? stored : null;
        this.loaded = true;
        this.loading = null;
        return this.token;
      });
    }
    return this.loading;
  }

  private async clearToken(): Promise<void> {
    this.token = null;
    this.loaded = true;
    await this.tokenStore.clear();
  }
}
