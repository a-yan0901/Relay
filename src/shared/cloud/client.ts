import type { AccountSession } from '../core/models.js';
import { AppError, isAppErrorCode } from '../errors.js';
import { parseCloudDataEnvelope, parseCloudKeyGrant, type CloudDataEnvelope, type CloudDeviceDescriptor, type CloudKeyGrant, type CloudKeyGrantInput } from './protocol.js';

export interface CloudAuthResponse {
  account: AccountSession;
  token: string;
}

export interface CloudWorkspaceDescriptor {
  id: string;
  accountId: string;
  ownerDeviceId: string;
  encryptedTitle: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Live status is ephemeral and is omitted by older cloud deployments. */
  online?: boolean;
  activeViewerCount?: number;
}

export interface CloudSnapshotHead {
  domain: 'account-data' | 'workspace';
  resourceId: string;
  revision: number;
  payloadHash: string;
  keyVersion: number;
  updatedAt: string;
}

export interface CloudClientDeviceInput {
  platform: 'web' | 'desktop' | 'android';
  label?: string;
  publicKey?: string | null;
}

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;
type FetchLike = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
) => Promise<FetchResponse>;

interface CloudErrorBody {
  error?: { code?: unknown; message?: unknown };
}

const parseError = async (response: FetchResponse): Promise<never> => {
  let body: CloudErrorBody = {};
  try {
    body = await response.json() as CloudErrorBody;
  } catch {
    // Keep a stable error when a proxy returns a non-JSON failure page.
  }
  const code = typeof body.error?.code === 'string' && isAppErrorCode(body.error.code)
    ? body.error.code
    : 'INTERNAL_ERROR';
  const message = typeof body.error?.message === 'string' ? body.error.message : '云服务请求失败';
  throw new AppError(code, message, response.status);
};

const parseJson = async <T>(response: FetchResponse): Promise<T> => {
  if (!response.ok) return parseError(response);
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务返回的数据格式无效');
  }
};

const parseKeyGrantResponse = (value: unknown): CloudKeyGrant => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务返回的密钥封装无效');
  }
  const candidate = value as Record<string, unknown>;
  const input = parseCloudKeyGrant({
    protocolVersion: candidate.protocolVersion,
    domain: candidate.domain,
    accountId: candidate.accountId,
    resourceId: candidate.resourceId,
    recipientDeviceId: candidate.recipientDeviceId,
    keyVersion: candidate.keyVersion,
    wrappedKey: candidate.wrappedKey
  });
  if (typeof candidate.createdAt !== 'string' || (candidate.revokedAt !== null && typeof candidate.revokedAt !== 'string')) {
    throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务返回的密钥封装时间字段无效');
  }
  return {
    ...input,
    createdAt: candidate.createdAt,
    revokedAt: candidate.revokedAt
  };
};

export class CloudApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
    const normalized = baseUrl.trim().replace(/\/+$/u, '');
    if (!/^https?:\/\//u.test(normalized)) throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务地址无效');
    this.baseUrl = normalized;
    this.fetchImpl = fetchImpl;
  }

  register(email: string, password: string, device: CloudClientDeviceInput): Promise<CloudAuthResponse> {
    return this.request('/v2/auth/register', { method: 'POST', body: { email, password, ...device } });
  }

  signIn(email: string, password: string, device: CloudClientDeviceInput): Promise<CloudAuthResponse> {
    return this.request('/v2/auth/login', { method: 'POST', body: { email, password, ...device } });
  }

  getSession(token: string): Promise<{ account: AccountSession }> {
    return this.request('/v2/auth/session', { token });
  }

  refresh(token: string): Promise<CloudAuthResponse> {
    return this.request('/v2/auth/refresh', { method: 'POST', token });
  }

  signOut(token: string): Promise<void> {
    return this.request('/v2/auth/logout', { method: 'POST', token });
  }

  listDevices(token: string): Promise<readonly CloudDeviceDescriptor[]> {
    return this.request('/v2/devices', { token });
  }

  revokeDevice(token: string, deviceId: string): Promise<void> {
    return this.request(`/v2/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', token });
  }

  trustDevice(token: string, deviceId: string): Promise<void> {
    return this.request(`/v2/devices/${encodeURIComponent(deviceId)}/trust`, { method: 'POST', token });
  }

  listWorkspaces(token: string): Promise<readonly CloudWorkspaceDescriptor[]> {
    return this.request('/v2/workspaces', { token });
  }

  getWorkspace(token: string, workspaceId: string): Promise<CloudWorkspaceDescriptor> {
    return this.request(`/v2/workspaces/${encodeURIComponent(workspaceId)}/descriptor`, { token });
  }

  getAccountDataHead(token: string): Promise<CloudSnapshotHead | null> {
    return this.request('/v2/account-data/head', { token });
  }

  async getAccountDataSnapshot(token: string, revision?: number): Promise<CloudDataEnvelope> {
    const path = revision === undefined ? '/v2/account-data/snapshot' : `/v2/account-data/snapshot?revision=${revision}`;
    return parseCloudDataEnvelope(await this.request<unknown>(path, { token }));
  }

  putAccountDataSnapshot(token: string, envelope: CloudDataEnvelope, idempotencyKey: string): Promise<CloudSnapshotHead> {
    return this.request('/v2/account-data/snapshot', { method: 'PUT', token, idempotencyKey, body: envelope });
  }

  async listAccountDataKeys(token: string): Promise<readonly CloudKeyGrant[]> {
    const grants = await this.request<unknown>('/v2/account-data/keys', { token });
    if (!Array.isArray(grants)) throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务返回的密钥封装列表无效');
    return grants.map(parseKeyGrantResponse);
  }

  async putAccountDataKey(token: string, recipientDeviceId: string, input: Omit<CloudKeyGrantInput, 'domain' | 'accountId' | 'resourceId' | 'recipientDeviceId'> & { wrappedKey: Record<string, unknown> }): Promise<CloudKeyGrant> {
    const result = await this.request<unknown>(`/v2/account-data/keys/${encodeURIComponent(recipientDeviceId)}`, {
      method: 'PUT',
      token,
      body: input
    });
    return parseKeyGrantResponse(result);
  }

  getWorkspaceHead(token: string, workspaceId: string): Promise<CloudSnapshotHead | null> {
    return this.request(`/v2/workspaces/${encodeURIComponent(workspaceId)}/head`, { token });
  }

  async getWorkspaceSnapshot(token: string, workspaceId: string, revision?: number): Promise<CloudDataEnvelope> {
    const suffix = revision === undefined ? '' : `?revision=${revision}`;
    return parseCloudDataEnvelope(await this.request<unknown>(`/v2/workspaces/${encodeURIComponent(workspaceId)}/snapshot${suffix}`, { token }));
  }

  putWorkspaceSnapshot(token: string, workspaceId: string, envelope: CloudDataEnvelope, idempotencyKey: string): Promise<CloudSnapshotHead> {
    return this.request(`/v2/workspaces/${encodeURIComponent(workspaceId)}/snapshot`, { method: 'PUT', token, idempotencyKey, body: envelope });
  }

  async listWorkspaceKeys(token: string, workspaceId: string): Promise<readonly CloudKeyGrant[]> {
    const grants = await this.request<unknown>(`/v2/workspaces/${encodeURIComponent(workspaceId)}/keys`, { token });
    if (!Array.isArray(grants)) throw new AppError('PROTOCOL_INVALID_MESSAGE', '云服务返回的工作区密钥封装列表无效');
    return grants.map(parseKeyGrantResponse);
  }

  async putWorkspaceKey(token: string, workspaceId: string, recipientDeviceId: string, input: Omit<CloudKeyGrantInput, 'domain' | 'accountId' | 'resourceId' | 'recipientDeviceId'> & { wrappedKey: Record<string, unknown> }): Promise<CloudKeyGrant> {
    const result = await this.request<unknown>(`/v2/workspaces/${encodeURIComponent(workspaceId)}/keys/${encodeURIComponent(recipientDeviceId)}`, {
      method: 'PUT',
      token,
      body: input
    });
    return parseKeyGrantResponse(result);
  }

  private async request<T = unknown>(path: string, options: { method?: string; token?: string; idempotencyKey?: string; body?: unknown } = {}): Promise<T> {
    const headers = new globalThis.Headers();
    if (options.token) headers.set('authorization', `Bearer ${options.token}`);
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return parseJson<T>(response);
  }
}
