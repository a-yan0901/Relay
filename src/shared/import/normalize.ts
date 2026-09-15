import type {
  ImportedConnection,
  ImportedCredential,
  ImportedCredentialState,
  ImportedAuthType,
  PreviewConnection
} from './types.js';

const SENSITIVE_FIELD = /(pass(word|phrase)?|private[_ -]?key|secret|credential|token|key)/iu;

export const normalizeHeader = (value: string): string => value
  .trim()
  .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
  .replaceAll(/[^a-z0-9]+/giu, '')
  .toLowerCase();

export const normalizeScalar = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const parsePort = (value: unknown, fallback = 22): number => {
  const scalar = normalizeScalar(value);
  if (!/^\d+$/u.test(scalar)) return fallback;
  const parsed = Number(scalar);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
};

export const normalizePath = (value: string): string[] => value
  .split(/[\\/]/u)
  .map((segment) => segment.trim())
  .filter(Boolean)
  .slice(0, 16);

export const normalizeTags = (value: string | string[] | undefined): string[] => {
  const values = Array.isArray(value) ? value : (value ?? '').split(/[;,]/u);
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, 20);
};

export const credentialToPreviewState = (credential: ImportedCredential | undefined): ImportedCredentialState => {
  if (!credential) return 'needs-user-input';
  if (credential.type === 'password') return credential.password.length > 0 ? 'ready' : 'needs-user-input';
  return credential.privateKey.length > 0 ? 'ready' : 'needs-user-input';
};

export const credentialStateForFields = (fields: {
  authType: ImportedAuthType;
  password?: string;
  privateKey?: string;
  identityFile?: string;
  protectedCredential?: boolean;
  referenceOnly?: boolean;
}): ImportedCredentialState => {
  if (fields.protectedCredential) return 'needs-source-passphrase';
  if (fields.referenceOnly) return 'reference-only';
  if (fields.authType === 'password' && fields.password) return 'ready';
  if (fields.authType === 'private_key' && fields.privateKey) return 'ready';
  return 'needs-user-input';
};

export const redactSourceFields = (fields: Record<string, string>): Record<string, string> => Object.fromEntries(
  Object.entries(fields).map(([key, value]) => [key, SENSITIVE_FIELD.test(key) ? '[redacted]' : value])
);

export const toPreviewConnection = (
  connection: ImportedConnection,
  credentialState = connection.credentialState,
  conflicts: PreviewConnection['conflicts'] = []
): PreviewConnection => {
  const safeConnection = { ...connection };
  delete safeConnection.credential;
  return {
    ...safeConnection,
    credentialState,
    sourceFields: redactSourceFields(connection.sourceFields),
    applicable: credentialState === 'ready' && conflicts.every((conflict) => conflict.kind !== 'unresolved-jump'),
    conflicts
  };
};

export const inferAuthType = (fields: { password?: string; privateKey?: string; identityFile?: string }): ImportedAuthType => {
  if (fields.privateKey || fields.identityFile) return 'private_key';
  if (fields.password) return 'password';
  return 'unknown';
};
