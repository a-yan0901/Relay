import { sftpPathSegments } from '../../shared/core/sftp-path';

export interface SftpBreadcrumbsProps {
  path: string;
  onNavigate: (path: string) => void;
}

export const SftpBreadcrumbs = ({ path, onNavigate }: SftpBreadcrumbsProps) => (
  <nav className="sftp-breadcrumbs" aria-label="远程路径层级">
    {sftpPathSegments(path).map((segment, index, segments) => <span className="sftp-breadcrumb" key={segment.path}>
      {index > 0 && <span className="sftp-breadcrumb-separator" aria-hidden="true">/</span>}
      {index === segments.length - 1
        ? <strong aria-current="page">{segment.label}</strong>
        : <button type="button" aria-label={`路径 ${segment.label}`} onClick={() => onNavigate(segment.path)}>{segment.label}</button>}
    </span>)}
  </nav>
);
