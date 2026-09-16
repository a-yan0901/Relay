import type { Capability, ClientPlatform } from './models.js';

export interface CapabilitySet {
  client: ClientPlatform;
  version: 1;
  capabilities: readonly Capability[];
  supports(capability: Capability): boolean;
}

export const createCapabilitySet = (
  client: ClientPlatform,
  capabilities: readonly Capability[]
): CapabilitySet => {
  const unique = [...new Set(capabilities)];
  return {
    client,
    version: 1,
    capabilities: unique,
    supports: (capability) => unique.includes(capability)
  };
};

export const WEB_CAPABILITIES: readonly Capability[] = [
  'workspace.persistence',
  'workspace.templates',
  'workspace.multi-pane',
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

export const createWebCapabilitySet = (): CapabilitySet => createCapabilitySet('web', WEB_CAPABILITIES);
