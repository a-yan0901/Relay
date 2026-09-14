import { AppError, isAppErrorCode } from '@shared/errors';
import type { HostCreateInput, HostMetadata, HostPatchInput } from '@shared/validation';

export interface SetupStatus {
  initialized: boolean;
  locked: boolean;
}

export interface GroupSummaryResponse {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ConnectionTestResult {
  ok: boolean;
  hostKey?: {
    algorithm: string;
    fingerprint: string;
    address: string;
    port: number;
  };
}

interface ApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

const REQUEST_TIMEOUT_MS = 15_000;

const parseErrorBody = async (response: Response): Promise<ApiErrorBody> => {
  try {
    return await response.json() as ApiErrorBody;
  } catch {
    return {};
  }
};

type RequestOptions = {
  method?: string;
  headers?: Headers;
  body?: string;
  acceptedStatuses?: readonly number[];
};

const request = async <T>(url: string, init: RequestOptions = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const { acceptedStatuses = [], ...fetchOptions } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'same-origin',
      signal: controller.signal
    });

    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const body = await parseErrorBody(response);
      const candidateCode = body.error?.code;
      const code = typeof candidateCode === 'string' && isAppErrorCode(candidateCode)
        ? candidateCode
        : 'INTERNAL_ERROR';
      const message = typeof body.error?.message === 'string' ? body.error.message : '请求失败';
      throw new AppError(code, message, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError('INTERNAL_ERROR', '请求超时，请稍后重试', 408);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const json = (value: unknown): RequestOptions => ({ body: JSON.stringify(value) });

export const getSetupStatus = (): Promise<SetupStatus> => request<SetupStatus>('/api/setup/status');

export const setupVault = (masterPassword: string): Promise<SetupStatus> => request<SetupStatus>('/api/setup', {
  method: 'POST',
  ...json({ masterPassword })
});

export const unlockVault = (masterPassword: string): Promise<SetupStatus> => request<SetupStatus>('/api/session/unlock', {
  method: 'POST',
  ...json({ masterPassword })
});

export const lockVault = (): Promise<void> => request<void>('/api/session/lock', { method: 'POST' });

export const listHosts = (filter: { query?: string; groupId?: string | null; favorite?: boolean } = {}): Promise<HostMetadata[]> => {
  const params = new URLSearchParams();
  if (filter.query) params.set('query', filter.query);
  if (filter.groupId) params.set('groupId', filter.groupId);
  if (filter.favorite !== undefined) params.set('favorite', String(filter.favorite));
  const suffix = params.toString();
  return request<HostMetadata[]>(`/api/hosts${suffix ? `?${suffix}` : ''}`);
};

export const createHost = (input: HostCreateInput): Promise<HostMetadata> => request<HostMetadata>('/api/hosts', {
  method: 'POST',
  ...json(input)
});

export const updateHost = (id: string, input: HostPatchInput): Promise<HostMetadata> => request<HostMetadata>(`/api/hosts/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteHost = (id: string): Promise<void> => request<void>(`/api/hosts/${encodeURIComponent(id)}`, {
  method: 'DELETE'
});

export const listGroups = (): Promise<GroupSummaryResponse[]> => request<GroupSummaryResponse[]>('/api/groups');

export const testConnection = (id: string): Promise<ConnectionTestResult> => request<ConnectionTestResult>(`/api/hosts/${encodeURIComponent(id)}/test-connection`, {
  method: 'POST',
  acceptedStatuses: [409]
});
