import { useState } from 'react';

import type { IdentityMetadata } from '../../shared/core/models';
import type { IdentityCreateInput, IdentityUpdateInput } from '../../shared/validation';
import { Dialog } from './Dialog';
import { IdentityEditor } from './IdentityEditor';

export interface IdentityManagerProps {
  identities: readonly IdentityMetadata[];
  onCreate: (input: IdentityCreateInput) => Promise<void> | void;
  onUpdate: (id: string, input: IdentityUpdateInput) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onClose: () => void;
}

export const IdentityManager = ({ identities, onCreate, onUpdate, onDelete, onClose }: IdentityManagerProps) => {
  const [editing, setEditing] = useState<IdentityMetadata | null | 'new'>(null);

  return (
    <Dialog title="身份管理" onClose={onClose} initialFocusSelector="#identity-create-button" className="identity-manager-dialog">
      <p className="dialog-copy">身份只返回名称、用户名、类型、指纹和使用数量；密码、私钥和口令始终留在服务端 Vault。</p>
      <div className="identity-manager-toolbar"><span>{identities.length} 个可复用身份</span><button id="identity-create-button" className="button button-primary button-small" type="button" onClick={() => setEditing('new')}>新建身份</button></div>
      {identities.length === 0 ? <div className="empty-state empty-state-compact"><h3>还没有可复用身份</h3><p>创建后可以在多个 Server 之间共享认证配置。</p></div> : <div className="identity-list" aria-label="身份列表">{identities.map((identity) => <article className="identity-item" key={identity.id}><div><strong>{identity.name}</strong><small>{identity.username} · {identity.type === 'password' ? '密码' : '私钥'} · {identity.keyFingerprint ? `SHA-256：${identity.keyFingerprint}` : '未记录公钥指纹'} · {identity.usageCount} 台 Server 使用中</small></div><div className="identity-item-actions"><button className="button button-ghost button-small" type="button" onClick={() => setEditing(identity)}>编辑</button><button className="button button-ghost button-small" type="button" onClick={() => void onDelete(identity.id)}>删除</button></div></article>)}</div>}
      {editing !== null && <div className="identity-editor-wrap"><IdentityEditor identity={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSubmit={async (input) => { if (editing === 'new') await onCreate(input as IdentityCreateInput); else await onUpdate(editing.id, input as IdentityUpdateInput); setEditing(null); }} /></div>}
    </Dialog>
  );
};
