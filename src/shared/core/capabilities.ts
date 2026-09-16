import type { Capability, ClientPlatform } from './models.js';

export interface CapabilitySet {
  client: ClientPlatform;
  version: 1;
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

export const createCapabilitySet = (
  client: ClientPlatform,
  capabilities: readonly Capability[],
  limits: Partial<CapabilityLimits> = {}
): CapabilitySet => {
  const unique = [...new Set(capabilities)];
  return {
    client,
    version: 1,
    capabilities: unique,
    limits: {
      ...(normalizeMaxWorkspacePanes(limits.maxWorkspacePanes) === undefined
        ? {}
        : { maxWorkspacePanes: normalizeMaxWorkspacePanes(limits.maxWorkspacePanes) })
    },
    supports: (capability) => unique.includes(capability)
  };
};

export const supportsWorkspacePanes = (capabilities: CapabilitySet): boolean => (
  capabilities.supports('workspace.max-panes') || capabilities.supports('workspace.multi-pane')
);

/**
 * Returns the effective pane count after a platform adapter supplies its local
 * upper bound. The shared core deliberately does not know Web/Desktop/Android
 * limits.
 */
export const effectiveMaxPanes = (capabilities: CapabilitySet, platformMaxPanes: number): number => {
  if (!supportsWorkspacePanes(capabilities)) return 1;
  const localLimit = Number.isFinite(platformMaxPanes) ? Math.max(1, Math.floor(platformMaxPanes)) : 1;
  return Math.min(localLimit, capabilities.limits.maxWorkspacePanes ?? localLimit);
};

export const WEB_CAPABILITIES: readonly Capability[] = [
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
  'sftp.browse',
  'sftp.transfer',
  'sftp.entry-mutations',
  'automation.snippets',
  'automation.snippet-manager',
  'automation.batch-exec',
  'automation.target-picker',
  'audit.activity',
  'session.lifecycle-status'
];

export const createWebCapabilitySet = (limits: Partial<CapabilityLimits> = {}): CapabilitySet => createCapabilitySet('web', WEB_CAPABILITIES, limits);
