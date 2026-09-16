import { describe, expect, it } from 'vitest';

import { sftpChildPath, sftpParentPath, sftpPathSegments } from '../../../src/shared/core/sftp-path.js';

describe('SFTP path helpers', () => {
  it('builds stable breadcrumb paths from a remote POSIX path', () => {
    expect(sftpPathSegments('/var//log/')).toEqual([
      { label: '/', path: '/' },
      { label: 'var', path: '/var' },
      { label: 'log', path: '/var/log' }
    ]);
  });

  it('joins child paths and never escapes to an empty parent', () => {
    expect(sftpChildPath('/', 'release/')).toBe('/release');
    expect(sftpChildPath('/apps', '/release/')).toBe('/apps/release');
    expect(sftpParentPath('/apps/release')).toBe('/apps');
    expect(sftpParentPath('/')).toBe('/');
  });
});
