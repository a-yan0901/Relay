import { useMemo, useState } from 'react';

import type { GroupNode, TargetSelection } from '../../shared/core/models';
import type { HostMetadata } from '../../shared/validation';
import { groupHostIds } from '../../shared/core/target-selection';
import { matchesHostNavigationFilter } from '../state/navigation-state';

export interface HostTargetPickerProps {
  hosts: readonly HostMetadata[];
  groups: readonly GroupNode[];
  selection: TargetSelection;
  onChange: (selection: TargetSelection) => void;
}

const depthOf = (groupId: string, groups: readonly GroupNode[]): number => {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visited = new Set<string>();
  let depth = 0;
  let current: string | null = groupId;
  while (current && !visited.has(current)) {
    visited.add(current);
    current = byId.get(current)?.parentId ?? null;
    depth += 1;
  }
  return Math.min(depth - 1, 6);
};

export const HostTargetPicker = ({ hosts, groups, selection, onChange }: HostTargetPickerProps) => {
  const [recentOnly, setRecentOnly] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set(hosts.flatMap((host) => host.tags))].sort((left, right) => left.localeCompare(right)), [hosts]);
  const visibleHosts = useMemo(() => {
    const scopedIds = selection.groupIds.length === 0
      ? null
      : new Set(selection.groupIds.flatMap((groupId) => groupHostIds(groupId, hosts, groups)));
    return hosts.filter((host) => {
      return matchesHostNavigationFilter(host, { query: selection.query, favoriteOnly: selection.favoriteOnly, recentOnly, selectedTag }) &&
        (scopedIds === null || scopedIds.has(host.id));
    });
  }, [groups, hosts, recentOnly, selectedTag, selection.favoriteOnly, selection.groupIds, selection.query]);

  const clearViewFilters = (): void => {
    setRecentOnly(false);
    setSelectedTag(null);
    onChange({ ...selection, groupIds: [], favoriteOnly: false });
  };

  const toggleHost = (hostId: string, checked: boolean): void => {
    const hostIds = checked
      ? [...new Set([...selection.hostIds, hostId])]
      : selection.hostIds.filter((id) => id !== hostId);
    onChange({ ...selection, hostIds });
  };

  const toggleGroup = (groupId: string): void => {
    const ids = groupHostIds(groupId, hosts, groups);
    const selected = ids.length > 0 && ids.every((id) => selection.hostIds.includes(id));
    const hostIds = selected
      ? selection.hostIds.filter((id) => !ids.includes(id))
      : [...new Set([...selection.hostIds, ...ids])];
    const groupIds = selected
      ? selection.groupIds.filter((id) => id !== groupId)
      : [...new Set([...selection.groupIds, groupId])];
    onChange({ ...selection, hostIds, groupIds, favoriteOnly: false });
  };

  return (
    <section className="target-picker" aria-label="批量目标">
      <div className="target-picker-heading"><div><strong>目标主机</strong><small>{selection.hostIds.length} 台已选择</small></div><span className="target-picker-snapshot">提交时固定目标快照</span></div>
      <label className="search-field target-picker-search" htmlFor="target-picker-search"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索目标</span><input id="target-picker-search" aria-label="搜索目标" value={selection.query} onChange={(event) => onChange({ ...selection, query: event.target.value })} placeholder="搜索名称、IP、用户名或标签" /></label>
      <div className="target-picker-filters" role="toolbar" aria-label="目标筛选">
        <button className={`target-filter ${selection.groupIds.length === 0 && !selection.favoriteOnly && !recentOnly && selectedTag === null ? 'is-active' : ''}`} type="button" onClick={clearViewFilters}>全部</button>
        <button className={`target-filter ${recentOnly ? 'is-active' : ''}`} type="button" aria-pressed={recentOnly} onClick={() => { setRecentOnly(true); setSelectedTag(null); onChange({ ...selection, groupIds: [], favoriteOnly: false }); }}>最近</button>
        <button className={`target-filter ${selection.favoriteOnly ? 'is-active' : ''}`} type="button" aria-pressed={selection.favoriteOnly} aria-label="仅显示收藏" onClick={() => { setRecentOnly(false); setSelectedTag(null); onChange({ ...selection, favoriteOnly: !selection.favoriteOnly, groupIds: [] }); }}>收藏</button>
        {tags.map((tag) => <button className={`target-filter ${selectedTag === tag ? 'is-active' : ''}`} type="button" key={tag} aria-label={`按标签 ${tag}`} aria-pressed={selectedTag === tag} onClick={() => { setRecentOnly(false); setSelectedTag(tag); onChange({ ...selection, groupIds: [], favoriteOnly: false }); }}>{tag}</button>)}
        {groups.map((group) => {
          const ids = groupHostIds(group.id, hosts, groups);
          const selected = ids.length > 0 && ids.every((id) => selection.hostIds.includes(id));
          return <button className={`target-filter ${selected ? 'is-active' : ''}`} style={{ paddingInlineStart: `${10 + depthOf(group.id, groups) * 12}px` }} type="button" key={group.id} aria-label={`选择分组 ${group.name}`} aria-pressed={selected} onClick={() => { setRecentOnly(false); setSelectedTag(null); toggleGroup(group.id); }}>{group.name}<span>{ids.length}</span></button>;
        })}
      </div>
      <div className="target-picker-list" role="group" aria-label="目标主机列表">
        {visibleHosts.map((host) => <label className="target-picker-item" key={host.id} htmlFor={`target-host-${host.id}`}><input id={`target-host-${host.id}`} type="checkbox" aria-label={`选择目标 ${host.name}`} checked={selection.hostIds.includes(host.id)} onChange={(event) => toggleHost(host.id, event.target.checked)} /><span><strong>{host.name}</strong><small>{host.username}@{host.address}:{host.port} · SSH · {host.authType === 'private_key' ? '私钥认证' : '密码认证'} · {host.lastConnectedAt ? '最近连接' : '未连接'}</small></span>{host.isFavorite && <span aria-label="已收藏">★</span>}</label>)}
        {visibleHosts.length === 0 && <p className="target-picker-empty">没有匹配的目标主机</p>}
      </div>
    </section>
  );
};
