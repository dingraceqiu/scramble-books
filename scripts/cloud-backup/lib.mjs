/**
 * Scramble Books 云端库备份：纯函数层（供 CLI 与测试共用）。
 *
 * 设计约束（见 BACKUP.md）：
 * - 只允许管理本工具自己产出的文件名（严格正则），绝不动任何其他文件；
 *   因此 /home/ubuntu/apps/data/cloud.db.bak-20260908-pre-v2 这类旧手动备份
 *   永远不匹配、也永远不会被清理。
 * - 备份文件名内嵌 UTC 时间戳，作为唯一事实来源；不做任何「按 mtime 猜测」。
 * - 保留策略：最近 7 个「天」各留最新一份 + 在每日窗口之外、最近 4 个 ISO 周
 *   各留最新一份；最新一份永远保留。
 */

/** 本工具产出的备份文件名（.db 主体 + .json 清单）。 */
export const MANAGED_NAME_RE = /^scramble-books-cloud-(\d{8})T(\d{6})Z\.db(\.json)?$/;

/** manifest = 主体名 + .json，且主体名必须匹配（正则已保证）。 */
export function isManagedBackupName(name) {
  if (!MANAGED_NAME_RE.test(name)) return false;
  // 时间戳必须真实可解析（拒绝 20260999T999999Z 之类格式合法但日期非法的名字）
  return parseBackupTimestamp(name) !== null;
}

/**
 * 从文件名解析 UTC 时间（Date 或 null）。只信文件名，不信 mtime。
 *
 * 必须回读校验：Date 构造会对越界字段静默进位（20260931 → 10 月 1 日、
 * 非闰年 20260229 → 3 月 1 日、24:61:00 → 次日），因此解析后重新格式化，
 * 与文件名中的原始年月日时分秒逐字一致才算合法。
 */
export function parseBackupTimestamp(name) {
  const m = MANAGED_NAME_RE.exec(name);
  if (!m) return null;
  const datePart = m[1];
  const timePart = m[2];
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6));
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n, w) => String(n).padStart(w, '0');
  const rebuilt =
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
  return rebuilt === `${datePart}T${timePart}` ? d : null;
}

/** 生成备份主体文件名（UTC 时间戳）。 */
export function backupNameFor(date) {
  const pad = (n, w) => String(n).padStart(w, '0');
  return (
    `scramble-books-cloud-` +
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z.db`
  );
}

/**
 * 严格路径校验：只有「父目录解析后 === 备份根目录」且文件名匹配管理正则的
 * 绝对路径才算本项目的备份文件。两边都 realpath（macOS /var → /private/var
 * 之类的根目录符号链接因此不会误判）；任何 ../、symlink 逃逸、子目录文件、
 * 或名字不匹配的路径一律拒绝。dir 必须是已 resolve 的绝对路径。
 */
export function isManagedBackupPath(backupRootResolved, candidatePath, fsLike) {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) return false;
  const name = fsLike.basename(candidatePath);
  if (!isManagedBackupName(name)) return false;
  let parent;
  try {
    parent = fsLike.dirname(fsLike.realpathSync(candidatePath));
    const root = fsLike.realpathSync(backupRootResolved);
    return parent === root;
  } catch {
    return false;
  }
}

/** ISO 周 key（如 2026-W37），用于每周保留分组。 */
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 保留策略。
 *
 * @param {string[]} names   候选文件名（.db 主体；调用方应已用 isManagedBackupName 过滤）
 * @param {object} opts
 * @param {number} opts.dailyKeep    保留最近 N 个「天」（默认 7）
 * @param {number} opts.weeklyKeep   每日窗口外再保留最近 N 个 ISO 周（默认 4）
 * @returns {{keep: Set<string>, delete: string[]}}
 *
 * 规则：
 * 1. 按文件名内嵌时间戳降序；
 * 2. 全局最新一份永远 keep（即使与窗口计算冲突）；
 * 3. 每个自然日只保留该日最新一份；最近 dailyKeep 个含备份的日期全部保留；
 * 4. 剩余（更旧的）文件里，按 ISO 周分组，最近 weeklyKeep 个含备份的周
 *    各保留该周最新一份；同一文件若已被日保留命中则不重复计；
 * 5. 其余全部进 delete。
 */
export function planRetention(names, { dailyKeep = 7, weeklyKeep = 4 } = {}) {
  const entries = [];
  for (const name of new Set(names)) {
    const ts = parseBackupTimestamp(name);
    if (ts) entries.push({ name, ts });
  }
  entries.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const keep = new Set();
  if (entries.length > 0) keep.add(entries[0].name);

  // 每日窗口：每个日期里最新一份
  const byDate = new Map();
  for (const e of entries) {
    const day = e.ts.toISOString().slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(e.name);
  }
  const dates = [...byDate.keys()].sort().reverse();
  for (const day of dates.slice(0, dailyKeep)) keep.add(byDate.get(day)[0]);

  // 每周窗口：每日窗口之外更旧的文件，按 ISO 周留最新
  const dailyCutoff = dates[Math.min(dailyKeep, dates.length) - 1];
  const byWeek = new Map();
  for (const e of entries) {
    if (keep.has(e.name)) continue;
    const day = e.ts.toISOString().slice(0, 10);
    if (day > dailyCutoff) continue;
    const week = isoWeekKey(e.ts);
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(e.name);
  }
  const weeks = [...byWeek.keys()].sort().reverse();
  for (const week of weeks.slice(0, weeklyKeep)) keep.add(byWeek.get(week)[0]);

  const del = entries.map((e) => e.name).filter((n) => !keep.has(n));
  return { keep, delete: del };
}
