import { useState } from 'react';

import { AppError } from '@shared/errors';
import type { IdentityMetadata } from '../../shared/core/models';
import {
  identityCreateSchema,
  identityUpdateSchema,
  type IdentityCreateInput,
  type IdentityUpdateInput
} from '../../shared/validation';

export interface IdentityEditorProps {
  identity?: IdentityMetadata;
  onSubmit: (input: IdentityCreateInput | IdentityUpdateInput) => Promise<void> | void;
  onCancel: () => void;
}

export const IdentityEditor = ({ identity, onSubmit, onCancel }: IdentityEditorProps) => {
  const isEdit = identity !== undefined;
  const [name, setName] = useState(identity?.name ?? '');
  const [type, setType] = useState<'password' | 'private_key'>(identity?.type ?? 'password');
  const [username, setUsername] = useState(identity?.username ?? '');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    const auth = type === 'password'
      ? { type: 'password' as const, password }
      : { type: 'private_key' as const, privateKey, passphrase: passphrase || undefined };
    const raw: Record<string, unknown> = { name, type, username };
    if (!isEdit || password.length > 0 || privateKey.length > 0 || passphrase.length > 0) raw.auth = auth;
    const parsed = (isEdit ? identityUpdateSchema : identityCreateSchema).safeParse(raw);
    if (!parsed.success) {
      setError(new AppError('HOST_VALIDATION_FAILED').message);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } catch (submitError) {
      setError(submitError instanceof AppError ? submitError.message : '保存身份失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="identity-editor" aria-labelledby="identity-editor-title">
      <div className="form-heading"><div><p className="eyebrow">{isEdit ? 'EDIT IDENTITY' : 'NEW IDENTITY'}</p><h3 id="identity-editor-title">{isEdit ? '编辑身份' : '新建身份'}</h3></div><button className="icon-button" type="button" aria-label="关闭身份编辑" title="关闭身份编辑" onClick={onCancel}>×</button></div>
      <div className="form-grid">
        <div className="field field-wide"><label htmlFor="identity-name">身份名称</label><input id="identity-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Production deploy" /></div>
        <div className="field"><label htmlFor="identity-type">认证方式</label><select id="identity-type" value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="password">密码</option><option value="private_key">私钥</option></select></div>
        <div className="field"><label htmlFor="identity-username">身份用户名</label><input id="identity-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /><small className="field-help">仅作为选择身份时的默认用户名；Host 已填写的用户名优先。</small></div>
        {type === 'password' ? <div className="field field-wide"><label htmlFor="identity-password">身份密码{isEdit ? '（留空保留现有）' : ''}</label><input id="identity-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></div> : <><div className="field field-wide"><label htmlFor="identity-private-key">身份私钥{isEdit ? '（留空保留现有）' : ''}</label><textarea id="identity-private-key" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} rows={6} spellCheck={false} /></div><div className="field field-wide"><label htmlFor="identity-passphrase">私钥口令</label><input id="identity-passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" /></div></>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button button-ghost" type="button" onClick={onCancel}>取消</button><button className="button button-primary" type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? '保存中…' : '保存身份'}</button></div>
    </section>
  );
};
