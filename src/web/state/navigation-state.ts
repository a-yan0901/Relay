import type { SnippetMetadata, WorkspaceTemplate } from '../../shared/core/models';
import type { TerminalStatus } from '../../shared/protocol';
import type { GroupSummary, HostMetadataState, TerminalTabState } from './app-state';

export type PrimaryDestination = 'servers' | 'workspaces' | 'activity';

export type QuickSwitcherItem =
  | { type: 'host'; id: string; label: string; secondary: string; tags: readonly string[] }
  | { type: 'tab'; id: string; label: string; secondary: string; status: string }
  | { type: 'workspace'; id: string; label: string; secondary: string }
  | { type: 'snippet'; id: string; label: string; secondary: string };

export interface QuickSwitcherIndexInput {
  hosts: readonly HostMetadataState[];
  groups: readonly GroupSummary[];
  terminals: readonly TerminalTabState[];
  workspaceTemplates: readonly WorkspaceTemplate[];
  snippets: readonly SnippetMetadata[];
}

export interface HostNavigationFilter {
  query: string;
  favoriteOnly: boolean;
  recentOnly?: boolean;
  selectedTag?: string | null;
}

const terminalStatusLabels: Record<TerminalStatus, string> = {
  connecting: '连接中',
  'awaiting-host-key': '等待 Host Key',
  'awaiting-credential': '等待凭据',
  connected: '已连接',
  reconnecting: '重连中',
  interrupted: '已中断',
  'needs-reopen': '需要重新连接',
  closed: '已关闭',
  failed: '连接失败'
};

const layoutLabels: Record<WorkspaceTemplate['state']['layout']['mode'], string> = {
  single: '单面板',
  horizontal: '左右分屏',
  vertical: '上下分屏',
  grid: '四格'
};

const normalized = (value: string): string => value.trim().toLocaleLowerCase();

export const hostSearchableText = (host: Pick<HostMetadataState, 'name' | 'address' | 'username' | 'authType' | 'tags'>): string => [
  host.name,
  host.address,
  host.username,
  'ssh',
  host.authType === 'private_key' ? 'private key 私钥' : 'password 密码',
  ...host.tags
].join(' ').toLocaleLowerCase();

export const matchesHostNavigationFilter = (host: HostMetadataState, filter: HostNavigationFilter): boolean => {
  const query = normalized(filter.query);
  return (!query || hostSearchableText(host).includes(query)) &&
    (!filter.favoriteOnly || host.isFavorite) &&
    (!filter.recentOnly || host.lastConnectedAt !== null) &&
    (filter.selectedTag === undefined || filter.selectedTag === null || host.tags.includes(filter.selectedTag));
};

const fuzzyIncludes = (needle: string, haystack: string): boolean => {
  if (needle.length === 0) return true;
  let next = 0;
  for (const character of haystack) {
    if (character === needle[next]) next += 1;
    if (next === needle.length) return true;
  }
  return false;
};

const itemSearchText = (item: QuickSwitcherItem): string => {
  if (item.type === 'host') return [item.label, item.secondary, ...item.tags].join(' ').toLocaleLowerCase();
  return [item.label, item.secondary, item.type === 'tab' ? item.status : ''].join(' ').toLocaleLowerCase();
};

export const filterQuickSwitcherItems = (
  items: readonly QuickSwitcherItem[],
  query: string
): readonly QuickSwitcherItem[] => {
  const tokens = normalized(query).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return items;
  return items.filter((item) => {
    const text = itemSearchText(item);
    return tokens.every((token) => fuzzyIncludes(token, text));
  });
};

export const createQuickSwitcherItems = ({
  hosts,
  groups,
  terminals,
  workspaceTemplates,
  snippets
}: QuickSwitcherIndexInput): QuickSwitcherItem[] => {
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const hostItems: QuickSwitcherItem[] = hosts.map((host) => {
    const secondary = [
      `${host.username}@${host.address}:${host.port}`,
      'SSH',
      host.authType === 'private_key' ? '私钥认证' : '密码认证',
      host.groupId ? `环境：${groupNames.get(host.groupId) ?? '未分组'}` : '未分组',
      host.identityName ? `身份：${host.identityName}` : undefined,
      host.lastConnectedAt ? '最近连接' : '未连接'
    ].filter((value): value is string => value !== undefined).join(' · ');
    return { type: 'host', id: host.id, label: host.name, secondary, tags: [...host.tags] };
  });
  const tabItems: QuickSwitcherItem[] = terminals.map((terminal) => {
    const host = hostById.get(terminal.hostId);
    const status = terminal.recoveryStatus === 'missing-host'
      ? 'Server 已不存在'
      : terminalStatusLabels[terminal.state];
    return {
      type: 'tab',
      id: terminal.terminalId,
      label: host?.name ?? terminal.label ?? terminal.hostId,
      secondary: [host ? `${host.username}@${host.address}:${host.port}` : terminal.hostId, status].join(' · '),
      status
    };
  });
  const workspaceItems: QuickSwitcherItem[] = workspaceTemplates.map((template) => ({
    type: 'workspace',
    id: template.id,
    label: template.name,
    secondary: `${template.state.tabs.length} 个 Console · ${layoutLabels[template.state.layout.mode]}`
  }));
  const snippetItems: QuickSwitcherItem[] = snippets.map((snippet) => ({
    type: 'snippet',
    id: snippet.id,
    label: snippet.name,
    secondary: [snippet.description, ...snippet.tags].filter(Boolean).join(' · ') || '无描述'
  }));
  return [...tabItems, ...hostItems, ...workspaceItems, ...snippetItems];
};
