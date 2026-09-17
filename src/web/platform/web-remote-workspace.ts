import type { AccountSession } from '../../shared/core/models.js';
import type { RemoteWorkspacePort } from '../../shared/core/ports.js';
import { AppError } from '../../shared/errors.js';
import { RemoteWorkspaceSocketSession, browserRemoteWorkspaceSocketFactory, type RemoteWorkspaceSocketFactory } from '../../shared/cloud/remote-socket.js';
import type { RemoteWorkspaceSession } from '../../shared/cloud/remote-workspace.js';

interface WebRemoteWorkspaceClient {
  getCloudAccountSession(): Promise<{ account: AccountSession | null }>;
}

const remoteWorkspaceUrl = (workspaceId: string): string => {
  const location = globalThis.location;
  const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location?.host || 'localhost';
  return `${protocol}//${host}/ws/cloud/workspaces/${encodeURIComponent(workspaceId)}`;
};

export class WebRemoteWorkspace implements RemoteWorkspacePort {
  constructor(
    private readonly client: WebRemoteWorkspaceClient,
    private readonly socketFactory: RemoteWorkspaceSocketFactory = browserRemoteWorkspaceSocketFactory()
  ) {}

  async open(workspaceId: string, ownerDeviceId: string): Promise<RemoteWorkspaceSession> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(ownerDeviceId)) {
      throw new AppError('PROTOCOL_INVALID_MESSAGE');
    }
    const account = (await this.client.getCloudAccountSession()).account;
    if (!account || account.state !== 'signed-in' || account.trusted === false) throw new AppError('ACCOUNT_SESSION_INVALID');
    return new RemoteWorkspaceSocketSession({
      url: remoteWorkspaceUrl(workspaceId),
      workspaceId,
      ownerDeviceId,
      participantDeviceId: account.deviceId,
      socketFactory: this.socketFactory
    });
  }
}

export { remoteWorkspaceUrl };
