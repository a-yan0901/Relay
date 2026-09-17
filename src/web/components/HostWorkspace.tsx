import { useMemo, type MouseEvent as ReactMouseEvent } from 'react';

import type { HostMetadataState, GroupSummary } from '../state/app-state';
import { GroupSidebar } from './GroupSidebar';
import { HostList } from './HostList';
import { ServerContextMenu, type ServerContextActions, type ServerContextTarget } from './ServerContextMenu';
import { useContextMenu } from '../hooks/use-context-menu';
import { descendantGroupIds } from '../../shared/core/group-tree';
import { createHostSearchIndex, matchesHostNavigationFilter } from '../state/navigation-state';
import type { ServerViewMode } from '../theme';

export interface HostWorkspaceProps {
  hosts: HostMetadataState[];
  groups: GroupSummary[];
  query: string;
  selectedGroupId: string | null;
  favoriteOnly: boolean;
  recentOnly?: boolean;
  selectedTag?: string | null;
  onQueryChange: (query: string) => void;
  onGroupSelected: (groupId: string | null) => void;
  onFavoriteFilter: (favoriteOnly: boolean) => void;
  onRecentFilter?: (recentOnly: boolean) => void;
  onTagSelected?: (tag: string | null) => void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onConnect: (host: HostMetadataState) => void;
  onAddHost: () => void;
  onBatchCommand?: (hostIds: readonly string[]) => void;
  onImport?: () => void;
  onExport?: () => void;
  onEdit?: (host: HostMetadataState) => void;
  onDelete?: (host: HostMetadataState) => void;
  onTestConnection?: (host: HostMetadataState) => void;
  onClearHostKey?: (host: HostMetadataState) => void;
  onOpenSftp?: (host: HostMetadataState) => void;
  onCopyText?: (value: string) => Promise<void> | void;
  viewMode?: ServerViewMode;
  onViewModeChange?: (viewMode: ServerViewMode) => void;
}

export const HostWorkspace = ({
  hosts,
  groups,
  query,
  selectedGroupId,
  favoriteOnly,
  recentOnly = false,
  selectedTag = null,
  onQueryChange,
  onGroupSelected,
  onFavoriteFilter,
  onRecentFilter = () => undefined,
  onTagSelected = () => undefined,
  onFavoriteToggle,
  onConnect,
  onAddHost,
  onBatchCommand,
  onImport,
  onExport,
  onEdit,
  onDelete,
  onTestConnection,
  onClearHostKey,
  onOpenSftp,
  onCopyText = () => undefined,
  viewMode = 'list',
  onViewModeChange = () => undefined
}: HostWorkspaceProps) => {
  const serverContextMenu = useContextMenu<ServerContextTarget>();
  const hostSearchIndex = useMemo(() => createHostSearchIndex(hosts), [hosts]);
  const visibleHosts = useMemo(() => {
    const groupScope = selectedGroupId === null ? null : new Set(descendantGroupIds(selectedGroupId, groups));
    return hosts.filter((host) => {
      return matchesHostNavigationFilter(host, { query, favoriteOnly, recentOnly, selectedTag }, hostSearchIndex.get(host.id)) &&
      (groupScope === null || (host.groupId !== null && groupScope.has(host.groupId)));
    }).sort((left, right) => {
      if (left.isFavorite !== right.isFavorite) return left.isFavorite ? -1 : 1;
      const leftTime = left.lastConnectedAt ? Date.parse(left.lastConnectedAt) : Number.NEGATIVE_INFINITY;
      const rightTime = right.lastConnectedAt ? Date.parse(right.lastConnectedAt) : Number.NEGATIVE_INFINITY;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.name.localeCompare(right.name);
    });
  }, [favoriteOnly, groups, hosts, hostSearchIndex, query, recentOnly, selectedGroupId, selectedTag]);

  const isFilteredEmpty = hosts.length > 0 && visibleHosts.length === 0;
  const tags = useMemo(() => [...new Set(hosts.flatMap((host) => host.tags))].sort((left, right) => left.localeCompare(right)), [hosts]);
  const activeFilterLabel = selectedTag !== null
    ? `标签：${selectedTag}`
    : recentOnly
      ? '最近连接'
      : favoriteOnly
        ? '收藏'
        : selectedGroupId !== null
          ? groups.find((group) => group.id === selectedGroupId)?.name ?? '分组'
          : null;

  const clearFilters = (): void => {
    onGroupSelected(null);
    onFavoriteFilter(false);
    onRecentFilter(false);
    onTagSelected(null);
  };

  const openHostContextMenu = (event: ReactMouseEvent<HTMLElement>, host: HostMetadataState): void => {
    serverContextMenu.open(event, { kind: 'host', host });
  };

  const openTagContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, tag: string, hostId?: string): void => {
    serverContextMenu.open(event, { kind: 'tag', tag, ...(hostId ? { hostId } : {}) });
  };

  const serverContextActions: ServerContextActions = {
    onConnect,
    onOpenSftp,
    onCopyText,
    onFavoriteToggle,
    onTagSelected,
    onTestConnection,
    onEdit,
    onClearHostKey,
    onDelete
  };

  return (
    <div className="workspace-shell">
      <GroupSidebar
        groups={groups}
        tags={tags}
        selectedGroupId={selectedGroupId}
        favoriteOnly={favoriteOnly}
        recentOnly={recentOnly}
        selectedTag={selectedTag}
        onGroupSelected={onGroupSelected}
        onFavoriteFilter={onFavoriteFilter}
        onRecentFilter={onRecentFilter}
        onTagSelected={onTagSelected}
        onTagContextMenu={(event, tag) => openTagContextMenu(event, tag)}
      />
      <section className="host-pane" aria-labelledby="workspace-title">
        <header className="host-pane-header">
          <div>
            <p className="eyebrow">MY WORKSPACE</p>
            <h1 id="workspace-title">Server</h1>
          </div>
          <div className="header-actions">
            {onImport && <button className="button button-ghost" type="button" onClick={onImport}>导入</button>}
            {onExport && <button className="button button-ghost" type="button" onClick={onExport}>导出</button>}
            {onBatchCommand && <button className="button button-ghost" type="button" onClick={() => onBatchCommand(visibleHosts.map((host) => host.id))}>批量执行</button>}
            <button className="button button-primary" type="button" onClick={onAddHost}><span aria-hidden="true">＋</span> 添加 Server</button>
          </div>
        </header>
        <div className="host-toolbar">
          <label className="search-field" htmlFor="host-search"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索 Server</span><input id="host-search" aria-label="搜索 Server" role="searchbox" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索名称、IP、用户名或标签" /></label>
          <div className="host-filter-summary">
            {activeFilterLabel && <><span className="filter-chip">{activeFilterLabel}</span><button className="filter-clear" type="button" onClick={clearFilters}>清除筛选</button></>}
            <span className="host-count">{visibleHosts.length} 台 Server</span>
            <div className="view-mode-toggle" role="group" aria-label="Server 视图切换">
              <button className="view-mode-button" type="button" aria-label="列表视图" aria-pressed={viewMode === 'list'} title="列表视图" onClick={() => onViewModeChange('list')}><span aria-hidden="true">☷</span></button>
              <button className="view-mode-button" type="button" aria-label="网格视图" aria-pressed={viewMode === 'grid'} title="网格视图" onClick={() => onViewModeChange('grid')}><span aria-hidden="true">▦</span></button>
            </div>
          </div>
        </div>
        {isFilteredEmpty ? (
          <div className="empty-state empty-state-compact"><h2>没有匹配的 Server</h2><p>试试名称、IP、用户名或标签。</p></div>
        ) : <HostList hosts={visibleHosts} groups={groups} viewMode={viewMode} onConnect={onConnect} onFavoriteToggle={onFavoriteToggle} onAddHost={onAddHost} onEdit={onEdit} onDelete={onDelete} onTestConnection={onTestConnection} onClearHostKey={onClearHostKey} onTagSelected={onTagSelected} onContextMenu={openHostContextMenu} onTagContextMenu={(event, tag, host) => openTagContextMenu(event, tag, host.id)} />}
      </section>
      <ServerContextMenu state={serverContextMenu.state} selectedTag={selectedTag} actions={serverContextActions} onClose={serverContextMenu.close} />
    </div>
  );
};
