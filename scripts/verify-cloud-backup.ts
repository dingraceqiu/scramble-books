/**
 * 云端库备份工具回归套件：路径校验 / 命名 / 保留策略 / 端到端备份与恢复演练。
 *
 * 运行：pnpm verify:cloud-backup
 *
 * 覆盖：
 * 1. 文件名正则——旧手动备份（cloud.db.bak-20260908-pre-v2）、其他项目文件、
 *    临时文件永远不匹配，清理逻辑因此不可能碰它们；
 * 2. 严格路径校验——遍历、子目录、symlink 逃逸一律拒绝；
 * 3. 保留策略——最近 7 个每日 + 4 个每周，最新一份永远保留；
 * 4. 端到端（需 node:sqlite）——对临时 WAL 库真实执行 backup/list/drill：
 *    manifest SHA-256 与文件一致、integrity_check=ok、行数一致、
 *    源库字节级不变、清理不触碰非管理文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  backupNameFor,
  isManagedBackupName,
  isManagedBackupPath,
  parseBackupTimestamp,
  planRetention,
} from './cloud-backup/lib.mjs';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) {
    passed += 1;
  } else {
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------- 1. 文件名正则 ----------

check('管理正则接受标准备份名', isManagedBackupName('scramble-books-cloud-20260913T043000Z.db'));
check('管理正则接受 manifest 名', isManagedBackupName('scramble-books-cloud-20260913T043000Z.db.json'));
check('旧手动备份不匹配', !isManagedBackupName('cloud.db.bak-20260908-pre-v2'));
check('生产主库不匹配', !isManagedBackupName('cloud.db'));
check('WAL/SHM 不匹配', !isManagedBackupName('cloud.db-wal') && !isManagedBackupName('cloud.db-shm'));
check('临时文件不匹配', !isManagedBackupName('.tmp-scramble-books-cloud-20260913T043000Z.db'));
check('缺 .db 的 json 不匹配', !isManagedBackupName('scramble-books-cloud-20260913T043000Z.json'));
check('其他项目前缀不匹配', !isManagedBackupName('finreport-cloud-20260913T043000Z.db'));
check('遍历式名字不匹配', !isManagedBackupName('../scramble-books-cloud-20260913T043000Z.db'));
check('时间戳非法的名字不匹配', !isManagedBackupName('scramble-books-cloud-20260999T999999Z.db'));

// ---------- 2. 时间戳解析与生成 ----------

const parsed = parseBackupTimestamp('scramble-books-cloud-20260913T043000Z.db');
check('时间戳解析为 UTC', parsed !== null && parsed.toISOString() === '2026-09-13T04:30:00.000Z');
check('非法时间戳返回 null', parseBackupTimestamp('scramble-books-cloud-20260999T999999Z.db') === null);
// 日期进位必须被拒绝（Date 构造会静默滚到下一天/下个月）
check('9 月 31 日被拒绝', parseBackupTimestamp('scramble-books-cloud-20260931T120000Z.db') === null);
check('非闰年 2 月 29 日被拒绝', parseBackupTimestamp('scramble-books-cloud-20260229T120000Z.db') === null);
check('闰年 2 月 29 日合法', parseBackupTimestamp('scramble-books-cloud-20240229T120000Z.db') !== null);
check('13 月被拒绝', parseBackupTimestamp('scramble-books-cloud-20261301T120000Z.db') === null);
check('0 月被拒绝', parseBackupTimestamp('scramble-books-cloud-20260001T120000Z.db') === null);
check('24 时被拒绝（进位到次日）', parseBackupTimestamp('scramble-books-cloud-20260913T246000Z.db') === null);
check('61 分被拒绝（进位到下一时）', parseBackupTimestamp('scramble-books-cloud-20260913T256100Z.db') === null);
check('60 秒被拒绝（进位到下一分）', parseBackupTimestamp('scramble-books-cloud-20260913T235960Z.db') === null);
check('边界 23:59:59 合法', parseBackupTimestamp('scramble-books-cloud-20260913T235959Z.db') !== null);
const generated = backupNameFor(new Date(Date.UTC(2026, 8, 13, 4, 30, 5)));
check(
  'backupNameFor 生成可回读的名字',
  generated === 'scramble-books-cloud-20260913T043005Z.db' &&
    parseBackupTimestamp(generated)?.toISOString() === '2026-09-13T04:30:05.000Z',
);

// ---------- 3. 严格路径校验 ----------

{
  const root = tmpDir('cb-pathcheck-');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'scramble-books-cloud-20260913T040000Z.db'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'scramble-books-cloud-20260913T040000Z.db'), 'x');
  fs.symlinkSync('/etc/passwd', path.join(root, 'scramble-books-cloud-20260913T050000Z.db'));

  const fsLike = { basename: path.basename, dirname: path.dirname, realpathSync: fs.realpathSync };
  check(
    '根目录下的合法备份路径通过',
    isManagedBackupPath(root, path.join(root, 'scramble-books-cloud-20260913T040000Z.db'), fsLike),
  );
  check(
    '子目录里的文件被拒绝',
    !isManagedBackupPath(root, path.join(root, 'sub', 'scramble-books-cloud-20260913T040000Z.db'), fsLike),
  );
  check(
    'symlink 逃逸被拒绝（realpath 后父目录不是备份根）',
    !isManagedBackupPath(root, path.join(root, 'scramble-books-cloud-20260913T050000Z.db'), fsLike),
  );
  check(
    '旧手动备份名字被拒绝',
    !isManagedBackupPath(root, path.join(root, 'cloud.db.bak-20260908-pre-v2'), fsLike),
  );
  check(
    '不存在的文件被拒绝',
    !isManagedBackupPath(root, path.join(root, 'scramble-books-cloud-20260913T060000Z.db'), fsLike),
  );
  check('空路径被拒绝', !isManagedBackupPath(root, '', fsLike));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- 4. 保留策略 ----------

{
  // 45 天，每天 04:30 一份：期望保留 = 7 个每日 + 4 个每周 = 11 份
  const names: string[] = [];
  for (let day = 45; day >= 1; day--) {
    const d = new Date(Date.UTC(2026, 8, 13, 4, 30, 0) - day * 86400000);
    names.push(backupNameFor(d));
  }
  const { keep, delete: doomed } = planRetention(names, { dailyKeep: 7, weeklyKeep: 4 });
  check('45 天每日备份保留 11 份', keep.size === 11);
  check('最新一份永远保留', keep.has(names[names.length - 1]));
  check('45 天每日备份删除 34 份', doomed.length === 45 - 11);
  check('保留的都是合法管理名', [...keep].every(isManagedBackupName));

  // 同一天多份（手动触发）：每日窗口里该日只留最新
  const dayOld = backupNameFor(new Date(Date.UTC(2026, 8, 13, 4, 30, 0) - 2 * 86400000));
  const dayOldLater = backupNameFor(new Date(Date.UTC(2026, 8, 13, 4, 30, 0) - 2 * 86400000 + 3600000));
  const r2 = planRetention([dayOld, dayOldLater, ...names], { dailyKeep: 7, weeklyKeep: 4 });
  check('同日两份只留最新', r2.keep.has(dayOldLater) && !r2.keep.has(dayOld));
  check('同日重复不改变保留总数', r2.keep.size === 11 && r2.delete.length === 46 - 11);

  // 每周窗口：对每日窗口之外更旧的文件按 ISO 周留最新
  // 最近 7 天放满每日备份，把 w1/w2 挤出每日窗口；两者同一 ISO 周 → 只留该周最新
  const w1 = backupNameFor(new Date(Date.UTC(2026, 5, 1, 4, 30, 0))); // 2026-06-01（周一）
  const w2 = backupNameFor(new Date(Date.UTC(2026, 5, 3, 4, 30, 0))); // 2026-06-03（同周）
  const fillers: string[] = [];
  for (let day = 1; day <= 7; day++) {
    fillers.push(backupNameFor(new Date(Date.UTC(2026, 8, 13, 4, 30, 0) - day * 86400000)));
  }
  const r3 = planRetention([w1, w2, ...fillers], { dailyKeep: 7, weeklyKeep: 4 });
  check('同周两份（窗口外）只留该周最新', r3.keep.has(w2) && !r3.keep.has(w1));
  check('窗口外每周保留后总数 = 7 + 1', r3.keep.size === 8);

  // 非法名字不参与保留计算
  const r4 = planRetention(
    ['cloud.db.bak-20260908-pre-v2', 'scramble-books-cloud-20260913T043000Z.db'],
    { dailyKeep: 7, weeklyKeep: 4 },
  );
  check('非法名字不进 keep 也不进 delete', r4.keep.size === 1 && r4.delete.length === 0);
}

// ---------- 5. 端到端（真实 CLI：backup / list / drill / prune） ----------

const hasSqlite = (() => {
  try {
    return (
      typeof process.versions.node === 'string' && Number(process.versions.node.split('.')[0]) >= 22
    );
  } catch {
    return false;
  }
})();

async function runE2E(): Promise<void> {
  const root = tmpDir('cb-e2e-');
  const srcDir = path.join(root, 'src');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(srcDir);
  const srcDb = path.join(srcDir, 'cloud.db');
  fs.mkdirSync(backupDir, { recursive: true });

  // 构造 WAL 模式源库（结构与 server/lib/cloudDb.ts 一致），并保持一个打开的
  // 写连接 + 未 checkpoint 的 WAL 内容，模拟在线状态
  const { DatabaseSync } = await import('node:sqlite');
  const writer = new DatabaseSync(srcDb);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login_at INTEGER);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE invite_codes (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id), used_at INTEGER);
    CREATE TABLE user_data (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  const insertUser = writer.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)');
  insertUser.run('drill@example.com', 'hash-not-a-secret', Date.now());
  writer.prepare('INSERT INTO user_data VALUES (?, ?, ?)').run(1, '{"probe":true}', Date.now());
  writer.prepare('INSERT INTO invite_codes (code, created_at) VALUES (?, ?)').run('DRILLCODE', Date.now());
  writer.exec('PRAGMA wal_checkpoint(PASSIVE)');

  const srcShaBefore = crypto.createHash('sha256').update(fs.readFileSync(srcDb)).digest('hex');

  // 目录预置为宽松权限，验证 CLI 会强制收紧到 0700
  fs.chmodSync(backupDir, 0o755);

  // 布置「应被保护」的文件：旧手动备份、其他项目文件
  const manualBak = path.join(srcDir, '..', 'manual-bak');
  fs.mkdirSync(manualBak);
  fs.writeFileSync(path.join(manualBak, 'cloud.db.bak-20260908-pre-v2'), 'manual');
  fs.writeFileSync(path.join(backupDir, 'cloud.db.bak-20260908-pre-v2'), 'manual');

  const run = (sub: string, extra: string[] = []) =>
    spawnSync(process.execPath, ['scripts/cloud-backup/cloud-backup.mjs', sub, '--db', srcDb, '--out', backupDir, ...extra], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

  const b1 = run('backup');
  check('backup 退出码 0', b1.status === 0);
  const dbFiles = fs.readdirSync(backupDir).filter((n) => n.endsWith('.db'));
  check('产出一个备份 .db', dbFiles.length === 1);
  const backupName = dbFiles[0] ?? '';
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, `${backupName}.json`), 'utf8'));
  check('manifest 记录来源路径', manifest.source.path === srcDb);
  check('manifest 记录 WAL journal mode', manifest.source.journalMode === 'wal');
  check('manifest integrity=ok', manifest.integrityCheck === 'ok');
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(backupDir, backupName))).digest('hex');
  check('manifest SHA-256 与文件一致', manifest.sha256 === actualSha);
  check('manifest 行数统计正确', manifest.rowCounts.users === 1 && manifest.rowCounts.user_data === 1 && manifest.rowCounts.invite_codes === 1);
  check(
    '备份后源库字节级不变（无写入路径）',
    crypto.createHash('sha256').update(fs.readFileSync(srcDb)).digest('hex') === srcShaBefore,
  );
  check('备份文件较源库已合并 WAL（有数据）', manifest.rowCounts.users >= 1);

  const list = run('list');
  check('list 退出码 0 且包含 SHA', list.status === 0 && list.stdout.includes(actualSha));

  // 权限：目录 0700、.db 0600、manifest 0600（预置 755 的目录也被收紧）
  check('备份目录权限为 0700', (fs.statSync(backupDir).mode & 0o777) === 0o700);
  check('备份 .db 权限为 0600', (fs.statSync(path.join(backupDir, backupName)).mode & 0o777) === 0o600);
  check(
    'manifest 权限为 0600',
    (fs.statSync(path.join(backupDir, `${backupName}.json`)).mode & 0o777) === 0o600,
  );

  // 相对路径拒绝（resolve 前判断，db 与备份目录都覆盖）
  const beforeRel = fs.readdirSync(backupDir).sort().join('|');
  const relDb = run('backup', ['--db', 'src/cloud.db']);
  check('相对路径源库被拒绝', relDb.status === 1 && relDb.stderr.includes('相对路径'));
  const relOut = run('backup', ['--out', 'rel-backups']);
  check('相对路径备份目录被拒绝', relOut.status === 1 && relOut.stderr.includes('相对路径'));
  check(
    '相对路径拒绝不产生任何文件',
    fs.readdirSync(backupDir).sort().join('|') === beforeRel && !fs.existsSync(path.join(root, 'rel-backups')),
  );

  const drill = run('drill');
  check(
    'drill PASS（SHA 复核 + integrity + 表结构 + 行数）',
    drill.status === 0 && drill.stdout.includes('drill PASS') && drill.stdout.includes('SHA-256 与 manifest 一致'),
  );

  // drill 拒绝路径注入
  const drillInject = run('drill', ['--file', '../../etc/passwd']);
  check('drill 拒绝带路径的 --file', drillInject.status === 1);
  const drillMissing = run('drill', ['--file', 'scramble-books-cloud-19990101T000000Z.db']);
  check('drill 拒绝不存在的备份名', drillMissing.status === 1);

  // 清理边界：布置过期管理备份 + 需要保护的文件，再跑一次 backup 触发 prune
  for (const [daysAgo, content] of [
    [40, 'old-daily-1'],
    [39, 'old-daily-2'],
    [35, 'old-weekly'],
  ] as const) {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const name = backupNameFor(d);
    fs.writeFileSync(path.join(backupDir, name), content);
  }
  fs.writeFileSync(path.join(backupDir, 'cloud.db.bak-20260908-pre-v2'), 'manual');
  fs.writeFileSync(path.join(backupDir, 'keepme.txt'), 'other-project');
  const b2 = run('backup');
  check('第二次 backup 退出码 0', b2.status === 0);
  check(
    '清理同日旧备份无路径校验误报',
    !b2.stderr.includes('路径校验未通过'),
  );
  const b2Name = /scramble-books-cloud-\d{8}T\d{6}Z\.db/.exec(b2.stdout)?.[0] ?? '';
  const after = fs.readdirSync(backupDir);
  const remainingDb = after.filter((n) => isManagedBackupName(n) && n.endsWith('.db'));
  // 现存 4 个不同日期（今天/40天前/39天前/35天前）都在 7 日窗口内，
  // 每个日期留最新 → 4 份；今天的两份里旧的那份（第一次备份）被清理
  check('prune 后管理备份剩 4 份（4 个日期各留最新）', remainingDb.length === 4);
  check('同日旧备份被清理', b2Name !== '' && !remainingDb.includes(backupName));
  check('本次新备份仍在', b2Name !== '' && remainingDb.includes(b2Name));
  check('旧手动备份未被触碰', after.includes('cloud.db.bak-20260908-pre-v2'));
  check('其他项目文件未被触碰', after.includes('keepme.txt'));
  check('临时文件无残留', !after.some((n) => n.startsWith('.tmp-')));

  writer.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function main(): Promise<void> {
  if (hasSqlite) {
    await runE2E();
  } else {
    console.log('  (node:sqlite 不可用，跳过端到端部分)');
  }

  console.log(`\ncloud-backup 套件：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    console.error('失败项：');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
