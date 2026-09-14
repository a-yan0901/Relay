import type { HostMetadataState } from '../state/app-state';
import { HostCard } from './HostCard';

export interface HostListProps {
  hosts: HostMetadataState[];
  onConnect: (host: HostMetadataState) => void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onAddHost: () => void;
  onEdit?: (host: HostMetadataState) => void;
  onDelete?: (host: HostMetadataState) => void;
  onTestConnection?: (host: HostMetadataState) => void;
}

export const HostList = ({ hosts, onConnect, onFavoriteToggle, onAddHost, onEdit, onDelete, onTestConnection }: HostListProps) => {
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
      {hosts.map((host) => <HostCard key={host.id} host={host} onConnect={onConnect} onFavoriteToggle={onFavoriteToggle} onEdit={onEdit} onDelete={onDelete} onTestConnection={onTestConnection} />)}
    </div>
  );
};
