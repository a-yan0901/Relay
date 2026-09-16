import { useState, type FormEvent, type ReactNode } from 'react';

import { AppError } from '@shared/errors';

const MASTER_PASSWORD_MIN_LENGTH = 8;

export interface UnlockViewProps {
  onSubmit: (masterPassword: string) => Promise<void>;
  errorMessage?: string | null;
  headerSlot?: ReactNode;
}

export const UnlockView = ({ onSubmit, errorMessage, headerSlot }: UnlockViewProps) => {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password.length < MASTER_PASSWORD_MIN_LENGTH) {
      setError('主密码至少需要 8 个字符');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(password);
      setPassword('');
    } catch (reason) {
      setError(reason instanceof AppError ? reason.message : '解锁失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-stage">
      {headerSlot && <div className="auth-header-slot">{headerSlot}</div>}
      <section className="auth-card" aria-labelledby="unlock-title">
        <div className="brand-mark">W</div>
        <p className="eyebrow">WEB SSH WORKSPACE</p>
        <h1 id="unlock-title">欢迎回来</h1>
        <p className="auth-copy">输入至少 8 个字符的主密码解锁你的服务器工作区。</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <label htmlFor="unlock-password">主密码</label>
          <input id="unlock-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus minLength={8} />
          {(error ?? errorMessage) && <p className="form-error" role="alert">{error ?? errorMessage}</p>}
          <button className="button button-primary button-wide" type="submit" disabled={submitting}>{submitting ? '解锁中…' : '解锁 Vault'}</button>
        </form>
      </section>
    </main>
  );
};
