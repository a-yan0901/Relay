import { useState, type FormEvent } from 'react';

import { AppError } from '@shared/errors';
import type { AccountSession, VaultRecoveryPreview } from '@shared/core/models';
import type { VaultRecoveryInput, VaultRecoveryPort } from '@shared/core/ports';

const MASTER_PASSWORD_MIN_LENGTH = 8;

export interface SyncRecoveryViewProps {
  account: AccountSession | null;
  recoveryPort?: VaultRecoveryPort;
  onRecovered: () => Promise<void>;
  onBack: () => void;
}

const messageFromError = (error: unknown): string => (
  error instanceof AppError || error instanceof Error ? error.message : '恢复失败，请稍后重试'
);

const shouldRestartPreview = (error: unknown): boolean => error instanceof AppError && (error.code === 'SYNC_NOT_FOUND' || error.code === 'SYNC_CONFLICT');

const recoverySummary = (preview: VaultRecoveryPreview): string => (
  `将恢复 ${preview.hostCount} 台 Server、${preview.groupCount} 个分组、${preview.identityCount} 个身份和 ${preview.snippetCount} 个片段`
);

export const SyncRecoveryView = ({ account, recoveryPort, onRecovered, onBack }: SyncRecoveryViewProps) => {
  const [method, setMethod] = useState<VaultRecoveryInput['method']>('recovery-key');
  const [secret, setSecret] = useState('');
  const [preview, setPreview] = useState<VaultRecoveryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectMethod = (nextMethod: VaultRecoveryInput['method']): void => {
    setMethod(nextMethod);
    setSecret('');
    setPreview(null);
    setError(null);
  };

  const previewRecovery = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!account || account.state !== 'signed-in') {
      setError('请先登录账号，再恢复云端 Vault');
      return;
    }
    if (!recoveryPort) {
      setError('当前客户端不支持同步恢复');
      return;
    }
    if (secret.length < (method === 'master-password' ? MASTER_PASSWORD_MIN_LENGTH : 1)) {
      setError(method === 'master-password' ? '主密码至少需要 8 个字符' : '请输入恢复密钥');
      return;
    }
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await recoveryPort.preview({ method, secret }));
    } catch (reason: unknown) {
      setError(messageFromError(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyRecovery = async (): Promise<void> => {
    if (!preview || !recoveryPort || !account || account.state !== 'signed-in') return;
    setBusy(true);
    setError(null);
    try {
      await recoveryPort.apply(preview.previewId, { method, secret });
      setSecret('');
      setPreview(null);
      await onRecovered();
    } catch (reason: unknown) {
      if (shouldRestartPreview(reason)) setPreview(null);
      setError(messageFromError(reason));
    } finally {
      setBusy(false);
    }
  };

  const goBack = (): void => {
    setSecret('');
    setPreview(null);
    setError(null);
    onBack();
  };

  if (!account || account.state !== 'signed-in') {
    return (
      <section className="auth-card sync-recovery-card" aria-labelledby="sync-recovery-title">
        <div className="brand-mark">W</div>
        <p className="eyebrow">NEW DEVICE RECOVERY</p>
        <h1 id="sync-recovery-title">恢复云端 Vault</h1>
        <p className="auth-copy">请先登录账号，再使用原 Vault 主密码或已确认的恢复密钥恢复本地数据。</p>
        <p className="dialog-warning" role="status">请先登录账号，再恢复云端 Vault</p>
        <button className="button button-ghost button-wide" type="button" onClick={goBack}>返回主密码解锁</button>
      </section>
    );
  }

  return (
    <section className="auth-card sync-recovery-card" aria-labelledby="sync-recovery-title">
      <div className="brand-mark">W</div>
      <p className="eyebrow">NEW DEVICE RECOVERY</p>
      <h1 id="sync-recovery-title">恢复云端 Vault</h1>
      <p className="auth-copy">先验证解锁方式并预览同步范围；确认后才会在当前设备创建本地 Vault。</p>

      <div className="recovery-methods" role="group" aria-label="恢复方式">
        <button className={`button button-small ${method === 'recovery-key' ? 'button-primary' : 'button-ghost'}`} type="button" onClick={() => selectMethod('recovery-key')}>恢复密钥</button>
        <button className={`button button-small ${method === 'master-password' ? 'button-primary' : 'button-ghost'}`} type="button" onClick={() => selectMethod('master-password')}>原 Vault 主密码</button>
      </div>

      <form className="auth-form" onSubmit={(event) => void previewRecovery(event)} noValidate>
        <label htmlFor="sync-recovery-secret">恢复密钥或原 Vault 主密码</label>
        <input
          id="sync-recovery-secret"
          type="password"
          value={secret}
          onChange={(event) => { setSecret(event.target.value); setPreview(null); setError(null); }}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary button-wide" type="submit" disabled={busy}>{busy ? '验证中…' : '预览恢复内容'}</button>
      </form>

      {preview && <section className="sync-recovery-preview" aria-labelledby="sync-recovery-preview-title">
        <div className="account-section-heading"><strong id="sync-recovery-preview-title">恢复预览</strong><span>云端 r{preview.revision}</span></div>
        <p className="dialog-copy">{`${recoverySummary(preview)}${preview.workspaceIncluded ? '，以及工作区布局。' : '。'} `}</p>
        {preview.conflictTypes.length > 0 && <p className="dialog-warning">当前设备已有同类数据，应用前需要明确处理冲突：{preview.conflictTypes.join('、')}。</p>}
        <p className="security-note">预览有效期有限；账号密码不能替代 Vault 解锁材料，恢复密钥丢失后无法找回。</p>
        <button className="button button-primary button-wide" type="button" disabled={busy} onClick={() => void applyRecovery()}>创建本地 Vault 并应用</button>
      </section>}

      <button className="button button-ghost button-wide" type="button" disabled={busy} onClick={goBack}>返回主密码解锁</button>
    </section>
  );
};
