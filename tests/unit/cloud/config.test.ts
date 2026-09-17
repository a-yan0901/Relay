import { describe, expect, it } from 'vitest';

import { loadCloudConfig } from '../../../src/cloud/config.js';

describe('cloud runtime config', () => {
  it('uses bounded low-memory defaults for MySQL and relay buffers', () => {
    const config = loadCloudConfig({
      NODE_ENV: 'test',
      MYSQL_DATABASE: 'relay_test',
      MYSQL_USER: 'relay',
      MYSQL_PASSWORD: 'secret'
    });

    expect(config.mysql.connectionLimit).toBe(4);
    expect(config.mysql.queueLimit).toBe(16);
    expect(config.relay.maxFrameBytes).toBe(64 * 1024);
    expect(config.relay.maxBufferedBytes).toBe(256 * 1024);
    expect(config.relay.maxSubscribersPerWorkspace).toBe(16);
    expect(config.relay.maxPayloadBytes).toBe(8 * 1024 * 1024);
  });

  it('rejects unbounded or unsafe values', () => {
    expect(() => loadCloudConfig({
      NODE_ENV: 'test',
      MYSQL_DATABASE: 'relay_test',
      MYSQL_USER: 'relay',
      MYSQL_PASSWORD: 'secret',
      CLOUD_MYSQL_CONNECTION_LIMIT: '17'
    })).toThrow('CLOUD_MYSQL_CONNECTION_LIMIT');
    expect(() => loadCloudConfig({
      NODE_ENV: 'test',
      MYSQL_DATABASE: 'relay_test',
      MYSQL_USER: 'relay',
      MYSQL_PASSWORD: 'secret',
      CLOUD_RELAY_MAX_BUFFERED_BYTES: '1024'
    })).toThrow('CLOUD_RELAY_MAX_BUFFERED_BYTES');
  });
});
