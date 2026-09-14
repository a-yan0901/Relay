import { useState, type FormEvent } from 'react';

export interface UnlockViewProps {
  onSubmit: (masterPassword: string) => Promise<void>;
  errorMessage?: string | null;
}

export const UnlockView = ({ onSubmit, errorMessage }: UnlockViewProps) => {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(password);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-stage">
      <section className="auth-card" aria-labelledby="unlock-title">
        <div className="brand-mark">W</div>
        <p className="eyebrow">WEB SSH WORKSPACE</p>
        <h1 id="unlock-title">欢迎回来</h1>
        <p className="auth-copy">输入主密码解锁你的服务器工作区。</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <label htmlFor="unlock-password">主密码</label>
          <input id="unlock-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />
          {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
          <button className="button button-primary button-wide" type="submit" disabled={submitting}>{submitting ? '解锁中…' : '解锁 Vault'}</button>
        </form>
      </section>
    </main>
  );
};
