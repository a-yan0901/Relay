import type { HostMetadataState } from '../state/app-state';
import type { ContextMenuItem, ContextMenuState } from '../context-menu';
import { ContextMenu } from './ContextMenu';

export type ServerContextTarget =
  | { kind: 'host'; host: HostMetadataState }
  | { kind: 'tag'; tag: string; hostId?: string };

export interface ServerContextActions {
  onConnect: (host: HostMetadataState) => void;
  onOpenSftp?: (host: HostMetadataState) => void;
  onCopyText: (value: string) => Promise<void> | void;
  onFavoriteToggle: (host: HostMetadataState) => void;
  onTagSelected: (tag: string | null) => void;
  onTestConnection?: (host: HostMetadataState) => void;
  onEdit?: (host: HostMetadataState) => void;
  onClearHostKey?: (host: HostMetadataState) => void;
  onDelete?: (host: HostMetadataState) => void;
}

export interface SftpOpenRequest {
  requestId: string;
  hostId: string;
}

export interface ServerContextMenuProps {
  state: ContextMenuState<ServerContextTarget> | null;
  selectedTag?: string | null;
  actions: ServerContextActions;
  onClose: () => void;
}

export const hostAddressText = (host: HostMetadataState): string => host.username + '@' + host.address + ':' + host.port;

const shellQuote = (value: string): string => "'" + value.split("'").join("'\"'\"'") + "'";

export const sshCommandText = (host: HostMetadataState): string => 'ssh -p ' + host.port + ' ' + shellQuote(host.username + '@' + host.address);

const hostItems = (host: HostMetadataState, actions: ServerContextActions): ContextMenuItem[] => [
  { id: 'connect', label: '进入 Console', onSelect: () => actions.onConnect(host) },
  ...(actions.onOpenSftp ? [{ id: 'open-sftp', label: '打开 SFTP', onSelect: () => actions.onOpenSftp?.(host) }] : []),
  { id: 'copy-address', label: '复制地址', separatorBefore: true, onSelect: () => actions.onCopyText(hostAddressText(host)) },
  { id: 'copy-ssh-command', label: '复制 SSH 命令', onSelect: () => actions.onCopyText(sshCommandText(host)) },
  ...(actions.onTestConnection ? [{ id: 'test', label: '测试连接', separatorBefore: true, onSelect: () => actions.onTestConnection?.(host) }] : []),
  { id: 'favorite', label: host.isFavorite ? '取消收藏' : '收藏', onSelect: () => actions.onFavoriteToggle(host) },
  ...(actions.onEdit ? [{ id: 'edit', label: '编辑', onSelect: () => actions.onEdit?.(host) }] : []),
  ...(actions.onClearHostKey && host.hostKeyFingerprint ? [{ id: 'clear-host-key', label: '清除 Host Key 信任', separatorBefore: true, onSelect: () => actions.onClearHostKey?.(host) }] : []),
  ...(actions.onDelete ? [{ id: 'delete', label: '删除 Server', tone: 'danger' as const, separatorBefore: true, onSelect: () => actions.onDelete?.(host) }] : [])
];

const tagItems = (tag: string, selectedTag: string | null | undefined, actions: ServerContextActions): ContextMenuItem[] => [
  {
    id: 'tag-filter',
    label: selectedTag === tag ? '清除当前标签筛选' : '按此标签筛选',
    onSelect: () => actions.onTagSelected(selectedTag === tag ? null : tag)
  },
  { id: 'copy-tag', label: '复制标签', onSelect: () => actions.onCopyText(tag) }
];

export const ServerContextMenu = ({ state, selectedTag = null, actions, onClose }: ServerContextMenuProps) => {
  if (!state) return null;
  const items = state.target.kind === 'host'
    ? hostItems(state.target.host, actions)
    : tagItems(state.target.tag, selectedTag, actions);
  return <ContextMenu state={state} items={items} onClose={onClose} ariaLabel={state.target.kind === 'host' ? 'Server ' + state.target.host.name + ' 菜单' : '标签 ' + state.target.tag + ' 菜单'} />;
};
