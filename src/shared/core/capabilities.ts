import type { Capability, ClientPlatform } from './models.js';

export interface CapabilitySet {
  client: ClientPlatform;
  version: 1;
  /** Capabilities implemented by the current client adapter before negotiation. */
  clientCapabilities: readonly Capability[];
  /** Capabilities advertised by the server/peer before client filtering. */
  serverCapabilities: readonly Capability[];
  /** The only capabilities that application code may use. */
  intersection: readonly Capability[];
  /** Backwards-compatible alias for the negotiated intersection. */
  capabilities: readonly Capability[];
  limits: CapabilityLimits;
  supports(capability: Capability): boolean;
}

export interface CapabilityLimits {
  /** Server/client negotiated workspace pane limit; platform adapters apply their local upper bound. */
  maxWorkspacePanes?: number;
}

const normalizeMaxWorkspacePanes = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
};

const uniqueCapabilities = (capabilities: readonly Capability[]): readonly Capability[] => (
  Object.freeze([...new Set(capabilities)])
);

const createCapabilitySetFromParts = (
  client: ClientPlatform,
  clientCapabilities: readonly Capability[],
  serverCapabilities: readonly Capability[],
  intersection: readonly Capability[],
  limits: Partial<CapabilityLimits>
): CapabilitySet => {
  const normalizedClientCapabilities = uniqueCapabilities(clientCapabilities);
  const normalizedServerCapabilities = uniqueCapabilities(serverCapabilities);
  const normalizedIntersection = uniqueCapabilities(intersection);
  const maxWorkspacePanes = normalizeMaxWorkspacePanes(limits.maxWorkspacePanes);
  return {
    client,
    version: 1,
    clientCapabilities: normalizedClientCapabilities,
    serverCapabilities: normalizedServerCapabilities,
    intersection: normalizedIntersection,
    capabilities: normalizedIntersection,
    limits: maxWorkspacePanes === undefined ? {} : { maxWorkspacePanes },
    supports: (capability) => normalizedIntersection.includes(capability)
  };
};

export const createCapabilitySet = (
  client: ClientPlatform,
  capabilities: readonly Capability[],
  limits: Partial<CapabilityLimits> = {}
): CapabilitySet => {
  const unique = uniqueCapabilities(capabilities);
  return createCapabilitySetFromParts(client, unique, unique, unique, limits);
};

/**
 * Creates a negotiated capability set. The returned `capabilities` field is
 * intentionally the same array as `intersection` so older callers cannot
 * accidentally bypass the server's advertised permission set.
 */
export const negotiateCapabilitySet = (
  client: ClientPlatform,
  clientCapabilities: readonly Capability[],
  serverCapabilities: readonly Capability[],
  limits: Partial<CapabilityLimits> = {}
): CapabilitySet => {
  const normalizedClientCapabilities = uniqueCapabilities(clientCapabilities);
  const normalizedServerCapabilities = uniqueCapabilities(serverCapabilities);
  const serverSet = new Set(normalizedServerCapabilities);
  const intersection = normalizedClientCapabilities.filter((capability) => serverSet.has(capability));
  return createCapabilitySetFromParts(
    client,
    normalizedClientCapabilities,
    normalizedServerCapabilities,
    intersection,
    limits
  );
};

export const supportsWorkspacePanes = (capabilities: CapabilitySet): boolean => (
  capabilities.supports('workspace.max-panes') || capabilities.supports('workspace.multi-pane')
);

/**
 * Returns the effective pane count after a platform adapter supplies its local
 * upper bound. The shared core deliberately does not know Web/Desktop/Android
 * limits.
 */
export const effectiveMaxPanes = (capabilities: CapabilitySet, platformMaxPanes?: number): number => {
  if (!supportsWorkspacePanes(capabilities)) return 1;
  const localLimit = platformMaxPanes === undefined
    ? capabilities.limits.maxWorkspacePanes ?? 1
    : Number.isFinite(platformMaxPanes) ? Math.max(1, Math.floor(platformMaxPanes)) : 1;
  return Math.min(localLimit, capabilities.limits.maxWorkspacePanes ?? localLimit);
};

const WEB_BASE_CAPABILITIES: readonly Capability[] = [
  'workspace.persistence',
  'workspace.templates',
  'workspace.multi-pane',
  'workspace.max-panes',
  'terminal.broadcast',
  'vault.bundle',
  'vault.identities',
  'ssh.shell',
  'ssh.reconnect',
  'ssh.proxy-jump',
  'session.reattach',
  'sftp.browse',
  'sftp.transfer',
  'transfer.resume',
  'sftp.local-files',
  'sftp.entry-mutations',
  'automation.snippets',
  'automation.snippet-manager',
  'automation.batch-exec',
  'automation.target-picker',
  'audit.activity',
  'session.lifecycle-status'
];

export const ACCOUNT_SYNC_CAPABILITIES: readonly Capability[] = [
  'account.auth',
  'device.trust',
  'sync.encrypted'
];

/** All capabilities a Web adapter can implement, including optional account/sync. */
export const WEB_CLIENT_CAPABILITIES: readonly Capability[] = [
  ...WEB_BASE_CAPABILITIES,
  ...ACCOUNT_SYNC_CAPABILITIES
];

/** @deprecated Use WEB_CLIENT_CAPABILITIES for client candidates. */
export const WEB_CAPABILITIES: readonly Capability[] = WEB_BASE_CAPABILITIES;

export interface WebCapabilityOptions extends Partial<CapabilityLimits> {
  accountSyncEnabled?: boolean;
}

export const createWebCapabilitySet = (options: WebCapabilityOptions = {}): CapabilitySet => {
  const capabilities = options.accountSyncEnabled
    ? WEB_CLIENT_CAPABILITIES
    : WEB_BASE_CAPABILITIES;
  return createCapabilitySet('web', capabilities, options);
};
