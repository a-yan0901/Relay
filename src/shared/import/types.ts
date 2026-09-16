export type ImportFormat =
  | 'openssh-config'
  | 'ssh-csv'
  | 'mobaxterm'
  | 'xshell'
  | 'securecrt';

export type ImportedCredentialState =
  | 'ready'
  | 'needs-source-passphrase'
  | 'needs-user-input'
  | 'reference-only'
  | 'unsupported';

export type ImportedAuthType = 'password' | 'private_key' | 'unknown';

export interface ImportedPasswordCredential {
  type: 'password';
  password: string;
}

export interface ImportedPrivateKeyCredential {
  type: 'private_key';
  privateKey: string;
  passphrase?: string;
  identityFile?: string;
}

export type ImportedCredential = ImportedPasswordCredential | ImportedPrivateKeyCredential;

export interface ImportedConnection {
  sourceId: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: ImportedAuthType;
  credentialState: ImportedCredentialState;
  credentialSource?: string;
  groupPath: string[];
  tags: string[];
  jumpHostSourceIds: string[];
  identityFile?: string;
  hostKeyAlgorithm?: string;
  hostKeyFingerprint?: string;
  notes: string[];
  sourceFields: Record<string, string>;
  /** Internal-only material. Never expose this through an API DTO. */
  credential?: ImportedCredential;
}

export interface ImportDocument {
  format: 'ssh-connection-exchange';
  version: 1;
  source: { format: ImportFormat; filename: string };
  groups: Array<{ path: string[]; sourceId: string }>;
  connections: ImportedConnection[];
  warnings: string[];
}

export interface ImportSourceFile {
  filename: string;
  content: string | Uint8Array;
  formatHint?: ImportFormat;
}

export interface SupportedImportFormat {
  id: ImportFormat;
  label: string;
  extensions: string[];
  description: string;
}

export const supportedImportFormats: readonly SupportedImportFormat[] = [
  { id: 'openssh-config', label: 'OpenSSH config', extensions: ['config', 'conf', 'ssh_config'], description: 'Host / HostName / User / ProxyJump' },
  { id: 'ssh-csv', label: 'SSH CSV / Termius CSV', extensions: ['csv'], description: '通用 CSV 和 Termius 常见字段' },
  { id: 'mobaxterm', label: 'MobaXterm', extensions: ['mxtsessions', 'ini', 'mobaconf'], description: '会话目录和 SSH 连接' },
  { id: 'xshell', label: 'Xshell', extensions: ['xsh'], description: 'Xshell 会话文件' },
  { id: 'securecrt', label: 'SecureCRT', extensions: ['xml', 'ini'], description: 'XML 设置导出和 session INI' }
];

export type ImportConflictKind = 'same-batch' | 'existing-host' | 'existing-group' | 'unresolved-jump';

export interface ImportConflict {
  kind: ImportConflictKind;
  sourceIds: string[];
  message: string;
}

export interface PreviewConnection extends Omit<ImportedConnection, 'credential'> {
  applicable: boolean;
  conflicts: ImportConflict[];
}

export interface ImportPreview {
  previewId: string;
  source: { filename: string; format: ImportFormat };
  sources: Array<{ filename: string; format: ImportFormat }>;
  connectionCount: number;
  groupCount: number;
  connections: PreviewConnection[];
  conflicts: ImportConflict[];
  warnings: string[];
  expiresAt: string;
}

export type ImportConflictPolicy = 'skip' | 'create' | 'replace';

export interface ImportCredentialInput {
  sourceId: string;
  credential: ImportedCredential;
}

export interface ImportApplyRequest {
  selectedSourceIds: string[];
  conflictPolicy: ImportConflictPolicy;
  credentials?: ImportCredentialInput[];
}

export interface ImportApplyResult {
  importedHosts: number;
  skippedHosts: number;
  importedGroups: number;
  skippedGroups: number;
  warnings: string[];
}

export interface VaultBundleConflict {
  type: 'host' | 'group' | 'identity';
  id: string;
  name: string;
}

export interface VaultBundlePreview {
  previewId: string;
  hostCount: number;
  groupCount: number;
  identityCount?: number;
  conflicts: readonly VaultBundleConflict[];
  expiresAt: string;
}

export interface VaultBundleResolution {
  hostConflicts: 'skip' | 'replace';
  groupConflicts: 'reuse' | 'replace';
  identityConflicts?: 'reuse' | 'replace';
}

export interface VaultBundleApplyResult {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
  importedIdentities?: number;
  skippedIdentities?: number;
}

export interface ExportOptions {
  includePasswords?: boolean;
  confirmPasswordExport?: boolean;
}

export interface ExistingImportHost {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  groupId: string | null;
  jumpHostIds?: string[];
}
