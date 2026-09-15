import { describe, expect, it } from 'vitest';

import { detectImportFormats } from '@shared/import/detect';

describe('external SSH format detection', () => {
  it('detects OpenSSH config by content', () => {
    expect(detectImportFormats('Host app\n  HostName app.example.com\n  ProxyJump bastion\n', 'backup.txt')[0]?.format).toBe('openssh-config');
  });

  it('detects CSV by header aliases regardless of extension', () => {
    expect(detectImportFormats('Folder,Username,Hostname,Port\nprod,ops,app.example.com,22\n', 'export.data')[0]?.format).toBe('ssh-csv');
  });

  it('detects vendor formats from their signatures', () => {
    expect(detectImportFormats('[Bookmarks]\nSubRep=prod\n', 'sessions.txt')[0]?.format).toBe('mobaxterm');
    expect(detectImportFormats('Product=Xshell\nHost=app.example.com\n', 'session.txt')[0]?.format).toBe('xshell');
    expect(detectImportFormats('<?xml version="1.0"?><VanDykeSoftware><Session><Hostname>app</Hostname></Session></VanDykeSoftware>', 'settings.txt')[0]?.format).toBe('securecrt');
  });

  it('returns an explicit ambiguity result for unknown text', () => {
    const result = detectImportFormats('just some notes', 'notes.txt');
    expect(result).toEqual([]);
  });
});
