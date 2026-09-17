import type { CloudWorkspaceDescriptor } from './client.js';
import type { CloudDeviceDescriptor } from './protocol.js';

export const CLOUD_DIRECTORY_MAX_ITEMS = 256;

export interface CloudWorkspaceDirectoryApi {
  listDevices(token: string): Promise<readonly CloudDeviceDescriptor[]>;
  listWorkspaces(token: string): Promise<readonly CloudWorkspaceDescriptor[]>;
}

export type CloudWorkspaceCardStatus = 'current' | 'online' | 'offline-snapshot' | 'needs-trust' | 'revoked' | 'unavailable';

export interface CloudWorkspaceCard {
  workspaceId: string;
  ownerDeviceId: string;
  ownerLabel: string;
  ownerPlatform: CloudDeviceDescriptor['platform'] | null;
  isCurrent: boolean;
  status: CloudWorkspaceCardStatus;
  online: boolean;
  activeViewerCount: number;
}

export interface CloudWorkspaceDirectorySnapshot {
  devices: readonly CloudDeviceDescriptor[];
  workspaces: readonly CloudWorkspaceDescriptor[];
  cards: readonly CloudWorkspaceCard[];
}

interface InFlightRefresh {
  key: string;
  promise: Promise<CloudWorkspaceDirectorySnapshot>;
}

function assertBoundedList(value: unknown, message: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > CLOUD_DIRECTORY_MAX_ITEMS) throw new Error(message);
}

function assertUniqueIds(items: readonly { id: string }[], message: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) throw new Error(message);
    ids.add(item.id);
  }
}

const cardStatus = (workspace: CloudWorkspaceDescriptor, owner: CloudDeviceDescriptor | undefined, currentDeviceId: string): CloudWorkspaceCardStatus => {
  if (!owner) return 'unavailable';
  if (owner.revokedAt !== null) return 'revoked';
  if (owner.id === currentDeviceId) return 'current';
  if (owner.trustedAt === null) return 'needs-trust';
  return workspace.online === true ? 'online' : 'offline-snapshot';
};

const toCard = (workspace: CloudWorkspaceDescriptor, devices: ReadonlyMap<string, CloudDeviceDescriptor>, currentDeviceId: string): CloudWorkspaceCard => {
  const owner = devices.get(workspace.ownerDeviceId);
  const status = cardStatus(workspace, owner, currentDeviceId);
  const activeViewerCount = workspace.activeViewerCount ?? 0;
  if (!Number.isSafeInteger(activeViewerCount) || activeViewerCount < 0 || activeViewerCount > 16) throw new Error('invalid cloud workspace presence');
  return {
    workspaceId: workspace.id,
    ownerDeviceId: workspace.ownerDeviceId,
    ownerLabel: owner?.label ?? '未知设备',
    ownerPlatform: owner?.platform ?? null,
    isCurrent: workspace.ownerDeviceId === currentDeviceId,
    status,
    online: workspace.online === true && status === 'online',
    activeViewerCount
  };
};

const sortCards = (left: CloudWorkspaceCard, right: CloudWorkspaceCard): number => {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  if (left.online !== right.online) return left.online ? -1 : 1;
  return left.ownerLabel.localeCompare(right.ownerLabel) || left.workspaceId.localeCompare(right.workspaceId);
};

export class CloudWorkspaceDirectory {
  private inFlight: InFlightRefresh | null = null;

  constructor(private readonly api: CloudWorkspaceDirectoryApi) {}

  refresh(token: string, currentDeviceId: string): Promise<CloudWorkspaceDirectorySnapshot> {
    if (typeof token !== 'string' || token.length === 0 || typeof currentDeviceId !== 'string' || currentDeviceId.length === 0) {
      return Promise.reject(new Error('invalid cloud directory context'));
    }
    const key = `${token}:${currentDeviceId}`;
    if (this.inFlight) {
      if (this.inFlight.key === key) return this.inFlight.promise;
      return Promise.reject(new Error('cloud directory refresh busy'));
    }
    const promise = this.load(token, currentDeviceId).finally(() => {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    });
    this.inFlight = { key, promise };
    return promise;
  }

  private async load(token: string, currentDeviceId: string): Promise<CloudWorkspaceDirectorySnapshot> {
    const devices = await this.api.listDevices(token);
    assertBoundedList(devices, 'cloud directory response too large');
    assertUniqueIds(devices as readonly { id: string }[], 'invalid cloud directory devices');
    const workspaces = await this.api.listWorkspaces(token);
    assertBoundedList(workspaces, 'cloud directory response too large');
    assertUniqueIds(workspaces as readonly { id: string }[], 'invalid cloud directory workspaces');
    const deviceMap = new Map(devices.map((device) => [device.id, device]));
    const cards = workspaces.map((workspace) => toCard(workspace, deviceMap, currentDeviceId)).sort(sortCards);
    return { devices, workspaces, cards };
  }
}
