#!/usr/bin/env node
/**
 * 生成邀请码（管理员）。
 * 用法：
 *   node scripts/invite.mjs [数量]          生成邀请码（默认 5 个）
 *   node scripts/invite.mjs --list          查看最近邀请码及使用状态
 *
 * 管理员密钥：开发环境见 data/admin-key.txt，生产环境见 /tmp/admin-key.txt，
 * 或设置环境变量 ADMIN_KEY。首次启动服务器时也会把密钥打印到日志。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const isProd = process.env.COZE_PROJECT_ENV === 'PROD';
const dbPath = process.env.CLOUD_DB_PATH
  || (isProd ? '/tmp/scrollbook-cloud.db' : path.join(process.cwd(), 'data', 'cloud.db'));

if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在（${dbPath}）。请先启动一次服务器以初始化。`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

if (process.argv.includes('--list')) {
  const rows = db.prepare(
    'SELECT code, created_at AS createdAt, used_at AS usedAt FROM invite_codes ORDER BY created_at DESC LIMIT 50',
  ).all();
  for (const r of rows) {
    const status = r.usedAt ? `已用 (${new Date(r.usedAt).toLocaleString()})` : '可用';
    console.log(`${r.code}  ${status}`);
  }
  const unused = db.prepare('SELECT COUNT(*) AS c FROM invite_codes WHERE used_at IS NULL').get();
  console.log(`\n剩余可用：${unused.c} 个`);
  process.exit(0);
}

const count = Math.min(50, Math.max(1, parseInt(process.argv[2] || '5', 10) || 5));
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const insert = db.prepare('INSERT OR IGNORE INTO invite_codes (code, created_at) VALUES (?, ?)');
const codes = [];
for (let i = 0; i < count; i++) {
  const code = Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  insert.run(code, Date.now());
  codes.push(code);
}
console.log(`已生成 ${codes.length} 个邀请码：`);
codes.forEach((c) => console.log(`  ${c}`));
