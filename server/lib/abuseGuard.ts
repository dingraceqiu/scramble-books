/**
 * GLM 代理接口防滥用守卫（TD-06）。
 *
 * 保护对象：/api/ai-titles、/api/knowledge-points、/api/classify-book。
 * 多层限制（全部内存态，单进程；重启即重置，属可接受的软状态）：
 * 1. 每桶每分钟请求数（固定分钟窗）；
 * 2. 每桶每日请求数（UTC 日界）；
 * 3. 桶级/全局并发数；
 * 4. 全局每日 GLM 真实调用预算（dailyGlobal）——由 glmChat() 在 fetch 上游前统一
 *    consume（见 consumeGlmCallBudget），请求级拒绝/未配置/不走 GLM 的路径不消耗，
 *    额度耗尽时含探针在内的所有调用方诚实失败；
 * 5. 轮换探针（本机回环直连、无代理链）独立小额度桶——外部无法命中该桶：
 *    - 经 nginx 进来的请求，nginx 会在 X-Forwarded-For 末尾追加真实 IP，
 *      trust proxy 'loopback' 取最右侧非可信地址 → 永远不是回环；
 *    - 公网直连 5000 时 socket 对端是公网地址，不是可信代理 → req.ip 为真实来源。
 *    仅「socket 对端是回环 且 解析出的客户端 IP 也是回环」（即服务器本机进程直连）
 *    才落入 probe 桶。
 *
 * 桶键：有效登录会话 → user:<id>；本机回环 → probe；其余 → ip:<sha256 前 8 位>。
 * 日志只输出接口、限制类型、桶哈希与状态码——绝不记录正文、书名、token、密钥或完整 IP。
 *
 * 所有阈值可经环境变量覆盖（不含任何密钥）：
 *   GLM_GUARD_RATE_PER_MIN / GLM_GUARD_DAILY_PER_BUCKET / GLM_GUARD_DAILY_GLOBAL /
 *   GLM_GUARD_CONCURRENCY_PER_BUCKET / GLM_GUARD_CONCURRENCY_GLOBAL /
 *   GLM_GUARD_PROBE_RATE_PER_MIN / GLM_GUARD_PROBE_DAILY /
 *   GLM_AI_TITLES_MAX_ITEMS / GLM_AI_TITLES_ITEM_CHARS / GLM_AI_TITLES_TOTAL_CHARS /
 *   GLM_KP_MAX_ITEMS / GLM_KP_ITEM_CHARS / GLM_KP_TOTAL_CHARS
 */
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { getSessionUser } from './cloudDb';

export type GlmEndpoint = 'ai-titles' | 'knowledge-points' | 'classify-book';

export interface AbuseGuardConfig {
  ratePerMin: number;
  dailyPerBucket: number;
  dailyGlobal: number;
  concurrencyPerBucket: number;
  concurrencyGlobal: number;
  probeRatePerMin: number;
  probeDaily: number;
  aiTitlesMaxItems: number;
  aiTitlesItemChars: number;
  aiTitlesTotalChars: number;
  kpMaxItems: number;
  kpItemChars: number;
  kpTotalChars: number;
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function loadAbuseGuardConfig(): AbuseGuardConfig {
  return {
    ratePerMin: intEnv('GLM_GUARD_RATE_PER_MIN', 30),
    dailyPerBucket: intEnv('GLM_GUARD_DAILY_PER_BUCKET', 400),
    dailyGlobal: intEnv('GLM_GUARD_DAILY_GLOBAL', 3000),
    concurrencyPerBucket: intEnv('GLM_GUARD_CONCURRENCY_PER_BUCKET', 4),
    concurrencyGlobal: intEnv('GLM_GUARD_CONCURRENCY_GLOBAL', 16),
    probeRatePerMin: intEnv('GLM_GUARD_PROBE_RATE_PER_MIN', 6),
    probeDaily: intEnv('GLM_GUARD_PROBE_DAILY', 20),
    aiTitlesMaxItems: intEnv('GLM_AI_TITLES_MAX_ITEMS', 8),
    aiTitlesItemChars: intEnv('GLM_AI_TITLES_ITEM_CHARS', 1500),
    aiTitlesTotalChars: intEnv('GLM_AI_TITLES_TOTAL_CHARS', 20000),
    kpMaxItems: intEnv('GLM_KP_MAX_ITEMS', 6),
    kpItemChars: intEnv('GLM_KP_ITEM_CHARS', 2500),
    kpTotalChars: intEnv('GLM_KP_TOTAL_CHARS', 20000),
  };
}

let config: AbuseGuardConfig = loadAbuseGuardConfig();

/** 仅测试使用：覆盖配置并清空全部计数状态 */
export function __configureAbuseGuardForTests(partial: Partial<AbuseGuardConfig>): void {
  config = { ...loadAbuseGuardConfig(), ...partial };
  resetAbuseGuardForTests();
}

/** 仅测试使用：清空全部计数状态（分钟窗/日计数/并发） */
export function resetAbuseGuardForTests(): void {
  minuteWindows.clear();
  dayCounters.clear();
  concurrency.clear();
  lastSweepAt = 0;
}

/** 仅测试使用：暴露内部计数 Map，供 GC 回归注入/检查 stale 条目 */
export function __abuseGuardInternalsForTests(): {
  minuteWindows: Map<string, WindowCounter>;
  dayCounters: Map<string, DayCounter>;
} {
  return { minuteWindows, dayCounters };
}

// ---------- 状态 ----------

interface WindowCounter {
  winStart: number;
  count: number;
}
interface DayCounter {
  day: string;
  count: number;
}

const minuteWindows = new Map<string, WindowCounter>();
const dayCounters = new Map<string, DayCounter>();
const concurrency = new Map<string, number>();

function dayKeyUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function bumpMinute(mapKey: string, limit: number, now: number): { ok: boolean; retryAfterSec: number; count: number } {
  const winStart = Math.floor(now / 60000) * 60000;
  const w = minuteWindows.get(mapKey);
  if (!w || w.winStart !== winStart) {
    minuteWindows.set(mapKey, { winStart, count: 1 });
    return { ok: true, retryAfterSec: 0, count: 1 };
  }
  w.count += 1;
  if (w.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((winStart + 60000 - now) / 1000)), count: w.count };
  }
  return { ok: true, retryAfterSec: 0, count: w.count };
}

function bumpDay(mapKey: string, limit: number, now: number): { ok: boolean; retryAfterSec: number; count: number } {
  const day = dayKeyUtc(now);
  const d = dayCounters.get(mapKey);
  if (!d || d.day !== day) {
    dayCounters.set(mapKey, { day, count: 1 });
    return { ok: true, retryAfterSec: 0, count: 1 };
  }
  d.count += 1;
  if (d.count > limit) {
    const midnight = Date.parse(`${day}T00:00:00.000Z`) + 24 * 3600 * 1000;
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((midnight - now) / 1000)), count: d.count };
  }
  return { ok: true, retryAfterSec: 0, count: d.count };
}

function tryAcquireConcurrency(mapKey: string, limit: number): boolean {
  const cur = concurrency.get(mapKey) ?? 0;
  if (cur >= limit) return false;
  concurrency.set(mapKey, cur + 1);
  return true;
}

function releaseConcurrency(mapKey: string): void {
  const cur = concurrency.get(mapKey) ?? 0;
  if (cur <= 1) concurrency.delete(mapKey);
  else concurrency.set(mapKey, cur - 1);
}

// ---------- 桶识别 ----------

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hashBucket(ip: string): string {
  return `ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 8)}`;
}

/**
 * 解析请求所属桶：
 * - 有效 Bearer 会话 → user:<id>（无效/过期 token 忽略，回退 IP 桶，绝不拒绝本地匿名用户）；
 * - 本机回环直连（socket 对端与解析 IP 均为回环）→ probe（轮换探针专用小桶）；
 * - 其余 → ip:<sha256 前 8 位>。
 */
export function bucketForRequest(req: Request): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) {
    try {
      const user = getSessionUser(token);
      if (user) return `user:${user.id}`;
    } catch {
      // 会话库不可用时回退 IP 桶，不影响本地模式
    }
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (isLoopbackIp(ip) && isLoopbackIp(req.socket.remoteAddress ?? '')) return 'probe';
  return hashBucket(ip);
}

// ---------- 稳定 JSON 拒绝 ----------

export function rejectJson(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryAfterSec?: number,
): void {
  if (retryAfterSec !== undefined) res.set('Retry-After', String(retryAfterSec));
  res.status(status).json({ ok: false, error: message, code });
}

// ---------- 守卫中间件 ----------

/**
 * GLM 接口守卫：通过者放行（计入日额度/并发，请求结束后释放并发），
 * 被拒者返回稳定 JSON 429 且绝不触达 GLM 上游。
 */
export function glmGuard(endpoint: GlmEndpoint): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bucket = bucketForRequest(req);
    const isProbe = bucket === 'probe';
    const now = Date.now();
    maybeSweepStale(now);

    // 1. 每分钟频率（探针独立阈值）
    const rate = bumpMinute(`${bucket}:rate`, isProbe ? config.probeRatePerMin : config.ratePerMin, now);
    if (!rate.ok) {
      logReject(endpoint, 'rate', bucket, 429, rate.count);
      rejectJson(res, 429, 'rate_limited', '请求过于频繁，请稍后再试', rate.retryAfterSec);
      return;
    }

    // 2. 每桶每日额度（探针独立小额度）。注意：这里只计「请求数」用于抗滥用，
    //    全局每日 GLM 真实调用预算（dailyGlobal）由 glmChat() 在 fetch 上游前统一 consume，
    //    400/413/未配置/classify 不走 GLM 的请求不计入真实调用额度。
    const daily = bumpDay(`${bucket}:day`, isProbe ? config.probeDaily : config.dailyPerBucket, now);
    if (!daily.ok) {
      logReject(endpoint, 'daily_bucket', bucket, 429, daily.count);
      rejectJson(res, 429, 'daily_quota_exceeded', '今日调用额度已用完，请明天再试', daily.retryAfterSec);
      return;
    }

    // 3. 并发（桶级 + 全局）
    const bucketConcKey = `${bucket}:conc`;
    if (!tryAcquireConcurrency(bucketConcKey, config.concurrencyPerBucket)) {
      logReject(endpoint, 'concurrency_bucket', bucket, 429, config.concurrencyPerBucket);
      rejectJson(res, 429, 'too_many_concurrent', '请求并发过高，请稍后再试', 2);
      return;
    }
    if (!tryAcquireConcurrency('global:conc', config.concurrencyGlobal)) {
      releaseConcurrency(bucketConcKey);
      logReject(endpoint, 'concurrency_global', bucket, 429, config.concurrencyGlobal);
      rejectJson(res, 429, 'too_many_concurrent', '服务繁忙，请稍后再试', 2);
      return;
    }

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      releaseConcurrency(bucketConcKey);
      releaseConcurrency('global:conc');
    };
    res.on('finish', settle);
    res.on('close', settle);

    next();
  };
}

function logReject(endpoint: string, limit: string, bucket: string, status: number, count: number): void {
  // 桶已哈希：绝不输出完整 IP / 正文 / token / 密钥
  console.log(`[abuse-guard] endpoint=${endpoint} limit=${limit} bucket=${bucket} status=${status} count=${count}`);
}

// ---------- 全局每日 GLM 真实调用预算（由 glmChat() 在 fetch 上游前 consume） ----------

/**
 * 消耗一次全局每日 GLM 调用预算（config.dailyGlobal）。
 * 唯一调用点是 glmChat()（所有 GLM 上游请求的公共入口），保证：
 * - 请求级拒绝（429/413/400）、GLM 未配置、classify 元数据命中等
 *   「不会真正调用 GLM」的路径绝不消耗全局额度；
 * - consume 成功后才 fetch 上游——上游失败也算一次 attempt；
 * - 额度耗尽在 fetch 之前抛出（零上游调用），含轮换探针在内的所有调用方诚实失败。
 */
export function consumeGlmCallBudget(): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  maybeSweepStale(now);
  const r = bumpDay('global:day', config.dailyGlobal, now);
  return { ok: r.ok, retryAfterSec: r.retryAfterSec };
}

// ---------- stale bucket GC（低复杂度 TTL 清扫，防唯一 IP 撑爆内存） ----------

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** 超过该规模立即清扫，不等间隔（恶意唯一 IP 洪峰兜底） */
const SWEEP_SIZE_THRESHOLD = 4096;
let lastSweepAt = 0;

/** 清扫过期桶：分钟窗保留 2 分钟内的；日计数只保留今天（global:day 由 bumpDay 按日翻新）。 */
export function sweepStaleBuckets(now: number): void {
  const today = dayKeyUtc(now);
  for (const [k, w] of minuteWindows) {
    if (now - w.winStart > 2 * 60000) minuteWindows.delete(k);
  }
  for (const [k, d] of dayCounters) {
    if (k !== 'global:day' && d.day !== today) dayCounters.delete(k);
  }
  lastSweepAt = now;
}

function maybeSweepStale(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS && minuteWindows.size + dayCounters.size < SWEEP_SIZE_THRESHOLD) {
    return;
  }
  sweepStaleBuckets(now);
}

// ---------- 内容校验（413/400，全部发生在 GLM 上游调用之前） ----------

export interface BatchItem {
  id: string;
  text: string;
  core?: string;
  bookType?: string;
}

/**
 * 批量文本接口（ai-titles / knowledge-points）的 items 校验：
 * - 非数组 / 单项缺正文 → 400；
 * - 超过 item 数上限 → 400（合法客户端上限 8/6，超限即异常流量）；
 * - 单项文本超长 → 截断（与历史行为一致，避免长单元整批失败）；
 * - 截断后总字符数超上限 → 413。
 * 全部拒绝发生在 GLM 上游调用之前。
 */
export function validateBatchItems(
  body: unknown,
  endpoint: 'ai-titles' | 'knowledge-points',
): { status: 400 | 413 | null; items: BatchItem[] | null; message?: string } {
  const maxItems = endpoint === 'ai-titles' ? config.aiTitlesMaxItems : config.kpMaxItems;
  const itemChars = endpoint === 'ai-titles' ? config.aiTitlesItemChars : config.kpItemChars;
  const totalChars = endpoint === 'ai-titles' ? config.aiTitlesTotalChars : config.kpTotalChars;
  const itemsRaw = (body as { items?: unknown } | null ?? {}).items;
  if (!Array.isArray(itemsRaw)) {
    return { status: 400, items: null, message: 'items 必须是数组' };
  }
  if (itemsRaw.length > maxItems) {
    return { status: 400, items: null, message: `一次最多 ${maxItems} 条` };
  }
  const cleaned: BatchItem[] = [];
  let total = 0;
  for (let i = 0; i < itemsRaw.length; i++) {
    const o = (itemsRaw[i] ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.slice(0, itemChars) : '';
    if (!text.trim()) {
      return { status: 400, items: null, message: '存在缺少正文的条目' };
    }
    total += text.length;
    const core = typeof o.coreSentence === 'string' ? o.coreSentence.slice(0, 200) : undefined;
    const bookType = typeof o.bookType === 'string' ? o.bookType.slice(0, 40) : undefined;
    if (core) total += core.length;
    cleaned.push({ id: String(o.id ?? i), text, core, bookType });
  }
  if (total > totalChars) {
    return { status: 413, items: null, message: '请求文本总量超出限制' };
  }
  return { status: null, items: cleaned };
}
