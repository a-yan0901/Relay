import { useMemo, useState } from 'react';

import type { CloudWorkspaceCard, CloudWorkspaceDirectorySnapshot } from '../../shared/cloud/directory';

const statusCopy: Record<CloudWorkspaceCard['status'], { label: string; tone: 'green' | 'blue' | 'amber' | 'muted' | 'red' }> = {
  current: { label: '当前设备', tone: 'blue' },
  online: { label: '在线', tone: 'green' },
  'offline-snapshot': { label: '离线快照', tone: 'muted' },
  'needs-trust': { label: '待信任', tone: 'amber' },
  revoked: { label: '已撤销', tone: 'red' },
  unavailable: { label: '不可用', tone: 'muted' }
};

const platformLabel: Record<NonNullable<CloudWorkspaceCard['ownerPlatform']>, string> = {
  web: 'Web',
  desktop: 'Windows',
  android: 'Android'
};

export interface WorkspaceDirectoryProps {
  snapshot: CloudWorkspaceDirectorySnapshot | null;
  loading?: boolean;
  error?: string | null;
  onRefresh: () => void;
  /** Enabled only when the local client has a live remote-workspace bridge. */
  onOpen?: (card: CloudWorkspaceCard) => void;
}

export const WorkspaceDirectory = ({ snapshot, loading = false, error = null, onRefresh, onOpen }: WorkspaceDirectoryProps) => {
  const [query, setQuery] = useState('');
  const visibleCards = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!snapshot || !normalized) return snapshot?.cards ?? [];
    return snapshot.cards.filter((card) => `${card.ownerLabel} ${card.ownerPlatform ?? ''} ${card.status}`.toLocaleLowerCase().includes(normalized));
  }, [query, snapshot]);

  return (
    <section className="workspace-directory" aria-labelledby="workspace-directory-title">
      <div className="workspace-directory-heading">
        <div>
          <p className="eyebrow">ACCOUNT WORKSPACES</p>
          <h2 id="workspace-directory-title">设备工作区</h2>
          <p className="workspace-directory-copy">每台设备保持独立的工作区和 SSH 连接，在线时可进入它的实时状态。</p>
        </div>
        <div className="workspace-directory-actions">
          <label className="search-field workspace-directory-search" htmlFor="workspace-directory-search">
            <span aria-hidden="true">⌕</span>
            <span className="visually-hidden">筛选设备工作区</span>
            <input id="workspace-directory-search" type="search" aria-label="筛选设备工作区" placeholder="筛选设备" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button className="button button-ghost button-small" type="button" onClick={onRefresh} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
        </div>
      </div>
      {error && <div className="workspace-directory-error" role="alert"><span>{error}</span><button className="button button-ghost button-small" type="button" onClick={onRefresh} disabled={loading}>重试</button></div>}
      {loading && !snapshot ? <div className="workspace-directory-loading" role="status">正在加载设备工作区…</div> : visibleCards.length === 0 ? <div className="workspace-directory-empty">{snapshot?.cards.length ? '没有匹配的设备工作区。' : '登录后，这里会显示账号下各设备的独立工作区。'}</div> : (
        <div className="workspace-directory-grid" role="list" aria-label="设备工作区列表">
          {visibleCards.map((card) => {
            const status = statusCopy[card.status];
            const canOpen = onOpen !== undefined && (card.status === 'online' || card.status === 'current');
            return <article className={`workspace-directory-card workspace-directory-card-${status.tone}`} key={card.workspaceId} role="listitem">
              <div className="workspace-directory-card-top">
                <span className={`status-dot status-dot-${status.tone}`} aria-hidden="true" />
                <span className="workspace-directory-status">{status.label}</span>
                {card.activeViewerCount > 0 && <span className="workspace-directory-viewers">{card.activeViewerCount} 人在线</span>}
              </div>
              <strong className="workspace-directory-owner">{card.ownerLabel}</strong>
              <span className="workspace-directory-platform">{card.ownerPlatform ? platformLabel[card.ownerPlatform] : '未知平台'} · 独立工作区</span>
              {canOpen ? <button className="button button-ghost button-small workspace-directory-open" type="button" onClick={() => onOpen(card)}>{card.isCurrent ? '查看当前' : '进入实时工作区'}</button> : <span className="workspace-directory-hint">{card.status === 'offline-snapshot' ? '设备离线，仅显示状态' : card.status === 'needs-trust' ? '设备获信任后可访问' : card.status === 'revoked' ? '设备访问已撤销' : '当前不可访问'}</span>}
            </article>;
          })}
        </div>
      )}
    </section>
  );
};
