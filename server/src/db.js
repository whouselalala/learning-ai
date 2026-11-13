import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let current = null;

/**
 * 打开数据库并初始化表结构。
 * 测试里用 openDatabase(':memory:') 即可拿到一份干净的库。
 */
export function openDatabase(file = process.env.DB_FILE === ':memory:' ? ':memory:' : config.dbFile) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  return db;
}

/** 轻量迁移：老库补列，避免升级时丢数据 */
function migrate(db) {
  const ensureColumns = (table, columns) => {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.includes(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  };

  ensureColumns('commissions', {
    ordinal: 'INTEGER NOT NULL DEFAULT 0',
  });
  ensureColumns('users', {
    wx_session_key: 'TEXT',
    qualified_at: 'INTEGER',
    qualify_ordinal: 'INTEGER',
  });
  // 支付字段：老库（只有演示充值时）需要补列
  ensureColumns('orders', {
    virtual_env: 'INTEGER',
    virtual_ack_at: 'INTEGER',
    virtual_checked_at: 'INTEGER',
    subject: 'TEXT',
    prepay_id: 'TEXT',
    transaction_id: 'TEXT',
    paid_amount_fen: 'INTEGER',
    refunded_fen: 'INTEGER NOT NULL DEFAULT 0',
    expire_at: 'INTEGER',
    notify_at: 'INTEGER',
  });
}

export function getDb() {
  if (!current) current = openDatabase();
  return current;
}

export function setDb(db) {
  current = db;
}

export function closeDb() {
  if (current) {
    current.close();
    current = null;
  }
}

/** 事务包装：fn 抛错则回滚 */
export function tx(fn) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function now() {
  return Date.now();
}
