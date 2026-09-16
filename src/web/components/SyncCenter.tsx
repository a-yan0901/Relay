import { useEffect, useState } from 'react';

import { AppError } from '@shared/errors';
import { describeAccountSyncState } from '@shared/core/account-sync';
import type { CapabilitySet } from '@shared/core/capabilities';
import type { AccountSession, DeviceDescriptor, RecoveryKeyState, SyncHead, SyncPreview, SyncResolution, SyncState } from '@shared/core/models';
import { serializeSyncConflictExport, SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH, SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH } from '@shared/core/sync-conflict-export';
import type { ClipboardPort, DeviceTrustPort, FileSavePort, SyncPort } from '@shared/core/ports';

export interface SyncCenterProps {
  account: AccountSession | null;
  sync: SyncState;
  capabilities: CapabilitySet;
  vaultLocked: boolean;
  syncPort?: SyncPort;
  devicesPort?: DeviceTrustPort;
  clipboard?: ClipboardPort;
  fileSave?: FileSavePort;
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

const defaultRecoveryState = (): RecoveryKeyState => ({
  status: 'not-configured',
  activeKeyVersion: null,
  pendingKeyVersion: null
});

interface RecoveryKeyIssue {
  recoveryKey: string;
  keyVersion: number;
  status: 'pending-confirmation';
}

export const SyncCenter = ({
  account,
  sync,
  capabilities,
  vaultLocked,
  syncPort,
  devicesPort,
  clipboard,
  fileSave,
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
  const [recovery, setRecovery] = useState<RecoveryKeyState>(sync.recovery ?? defaultRecoveryState());
  const [recoveryIssue, setRecoveryIssue] = useState<RecoveryKeyIssue | null>(null);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recoverySavedOffline, setRecoverySavedOffline] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');

  const accountSignedIn = account?.state === 'signed-in';
  const available = accountSignedIn && capabilities.supports('sync.encrypted') && syncPort !== undefined;
  const visibleStatus = vaultLocked && accountSignedIn ? 'needs-unlock' : current.sync;
  const description = describeAccountSyncState(account?.state ?? 'signed-out', visibleStatus);

  useEffect(() => {
    setCurrent(sync);
    setConflict(preview ?? null);
    setResolved(null);
    setExportOpen(false);
    setExportPassword('');
    setExportPasswordConfirm('');
    const nextRecovery = sync.recovery ?? defaultRecoveryState();
    setRecovery(nextRecovery);
    if (nextRecovery.status !== 'pending-confirmation') {
      setRecoveryIssue(null);
      setRecoveryInput('');
      setRecoverySavedOffline(false);
      setRecoveryCopied(false);
    }
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
      const next = withHead(current, head);
      try {
        let revealed: RecoveryKeyIssue | undefined;
        const nextRecovery = await syncPort.issueRecoveryKey((recoveryKey, keyVersion) => {
          revealed = { recoveryKey, keyVersion, status: 'pending-confirmation' };
        });
        if (!revealed) throw new AppError('PROTOCOL_INVALID_MESSAGE');
        setRecoveryIssue(revealed);
        setRecovery(nextRecovery);
        update({ ...next, recovery: nextRecovery });
      } catch (reason: unknown) {
        update(next);
        setError(`同步已启用，但恢复密钥生成失败：${messageFromError(reason, '请稍后重试')}`);
      }
    } catch (reason: unknown) {
      setError(messageFromError(reason, '启用同步失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const issueRecoveryKey = async (): Promise<void> => {
    if (!syncPort || !available || vaultLocked || current.sync === 'local-only') return;
    setBusy(true);
    setError(null);
    try {
      let revealed: RecoveryKeyIssue | undefined;
      const nextRecovery = await syncPort.issueRecoveryKey((recoveryKey, keyVersion) => {
        revealed = { recoveryKey, keyVersion, status: 'pending-confirmation' };
      });
      if (!revealed) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      setRecoveryIssue(revealed);
      setRecoveryInput('');
      setRecoverySavedOffline(false);
      setRecoveryCopied(false);
      setRecovery(nextRecovery);
      update({ ...current, recovery: nextRecovery });
    } catch (reason: unknown) {
      setError(messageFromError(reason, '恢复密钥生成失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const confirmRecoveryKey = async (): Promise<void> => {
    if (!syncPort || !available || vaultLocked || !recoveryIssue || !recoverySavedOffline || recoveryInput !== recoveryIssue.recoveryKey) return;
    setBusy(true);
    setError(null);
    try {
      const nextRecovery = await syncPort.confirmRecoveryKey(recoveryInput);
      setRecovery(nextRecovery);
      setRecoveryIssue(null);
      setRecoveryInput('');
      setRecoverySavedOffline(false);
      update({ ...current, recovery: nextRecovery });
      setResolved('恢复密钥已配置');
    } catch (reason: unknown) {
      setError(messageFromError(reason, '恢复密钥确认失败，请检查输入'));
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryKey = async (): Promise<void> => {
    if (!clipboard || !recoveryIssue) return;
    try {
      await clipboard.writeText(recoveryIssue.recoveryKey);
      setRecoveryCopied(true);
    } catch (reason: unknown) {
      setError(messageFromError(reason, '复制失败，请手动选择并复制'));
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
        ...(next.lastErrorCode === undefined ? {} : { lastErrorCode: next.lastErrorCode }),
        ...(next.recovery === undefined ? {} : { recovery: next.recovery })
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

  const clearExportSecrets = (): void => {
    setExportPassword('');
    setExportPasswordConfirm('');
  };

  const closeExport = (): void => {
    setExportOpen(false);
    clearExportSecrets();
  };

  const openExport = (): void => {
    if (!fileSave) {
      setError('当前客户端不支持文件保存');
      return;
    }
    setError(null);
    setResolved(null);
    setExportOpen(true);
  };

  const exportConflict = async (): Promise<void> => {
    if (!syncPort || !available || !conflict || vaultLocked || !fileSave || busy) return;
    if (exportPassword.length < SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH) {
      setError(`至少需要 ${SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH} 个字符`);
      return;
    }
    if (exportPassword.length > SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH) {
      setError(`不能超过 ${SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH} 个字符`);
      return;
    }
    if (exportPassword !== exportPasswordConfirm) {
      setError('两次输入的导出密码不一致');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const exported = await syncPort.exportConflict(conflict.conflictId, exportPassword);
      const content = new TextEncoder().encode(serializeSyncConflictExport(exported));
      await fileSave.save({
        name: `relay-sync-conflict-${conflict.conflictId}.json`,
        content,
        mimeType: 'application/json;charset=utf-8'
      });
      closeExport();
      setResolved('已下载加密冲突副本；当前冲突仍保留');
    } catch (reason: unknown) {
      clearExportSecrets();
      if (reason instanceof AppError && (reason.code === 'SYNC_CONFLICT' || reason.code === 'SYNC_NOT_FOUND')) {
        closeExport();
        setConflict(null);
        setError('冲突状态已变化，请重新加载');
      } else {
        setError(messageFromError(reason, '导出失败，请稍后重试'));
      }
    } finally {
      setBusy(false);
    }
  };

  const closeCenter = (): void => {
    closeExport();
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="sync-center-dialog" role="dialog" aria-modal="true" aria-label="同步中心">
        <div className="sync-center-heading">
          <div><p className="eyebrow">ENCRYPTED SYNC</p><h2>同步中心</h2></div>
          <button className="icon-button" type="button" aria-label="关闭同步中心" title="关闭同步中心" onClick={closeCenter}>×</button>
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

        {available && !vaultLocked && current.sync !== 'local-only' && <section className="sync-recovery" aria-labelledby="sync-recovery-title">
          <div className="account-section-heading"><strong id="sync-recovery-title">恢复密钥</strong>{recovery.status === 'configured' && <span>版本 {recovery.activeKeyVersion}</span>}</div>
          {recoveryIssue ? <>
            <p className="dialog-copy"><strong>请离线保存新的恢复密钥</strong>；关闭此窗口后不会再次显示。它不能通过账号密码重置恢复。</p>
            <div className="recovery-key-display"><code>{recoveryIssue.recoveryKey}</code>{clipboard && <button className="button button-ghost button-small" type="button" onClick={() => void copyRecoveryKey()}>{recoveryCopied ? '已复制' : '复制'}</button>}</div>
            <label className="checkbox-field"><input type="checkbox" checked={recoverySavedOffline} onChange={(event) => setRecoverySavedOffline(event.target.checked)} /> <span>我已离线保存恢复密钥</span></label>
            <label className="field recovery-key-confirm-field"><span>再次输入恢复密钥</span><input aria-label="再次输入恢复密钥" type="text" autoComplete="off" spellCheck={false} value={recoveryInput} onChange={(event) => setRecoveryInput(event.target.value)} /></label>
            <button className="button button-primary" type="button" disabled={busy || !recoverySavedOffline || recoveryInput !== recoveryIssue.recoveryKey} onClick={() => void confirmRecoveryKey()}>确认已离线保存</button>
          </> : recovery.status === 'configured' ? <>
            <p className="dialog-copy">恢复密钥已配置。请将它保存在密码管理器或离线介质中；Relay 不保存恢复密钥明文。</p>
            <button className="button button-ghost" type="button" disabled={busy} onClick={() => void issueRecoveryKey()}>轮换恢复密钥</button>
          </> : recovery.status === 'pending-confirmation' ? <>
            <p className="dialog-copy"><strong>恢复密钥待确认</strong>；上次生成的 key 只显示过一次。为继续使用它，请重新生成并离线保存。</p>
            <button className="button button-ghost" type="button" disabled={busy} onClick={() => void issueRecoveryKey()}>重新生成恢复密钥</button>
          </> : <>
            <p className="dialog-copy">恢复密钥用于在新设备上解锁同步 Vault；丢失主密码和恢复密钥时，云端数据不可恢复。</p>
            <button className="button button-ghost" type="button" disabled={busy} onClick={() => void issueRecoveryKey()}>生成恢复密钥</button>
          </>}
        </section>}

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
              <button className="button button-ghost" type="button" disabled={!available || busy || vaultLocked || !fileSave} onClick={openExport}>导出两份</button>
            </div>
            {exportOpen && <div className="sync-export-form" role="dialog" aria-modal="true" aria-label="导出加密副本">
              <div className="account-section-heading"><strong>导出加密副本</strong></div>
              <p className="dialog-copy">导出内容包含本地和远端的加密快照。导出密码只用于保护文件，当前冲突不会被解决。</p>
              <form onSubmit={(event) => { event.preventDefault(); void exportConflict(); }}>
                <label className="field" htmlFor="sync-export-password"><span>导出密码</span><input id="sync-export-password" type="password" autoComplete="new-password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} /></label>
                <label className="field" htmlFor="sync-export-password-confirm"><span>确认导出密码</span><input id="sync-export-password-confirm" type="password" autoComplete="new-password" value={exportPasswordConfirm} onChange={(event) => setExportPasswordConfirm(event.target.value)} /></label>
                <p className="sync-export-hint">至少 8 个字符。请将密码与下载文件分开保存。</p>
                <div className="sync-export-actions">
                  <button className="button button-primary" type="submit" disabled={busy || !exportPassword || !exportPasswordConfirm || exportPassword !== exportPasswordConfirm}>{busy ? '下载中…' : '下载加密副本'}</button>
                  <button className="button button-ghost" type="button" disabled={busy} onClick={closeExport}>取消</button>
                </div>
              </form>
            </div>}
          </> : <p className="dialog-copy">正在加载冲突详情…</p>}
        </section>}

        {visibleStatus === 'device-revoked' && <p className="dialog-warning">当前设备已被撤销。你仍可使用本地 Vault，但需要在账号菜单中重新登录受信任设备。</p>}
        <div className="dialog-actions"><button className="button button-ghost" type="button" onClick={closeCenter}>完成</button></div>
      </section>
    </div>
  );
};
