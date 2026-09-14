import BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = BetterSqlite3.Database;

export const openDatabase = (filename: string): SqliteDatabase => {
  const database = new BetterSqlite3(filename);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  return database;
};
