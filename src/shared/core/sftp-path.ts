export interface SftpPathSegment {
  label: string;
  path: string;
}

const normalizedPath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const segments = trimmed.split('/').filter(Boolean);
  return `/${segments.join('/')}`;
};

export const sftpPathSegments = (path: string): readonly SftpPathSegment[] => {
  const normalized = normalizedPath(path);
  if (normalized === '/') return [{ label: '/', path: '/' }];
  const segments = normalized.slice(1).split('/');
  return [
    { label: '/', path: '/' },
    ...segments.map((label, index) => ({
      label,
      path: `/${segments.slice(0, index + 1).join('/')}`
    }))
  ];
};

export const sftpChildPath = (directory: string, name: string): string => {
  const cleanName = name.trim().replace(/^\/+|\/+$/gu, '');
  if (!cleanName) return normalizedPath(directory);
  const parent = normalizedPath(directory);
  return parent === '/' ? `/${cleanName}` : `${parent}/${cleanName}`;
};

export const sftpParentPath = (path: string): string => {
  const normalized = normalizedPath(path);
  if (normalized === '/') return '/';
  const parent = normalized.slice(0, normalized.lastIndexOf('/'));
  return parent || '/';
};
