import type { GroupSummary } from '../state/app-state';
import { flattenGroupTree } from '../../shared/core/group-tree';

export interface GroupSidebarProps {
  groups: GroupSummary[];
  tags?: readonly string[];
  selectedGroupId: string | null;
  favoriteOnly: boolean;
  recentOnly?: boolean;
  selectedTag?: string | null;
  onGroupSelected: (groupId: string | null) => void;
  onFavoriteFilter: (favoriteOnly: boolean) => void;
  onRecentFilter?: (recentOnly: boolean) => void;
  onTagSelected?: (tag: string | null) => void;
}

export const GroupSidebar = ({
  groups,
  tags = [],
  selectedGroupId,
  favoriteOnly,
  recentOnly = false,
  selectedTag = null,
  onGroupSelected,
  onFavoriteFilter,
  onRecentFilter = () => undefined,
  onTagSelected = () => undefined
}: GroupSidebarProps) => {
  const rows = flattenGroupTree(groups);
  return <aside className="sidebar" aria-label="Server 导航">
    <div className="sidebar-section">
      <p className="sidebar-label">浏览</p>
      <button className={`nav-item ${selectedGroupId === null && !favoriteOnly && !recentOnly && selectedTag === null ? 'is-active' : ''}`} type="button" onClick={() => { onGroupSelected(null); onFavoriteFilter(false); onRecentFilter(false); onTagSelected(null); }}>
        <span className="nav-icon" aria-hidden="true">▦</span>全部 Server
      </button>
      <button className={`nav-item ${recentOnly ? 'is-active' : ''}`} type="button" onClick={() => { onGroupSelected(null); onFavoriteFilter(false); onRecentFilter(true); onTagSelected(null); }}>
        <span className="nav-icon" aria-hidden="true">◷</span>最近
      </button>
      <button className={`nav-item ${favoriteOnly ? 'is-active' : ''}`} type="button" onClick={() => { onGroupSelected(null); onFavoriteFilter(true); onRecentFilter(false); onTagSelected(null); }}>
        <span className="nav-icon" aria-hidden="true">★</span>收藏
      </button>
    </div>
    {tags.length > 0 && <div className="sidebar-section">
      <div className="sidebar-heading"><p className="sidebar-label">标签</p><span className="sidebar-count">{tags.length}</span></div>
      <div className="tag-filter-list">
        {tags.map((tag) => <button className={`nav-item tag-filter-item ${selectedTag === tag ? 'is-active' : ''}`} type="button" key={tag} aria-label={`标签 ${tag}`} onClick={() => { onGroupSelected(null); onFavoriteFilter(false); onRecentFilter(false); onTagSelected(tag); }}>
          <span className="tag-filter-mark" aria-hidden="true">#</span>{tag}
        </button>)}
      </div>
    </div>}
    <div className="sidebar-section">
      <div className="sidebar-heading"><p className="sidebar-label">分组</p><span className="sidebar-count">{groups.length}</span></div>
      <div className="group-list">
        {rows.map(({ group, depth }) => (
          <button className={`nav-item ${selectedGroupId === group.id ? 'is-active' : ''}`} style={{ paddingInlineStart: `${10 + depth * 16}px` }} type="button" key={group.id} data-group-depth={depth} onClick={() => { onGroupSelected(group.id); onFavoriteFilter(false); onRecentFilter(false); onTagSelected(null); }}>
            <span className="group-dot" aria-hidden="true" />{group.name}
          </button>
        ))}
      </div>
    </div>
    <div className="sidebar-footer"><span className="status-dot status-dot-green" />本地 Vault 已加密</div>
  </aside>;
};
