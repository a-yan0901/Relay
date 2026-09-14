import type { HostMetadataState } from '../state/app-state';

export interface HostCardProps {
  host: HostMetadataState;
  onConnect: (host: HostMetadataState) => void;
  onFavoriteToggle: (host: HostMetadataState) => void;
}

export const HostCard = ({ host, onConnect, onFavoriteToggle }: HostCardProps) => (
  <article className="host-card">
    <div className="host-card-main">
      <div className="card-title-line">
        <h2>{host.name}</h2>
        {host.isFavorite && <span className="favorite-star" aria-label="已收藏">★</span>}
      </div>
      <p className="host-address"><strong>{host.username}</strong>@{host.address}:{host.port}</p>
      <div className="host-meta">
        <span>{host.authType === 'password' ? '密码认证' : '私钥认证'}</span>
        <span>{host.hostKeyFingerprint ? '指纹已验证' : '等待首次验证'}</span>
      </div>
      {host.tags.length > 0 && <div className="tag-list">{host.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>}
    </div>
    <div className="host-card-actions">
      <button className="card-action" type="button" aria-label={`收藏 ${host.name}`} aria-pressed={host.isFavorite} onClick={() => onFavoriteToggle(host)}>{host.isFavorite ? '取消收藏' : '收藏'}</button>
      <button className="card-action card-action-connect" type="button" aria-label={`连接 ${host.name}`} onClick={() => onConnect(host)}>连接</button>
    </div>
  </article>
);
