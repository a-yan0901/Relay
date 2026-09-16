import { useEffect, useState, type FormEvent } from 'react';

import { AppError } from '@shared/errors';
import type { AccountSession, DeviceDescriptor, SyncState } from '@shared/core/models';
import { describeAccountSyncState } from '@shared/core/account-sync';
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

  const accountAvailable = capabilities.supports('account.auth') && accountPort !== undefined;
  const syncAvailable = capabilities.supports('sync.encrypted') && syncPort !== undefined && onOpenSync !== undefined;
  const syncDescription = describeAccountSyncState(currentAccount?.state ?? 'signed-out', sync?.sync ?? 'local-only');

  useEffect(() => {
    setCurrentAccount(account);
    if (!account) setAccountEmail(null);
  }, [account]);

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
          {syncAvailable && <button className="button button-primary button-wide" type="button" onClick={onOpenSync}>打开同步中心</button>}
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
    </div>
  );
};
