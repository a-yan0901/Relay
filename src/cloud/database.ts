import { createPool, type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise';

import type { CloudRuntimeConfig } from './config.js';

export interface CloudSqlExecutor {
  query<T = unknown>(statement: string, values?: readonly unknown[]): Promise<T>;
  execute<T = unknown>(statement: string, values?: readonly unknown[]): Promise<T>;
}

export interface CloudSqlTransaction extends CloudSqlExecutor {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export const createMySqlPoolOptions = (config: CloudRuntimeConfig): PoolOptions => ({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  user: config.mysql.user,
  password: config.mysql.password,
  waitForConnections: true,
  connectionLimit: config.mysql.connectionLimit,
  queueLimit: config.mysql.queueLimit,
  enableKeepAlive: true,
  maxIdle: config.mysql.connectionLimit,
  idleTimeout: 60_000
});

type MysqlQueryValues = Parameters<Pool['query']>[1];
type MysqlExecuteValues = Parameters<Pool['execute']>[1];

const valuesForQuery = (values: readonly unknown[] | undefined): MysqlQueryValues => (
  (values === undefined ? [] : [...values]) as MysqlQueryValues
);

const valuesForExecute = (values: readonly unknown[] | undefined): MysqlExecuteValues => (
  (values === undefined ? [] : [...values]) as MysqlExecuteValues
);

const createExecutor = (connection: Pick<Pool, 'query' | 'execute'>): CloudSqlExecutor => ({
  async query<T>(statement: string, values?: readonly unknown[]) {
    const [rows] = await connection.query(statement, valuesForQuery(values));
    return rows as T;
  },
  async execute<T>(statement: string, values?: readonly unknown[]) {
    const [result] = await connection.execute(statement, valuesForExecute(values));
    return result as T;
  }
});

export class MySqlCloudDatabase implements CloudSqlExecutor {
  private readonly pool: Pool;

  constructor(config: CloudRuntimeConfig, pool: Pool = createPool(createMySqlPoolOptions(config))) {
    this.pool = pool;
  }

  query<T = unknown>(statement: string, values?: readonly unknown[]): Promise<T> {
    return createExecutor(this.pool).query<T>(statement, values);
  }

  execute<T = unknown>(statement: string, values?: readonly unknown[]): Promise<T> {
    return createExecutor(this.pool).execute<T>(statement, values);
  }

  async transaction<T>(work: (transaction: CloudSqlTransaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    const executor = createExecutor(connection);
    const transaction: CloudSqlTransaction = {
      ...executor,
      commit: async () => { await connection.commit(); },
      rollback: async () => { await connection.rollback(); }
    };
    try {
      await connection.beginTransaction();
      const result = await work(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const releaseConnection = (connection: PoolConnection): void => {
  connection.release();
};
