import type { MouseEvent as ReactMouseEvent } from 'react';

import type { GroupSummary, HostMetadataState } from '../state/app-state';
import { HostCard } from './HostCard';

export interface HostListProps {
  hosts: HostMetadataState[];
  onConnect: (host: HostMetadataState) => void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onAddHost: () => void;
  onEdit?: (host: HostMetadataState) => void;
  onDelete?: (host: HostMetadataState) => void;
  onTestConnection?: (host: HostMetadataState) => void;
  onClearHostKey?: (host: HostMetadataState) => void;
  groups?: readonly GroupSummary[];
  onTagSelected?: (tag: string) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>, host: HostMetadataState) => void;
  onTagContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>, tag: string, host: HostMetadataState) => void;
}

export const HostList = ({ hosts, onConnect, onFavoriteToggle, onAddHost, onEdit, onDelete, onTestConnection, onClearHostKey, groups = [], onTagSelected, onContextMenu, onTagContextMenu }: HostListProps) => {
  if (hosts.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-illustration" aria-hidden="true">⌁</div>
        <h2>还没有 Server</h2>
        <p>保存第一台服务器，之后即可一键打开安全的 SSH 终端。</p>
        <button className="button button-primary" type="button" onClick={onAddHost}>添加第一台 Server</button>
      </div>
    );
  }

  return (
    <div className="host-list" aria-label="Server 列表">
      {hosts.map((host) => <HostCard key={host.id} host={host} groupName={groups.find((group) => group.id === host.groupId)?.name} onConnect={onConnect} onFavoriteToggle={onFavoriteToggle} onEdit={onEdit} onDelete={onDelete} onTestConnection={onTestConnection} onClearHostKey={onClearHostKey} onTagSelected={onTagSelected} onContextMenu={onContextMenu} onTagContextMenu={onTagContextMenu} />)}
    </div>
  );
};
