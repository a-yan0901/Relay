import { useMemo } from 'react';

import type { HostMetadataState, GroupSummary } from '../state/app-state';
import { ConnectionStatus } from './ConnectionStatus';
import { GroupSidebar } from './GroupSidebar';
import { HostList } from './HostList';

export interface HostWorkspaceProps {
  hosts: HostMetadataState[];
  groups: GroupSummary[];
  query: string;
  selectedGroupId: string | null;
  favoriteOnly: boolean;
  onQueryChange: (query: string) => void;
  onGroupSelected: (groupId: string | null) => void;
  onFavoriteFilter: (favoriteOnly: boolean) => void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onConnect: (host: HostMetadataState) => void;
  onAddHost: () => void;
}

export const HostWorkspace = ({
  hosts,
  groups,
  query,
  selectedGroupId,
  favoriteOnly,
  onQueryChange,
  onGroupSelected,
  onFavoriteFilter,
  onFavoriteToggle,
  onConnect,
  onAddHost
}: HostWorkspaceProps) => {
  const visibleHosts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return hosts.filter((host) => {
      const searchable = [host.name, host.address, host.username, ...host.tags].join(' ').toLowerCase();
      return (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (selectedGroupId === null || host.groupId === selectedGroupId) &&
        (!favoriteOnly || host.isFavorite);
    });
  }, [favoriteOnly, hosts, query, selectedGroupId]);

  const isFilteredEmpty = hosts.length > 0 && visibleHosts.length === 0;

  return (
    <div className="workspace-shell">
      <GroupSidebar
        groups={groups}
        selectedGroupId={selectedGroupId}
        favoriteOnly={favoriteOnly}
        onGroupSelected={onGroupSelected}
        onFavoriteFilter={onFavoriteFilter}
      />
      <section className="host-pane" aria-labelledby="workspace-title">
        <header className="host-pane-header">
          <div>
            <p className="eyebrow">MY WORKSPACE</p>
            <h1 id="workspace-title">Server</h1>
          </div>
          <div className="header-actions">
            <ConnectionStatus label="Vault 已解锁" tone="success" />
            <button className="button button-primary" type="button" onClick={onAddHost}><span aria-hidden="true">＋</span> 添加 Server</button>
          </div>
        </header>
        <div className="host-toolbar">
          <label className="search-field" htmlFor="host-search"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索 Server</span><input id="host-search" aria-label="搜索 Server" role="searchbox" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索名称、IP、用户名或标签" /></label>
          <span className="host-count">{visibleHosts.length} 台 Server</span>
        </div>
        {isFilteredEmpty ? (
          <div className="empty-state empty-state-compact"><h2>没有匹配的 Server</h2><p>试试名称、IP、用户名或标签。</p></div>
        ) : <HostList hosts={visibleHosts} onConnect={onConnect} onFavoriteToggle={onFavoriteToggle} onAddHost={onAddHost} />}
      </section>
    </div>
  );
};
