import { AppError, isAppErrorCode } from '@shared/errors';
import type { ActivityFilter, AuditEvent, Capability, ClientPlatform, CommandRun, CommandRunRequest, ConnectionTestResult as SharedConnectionTestResult, GroupNode, HostListFilter, IdentityMetadata, SftpEntry, Snippet, SnippetMetadata, TransferJob, TransferResumeRequest, WorkspaceState, WorkspaceTemplate } from '@shared/core/models';
import type { GroupPatchInput, GroupMutationInput, HostCreateInput, HostMetadata, HostPatchInput, IdentityCreateInput, IdentityUpdateInput } from '@shared/validation';
import type { ExportOptions, ImportApplyRequest, ImportFormat, ImportPreview } from '@shared/import/types';

export interface SetupStatus {
  initialized: boolean;
  locked: boolean;
}

export interface CapabilityResponse {
  client: ClientPlatform;
  version: 1;
  capabilities: Capability[];
  limits?: {
    maxWorkspacePanes?: number;
    /** @deprecated Older servers called this limit maxPanes. */
    maxPanes?: number;
  };
}

export type GroupSummaryResponse = GroupNode;
export type ConnectionTestResult = SharedConnectionTestResult;

export interface WorkspaceResponse extends WorkspaceState {}

export interface ImportPreviewResponse {
  previewId: string;
  hostCount: number;
  groupCount: number;
  identityCount?: number;
  conflicts: Array<{ type: 'host' | 'group' | 'identity'; id: string; name: string }>;
  expiresAt: string;
}

export interface ImportResultResponse {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
  importedIdentities?: number;
  skippedIdentities?: number;
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

export type WorkspaceTemplateResponse = WorkspaceTemplate;
export type IdentityResponse = IdentityMetadata;

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
  body?: string | Blob | FormData | ReadableStream<Uint8Array>;
  acceptedStatuses?: readonly number[];
  responseType?: 'json' | 'blob' | 'stream';
  /** Streaming transfers must not be aborted by the short control-request timeout. */
  timeoutMs?: number | null;
  duplex?: 'half';
};

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> => (
  typeof value === 'object' && value !== null && typeof (value as { getReader?: unknown }).getReader === 'function'
);

const request = async <T>(url: string, init: RequestOptions = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const { acceptedStatuses = [], responseType = 'json', timeoutMs = REQUEST_TIMEOUT_MS, duplex, ...fetchOptions } = init;
  const controller = new AbortController();
  const timeout = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
      ...(duplex === undefined && isReadableStream(init.body) ? { duplex: 'half' as const } : duplex === undefined ? {} : { duplex })
    } as Parameters<typeof fetch>[1] & { duplex?: 'half' });

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
    if (responseType === 'blob') return await response.blob() as T;
    if (responseType === 'stream') {
      return (response.body ?? new ReadableStream<Uint8Array>()) as T;
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError('INTERNAL_ERROR', '请求超时，请稍后重试', 408);
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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

export const listHosts = (filter: HostListFilter = {}): Promise<HostMetadata[]> => {
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

export const clearHostKey = (id: string): Promise<void> => request<void>(`/api/hosts/${encodeURIComponent(id)}/host-key`, {
  method: 'DELETE'
});

export const listIdentities = (): Promise<IdentityMetadata[]> => request<IdentityMetadata[]>('/api/identities');

export const getIdentity = (id: string): Promise<IdentityMetadata> => request<IdentityMetadata>(`/api/identities/${encodeURIComponent(id)}`);

export const createIdentity = (input: IdentityCreateInput): Promise<IdentityMetadata> => request<IdentityMetadata>('/api/identities', {
  method: 'POST',
  ...json(input)
});

export const updateIdentity = (id: string, input: IdentityUpdateInput): Promise<IdentityMetadata> => request<IdentityMetadata>(`/api/identities/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteIdentity = (id: string): Promise<void> => request<void>(`/api/identities/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listGroups = (): Promise<GroupSummaryResponse[]> => request<GroupSummaryResponse[]>('/api/groups');

export const getGroup = (id: string): Promise<GroupSummaryResponse> => request<GroupSummaryResponse>(`/api/groups/${encodeURIComponent(id)}`);

export const createGroup = (input: GroupMutationInput): Promise<GroupSummaryResponse> => request<GroupSummaryResponse>('/api/groups', {
  method: 'POST',
  ...json(input)
});

export const updateGroup = (id: string, input: GroupPatchInput): Promise<GroupSummaryResponse> => request<GroupSummaryResponse>(`/api/groups/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteGroup = (id: string): Promise<void> => request<void>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const testConnection = (id: string): Promise<ConnectionTestResult> => request<ConnectionTestResult>(`/api/hosts/${encodeURIComponent(id)}/test-connection`, {
  method: 'POST',
  acceptedStatuses: [409]
});

export const getWorkspace = (): Promise<WorkspaceResponse> => request<WorkspaceResponse>('/api/workspace');

export const saveWorkspace = (expectedVersion: number, state: WorkspaceState): Promise<WorkspaceResponse> => request<WorkspaceResponse>('/api/workspace', {
  method: 'PUT',
  ...json({ expectedVersion, state })
});

export const listWorkspaceTemplates = (): Promise<WorkspaceTemplateResponse[]> => request<WorkspaceTemplateResponse[]>('/api/workspace/templates');

export const createWorkspaceTemplate = (input: { name: string; state: WorkspaceState }): Promise<WorkspaceTemplateResponse> => request<WorkspaceTemplateResponse>('/api/workspace/templates', {
  method: 'POST',
  ...json(input)
});

export const deleteWorkspaceTemplate = (id: string): Promise<void> => request<void>(`/api/workspace/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });

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
  resolution: { hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace'; identityConflicts?: 'reuse' | 'replace' }
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

export const listTransfers = (): Promise<TransferJob[]> => request<TransferJob[]>('/api/transfers');

export const getTransfer = (id: string): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}`);

export const uploadTransferContent = (id: string, source: ReadableStream<Uint8Array>, resume?: TransferResumeRequest): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/content`, {
  method: 'PUT',
  headers: new Headers({
    'content-type': 'application/octet-stream',
    ...(resume === undefined ? {} : {
      'x-transfer-offset': String(resume.expectedOffset),
      ...(resume.checksum === null ? {} : { 'x-transfer-checksum': resume.checksum })
    })
  }),
  body: source,
  timeoutMs: null,
  duplex: 'half'
});

export const uploadTransferChunk = (id: string, chunk: Blob, resume: TransferResumeRequest, nextChecksum: string, final: boolean): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/content/chunk`, {
  method: 'PUT',
  headers: new Headers({
    'content-type': 'application/octet-stream',
    'x-transfer-offset': String(resume.expectedOffset),
    ...(resume.checksum === null ? {} : { 'x-transfer-checksum': resume.checksum }),
    'x-transfer-next-checksum': nextChecksum,
    'x-transfer-final': String(final)
  }),
  body: chunk,
  timeoutMs: null
});

export const downloadTransferContent = (id: string, resume?: TransferResumeRequest): Promise<ReadableStream<Uint8Array>> => request<ReadableStream<Uint8Array>>(`/api/transfers/${encodeURIComponent(id)}/content`, {
  headers: resume === undefined ? undefined : new Headers({
    'x-transfer-offset': String(resume.expectedOffset),
    ...(resume.checksum === null ? {} : { 'x-transfer-checksum': resume.checksum })
  }),
  responseType: 'stream',
  timeoutMs: null
});

export const cancelTransfer = (id: string): Promise<void> => request<void>(`/api/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const pauseTransfer = (id: string): Promise<void> => request<void>(`/api/transfers/${encodeURIComponent(id)}/pause`, { method: 'POST' });

export const retryTransfer = (id: string): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/retry`, { method: 'POST' });

export const listAuditEvents = (filter: ActivityFilter = {}): Promise<AuditEventsResponse> => {
  const params = new URLSearchParams();
  if (filter.cursor) params.set('cursor', filter.cursor);
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.eventType) params.set('eventType', filter.eventType);
  if (filter.hostId) params.set('hostId', filter.hostId);
  const suffix = params.toString();
  return request<AuditEventsResponse>(`/api/audit${suffix ? `?${suffix}` : ''}`);
};
