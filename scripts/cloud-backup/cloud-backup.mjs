#!/usr/bin/env node
/**
 * Scramble Books 云端库（SQLite）备份 CLI。
 *
 * 子命令：
 *   backup  对 CLOUD_DB_PATH 做一次一致性备份（VACUUM INTO），写入备份目录
 *   list    列出备份目录中的备份（时间 / 大小 / SHA-256 / 完整性结果）
 *   drill   恢复演练：把指定（默认最新）备份复制到临时目录，验证
 *           integrity_check、表结构、记录数量；绝不触碰生产库
 *
 * 一致性保证：源库以只读连接打开，经 `VACUUM INTO` 生成快照（SQLite 官方
 * 一致读语义，对 WAL 在线库安全）。禁止用 `cp cloud.db` 备份：WAL 模式下
 * 直接复制主库文件会丢掉未 checkpoint 的 WAL 内容。
 *
 * 安全性：
 * - 源库全程只读；备份失败只影响本次任务（退出码 1），不影响在线服务；
 * - 先写临时文件，integrity_check 通过后再原子 rename；
 * - 日志/清单只含路径、大小、SHA、时间戳、表名与行数统计，不输出任何
 *   正文、笔记、账号、token、密码或数据库内容；
 * - 清理只删除「严格路径校验通过 + 命名正则匹配」的本项目备份文件，
 *   绝不触碰旧手动备份（如 cloud.db.bak-20260908-pre-v2）或其他项目文件。
 *
 * 环境变量（或同名 CLI 参数，CLI 优先）：
 *   CLOUD_DB_PATH      生产 SQLite 主库路径
 *   CLOUD_BACKUP_DIR   备份目录（须与主库同一文件系统以保证原子 rename）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  backupNameFor,
  isManagedBackupName,
  isManagedBackupPath,
  planRetention,
} from './lib.mjs';

const EXPECTED_TABLES = ['users', 'sessions', 'invite_codes', 'user_data'];

// ---------- 通用 ----------

function fail(msg) {
  console.error(`[cloud-backup] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveBackupDir(args) {
  const dir = args.out || args['backup-dir'] || process.env.CLOUD_BACKUP_DIR;
  if (!dir || typeof dir !== 'string') {
    fail('缺少备份目录：用 --out 或环境变量 CLOUD_BACKUP_DIR 指定');
  }
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(resolved)) fail('备份目录必须是绝对路径');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function resolveDbPath(args) {
  const dbPath = args.db || process.env.CLOUD_DB_PATH;
  if (!dbPath || typeof dbPath !== 'string') {
    fail('缺少源库路径：用 --db 或环境变量 CLOUD_DB_PATH 指定');
  }
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) fail(`源库不存在：${resolved}`);
  return resolved;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function quoteSqlString(p) {
  return `'${p.replace(/'/g, "''")}'`;
}

function openReadOnly(dbPath) {
  // file: URI + mode=ro：从语义上禁止任何写路径
  return new DatabaseSync(`file:${dbPath.split('?')[0]}?mode=ro`);
}

function countRows(db) {
  const counts = {};
  for (const table of EXPECTED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    counts[table] = Number(row.c);
  }
  return counts;
}

function readManifest(backupRootResolved, name) {
  const manifestPath = path.join(backupRootResolved, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------- backup ----------

async function cmdBackup(args) {
  const dbPath = resolveDbPath(args);
  const backupDir = resolveBackupDir(args);
  const dailyKeep = Number(args['keep-daily'] ?? process.env.CLOUD_BACKUP_KEEP_DAILY ?? 7);
  const weeklyKeep = Number(args['keep-weekly'] ?? process.env.CLOUD_BACKUP_KEEP_WEEKLY ?? 4);
  const t0 = Date.now();

  // 1. 只读打开源库，记录来源信息。quick_check 失败仅记录不阻断：
  //    有备份永远好过没备份，但清单里会如实标记。
  let sourceQuickCheck = 'not-run';
  const source = openReadOnly(dbPath);
  try {
    const journal = source.prepare('PRAGMA journal_mode').get();
    const pageCount = Number(source.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(source.prepare('PRAGMA page_size').get().page_size);
    try {
      sourceQuickCheck = source.prepare('PRAGMA quick_check').get().quick_check;
    } catch {
      /* quick_check 失败不阻断备份 */
    }

    // 2. 先写临时文件（同目录、同文件系统，保证 rename 原子）。
    //    文件名秒级精度：若同一秒已有备份，等一个新秒再命名，绝不覆盖。
    let finalName = backupNameFor(new Date());
    const tmpName = `.tmp-${finalName}`;
    const tmpPath = path.join(backupDir, tmpName);
    let finalPath = path.join(backupDir, finalName);
    for (let i = 0; i < 3 && fs.existsSync(finalPath); i++) {
      await new Promise((r) => setTimeout(r, 1100));
      finalName = backupNameFor(new Date());
      finalPath = path.join(backupDir, finalName);
    }
    if (fs.existsSync(finalPath)) fail('1 秒内重试 3 次仍存在同名备份，放弃本次（未影响任何数据）');
    if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });

    try {
      source.exec(`VACUUM INTO ${quoteSqlString(tmpPath)}`);
    } catch (e) {
      fs.rmSync(tmpPath, { force: true });
      fail(`VACUUM INTO 失败（源库未受影响）：${e.message}`);
    }

    // 3. 对备份文件做完整性检查 + 收集统计
    const backup = openReadOnly(tmpPath);
    let integrity;
    let rowCounts;
    try {
      integrity = backup
        .prepare('PRAGMA integrity_check')
        .all()
        .map((r) => r.integrity_check);
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        fs.rmSync(tmpPath, { force: true });
        fail(`备份 integrity_check 未通过：${integrity.join('; ')}`);
      }
      rowCounts = countRows(backup);
    } finally {
      backup.close();
    }

    const size = fs.statSync(tmpPath).size;
    const sha256 = await sha256File(tmpPath);

    // 4. 原子改名
    fs.renameSync(tmpPath, finalPath);

    // 5. 写 manifest（同样原子；失败只告警，.db 仍有效可复核 SHA）
    const manifest = {
      schemaVersion: 1,
      tool: 'scripts/cloud-backup/cloud-backup.mjs',
      createdAt: new Date().toISOString(),
      source: {
        path: dbPath,
        journalMode: journal.journal_mode,
        pageCount,
        pageSize,
        sizeBytes: fs.statSync(dbPath).size,
        quickCheck: sourceQuickCheck,
      },
      backupFile: finalName,
      sizeBytes: size,
      sha256,
      integrityCheck: integrity.join('; '),
      rowCounts,
      durationMs: Date.now() - t0,
    };
    try {
      const manifestTmp = path.join(backupDir, `.tmp-${finalName}.json`);
      fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + '\n');
      fs.renameSync(manifestTmp, path.join(backupDir, `${finalName}.json`));
    } catch (e) {
      console.error(`[cloud-backup] WARN: manifest 写入失败（备份本体有效）：${e.message}`);
    }

    // 6. 保留策略清理（只删校验通过的管理文件）
    pruneBackups(backupDir, { dailyKeep, weeklyKeep });

    console.log(
      `[cloud-backup] OK ${finalName} size=${size}B sha256=${sha256} ` +
        `rows=${JSON.stringify(rowCounts)} sourceQuickCheck=${sourceQuickCheck} ` +
        `durationMs=${Date.now() - t0}`,
    );
  } finally {
    source.close();
  }
}

/**
 * 保留策略清理。三重防线：
 * 1. 文件名必须匹配管理正则（isManagedBackupName）；
 * 2. planRetention 决定删除集合（最新一份永远保留）；
 * 3. 删除前 isManagedBackupPath 再做严格路径校验（realpath 后父目录必须
 *    等于备份根目录）。
 * 任何不满足条件的文件（旧手动备份、其他项目文件、symlink）一律跳过。
 */
export function pruneBackups(backupDir, { dailyKeep, weeklyKeep }) {
  const fsLike = { basename: path.basename, dirname: path.dirname, realpathSync: fs.realpathSync };
  const entries = fs.readdirSync(backupDir).filter((n) => isManagedBackupName(n));
  const { keep, delete: doomed } = planRetention(entries, { dailyKeep, weeklyKeep });
  let deleted = 0;
  for (const name of doomed) {
    if (keep.has(name)) continue;
    const target = path.join(backupDir, name);
    if (!isManagedBackupPath(backupDir, target, fsLike)) {
      console.error(`[cloud-backup] WARN: 路径校验未通过，跳过删除：${name}`);
      continue;
    }
    for (const victim of [target, `${target}.json`]) {
      try {
        fs.rmSync(victim, { force: true });
        deleted += 1;
      } catch (e) {
        console.error(`[cloud-backup] WARN: 删除失败 ${path.basename(victim)}：${e.message}`);
      }
    }
  }
  // keep 集合里的 manifest 必须原样保留（.json 不参与保留计算，跟着 .db 走）
  if (deleted > 0) console.log(`[cloud-backup] prune: 删除 ${deleted} 个过期文件`);
  return { keep: [...keep], deleted };
}

// ---------- list ----------

async function cmdList(args) {
  const backupDir = resolveBackupDir(args);
  const entries = fs
    .readdirSync(backupDir)
    .filter((n) => isManagedBackupName(n) && n.endsWith('.db'))
    .sort()
    .reverse();
  if (entries.length === 0) {
    console.log('[cloud-backup] 备份目录为空');
    return;
  }
  for (const name of entries) {
    const filePath = path.join(backupDir, name);
    const size = fs.statSync(filePath).size;
    const manifest = readManifest(backupDir, name);
    const integrity = manifest ? manifest.integrityCheck : 'unknown(无manifest)';
    const sha = manifest ? manifest.sha256 : '(无manifest，可手工 sha256sum 复核)';
    console.log(
      `${name}  size=${size}B  integrity=${integrity}\n  sha256=${sha}` +
        (manifest ? `\n  createdAt=${manifest.createdAt} source=${manifest.source.path}` : ''),
    );
  }
}

// ---------- drill（恢复演练） ----------

async function cmdDrill(args) {
  const backupDir = resolveBackupDir(args);
  const entries = fs
    .readdirSync(backupDir)
    .filter((n) => isManagedBackupName(n) && n.endsWith('.db'))
    .sort()
    .reverse();
  if (entries.length === 0) fail('备份目录中没有可演练的备份');

  let name;
  if (args.file) {
    name = path.basename(String(args.file));
    if (!isManagedBackupName(name)) {
      fail(`--file 必须是本工具命名的备份文件名（basename，不含路径）：${args.file}`);
    }
    if (!entries.includes(name)) fail(`备份不存在：${name}`);
  } else {
    name = entries[0];
  }
  const backupPath = path.join(backupDir, name);
  console.log(`[cloud-backup] drill: 使用备份 ${name}`);

  // SHA 复核（与 manifest 比对；无 manifest 则记录本次计算值）
  const actualSha = await sha256File(backupPath);
  const manifest = readManifest(backupDir, name);
  if (manifest) {
    if (manifest.sha256 !== actualSha) fail('SHA-256 与 manifest 不符，备份文件已损坏或被篡改');
    console.log(`[cloud-backup] drill: SHA-256 与 manifest 一致 (${actualSha})`);
  } else {
    console.log(`[cloud-backup] drill: 无 manifest，本次计算 sha256=${actualSha}`);
  }

  // 复制到临时目录演练。绝不指向生产库；演练产物用完即删。
  const tempRoot = args['temp-root'] ? path.resolve(String(args['temp-root'])) : os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(tempRoot, 'scramble-books-drill-'));
  const restoredPath = path.join(tempDir, 'restored.db');
  if (path.resolve(restoredPath) === path.resolve(backupPath)) fail('演练路径非法');
  fs.copyFileSync(backupPath, restoredPath);

  try {
    const db = openReadOnly(restoredPath);
    try {
      const integrity = db
        .prepare('PRAGMA integrity_check')
        .all()
        .map((r) => r.integrity_check);
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        fail(`恢复副本 integrity_check 未通过：${integrity.join('; ')}`);
      }
      console.log('[cloud-backup] drill: integrity_check = ok');

      // 表结构：要求的业务表必须存在且列齐全（列名单来自 server/lib/cloudDb.ts）
      const expectedColumns = {
        users: ['id', 'email', 'password_hash', 'created_at', 'last_login_at'],
        sessions: ['token', 'user_id', 'expires_at', 'created_at'],
        invite_codes: ['code', 'created_at', 'used_by', 'used_at'],
        user_data: ['user_id', 'data', 'updated_at'],
      };
      for (const [table, cols] of Object.entries(expectedColumns)) {
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        if (info.length === 0) fail(`恢复副本缺少表：${table}`);
        const actualCols = info.map((c) => c.name);
        for (const col of cols) {
          if (!actualCols.includes(col)) fail(`表 ${table} 缺少列：${col}`);
        }
      }
      console.log('[cloud-backup] drill: 表结构完整（users/sessions/invite_codes/user_data）');

      const rowCounts = countRows(db);
      if (manifest && manifest.rowCounts) {
        for (const table of EXPECTED_TABLES) {
          if (manifest.rowCounts[table] !== rowCounts[table]) {
            fail(`表 ${table} 行数与 manifest 不符：${manifest.rowCounts[table]} -> ${rowCounts[table]}`);
          }
        }
        console.log('[cloud-backup] drill: 行数与 manifest 一致');
      }
      console.log(`[cloud-backup] drill: 行数统计 ${JSON.stringify(rowCounts)}`);
      console.log(`[cloud-backup] drill PASS（临时目录 ${tempDir} 已验证，即将清理）`);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------- 入口 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'backup') await cmdBackup(args);
  else if (cmd === 'list') await cmdList(args);
  else if (cmd === 'drill') await cmdDrill(args);
  else {
    console.error(
      '用法: node scripts/cloud-backup/cloud-backup.mjs <backup|list|drill> [--db <path>] [--out <dir>]\n' +
        '  backup  一致性备份（VACUUM INTO + integrity_check + SHA-256 + 原子改名 + 保留清理）\n' +
        '  list    列出备份（时间/大小/SHA/完整性）\n' +
        '  drill   恢复演练（最新或 --file <name>，复制到临时目录验证，不动生产库）',
    );
    process.exit(2);
  }
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
