import { useEffect, useState, type FormEvent } from 'react';

import { AppError } from '@shared/errors';
import type { AccountDeletionState, AccountSession, DeviceDescriptor, SyncState } from '@shared/core/models';
import { ACCOUNT_DELETION_CONFIRMATION, CLOUD_SYNC_DELETION_CONFIRMATION, describeAccountSyncState } from '@shared/core/account-sync';
import { type CapabilitySet } from '@shared/core/capabilities';
import type { AccountSessionPort, DeviceTrustPort, SyncPort } from '@shared/core/ports';

export interface AccountMenuProps {
  capabilities: CapabilitySet;
  account?: AccountSession | null;
  sync?: SyncState | null;
  accountPort?: AccountSessionPort;
  devicesPort?: DeviceTrustPort;
  syncPort?: SyncPort;
  onAccountChange?: (account: AccountSession | null) => void;
  onSyncChange?: (sync: SyncState | null) => void;
  onOpenSync?: () => void;
}

type AuthMode = 'sign-in' | 'register';
type DestructiveAction = 'account-delete' | 'account-restore' | 'cloud-delete' | 'cloud-restore';

const messageFromError = (error: unknown, fallback: string): string => (
  error instanceof AppError || error instanceof Error ? error.message : fallback
);

const formatLastSyncedAt = (value: string | undefined): string => {
  if (!value) return '尚未同步';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `最后同步 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)}` : '最后同步时间未知';
};

const deviceLabel = (device: DeviceDescriptor): string => `${device.label} · ${device.platform}`;

const maskEmail = (email: string): string => {
  const separator = email.indexOf('@');
  if (separator <= 0 || separator === email.length - 1) return '账号已登录';
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  return `${local.slice(0, 1)}***@${domain}`;
};

const formatDeletionRemaining = (remainingMs: number): string => {
  const days = Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1_000)));
  return `约 ${days} 天`;
};

const syncStateFromStatus = (current: SyncState | null, next: Awaited<ReturnType<SyncPort['status']>>): SyncState => {
  const nextState: SyncState = {
    ...(current?.lastSyncedAt === undefined ? {} : { lastSyncedAt: current.lastSyncedAt }),
    sync: next.sync,
    head: next.head,
    pendingCount: next.pendingCount ?? 0
  };
  if (next.lastErrorCode !== undefined) nextState.lastErrorCode = next.lastErrorCode;
  if (next.recovery !== undefined) nextState.recovery = next.recovery;
  if (next.deletion !== undefined) nextState.deletion = next.deletion;
  return nextState;
};

const destructiveActionCopy: Record<DestructiveAction, { title: string; submit: string; confirmation: string; description: string }> = {
  'account-delete': {
    title: '确认删除账号',
    submit: '确认删除账号',
    confirmation: ACCOUNT_DELETION_CONFIRMATION,
    description: '账号会进入 30 天恢复期；云端账号和同步数据将在恢复期结束后删除，本地 Vault 保留。'
  },
  'account-restore': {
    title: '恢复账号删除',
    submit: '确认恢复账号删除',
    confirmation: 'RESTORE ACCOUNT',
    description: '恢复账号后会继续保留本地 Vault；请重新认证以确认这是你的账号。'
  },
  'cloud-delete': {
    title: '确认删除云端同步数据',
    submit: '确认删除云端同步数据',
    confirmation: CLOUD_SYNC_DELETION_CONFIRMATION,
    description: '只删除云端同步数据并停止云同步；本地 Vault、账号和服务器配置保留。'
  },
  'cloud-restore': {
    title: '恢复云端删除',
    submit: '确认恢复云端删除',
    confirmation: 'RESTORE CLOUD DATA',
    description: '恢复云端同步后，已保留的云端数据可以继续同步；请重新认证以确认操作。'
  }
};

export const AccountMenu = ({
  capabilities,
  account = null,
  sync = null,
  accountPort,
  devicesPort,
  syncPort,
  onAccountChange,
  onSyncChange,
  onOpenSync
}: AccountMenuProps) => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<readonly DeviceDescriptor[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [currentAccount, setCurrentAccount] = useState<AccountSession | null>(account);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [accountDeletion, setAccountDeletion] = useState<AccountDeletionState | null>(null);
  const [accountDeletionLoading, setAccountDeletionLoading] = useState(false);
  const [destructiveAction, setDestructiveAction] = useState<DestructiveAction | null>(null);
  const [destructivePassword, setDestructivePassword] = useState('');
  const [destructiveConfirmation, setDestructiveConfirmation] = useState('');
  const [destructiveSubmitting, setDestructiveSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const accountAvailable = capabilities.supports('account.auth') && accountPort !== undefined;
  const syncAvailable = capabilities.supports('sync.encrypted') && syncPort !== undefined;
  const canOpenSync = syncAvailable && onOpenSync !== undefined;
  const syncDescription = describeAccountSyncState(currentAccount?.state ?? 'signed-out', sync?.sync ?? 'local-only');
  const canRequestAccountDeletion = typeof accountPort?.reauthenticate === 'function'
    && (accountDeletion ? typeof accountPort?.restoreDeletion === 'function' : typeof accountPort?.requestDeletion === 'function');
  const canManageCloudDeletion = syncAvailable
    && typeof accountPort?.reauthenticate === 'function'
    && (sync?.deletion ? typeof syncPort?.restoreCloudDeletion === 'function' : typeof syncPort?.requestCloudDeletion === 'function');
  const activeDestructiveCopy = destructiveAction ? destructiveActionCopy[destructiveAction] : null;

  useEffect(() => {
    setCurrentAccount(account);
    setAccountDeletion(null);
    if (!account) {
      setAccountEmail(null);
      setDestructiveAction(null);
    }
  }, [account]);

  useEffect(() => {
    if (!open || !currentAccount || !accountPort?.getDeletion) {
      setAccountDeletionLoading(false);
      if (!currentAccount) setAccountDeletion(null);
      return;
    }
    let cancelled = false;
    setAccountDeletionLoading(true);
    void accountPort.getDeletion()
      .then((deletion) => {
        if (!cancelled) setAccountDeletion(deletion);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFromError(reason, '账号删除状态暂时无法加载'));
      })
      .finally(() => {
        if (!cancelled) setAccountDeletionLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountPort, currentAccount, open]);

  useEffect(() => {
    if (!open || !currentAccount || !devicesPort || !capabilities.supports('device.trust')) {
      setDevices([]);
      setDevicesError(null);
      return;
    }
    let cancelled = false;
    setDevicesLoading(true);
    void devicesPort.listDevices()
      .then((nextDevices) => {
        if (!cancelled) setDevices(nextDevices);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setDevicesError(messageFromError(reason, '设备列表暂时无法加载'));
      })
      .finally(() => {
        if (!cancelled) setDevicesLoading(false);
      });
    return () => { cancelled = true; };
  }, [capabilities, currentAccount, devicesPort, open]);

  const submitAuth = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const labelValue = String(data.get('deviceLabel') ?? '').trim();
    if (!email || !password) {
      setError('请输入账号邮箱和密码');
      return;
    }
    if (!accountPort) {
      setError('当前客户端不支持账号登录');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const nextAccount = mode === 'register'
        ? await accountPort.register(email, password, labelValue || undefined)
        : await accountPort.signIn(email, password, labelValue || undefined);
      form.reset();
      setCurrentAccount(nextAccount);
      setAccountEmail(maskEmail(email));
      setAccountDeletion(null);
      setNotice(null);
      onAccountChange?.(nextAccount);
      setOpen(true);
    } catch (reason: unknown) {
      setError(messageFromError(reason, mode === 'register' ? '注册失败，请稍后重试' : '登录失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  const signOut = async (): Promise<void> => {
    if (!accountPort) return;
    setError(null);
    setSubmitting(true);
    try {
      await accountPort.signOut();
      setCurrentAccount(null);
      setAccountEmail(null);
      setAccountDeletion(null);
      setNotice(null);
      clearDestructiveInputs();
      setDestructiveAction(null);
      onAccountChange?.(null);
      onSyncChange?.(null);
      setDevices([]);
    } catch (reason: unknown) {
      setError(messageFromError(reason, '退出登录失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  const revokeDevice = async (device: DeviceDescriptor): Promise<void> => {
    if (!devicesPort || device.current) return;
    setRevokingDeviceId(device.id);
    setDevicesError(null);
    try {
      await devicesPort.revokeDevice(device.id);
      setDevices((current) => current.filter((item) => item.id !== device.id));
    } catch (reason: unknown) {
      setDevicesError(messageFromError(reason, '设备撤销失败，请稍后重试'));
    } finally {
      setRevokingDeviceId(null);
    }
  };

  const clearDestructiveInputs = (): void => {
    setDestructivePassword('');
    setDestructiveConfirmation('');
  };

  const closeDestructiveAction = (): void => {
    if (destructiveSubmitting) return;
    setDestructiveAction(null);
    clearDestructiveInputs();
  };

  const openDestructiveAction = (action: DestructiveAction): void => {
    setError(null);
    setNotice(null);
    clearDestructiveInputs();
    setDestructiveAction(action);
  };

  const refreshSync = async (): Promise<void> => {
    if (!syncPort) {
      onSyncChange?.(null);
      return;
    }
    const next = await syncPort.status();
    onSyncChange?.(syncStateFromStatus(sync, next));
  };

  const submitDestructiveAction = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!destructiveAction || destructiveSubmitting) return;
    const copy = destructiveActionCopy[destructiveAction];
    if (!destructivePassword) {
      setError('请输入账号密码');
      return;
    }
    if (destructiveConfirmation !== copy.confirmation) {
      setError(`请输入确认文本：${copy.confirmation}`);
      return;
    }
    if (!accountPort?.reauthenticate) {
      setError('当前客户端不支持重新认证');
      return;
    }
    if (destructiveAction === 'account-delete' && !accountPort.requestDeletion) {
      setError('当前客户端不支持账号删除');
      return;
    }
    if (destructiveAction === 'account-restore' && !accountPort.restoreDeletion) {
      setError('当前客户端不支持恢复账号删除');
      return;
    }
    if ((destructiveAction === 'cloud-delete' && (!syncPort || !syncPort.requestCloudDeletion))
      || (destructiveAction === 'cloud-restore' && (!syncPort || !syncPort.restoreCloudDeletion))) {
      setError('当前客户端不支持云端删除管理');
      return;
    }

    setError(null);
    setNotice(null);
    setDestructiveSubmitting(true);
    try {
      await accountPort.reauthenticate(destructivePassword);
      if (destructiveAction === 'account-delete') {
        await accountPort.requestDeletion!(ACCOUNT_DELETION_CONFIRMATION);
        setCurrentAccount(null);
        setAccountDeletion(null);
        setAccountEmail(null);
        setDevices([]);
        onAccountChange?.(null);
        onSyncChange?.(null);
        setNotice('账号删除已计划，本地 Vault 保留');
      } else if (destructiveAction === 'account-restore') {
        await accountPort.restoreDeletion!();
        setAccountDeletion(null);
        if (currentAccount) onAccountChange?.(currentAccount);
        await refreshSync();
        setNotice('账号删除已恢复');
      } else if (destructiveAction === 'cloud-delete') {
        const deletion = await syncPort!.requestCloudDeletion!(CLOUD_SYNC_DELETION_CONFIRMATION);
        const nextSync: SyncState = {
          sync: 'local-only',
          head: null,
          pendingCount: 0,
          ...(sync?.recovery === undefined ? {} : { recovery: sync.recovery }),
          deletion
        };
        onSyncChange?.(nextSync);
        setNotice('云端同步数据已计划删除，本地 Vault 保留');
      } else {
        await syncPort!.restoreCloudDeletion!();
        await refreshSync();
        setNotice('云端同步数据删除已恢复');
      }
      setDestructiveAction(null);
      clearDestructiveInputs();
    } catch (reason: unknown) {
      clearDestructiveInputs();
      setError(messageFromError(reason, '操作失败，请稍后重试'));
    } finally {
      setDestructiveSubmitting(false);
    }
  };

  useEffect(() => {
    if (!destructiveAction) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeDestructiveAction();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [destructiveAction, destructiveSubmitting]);

  return (
    <div className="account-menu">
      <button
        className={`account-menu-trigger ${currentAccount ? 'is-signed-in' : ''}`}
        type="button"
        aria-label="账号菜单"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => { setOpen((current) => !current); setError(null); }}
      >
        <span className="avatar" aria-hidden="true">{currentAccount ? 'A' : 'L'}</span>
        <span className="account-menu-trigger-copy">
          <strong>{currentAccount ? '账号' : '仅本地'}</strong>
          <small>{currentAccount ? (sync?.sync === 'synced' ? '已同步' : '账号已登录') : '不上传'}</small>
        </span>
      </button>

      {open && <section className="account-menu-popover" role="dialog" aria-modal="false" aria-label="账号与同步">
        <div className="account-menu-heading">
          <div><p className="eyebrow">ACCOUNT & SYNC</p><h2>账号与同步</h2></div>
          <button className="icon-button" type="button" aria-label="关闭账号菜单" title="关闭账号菜单" onClick={() => setOpen(false)}>×</button>
        </div>

        <div className={`account-status-badge ${currentAccount ? 'is-signed-in' : ''}`} role="status">
          <span className="status-dot" />
          <span>{currentAccount ? syncDescription.label : '仅本地，不同步'}</span>
        </div>
        {notice && <p className="form-success" role="status">{notice}</p>}

        {!currentAccount && !accountAvailable && <p className="account-menu-copy">账号服务未启用，当前只使用本地加密 Vault。</p>}

        {!currentAccount && accountAvailable && <>
          <p className="account-menu-copy">登录后可在受信任设备间同步加密配置；主密码和私钥不会上传。</p>
          <form className="account-auth-form" onSubmit={(event) => void submitAuth(event)} noValidate>
            <label htmlFor="account-email">账号邮箱</label>
            <input id="account-email" name="email" type="email" autoComplete="email" required />
            <label htmlFor="account-password">账号密码</label>
            <input id="account-password" name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={8} />
            {mode === 'register' && <>
              <label htmlFor="account-device-label">设备名称 <span className="field-help-inline">可选</span></label>
              <input id="account-device-label" name="deviceLabel" type="text" autoComplete="off" placeholder="例如：办公室浏览器" maxLength={128} />
            </>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button-primary button-wide" type="submit" disabled={submitting}>{submitting ? (mode === 'register' ? '注册中…' : '登录中…') : (mode === 'register' ? '注册' : '登录')}</button>
            <button className="button button-ghost button-wide" type="button" onClick={() => { setMode((current) => current === 'sign-in' ? 'register' : 'sign-in'); setError(null); }}>
              {mode === 'register' ? '已有账号，返回登录' : '创建新账号'}
            </button>
          </form>
        </>}

        {currentAccount && <>
          <div className="account-summary">
            <strong>账号已登录</strong>
            <span>账号摘要：{accountEmail ?? '当前会话'}</span>
            <span>当前设备：{currentAccount.deviceId.slice(0, 8)}</span>
            <span>{formatLastSyncedAt(sync?.lastSyncedAt ?? sync?.head?.updatedAt)}</span>
            {sync?.head && <span>云端版本：r{sync.head.revision}</span>}
            {sync?.pendingCount ? <span>待同步变更：{sync.pendingCount}</span> : null}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {canOpenSync && <button className="button button-primary button-wide" type="button" onClick={onOpenSync}>打开同步中心</button>}
          <section className="account-security" aria-labelledby="account-security-title">
            <div className="account-section-heading"><strong id="account-security-title">账号安全</strong>{accountDeletionLoading && <span>加载中…</span>}</div>
            {accountDeletion ? <>
              <p className="account-menu-copy"><strong>账号将在{formatDeletionRemaining(accountDeletion.remainingMs)}后删除</strong>；恢复期内可撤销，<strong>本地 Vault 保留</strong>。</p>
              {canRequestAccountDeletion
                ? <button className="button button-ghost button-wide" type="button" onClick={() => openDestructiveAction('account-restore')}>恢复账号删除</button>
                : <p className="account-menu-copy">当前客户端暂不支持恢复账号删除。</p>}
            </> : <>
              <p className="account-menu-copy">删除账号会进入 30 天恢复期；本地 Vault 和本地服务器配置不会删除。</p>
              {canRequestAccountDeletion
                ? <button className="button button-danger button-wide" type="button" onClick={() => openDestructiveAction('account-delete')}>删除账号</button>
                : <p className="account-menu-copy">当前客户端暂不支持账号删除。</p>}
            </>}
          </section>
          {syncAvailable && <section className="account-security" aria-labelledby="cloud-security-title">
            <div className="account-section-heading"><strong id="cloud-security-title">云端同步数据</strong></div>
            {sync?.deletion ? <>
              <p className="account-menu-copy"><strong>云端同步数据将在{formatDeletionRemaining(sync.deletion.remainingMs)}后删除</strong>；已停止云同步，本地 Vault 保留。</p>
              {canManageCloudDeletion
                ? <button className="button button-ghost button-wide" type="button" onClick={() => openDestructiveAction('cloud-restore')}>恢复云端删除</button>
                : <p className="account-menu-copy">当前客户端暂不支持恢复云端删除。</p>}
            </> : <>
              <p className="account-menu-copy">只删除云端同步副本，不影响账号、本地 Vault 或服务器配置。</p>
              {canManageCloudDeletion
                ? <button className="button button-danger button-wide" type="button" onClick={() => openDestructiveAction('cloud-delete')}>删除云端同步数据</button>
                : <p className="account-menu-copy">当前客户端暂不支持云端同步数据删除。</p>}
            </>}
          </section>}
          <button className="button button-ghost button-wide" type="button" disabled={submitting} onClick={() => void signOut()}>退出登录</button>

          {devicesPort && capabilities.supports('device.trust') && <section className="account-devices" aria-labelledby="account-devices-title">
            <div className="account-section-heading"><strong id="account-devices-title">受信任设备</strong>{devicesLoading && <span>加载中…</span>}</div>
            {devicesError && <p className="form-error" role="alert">{devicesError}</p>}
            {!devicesLoading && !devicesError && devices.length === 0 && <p className="account-menu-copy">暂无设备信息。</p>}
            <ul>
              {devices.map((device) => <li key={device.id}>
                <span><strong>{deviceLabel(device)}{device.current ? ' · 当前' : ''}</strong><small>{device.revokedAt ? '已撤销' : device.lastSeenAt ? `最近活动 ${device.lastSeenAt.slice(0, 10)}` : '尚未连接'}</small></span>
                {!device.current && !device.revokedAt && <button className="button button-ghost button-small" type="button" disabled={revokingDeviceId === device.id} onClick={() => void revokeDevice(device)}>{revokingDeviceId === device.id ? '撤销中…' : '撤销'}</button>}
              </li>)}
            </ul>
          </section>}
        </>}
      </section>}

      {destructiveAction && activeDestructiveCopy && <div
        className="modal-backdrop account-destructive-backdrop"
        role="presentation"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeDestructiveAction(); }}
      >
        <section className="account-destructive-dialog" role="dialog" aria-modal="true" aria-labelledby="account-destructive-title" onMouseDown={(event) => event.stopPropagation()}>
          <div className="account-menu-heading">
            <div><p className="eyebrow">CONFIRM ACTION</p><h2 id="account-destructive-title">{activeDestructiveCopy.title}</h2></div>
            <button className="icon-button" type="button" aria-label="取消危险操作" title="取消危险操作" onClick={closeDestructiveAction}>×</button>
          </div>
          <p className="account-menu-copy">{activeDestructiveCopy.description}</p>
          <form className="account-security-form" onSubmit={(event) => void submitDestructiveAction(event)} noValidate>
            <label htmlFor="account-destructive-password">重新输入账号密码</label>
            <input
              id="account-destructive-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={destructivePassword}
              onChange={(event) => setDestructivePassword(event.target.value)}
            />
            <label htmlFor="account-destructive-confirmation">输入确认文本</label>
            <input
              id="account-destructive-confirmation"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={destructiveConfirmation}
              onChange={(event) => setDestructiveConfirmation(event.target.value)}
            />
            <p className="field-help">请输入：<code>{activeDestructiveCopy.confirmation}</code></p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button className="button button-danger" type="submit" disabled={destructiveSubmitting}>{destructiveSubmitting ? '处理中…' : activeDestructiveCopy.submit}</button>
              <button className="button button-ghost" type="button" disabled={destructiveSubmitting} onClick={closeDestructiveAction}>取消</button>
            </div>
          </form>
        </section>
      </div>}
    </div>
  );
};
