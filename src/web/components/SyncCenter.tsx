import { useEffect, useState } from 'react';

import { AppError } from '@shared/errors';
import { describeAccountSyncState } from '@shared/core/account-sync';
import type { CapabilitySet } from '@shared/core/capabilities';
import type { AccountSession, DeviceDescriptor, SyncHead, SyncPreview, SyncResolution, SyncState } from '@shared/core/models';
import type { DeviceTrustPort, SyncPort } from '@shared/core/ports';

export interface SyncCenterProps {
  account: AccountSession | null;
  sync: SyncState;
  capabilities: CapabilitySet;
  vaultLocked: boolean;
  syncPort?: SyncPort;
  devicesPort?: DeviceTrustPort;
  preview?: SyncPreview | null;
  onSyncChange?: (sync: SyncState) => void;
  onClose: () => void;
}

const messageFromError = (error: unknown, fallback: string): string => (
  error instanceof AppError || error instanceof Error ? error.message : fallback
);

const conflictTypeLabels: Record<SyncPreview['conflictTypes'][number], string> = {
  host: 'Server',
  group: '分组',
  identity: '身份',
  snippet: '片段',
  workspace: '工作区',
  'host-key': 'Host Key'
};

const formatDate = (value: string | undefined): string => {
  if (!value) return '尚未同步';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp) : '时间未知';
};

const withHead = (sync: SyncState, head: SyncHead): SyncState => ({
  ...sync,
  sync: 'synced',
  head,
  pendingCount: 0,
  lastSyncedAt: head.updatedAt,
  lastErrorCode: undefined
});

export const SyncCenter = ({
  account,
  sync,
  capabilities,
  vaultLocked,
  syncPort,
  devicesPort,
  preview,
  onSyncChange,
  onClose
}: SyncCenterProps) => {
  const [current, setCurrent] = useState<SyncState>(sync);
  const [conflict, setConflict] = useState<SyncPreview | null>(preview ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const [devices, setDevices] = useState<readonly DeviceDescriptor[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);

  const accountSignedIn = account?.state === 'signed-in';
  const available = accountSignedIn && capabilities.supports('sync.encrypted') && syncPort !== undefined;
  const visibleStatus = vaultLocked && accountSignedIn ? 'needs-unlock' : current.sync;
  const description = describeAccountSyncState(account?.state ?? 'signed-out', visibleStatus);

  useEffect(() => {
    setCurrent(sync);
    setConflict(preview ?? null);
    setResolved(null);
  }, [preview, sync]);

  useEffect(() => {
    if (visibleStatus !== 'conflict' || conflict || !syncPort || vaultLocked || !available) return;
    let cancelled = false;
    void syncPort.previewPull()
      .then((nextPreview) => {
        if (!cancelled) setConflict(nextPreview);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFromError(reason, '冲突详情暂时无法加载'));
      });
    return () => { cancelled = true; };
  }, [available, conflict, syncPort, vaultLocked, visibleStatus]);

  useEffect(() => {
    if (!accountSignedIn || !devicesPort || !capabilities.supports('device.trust')) {
      setDevices([]);
      return;
    }
    let cancelled = false;
    setDevicesLoading(true);
    void devicesPort.listDevices()
      .then((nextDevices) => {
        if (!cancelled) setDevices(nextDevices);
      })
      .catch(() => {
        if (!cancelled) setDevices([]);
      })
      .finally(() => {
        if (!cancelled) setDevicesLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountSignedIn, capabilities, devicesPort]);

  const update = (next: SyncState): void => {
    setCurrent(next);
    onSyncChange?.(next);
  };

  const enableSync = async (): Promise<void> => {
    if (!syncPort || !available || vaultLocked) return;
    setBusy(true);
    setError(null);
    try {
      const head = await syncPort.enable();
      update(withHead(current, head));
    } catch (reason: unknown) {
      setError(messageFromError(reason, '启用同步失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const retrySync = async (): Promise<void> => {
    if (!syncPort || !available) return;
    setBusy(true);
    setError(null);
    try {
      await syncPort.retry();
      const next = await syncPort.status();
      update({
        ...current,
        sync: next.sync,
        head: next.head,
        ...(next.pendingCount === undefined ? {} : { pendingCount: next.pendingCount }),
        ...(next.lastErrorCode === undefined ? {} : { lastErrorCode: next.lastErrorCode })
      });
    } catch (reason: unknown) {
      setError(messageFromError(reason, '同步重试失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (resolution: SyncResolution): Promise<void> => {
    if (!syncPort || !available || !conflict || vaultLocked) return;
    setBusy(true);
    setError(null);
    try {
      await syncPort.resolveConflict(conflict.conflictId, resolution);
      update({ ...current, sync: 'synced', pendingCount: 0, lastErrorCode: undefined });
      setResolved(resolution === 'keep-local' ? '已保留本地版本' : resolution === 'use-remote' ? '已使用远端版本' : '已保留两份并完成导出');
    } catch (reason: unknown) {
      setError(messageFromError(reason, '冲突处理失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="sync-center-dialog" role="dialog" aria-modal="true" aria-label="同步中心">
        <div className="sync-center-heading">
          <div><p className="eyebrow">ENCRYPTED SYNC</p><h2>同步中心</h2></div>
          <button className="icon-button" type="button" aria-label="关闭同步中心" title="关闭同步中心" onClick={onClose}>×</button>
        </div>

        <div className={`sync-status-card sync-status-${visibleStatus}`} role="status">
          <span className="sync-status-icon" aria-hidden="true">{visibleStatus === 'synced' ? '✓' : visibleStatus === 'conflict' ? '!' : '·'}</span>
          <div><strong>{description.label}</strong><span>{accountSignedIn ? `账号 ${account?.accountId.slice(0, 8)}` : '本地 Vault'}</span></div>
        </div>

        {!accountSignedIn && <p className="dialog-warning">请先登录账号，才能查看云端同步状态。</p>}
        {accountSignedIn && vaultLocked && <p className="dialog-warning"><strong>请先解锁 Vault</strong>；主密码只在本地用于解密和生成同步内容。</p>}
        {!available && accountSignedIn && !vaultLocked && <p className="dialog-warning">当前客户端或服务端未启用加密同步。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {resolved && <p className="sync-resolved" role="status">{resolved}</p>}

        <dl className="sync-metrics">
          <div><dt>云端版本</dt><dd>{current.head ? `r${current.head.revision}` : '未启用'}</dd></div>
          <div><dt>待同步变更</dt><dd>{current.pendingCount}</dd></div>
          <div><dt>最近同步</dt><dd>{formatDate(current.lastSyncedAt ?? current.head?.updatedAt)}</dd></div>
        </dl>
        {current.lastErrorCode && <p className="sync-reason">原因：{current.lastErrorCode}</p>}

        {devicesPort && capabilities.supports('device.trust') && <section className="sync-devices" aria-labelledby="sync-devices-title">
          <div className="account-section-heading"><strong id="sync-devices-title">受信任设备</strong>{devicesLoading && <span>加载中…</span>}</div>
          {!devicesLoading && devices.length === 0 && <p className="dialog-copy">暂无设备信息。</p>}
          <ul>
            {devices.map((device) => <li key={device.id}><span><strong>{device.label}{device.current ? ' · 当前设备' : ''}</strong><small>{device.platform}{device.revokedAt ? ' · 已撤销' : ''}</small></span></li>)}
          </ul>
        </section>}

        <div className="sync-center-actions">
          {visibleStatus === 'local-only' && <button className="button button-primary" type="button" disabled={!available || vaultLocked || busy} onClick={() => void enableSync()}>启用加密同步</button>}
          {visibleStatus === 'needs-unlock' && <button className="button button-primary" type="button" disabled>{vaultLocked ? '解锁后继续' : '解锁 Vault'}</button>}
          {(visibleStatus === 'pending' || visibleStatus === 'offline') && <button className="button button-primary" type="button" disabled={!available || busy} onClick={() => void retrySync()}>{busy ? '重试中…' : '重试同步'}</button>}
          {visibleStatus === 'syncing' && <span className="sync-progress" role="status">同步中…</span>}
        </div>

        {visibleStatus === 'conflict' && <section className="sync-conflict" aria-labelledby="sync-conflict-title">
          <div className="account-section-heading"><strong id="sync-conflict-title">需要你选择冲突处理方式</strong>{conflict && <span>本地 r{conflict.localRevision} · 远端 r{conflict.remoteRevision}</span>}</div>
          {conflict ? <>
            <p className="dialog-copy">涉及：{conflict.conflictTypes.map((type) => conflictTypeLabels[type]).join('、')}。选择后才会继续同步。</p>
            <div className="sync-conflict-actions">
              <button className="button button-ghost" type="button" disabled={!available || busy || vaultLocked} onClick={() => void resolve('keep-local')}>保留本地</button>
              <button className="button button-ghost" type="button" disabled={!available || busy || vaultLocked} onClick={() => void resolve('use-remote')}>使用远端</button>
              <button className="button button-ghost" type="button" disabled={!available || busy || vaultLocked} onClick={() => void resolve('export-both')}>导出两份</button>
            </div>
          </> : <p className="dialog-copy">正在加载冲突详情…</p>}
        </section>}

        {visibleStatus === 'device-revoked' && <p className="dialog-warning">当前设备已被撤销。你仍可使用本地 Vault，但需要在账号菜单中重新登录受信任设备。</p>}
        <div className="dialog-actions"><button className="button button-ghost" type="button" onClick={onClose}>完成</button></div>
      </section>
    </div>
  );
};
