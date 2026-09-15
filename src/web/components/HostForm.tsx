import { useState, type FormEvent } from 'react';

import { AppError } from '@shared/errors';
import {
  parseHostCreateInput,
  parseHostPatchInput,
  defaultConnectionProfileSettings,
  type HostCreateInput,
  type HostPatchInput
} from '@shared/validation';

import type { GroupSummary, HostMetadataState } from '../state/app-state';

export interface HostFormProps {
  onSubmit?: (input: HostCreateInput) => Promise<void> | void;
  onEditSubmit?: (input: HostPatchInput) => Promise<void> | void;
  onCancel: () => void;
  mode?: 'create' | 'edit';
  initialHost?: HostMetadataState;
  groups?: GroupSummary[];
  hosts?: HostMetadataState[];
}

interface HostFormState {
  name: string;
  address: string;
  port: string;
  username: string;
  authType: 'password' | 'private_key';
  password: string;
  privateKey: string;
  passphrase: string;
  groupId: string;
  tags: string;
  isFavorite: boolean;
  jumpHostIds: string[];
  keepaliveIntervalMs: string;
  keepaliveCountMax: string;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: string;
  reconnectBaseDelayMs: string;
  reconnectMaxDelayMs: string;
}

const defaultProfile = defaultConnectionProfileSettings();

const initialForm: HostFormState = {
  name: '',
  address: '',
  port: '22',
  username: '',
  authType: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  groupId: '',
  tags: '',
  isFavorite: false,
  jumpHostIds: [],
  keepaliveIntervalMs: String(defaultProfile.keepaliveIntervalMs),
  keepaliveCountMax: String(defaultProfile.keepaliveCountMax),
  reconnectEnabled: defaultProfile.reconnect.enabled,
  reconnectMaxAttempts: String(defaultProfile.reconnect.maxAttempts),
  reconnectBaseDelayMs: String(defaultProfile.reconnect.baseDelayMs),
  reconnectMaxDelayMs: String(defaultProfile.reconnect.maxDelayMs)
};

const formFromHost = (host: HostMetadataState): HostFormState => {
  const profile = host.connectionProfile ?? defaultProfile;
  return {
    name: host.name,
    address: host.address,
    port: String(host.port),
    username: host.username,
    authType: host.authType,
    password: '',
    privateKey: '',
    passphrase: '',
    groupId: host.groupId ?? '',
    tags: host.tags.join(', '),
    isFavorite: host.isFavorite,
    jumpHostIds: [...(host.jumpHostIds ?? [])],
    keepaliveIntervalMs: String(profile.keepaliveIntervalMs),
    keepaliveCountMax: String(profile.keepaliveCountMax),
    reconnectEnabled: profile.reconnect.enabled,
    reconnectMaxAttempts: String(profile.reconnect.maxAttempts),
    reconnectBaseDelayMs: String(profile.reconnect.baseDelayMs),
    reconnectMaxDelayMs: String(profile.reconnect.maxDelayMs)
  };
};

export const HostForm = ({
  onSubmit,
  onEditSubmit,
  onCancel,
  mode = 'create',
  initialHost,
  groups = [],
  hosts = []
}: HostFormProps) => {
  const isEdit = mode === 'edit';
  const [form, setForm] = useState(() => initialHost ? formFromHost(initialHost) : initialForm);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = <K extends keyof HostFormState>(key: K, value: HostFormState[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    const raw: Record<string, unknown> = {
      name: form.name,
      address: form.address,
      port: Number(form.port),
      username: form.username,
      groupId: form.groupId || null,
      jumpHostIds: form.jumpHostIds,
      connectionProfile: {
        keepaliveIntervalMs: Number(form.keepaliveIntervalMs),
        keepaliveCountMax: Number(form.keepaliveCountMax),
        reconnect: {
          enabled: form.reconnectEnabled,
          maxAttempts: Number(form.reconnectMaxAttempts),
          baseDelayMs: Number(form.reconnectBaseDelayMs),
          maxDelayMs: Number(form.reconnectMaxDelayMs)
        }
      },
      tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      isFavorite: form.isFavorite
    };
    const credentialChanged = !isEdit || initialHost === undefined || initialHost.authType !== form.authType || form.password.length > 0 || form.privateKey.length > 0 || form.passphrase.length > 0;
    if (credentialChanged) {
      raw.auth = form.authType === 'password'
        ? { type: 'password', password: form.password }
        : { type: 'private_key', privateKey: form.privateKey, passphrase: form.passphrase || undefined };
    }

    let parsed: HostCreateInput | HostPatchInput;
    try {
      parsed = isEdit ? parseHostPatchInput(raw) : parseHostCreateInput(raw);
    } catch (validationError) {
      setError(validationError instanceof AppError ? validationError.message : '请检查服务器配置');
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit) {
        if (!onEditSubmit) throw new Error('编辑回调缺失');
        await onEditSubmit(parsed as HostPatchInput);
      } else {
        if (!onSubmit) throw new Error('保存回调缺失');
        await onSubmit(parsed as HostCreateInput);
        setForm(initialForm);
      }
    } catch (submitError) {
      setError(submitError instanceof AppError ? submitError.message : '保存失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="host-form" onSubmit={submit} noValidate>
      <div className="form-heading">
        <div>
          <p className="eyebrow">{isEdit ? 'EDIT CONNECTION' : 'NEW CONNECTION'}</p>
          <h2 id="host-form-title">{isEdit ? '编辑 Server' : '添加 Server'}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onCancel} aria-label="关闭表单">×</button>
      </div>

      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="host-name">服务器名称</label>
          <input id="host-name" value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：Production API" />
        </div>
        <div className="field field-wide">
          <label htmlFor="host-address">IP / 域名</label>
          <input id="host-address" value={form.address} onChange={(event) => update('address', event.target.value)} placeholder="例如：10.0.0.8" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="host-port">端口</label>
          <input id="host-port" type="number" min="1" max="65535" value={form.port} onChange={(event) => update('port', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="host-username">用户名</label>
          <input id="host-username" value={form.username} onChange={(event) => update('username', event.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="field field-wide">
          <label htmlFor="host-auth-type">认证方式</label>
          <select id="host-auth-type" value={form.authType} onChange={(event) => update('authType', event.target.value as HostFormState['authType'])}>
            <option value="password">密码</option>
            <option value="private_key">私钥</option>
          </select>
        </div>
        <div className="field field-wide">
          <label htmlFor="host-group">分组</label>
          <select id="host-group" value={form.groupId} onChange={(event) => update('groupId', event.target.value)}>
            <option value="">未分组</option>
            {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
          </select>
        </div>
        <div className="field field-wide">
          <label htmlFor="host-jump-hosts">跳板机（可选，按连接顺序）</label>
          <select id="host-jump-hosts" multiple size={Math.min(4, Math.max(2, hosts.filter((host) => host.id !== initialHost?.id).length || 2))} value={form.jumpHostIds.filter((id) => id !== initialHost?.id)} onChange={(event) => update('jumpHostIds', Array.from(event.target.selectedOptions, (option) => option.value))}>
            {hosts.filter((host) => host.id !== initialHost?.id).map((host) => <option value={host.id} key={host.id}>{host.name} · {host.address}</option>)}
          </select>
          <small className="field-help">最多 4 跳；跳板机凭据只在服务端解密。</small>
        </div>
        <details className="field field-wide host-advanced-settings">
          <summary>连接高级设置</summary>
          <div className="form-grid form-grid-nested">
            <div className="field">
              <label htmlFor="host-keepalive-interval">Keepalive 间隔（毫秒）</label>
              <input id="host-keepalive-interval" type="number" min="0" max="600000" value={form.keepaliveIntervalMs} onChange={(event) => update('keepaliveIntervalMs', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="host-keepalive-count">Keepalive 次数</label>
              <input id="host-keepalive-count" type="number" min="0" max="100" value={form.keepaliveCountMax} onChange={(event) => update('keepaliveCountMax', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="host-reconnect-attempts">自动重连次数</label>
              <input id="host-reconnect-attempts" type="number" min="0" max="20" value={form.reconnectMaxAttempts} onChange={(event) => update('reconnectMaxAttempts', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="host-reconnect-base-delay">首次重连等待（毫秒）</label>
              <input id="host-reconnect-base-delay" type="number" min="0" max="60000" value={form.reconnectBaseDelayMs} onChange={(event) => update('reconnectBaseDelayMs', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="host-reconnect-max-delay">最大重连等待（毫秒）</label>
              <input id="host-reconnect-max-delay" type="number" min="0" max="600000" value={form.reconnectMaxDelayMs} onChange={(event) => update('reconnectMaxDelayMs', event.target.value)} />
            </div>
            <label className="checkbox-field" htmlFor="host-reconnect-enabled">
              <input id="host-reconnect-enabled" type="checkbox" checked={form.reconnectEnabled} onChange={(event) => update('reconnectEnabled', event.target.checked)} />
              <span>断线后自动重连</span>
            </label>
          </div>
        </details>
        {form.authType === 'password' ? (
          <div className="field field-wide">
            <label htmlFor="host-password">密码{isEdit ? '（留空保留现有）' : ''}</label>
            <input id="host-password" type="password" value={form.password} onChange={(event) => update('password', event.target.value)} autoComplete="new-password" placeholder={isEdit ? '留空保留现有密码' : undefined} />
          </div>
        ) : (
          <>
            <div className="field field-wide">
              <label htmlFor="host-private-key">私钥{isEdit ? '（留空保留现有）' : ''}</label>
              <textarea id="host-private-key" value={form.privateKey} onChange={(event) => update('privateKey', event.target.value)} rows={6} spellCheck={false} placeholder={isEdit ? '留空保留现有私钥' : undefined} />
            </div>
            <div className="field field-wide">
              <label htmlFor="host-passphrase">私钥口令</label>
              <input id="host-passphrase" type="password" value={form.passphrase} onChange={(event) => update('passphrase', event.target.value)} autoComplete="new-password" />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="host-tags">标签</label>
          <input id="host-tags" value={form.tags} onChange={(event) => update('tags', event.target.value)} placeholder="prod, api" />
        </div>
        <label className="checkbox-field" htmlFor="host-favorite">
          <input id="host-favorite" type="checkbox" checked={form.isFavorite} onChange={(event) => update('isFavorite', event.target.checked)} />
          <span>加入收藏</span>
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="button button-ghost" type="button" onClick={onCancel}>取消</button>
        <button className="button button-primary" type="submit" disabled={submitting}>{submitting ? '保存中…' : isEdit ? '保存修改' : '保存 Server'}</button>
      </div>
    </form>
  );
};
