import { useState, type FormEvent, type ReactNode } from 'react';

import { AppError } from '@shared/errors';
import type { AccountSession } from '@shared/core/models';
import type { VaultRecoveryPort } from '@shared/core/ports';
import { SyncRecoveryView } from './SyncRecoveryView';

const MASTER_PASSWORD_MIN_LENGTH = 8;

export interface SetupGateProps {
  onSubmit: (masterPassword: string) => Promise<void>;
  errorMessage?: string | null;
  headerSlot?: ReactNode;
  account?: AccountSession | null;
  recoveryPort?: VaultRecoveryPort;
  onRecovered?: () => Promise<void>;
}

export const SetupGate = ({ onSubmit, errorMessage, headerSlot, account = null, recoveryPort, onRecovered }: SetupGateProps) => {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password.length < MASTER_PASSWORD_MIN_LENGTH) {
      setError('主密码至少需要 8 个字符');
      return;
    }
    if (password !== confirmation) {
      setError('两次输入的主密码不一致');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(password);
      setPassword('');
      setConfirmation('');
    } catch (reason) {
      setError(reason instanceof AppError ? reason.message : '初始化失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (recoveryOpen && recoveryPort && onRecovered) {
    return (
      <main className="auth-stage">
        {headerSlot && <div className="auth-header-slot">{headerSlot}</div>}
        <SyncRecoveryView
          account={account}
          recoveryPort={recoveryPort}
          onRecovered={onRecovered}
          onBack={() => setRecoveryOpen(false)}
        />
      </main>
    );
  }

  return (
    <main className="auth-stage">
      {headerSlot && <div className="auth-header-slot">{headerSlot}</div>}
      <section className="auth-card" aria-labelledby="setup-title">
        <div className="brand-mark">W</div>
        <p className="eyebrow">WEB SSH WORKSPACE</p>
        <h1 id="setup-title">建立你的 Server Vault</h1>
        <p className="auth-copy">所有服务器凭据只保存在当前实例的加密 Vault 中。主密码至少 8 个字符。</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <label htmlFor="setup-password">主密码</label>
          <input id="setup-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} />
          <label htmlFor="setup-confirmation">确认主密码</label>
          <input id="setup-confirmation" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} />
          {(error ?? errorMessage) && <p className="form-error" role="alert">{error ?? errorMessage}</p>}
          <button className="button button-primary button-wide" type="submit" disabled={submitting}>{submitting ? '创建中…' : '创建 Vault'}</button>
        </form>
        <p className="security-note">主密码不会上传或落库。遗失后无法恢复已保存凭据。</p>
        {recoveryPort && onRecovered && <button className="button button-ghost button-wide unlock-recovery-trigger" type="button" onClick={() => setRecoveryOpen(true)}>使用同步恢复</button>}
      </section>
    </main>
  );
};
