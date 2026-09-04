/**
 * 云端数据存储（SQLite）。
 *
 * 与前端 IndexedDB 并行：未登录用户一切照旧，数据完全在浏览器本地；
 * 登录后用户数据以整库快照形式存到这里（表 user_data.data 一个 JSON blob），
 * MVP 不做实体级 CRUD，同步逻辑由「拉取整库 → 替换本地 / 推送整库」完成。
 *
 * 数据库文件位置：
 * - 优先 CLOUD_DB_PATH 环境变量；
 * - 开发环境默认 <工作区>/data/cloud.db；
 * - 生产环境（沙箱唯一可写目录为 /tmp）默认 /tmp/scrollbook-cloud.db（注意 /tmp 可能被定期清理）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let db: DatabaseSync | null = null;

function resolveDbPath(): string {
  if (process.env.CLOUD_DB_PATH) return process.env.CLOUD_DB_PATH;
  const isProd = process.env.COZE_PROJECT_ENV === 'PROD';
  if (isProd) return '/tmp/scrollbook-cloud.db';
  return path.join(process.cwd(), 'data', 'cloud.db');
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      used_by INTEGER REFERENCES users(id),
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_data (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

export interface CloudUser {
  id: number;
  email: string;
  createdAt: number;
  lastLoginAt: number | null;
}

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: number;
  last_login_at: number | null;
}

function rowToUser(r: UserRow): CloudUser {
  return { id: r.id, email: r.email, createdAt: r.created_at, lastLoginAt: r.last_login_at };
}

export function findUserByEmail(email: string): CloudUser | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE lower(email) = lower(?)')
    .get(email.trim()) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function getUserPasswordHash(email: string): { user: CloudUser; hash: string } | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE lower(email) = lower(?)')
    .get(email.trim()) as UserRow | undefined;
  if (!row) return null;
  return { user: rowToUser(row), hash: row.password_hash };
}

export function getUserById(id: number): CloudUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function createUser(email: string, passwordHash: string): CloudUser {
  const info = getDb()
    .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
    .run(email.trim(), passwordHash, Date.now());
  const id = Number(info.lastInsertRowid);
  return { id, email: email.trim(), createdAt: Date.now(), lastLoginAt: null };
}

export function touchLogin(userId: number): void {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), userId);
}

// ---------- 邀请码 ----------

export function findInviteCode(code: string): { code: string; usedAt: number | null } | null {
  const row = getDb()
    .prepare('SELECT code, used_at AS usedAt FROM invite_codes WHERE code = ?')
    .get(code.trim().toUpperCase()) as { code: string; usedAt: number | null } | undefined;
  return row ?? null;
}

/** 原子地消费邀请码：同一码并发注册时只有一个事务能成功 */
export function consumeInviteCode(code: string, userId: number): boolean {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = d
      .prepare('SELECT code FROM invite_codes WHERE code = ? AND used_at IS NULL')
      .get(code.trim().toUpperCase()) as { code: string } | undefined;
    if (row) {
      d.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ?').run(
        userId,
        Date.now(),
        code.trim().toUpperCase(),
      );
      d.exec('COMMIT');
      return true;
    }
    d.exec('ROLLBACK');
    return false;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function createInviteCodes(count: number): string[] {
  const codes: string[] = [];
  const d = getDb();
  const insert = d.prepare('INSERT OR IGNORE INTO invite_codes (code, created_at) VALUES (?, ?)');
  for (let i = 0; i < count; i++) {
    // 8 位大写易读字符（去掉易混淆的 0/O、1/I）
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 8 }, () =>
      alphabet[crypto.randomInt(alphabet.length)],
    ).join('');
    insert.run(code, Date.now());
    codes.push(code);
  }
  return codes;
}

export function countUnusedInviteCodes(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM invite_codes WHERE used_at IS NULL')
    .get() as { c: number };
  return Number(row.c);
}

export function listInviteCodes(): { code: string; createdAt: number; usedAt: number | null }[] {
  return getDb()
    .prepare('SELECT code, created_at AS createdAt, used_at AS usedAt FROM invite_codes ORDER BY created_at DESC LIMIT 50')
    .all() as { code: string; createdAt: number; usedAt: number | null }[];
}

// ---------- 会话 ----------

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export function createSession(userId: number): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  getDb()
    .prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, expiresAt, Date.now());
  return { token, expiresAt };
}

export function getSessionUser(token: string): CloudUser | null {
  const row = getDb()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as UserRow | undefined;
  if (!row) return null;
  // 滑动续期：每次访问把过期时间往后推
  getDb()
    .prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
    .run(Date.now() + SESSION_TTL_MS, token);
  return rowToUser(row);
}

export function deleteSession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------- 用户数据（整库快照） ----------

export function getUserData(userId: number): { data: string; updatedAt: number } | null {
  const row = getDb()
    .prepare('SELECT data, updated_at AS updatedAt FROM user_data WHERE user_id = ?')
    .get(userId) as { data: string; updatedAt: number } | undefined;
  return row ?? null;
}

export function putUserData(userId: number, data: string): number {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO user_data (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .run(userId, data, now);
  return now;
}
