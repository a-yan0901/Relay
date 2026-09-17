import { describe, expect, it } from 'vitest';

import { loadCloudConfig } from '../../../src/cloud/config.js';
import { createMySqlPoolOptions } from '../../../src/cloud/database.js';

describe('cloud database options', () => {
  it('passes the configured low-memory pool bounds to mysql2', () => {
    const config = loadCloudConfig({
      NODE_ENV: 'test',
      MYSQL_DATABASE: 'relay_test',
      MYSQL_USER: 'relay',
      MYSQL_PASSWORD: 'secret',
      CLOUD_MYSQL_CONNECTION_LIMIT: '3',
      CLOUD_MYSQL_QUEUE_LIMIT: '7'
    });

    expect(createMySqlPoolOptions(config)).toMatchObject({
      host: '127.0.0.1',
      port: 3306,
      database: 'relay_test',
      user: 'relay',
      password: 'secret',
      connectionLimit: 3,
      queueLimit: 7,
      waitForConnections: true,
      enableKeepAlive: true,
      maxIdle: 3
    });
  });
});
