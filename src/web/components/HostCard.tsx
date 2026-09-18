import type { MouseEvent as ReactMouseEvent } from 'react';

import type { HostMetadataState } from '../state/app-state';

export interface HostCardProps {
  host: HostMetadataState;
  onConnect: (host: HostMetadataState) => void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onEdit?: (host: HostMetadataState) => void;
  onDelete?: (host: HostMetadataState) => void;
  onTestConnection?: (host: HostMetadataState) => void;
  onClearHostKey?: (host: HostMetadataState) => void;
  groupName?: string;
  onTagSelected?: (tag: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, host: HostMetadataState) => void;
  onTagContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>, tag: string, host: HostMetadataState) => void;
}

const openHostContextMenu = (event: ReactMouseEvent<HTMLElement>, host: HostMetadataState, onContextMenu?: HostCardProps['onContextMenu']): void => {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('.tag-button')) return;
  onContextMenu?.(event, host);
};

const formatLastConnected = (value: string | null): string => {
  if (!value) return '尚未连接';
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return '最近连接时间未知';
  return `最近连接：${timestamp.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}`;
};

export const HostCard = ({ host, onConnect, onFavoriteToggle, onEdit, onDelete, onTestConnection, onClearHostKey, groupName, onTagSelected, onContextMenu, onTagContextMenu }: HostCardProps) => (
  <article className="host-card" onContextMenuCapture={(event) => openHostContextMenu(event, host, onContextMenu)}>
    <div className="host-card-main">
      <div className="card-title-line">
        <h2>{host.name}</h2>
        {host.isFavorite && <span className="favorite-star" aria-label="已收藏">★</span>}
      </div>
      <p className="host-address"><strong>{host.username}</strong>@{host.address}:{host.port}</p>
      <div className="host-meta">
        <span><span aria-hidden="true">{host.authType === 'password' ? '▣' : '⌁'}</span><span>{host.authType === 'password' ? '密码认证' : '私钥认证'}</span></span>
        <span className="host-key-status"><span aria-hidden="true">{host.hostKeyFingerprint ? '✓' : '!'}</span><span>{host.hostKeyFingerprint ? '指纹已验证' : '等待首次验证'}</span>{host.hostKeyAlgorithm && <span className="host-key-detail">{host.hostKeyAlgorithm}</span>}{host.hostKeyFingerprint && <span className="host-key-detail">{host.hostKeyFingerprint}</span>}</span>
        {host.identityName && <span>{host.identitySource === 'group' ? `继承身份：${host.identityName}` : `身份：${host.identityName}`}</span>}
        {host.credentialSource && !host.identityName && <span>{host.credentialSource.type === 'group' ? '分组默认身份：待解析' : host.credentialSource.type === 'identity' ? '身份：未找到' : 'Host 独立凭据'}</span>}
        {groupName && <span>环境：{groupName}</span>}
      </div>
      <p className="host-last-connected">{formatLastConnected(host.lastConnectedAt)}</p>
      {host.tags.length > 0 && <div className="tag-list">{host.tags.map((tag) => onTagSelected
        ? <button className="tag tag-button" type="button" key={tag} aria-label={`筛选标签 ${tag}`} onClick={() => onTagSelected(tag)} onContextMenu={(event) => { event.stopPropagation(); onTagContextMenu?.(event, tag, host); }}>{tag}</button>
        : <span className="tag" key={tag}>{tag}</span>)}</div>}
    </div>
    <div className="host-card-actions">
      <button className="card-action" type="button" aria-label={`收藏 ${host.name}`} aria-pressed={host.isFavorite} onClick={() => onFavoriteToggle(host)}><span aria-hidden="true">{host.isFavorite ? '★' : '☆'}</span> {host.isFavorite ? '取消收藏' : '收藏'}</button>
      {onTestConnection && <button className="card-action" type="button" aria-label={`测试连接 ${host.name}`} onClick={() => onTestConnection(host)}><span aria-hidden="true">◌</span> 测试</button>}
      {onEdit && <button className="card-action" type="button" aria-label={`编辑 ${host.name}`} onClick={() => onEdit(host)}><span aria-hidden="true">✎</span> 编辑</button>}
      {onClearHostKey && host.hostKeyFingerprint && <button className="card-action" type="button" aria-label={`清除 Host Key 信任 ${host.name}`} onClick={() => onClearHostKey(host)}><span aria-hidden="true">⌫</span> 清除信任</button>}
      {onDelete && <button className="card-action card-action-danger" type="button" aria-label={`删除 ${host.name}`} onClick={() => onDelete(host)}><span aria-hidden="true">×</span> 删除</button>}
      <button className="card-action card-action-connect" type="button" aria-label={`进入 Console：${host.name}`} onClick={() => onConnect(host)}><span aria-hidden="true">→</span> 进入 Console</button>
    </div>
  </article>
);
