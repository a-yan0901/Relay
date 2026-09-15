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
  'vault.bundle',
  'ssh.shell',
  'ssh.reconnect',
  'ssh.proxy-jump',
  'sftp.browse',
  'sftp.transfer',
  'automation.snippets',
  'automation.batch-exec',
  'audit.activity'
];

export const createWebCapabilitySet = (): CapabilitySet => createCapabilitySet('web', WEB_CAPABILITIES);
