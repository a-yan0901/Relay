import type { GroupSummary } from '../state/app-state';

export interface GroupSidebarProps {
  groups: GroupSummary[];
  selectedGroupId: string | null;
  favoriteOnly: boolean;
  onGroupSelected: (groupId: string | null) => void;
  onFavoriteFilter: (favoriteOnly: boolean) => void;
}

export const GroupSidebar = ({ groups, selectedGroupId, favoriteOnly, onGroupSelected, onFavoriteFilter }: GroupSidebarProps) => (
  <aside className="sidebar" aria-label="Server 导航">
    <div className="sidebar-section">
      <p className="sidebar-label">工作区</p>
      <button className={`nav-item ${selectedGroupId === null && !favoriteOnly ? 'is-active' : ''}`} type="button" onClick={() => { onGroupSelected(null); onFavoriteFilter(false); }}>
        <span className="nav-icon" aria-hidden="true">▦</span>全部 Server
      </button>
      <button className={`nav-item ${favoriteOnly ? 'is-active' : ''}`} type="button" onClick={() => onFavoriteFilter(true)}>
        <span className="nav-icon" aria-hidden="true">★</span>收藏
      </button>
    </div>
    <div className="sidebar-section">
      <div className="sidebar-heading"><p className="sidebar-label">分组</p><span className="sidebar-count">{groups.length}</span></div>
      <div className="group-list">
        {groups.map((group) => (
          <button className={`nav-item ${selectedGroupId === group.id ? 'is-active' : ''}`} type="button" key={group.id} onClick={() => { onGroupSelected(group.id); onFavoriteFilter(false); }}>
            <span className="group-dot" aria-hidden="true" />{group.name}
          </button>
        ))}
      </div>
    </div>
    <div className="sidebar-footer"><span className="status-dot status-dot-green" />本地 Vault 已加密</div>
  </aside>
);
