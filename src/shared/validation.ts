import { z } from 'zod';

import { AppError } from './errors.js';
import type { ConnectionProfileOverrides, IdentitySource } from './core/models.js';

const MAX_HOST_NAME_LENGTH = 120;
const MAX_USERNAME_LENGTH = 255;
const MAX_TAG_LENGTH = 64;
const MAX_GROUP_ID_LENGTH = 128;

const hasControlCharacter = (value: string): boolean => [...value].some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
});

const isValidIpv4 = (value: string): boolean => {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d+$/u.test(octet) || octet.length > 3) {
      return false;
    }

    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
};

const ipv6PartUnits = (part: string, isLast: boolean): number | null => {
  if (part.includes('.')) {
    return isLast && isValidIpv4(part) ? 2 : null;
  }

  return /^[0-9a-f]{1,4}$/iu.test(part) ? 1 : null;
};

const isValidIpv6 = (value: string): boolean => {
  if (value.includes('%') || value.startsWith('[') || value.endsWith(']')) {
    return false;
  }

  const compressionCount = value.match(/::/gu)?.length ?? 0;
  if (compressionCount > 1 || value.includes(':::')) {
    return false;
  }

  const hasCompression = compressionCount === 1;
  const [left, right = ''] = hasCompression ? value.split('::') : [value, ''];
  const leftParts = left === '' ? [] : left.split(':');
  const rightParts = right === '' ? [] : right.split(':');
  const parts = [...leftParts, ...rightParts];

  if (parts.length === 0) {
    return hasCompression;
  }

  let units = 0;
  for (const [index, part] of parts.entries()) {
    if (part === '') {
      return false;
    }

    const partUnits = ipv6PartUnits(part, index === parts.length - 1);
    if (partUnits === null) {
      return false;
    }

    units += partUnits;
  }

  return hasCompression ? units < 8 : units === 8;
};

const isValidHostname = (value: string): boolean => {
  if (value.length === 0 || value.length > 253 || hasControlCharacter(value) || /[\s/?#\\:]/u.test(value)) {
    return false;
  }

  return value.split('.').every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)
  ));
};

export const isHostAddress = (value: string): boolean => {
  if (value.length === 0 || value.length > 253 || hasControlCharacter(value)) {
    return false;
  }

  if (isValidIpv4(value) || isValidIpv6(value)) {
    return true;
  }

  return isValidHostname(value);
};

const nameSchema = z.string()
  .min(1)
  .max(MAX_HOST_NAME_LENGTH)
  .refine((value) => !hasControlCharacter(value));

const usernameSchema = z.string()
  .min(1)
  .max(MAX_USERNAME_LENGTH)
  .refine((value) => !hasControlCharacter(value) && !/\s/u.test(value));

const tagSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_TAG_LENGTH)
  .refine((value) => !hasControlCharacter(value));

export const reconnectPolicySchema = z.object({
  enabled: z.boolean(),
  maxAttempts: z.number().int().min(0).max(20),
  baseDelayMs: z.number().int().min(0).max(60_000),
  maxDelayMs: z.number().int().min(0).max(10 * 60_000)
}).strict().superRefine((policy, context) => {
  if (policy.maxDelayMs < policy.baseDelayMs) {
    context.addIssue({ code: 'custom', path: ['maxDelayMs'], message: 'maxDelayMs must be >= baseDelayMs' });
  }
});

const reconnectPolicyPatchSchema = z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(0).max(20).optional(),
  baseDelayMs: z.number().int().min(0).max(60_000).optional(),
  maxDelayMs: z.number().int().min(0).max(10 * 60_000).optional()
}).strict().superRefine((policy, context) => {
  if (policy.baseDelayMs !== undefined && policy.maxDelayMs !== undefined && policy.maxDelayMs < policy.baseDelayMs) {
    context.addIssue({ code: 'custom', path: ['maxDelayMs'], message: 'maxDelayMs must be >= baseDelayMs' });
  }
});

export const connectionProfileSettingsSchema = z.object({
  keepaliveIntervalMs: z.number().int().min(0).max(10 * 60_000),
  keepaliveCountMax: z.number().int().min(0).max(100),
  reconnect: reconnectPolicySchema
}).strict();

export const connectionProfileSettingsPatchSchema = z.object({
  keepaliveIntervalMs: z.number().int().min(0).max(10 * 60_000).optional(),
  keepaliveCountMax: z.number().int().min(0).max(100).optional(),
  reconnect: reconnectPolicyPatchSchema.optional()
}).strict();

export type ConnectionProfileSettings = z.infer<typeof connectionProfileSettingsSchema>;
export type ConnectionProfileSettingsPatch = z.infer<typeof connectionProfileSettingsPatchSchema>;

export const defaultConnectionProfileSettings = (): ConnectionProfileSettings => ({
  keepaliveIntervalMs: 10_000,
  keepaliveCountMax: 3,
  reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5_000 }
});

export const mergeConnectionProfileSettings = (
  patch: ConnectionProfileSettingsPatch | undefined,
  current: ConnectionProfileSettings = defaultConnectionProfileSettings()
): ConnectionProfileSettings => ({
  ...current,
  ...(patch ?? {}),
  reconnect: { ...current.reconnect, ...(patch?.reconnect ?? {}) }
});

export const hostCredentialSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('password'),
    password: z.string().min(1).max(4096)
  }).strict(),
  z.object({
    type: z.literal('private_key'),
    privateKey: z.string().min(1).max(32768),
    passphrase: z.string().max(4096).optional(),
    identityFile: z.string().min(1).max(4096).optional()
  }).strict()
]);

export type HostCredentialInput = z.infer<typeof hostCredentialSchema>;

export const pendingHostCredentialSchema = z.object({
  type: z.literal('pending'),
  authType: z.enum(['password', 'private_key'])
}).strict();

export type PendingHostCredential = z.infer<typeof pendingHostCredentialSchema>;
export type StoredHostCredential = HostCredentialInput | PendingHostCredential;
export const storedHostCredentialSchema = z.union([hostCredentialSchema, pendingHostCredentialSchema]);

const scopedIdentifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);

export const hostCredentialSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline'), authType: z.enum(['password', 'private_key']) }).strict(),
  z.object({ type: z.literal('identity'), identityId: scopedIdentifierSchema }).strict(),
  z.object({ type: z.literal('group') }).strict()
]);

export type HostCredentialSource = z.infer<typeof hostCredentialSourceSchema>;

const hostBaseSchema = z.object({
  name: nameSchema,
  address: z.string().refine(isHostAddress),
  port: z.number().int().min(1).max(65535).default(22),
  username: usernameSchema,
  auth: hostCredentialSchema.optional(),
  credentialSource: hostCredentialSourceSchema.optional(),
  groupId: z.string().min(1).max(MAX_GROUP_ID_LENGTH).optional().nullable(),
  jumpHostIds: z.array(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu)).max(4).refine((ids) => new Set(ids).size === ids.length).default([]),
  connectionProfile: connectionProfileSettingsPatchSchema.optional(),
  tags: z.array(tagSchema).max(20).default([]).transform((tags) => [...new Set(tags)]),
  isFavorite: z.boolean().default(false)
}).strict();

export const hostMetadataInputSchema = hostBaseSchema.omit({ auth: true, credentialSource: true });

const validateCredentialSource = (
  input: { auth?: HostCredentialInput; credentialSource?: HostCredentialSource },
  context: z.RefinementCtx,
  required: boolean
): void => {
  if (required && !input.auth && !input.credentialSource) {
    context.addIssue({ code: 'custom', path: ['credentialSource'], message: 'credential source is required' });
  }
  if (input.auth && input.credentialSource && input.credentialSource.type !== 'inline') {
    context.addIssue({ code: 'custom', path: ['credentialSource'], message: 'inline and reusable credentials are mutually exclusive' });
  }
  if (input.credentialSource?.type === 'inline' && (!input.auth || input.auth.type !== input.credentialSource.authType)) {
    context.addIssue({ code: 'custom', path: ['credentialSource'], message: 'inline credential source must match auth' });
  }
};

export const hostCreateSchema = hostBaseSchema.superRefine((input, context) => validateCredentialSource(input, context, true));

export type HostCreateInput = z.infer<typeof hostCreateSchema>;

export const hostPatchSchema = hostBaseSchema.partial().superRefine((input, context) => validateCredentialSource(input, context, false));

export type HostPatchInput = z.infer<typeof hostPatchSchema>;

export interface HostMetadata {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: HostCredentialInput['type'];
  groupId: string | null;
  tags: string[];
  isFavorite: boolean;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  jumpHostIds?: string[];
  connectionProfile?: ConnectionProfileSettings;
  connectionProfileOverrides?: ConnectionProfileOverrides | null;
  /** The profile after applying group inheritance; explicit host values stay in connectionProfileOverrides. */
  resolvedConnectionProfile?: ConnectionProfileSettings;
  credentialSource?: HostCredentialSource;
  identityId?: string | null;
  identityName?: string | null;
  identitySource?: IdentitySource;
}

export const groupSchema = z.object({
  name: nameSchema,
  sortOrder: z.number().int().min(0).max(1_000_000).default(0)
}).strict();

export type GroupInput = z.infer<typeof groupSchema>;

export const identityCreateSchema = z.object({
  name: nameSchema,
  type: z.enum(['password', 'private_key']),
  username: usernameSchema,
  auth: hostCredentialSchema
}).strict();

export type IdentityCreateInput = z.infer<typeof identityCreateSchema>;
export const identityUpdateSchema = identityCreateSchema.partial().strict();
export type IdentityUpdateInput = z.infer<typeof identityUpdateSchema>;

export const groupMutationSchema = z.object({
  name: nameSchema,
  parentId: z.string().min(1).max(MAX_GROUP_ID_LENGTH).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).default(0),
  defaultIdentityId: z.string().min(1).max(128).nullable().optional(),
  connectionProfile: connectionProfileSettingsPatchSchema.nullable().optional()
}).strict();

export type GroupMutationInput = z.infer<typeof groupMutationSchema>;
export const groupPatchSchema = groupMutationSchema.partial();
export type GroupPatchInput = z.infer<typeof groupPatchSchema>;

export const parseGroupMutationInput = (input: unknown): GroupMutationInput => (
  parseWith(groupMutationSchema, input, 'HOST_VALIDATION_FAILED')
);

export const parseGroupPatchInput = (input: unknown): GroupPatchInput => (
  parseWith(groupPatchSchema, input, 'HOST_VALIDATION_FAILED')
);

export const parseHostCreateInput = (input: unknown): HostCreateInput => {
  try {
    return hostCreateSchema.parse(input);
  } catch {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

export const parseHostPatchInput = (input: unknown): HostPatchInput => {
  try {
    return hostPatchSchema.parse(input);
  } catch {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

const identifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const finiteNonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const connectionProfileSchema = z.object({
  hostId: identifierSchema,
  address: z.string().refine(isHostAddress),
  port: z.number().int().min(1).max(65535),
  username: usernameSchema,
  authType: z.enum(['password', 'private_key']),
  jumpHostIds: z.array(identifierSchema).max(4).refine((ids) => new Set(ids).size === ids.length),
  keepaliveIntervalMs: z.number().int().min(0).max(10 * 60_000),
  keepaliveCountMax: z.number().int().min(0).max(100),
  reconnect: reconnectPolicySchema,
  hostKeyAlgorithm: z.string().max(128).nullable(),
  hostKeyFingerprint: z.string().max(255).nullable()
}).strict();

export type ConnectionProfileInput = z.infer<typeof connectionProfileSchema>;

const workspaceTabSchema = z.object({
  id: identifierSchema,
  hostId: identifierSchema,
  title: z.string().max(120).optional()
}).strict();

export const workspaceStateSchema = z.object({
  version: z.number().int().min(0).max(1_000_000_000),
  tabs: z.array(workspaceTabSchema).max(64),
  activeTabId: identifierSchema.nullable(),
  layout: z.object({
    mode: z.enum(['single', 'vertical', 'horizontal', 'grid']),
    ratio: z.number().min(0.2).max(0.8),
    // Durable layout intent may outlive the current platform's visible pane
    // limit. The UI applies the negotiated limit without dropping tab ids.
    paneTabIds: z.array(identifierSchema).max(64).optional()
  }).strict(),
  filters: z.object({
    query: z.string().max(255).refine((value) => !hasControlCharacter(value)),
    groupId: identifierSchema.nullable(),
    favoriteOnly: z.boolean()
  }).strict()
}).strict();

export type WorkspaceStateInput = z.infer<typeof workspaceStateSchema>;

export const normalizeSftpPath = (input: string): string => {
  if (input.length === 0 || input.length > 4096 || hasControlCharacter(input) || input.includes('\\')) {
    throw new AppError('SFTP_PATH_INVALID');
  }

  const absolute = input.startsWith('/');
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new AppError('SFTP_PATH_INVALID');
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  const normalized = parts.join('/');
  if (absolute) return normalized.length === 0 ? '/' : '/' + normalized;
  return normalized.length === 0 ? '.' : normalized;
};

export const sftpPathSchema = z.string().min(1).max(4096).refine((value) => {
  try {
    normalizeSftpPath(value);
    return true;
  } catch {
    return false;
  }
});

export interface TransferRequestInput {
  kind: 'upload' | 'download';
  hostId: string;
  sourcePath: string;
  targetPath: string;
  totalBytes?: number | null;
}

export const transferRequestSchema = z.object({
  kind: z.enum(['upload', 'download']),
  hostId: identifierSchema,
  sourcePath: sftpPathSchema,
  targetPath: sftpPathSchema,
  totalBytes: finiteNonNegativeInteger.nullable().optional()
}).strict();

const variableNameSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/u);
const variableMapSchema = z.record(variableNameSchema, z.string().max(4096))
  .refine((values) => Object.keys(values).length <= 64);

const targetSelectionSnapshotSchema = z.object({
  hostIds: z.array(identifierSchema).min(1).max(256).refine((ids) => new Set(ids).size === ids.length),
  source: z.enum(['servers', 'workspace', 'group', 'tag', 'favorites', 'recent']),
  capturedAt: z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value))),
  displayNames: z.array(z.string().min(1).max(MAX_HOST_NAME_LENGTH)).min(1).max(256)
}).strict().superRefine((snapshot, context) => {
  if (snapshot.hostIds.length !== snapshot.displayNames.length) context.addIssue({ code: 'custom', path: ['displayNames'], message: 'display names must match target count' });
});

export const snippetSchema = z.object({
  name: nameSchema,
  description: z.string().max(500).nullable().optional(),
  tags: z.array(tagSchema).max(20).default([]).transform((tags) => [...new Set(tags)]),
  command: z.string().min(1).max(64 * 1024).refine((value) => value.trim().length > 0),
  variables: z.array(variableNameSchema).max(64).refine((names) => new Set(names).size === names.length)
}).strict();

export type SnippetInput = z.infer<typeof snippetSchema>;
export const snippetPatchSchema = snippetSchema.partial().strict();
export type SnippetPatchInput = z.infer<typeof snippetPatchSchema>;

export const commandRunRequestSchema = z.object({
  command: z.string().min(1).max(64 * 1024).refine((value) => value.trim().length > 0),
  hostIds: z.array(identifierSchema).min(1).max(256).refine((ids) => new Set(ids).size === ids.length),
  variables: variableMapSchema.default({}),
  concurrency: z.number().int().min(1).max(16).default(4),
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).default(60_000),
  persistOutput: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  targetSelection: targetSelectionSnapshotSchema.optional()
}).strict();

export type CommandRunRequestInput = z.infer<typeof commandRunRequestSchema>;

const parseWith = <T>(schema: z.ZodType<T>, input: unknown, code: ConstructorParameters<typeof AppError>[0]): T => {
  try {
    return schema.parse(input);
  } catch {
    throw new AppError(code);
  }
};

export const parseConnectionProfile = (input: unknown): ConnectionProfileInput => (
  parseWith(connectionProfileSchema, input, 'HOST_VALIDATION_FAILED')
);
export const parseWorkspaceState = (input: unknown): WorkspaceStateInput => (
  parseWith(workspaceStateSchema, input, 'WORKSPACE_INVALID')
);
export const parseTransferRequest = (input: unknown): TransferRequestInput => (
  parseWith(transferRequestSchema, input, 'SFTP_PATH_INVALID')
);
export const parseSnippetInput = (input: unknown): SnippetInput => (
  parseWith(snippetSchema, input, 'COMMAND_RUN_VALIDATION_FAILED')
);
export const parseSnippetPatchInput = (input: unknown): SnippetPatchInput => (
  parseWith(snippetPatchSchema, input, 'COMMAND_RUN_VALIDATION_FAILED')
);
export const parseCommandRunRequest = (input: unknown): CommandRunRequestInput => (
  parseWith(commandRunRequestSchema, input, 'COMMAND_RUN_VALIDATION_FAILED')
);

const commandVariablePattern = /\{\{([^{}]+)\}\}/gu;

export const extractCommandVariables = (command: string): string[] => {
  const variables: string[] = [];
  for (const match of command.matchAll(commandVariablePattern)) {
    const name = match[1];
    if (!name || !variableNameSchema.safeParse(name).success) {
      throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
    }
    if (!variables.includes(name)) variables.push(name);
  }
  if (/\{\{|\}\}/u.test(command.replaceAll(commandVariablePattern, ''))) {
    throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
  }
  return variables;
};

export const validateCommandVariables = (
  command: string,
  variables: Readonly<Record<string, string>>,
  declaredVariables?: readonly string[]
): readonly string[] => {
  const referenced = extractCommandVariables(command);
  const declared = declaredVariables === undefined ? referenced : [...declaredVariables];
  if (new Set(declared).size !== declared.length || declared.some((name) => !variableNameSchema.safeParse(name).success)) {
    throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
  }
  if (referenced.some((name) => !declared.includes(name)) || Object.keys(variables).some((name) => !declared.includes(name))) {
    throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
  }
  for (const name of referenced) {
    const value = variables[name];
    if (typeof value !== 'string' || value.length > 4096) throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
  }
  return referenced;
};

export const expandCommandTemplate = (
  command: string,
  variables: Readonly<Record<string, string>>,
  declaredVariables?: readonly string[]
): string => {
  validateCommandVariables(command, variables, declaredVariables);
  return command.replace(commandVariablePattern, (_match, name: string) => variables[name] ?? '');
};
