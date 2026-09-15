import { AppError, isAppErrorCode } from '@shared/errors';
import type { AuditEvent, Capability, ClientPlatform, CommandRun, CommandRunRequest, SftpEntry, Snippet, SnippetMetadata, TransferJob, WorkspaceState } from '@shared/core/models';
import type { HostCreateInput, HostMetadata, HostPatchInput } from '@shared/validation';
import type { ExportOptions, ImportApplyRequest, ImportFormat, ImportPreview } from '@shared/import/types';

export interface SetupStatus {
  initialized: boolean;
  locked: boolean;
}

export interface CapabilityResponse {
  client: ClientPlatform;
  version: 1;
  capabilities: Capability[];
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

export interface WorkspaceResponse extends WorkspaceState {}

export interface ImportPreviewResponse {
  previewId: string;
  hostCount: number;
  groupCount: number;
  conflicts: Array<{ type: 'host' | 'group'; id: string; name: string }>;
  expiresAt: string;
}

export interface ImportResultResponse {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
}

export type ExternalImportPreviewResponse = ImportPreview;

export interface ExternalImportResultResponse {
  importedHosts: number;
  skippedHosts: number;
  importedGroups: number;
  skippedGroups: number;
  warnings: string[];
}

export type SnippetResponse = Snippet;
export type CommandRunResponse = CommandRun;

export interface AuditEventsResponse {
  items: AuditEvent[];
  nextCursor?: string;
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
  body?: string | Blob | FormData;
  acceptedStatuses?: readonly number[];
  responseType?: 'json' | 'blob';
};

const request = async <T>(url: string, init: RequestOptions = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const { acceptedStatuses = [], responseType = 'json', ...fetchOptions } = init;
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
    if (responseType === 'blob') {
      return await response.blob() as T;
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

export const getCapabilities = (): Promise<CapabilityResponse> => request<CapabilityResponse>('/api/capabilities');

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

export const getHost = (id: string): Promise<HostMetadata> => request<HostMetadata>(`/api/hosts/${encodeURIComponent(id)}`);

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

export const getWorkspace = (): Promise<WorkspaceResponse> => request<WorkspaceResponse>('/api/workspace');

export const saveWorkspace = (expectedVersion: number, state: WorkspaceState): Promise<WorkspaceResponse> => request<WorkspaceResponse>('/api/workspace', {
  method: 'PUT',
  ...json({ expectedVersion, state })
});

export const exportVaultBundle = (exportPassword: string): Promise<{ bundle: string }> => request<{ bundle: string }>('/api/vault/export', {
  method: 'POST',
  ...json({ exportPassword })
});

export const previewVaultImport = (exportPassword: string, bundle: string): Promise<ImportPreviewResponse> => request<ImportPreviewResponse>('/api/vault/import/preview', {
  method: 'POST',
  ...json({ exportPassword, bundle })
});

export const applyVaultImport = (
  previewId: string,
  resolution: { hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace' }
): Promise<ImportResultResponse> => request<ImportResultResponse>('/api/vault/import/apply', {
  method: 'POST',
  ...json({ previewId, resolution })
});

export const listImportFormats = (): Promise<Array<{ id: ImportFormat; label: string; extensions: string[]; description: string }>> => request('/api/import/formats');

export const previewExternalImport = (files: readonly File[], formatHint?: ImportFormat): Promise<ExternalImportPreviewResponse> => {
  const form = new FormData();
  for (const file of files) form.append('file', file, file.name);
  if (formatHint) form.append('format', formatHint);
  return request<ExternalImportPreviewResponse>('/api/import/preview', { method: 'POST', body: form });
};

export const applyExternalImport = (previewId: string, input: ImportApplyRequest): Promise<ExternalImportResultResponse> => request<ExternalImportResultResponse>('/api/import/apply', {
  method: 'POST',
  ...json({ previewId, ...input })
});

export const exportOpenSshConfig = (): Promise<Blob> => request<Blob>('/api/export/openssh', { responseType: 'blob' });

export const exportSshCsv = (options: ExportOptions = {}): Promise<Blob> => {
  const params = new URLSearchParams();
  if (options.includePasswords) params.set('includePasswords', 'true');
  if (options.confirmPasswordExport) params.set('confirmPasswordExport', 'true');
  const suffix = params.toString();
  return request<Blob>(`/api/export/csv${suffix ? `?${suffix}` : ''}`, { responseType: 'blob' });
};

export const listSnippets = (): Promise<SnippetMetadata[]> => request<SnippetMetadata[]>('/api/snippets');

export const getSnippet = (id: string): Promise<SnippetResponse> => request<SnippetResponse>(`/api/snippets/${encodeURIComponent(id)}`);

export const createSnippet = (input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Promise<SnippetResponse> => request<SnippetResponse>('/api/snippets', {
  method: 'POST',
  ...json(input)
});

export const updateSnippet = (id: string, input: Partial<Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>>): Promise<SnippetResponse> => request<SnippetResponse>(`/api/snippets/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteSnippet = (id: string): Promise<void> => request<void>(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const startCommandRun = (input: CommandRunRequest): Promise<CommandRunResponse> => request<CommandRunResponse>('/api/command-runs', {
  method: 'POST',
  ...json(input)
});

export const getCommandRun = (id: string): Promise<CommandRunResponse> => request<CommandRunResponse>(`/api/command-runs/${encodeURIComponent(id)}`);

export const cancelCommandRun = (id: string): Promise<void> => request<void>(`/api/command-runs/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listSftpEntries = (hostId: string, path = '/'): Promise<SftpEntry[]> => request<SftpEntry[]>(`/api/sftp/${encodeURIComponent(hostId)}/list?path=${encodeURIComponent(path)}`);

export const mutateSftpEntry = (hostId: string, input: { action: 'mkdir'; path: string } | { action: 'rename'; from: string; to: string } | { action: 'delete'; path: string; confirmed: boolean }): Promise<void> => request<void>(`/api/sftp/${encodeURIComponent(hostId)}/entries`, {
  method: 'POST',
  ...json(input)
});

export const createTransfer = (input: { kind: 'upload' | 'download'; hostId: string; sourcePath: string; targetPath: string; totalBytes?: number | null }): Promise<TransferJob> => request<TransferJob>('/api/sftp/' + encodeURIComponent(input.hostId) + '/transfers', {
  method: 'POST',
  ...json(input)
});

export const getTransfer = (id: string): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}`);

export const uploadTransferContent = (id: string, file: Blob): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/content`, {
  method: 'PUT',
  body: (() => {
    const form = new FormData();
    const filename = 'name' in file && typeof file.name === 'string' ? file.name : 'upload';
    form.append('file', file, filename);
    return form;
  })()
});

export const downloadTransferContent = (id: string): Promise<Blob> => request<Blob>(`/api/transfers/${encodeURIComponent(id)}/content`, {
  responseType: 'blob'
});

export const cancelTransfer = (id: string): Promise<void> => request<void>(`/api/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const retryTransfer = (id: string): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/retry`, { method: 'POST' });

export const listAuditEvents = (filter: { cursor?: string; limit?: number; eventType?: string; hostId?: string } = {}): Promise<AuditEventsResponse> => {
  const params = new URLSearchParams();
  if (filter.cursor) params.set('cursor', filter.cursor);
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.eventType) params.set('eventType', filter.eventType);
  if (filter.hostId) params.set('hostId', filter.hostId);
  const suffix = params.toString();
  return request<AuditEventsResponse>(`/api/audit${suffix ? `?${suffix}` : ''}`);
};
