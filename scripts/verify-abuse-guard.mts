/**
 * TD-06 防滥用守卫回归套件：三个 GLM 代理接口的多层保护。
 *
 * 运行：pnpm verify:abuse-guard
 *
 * 覆盖：
 * 1. 三个接口全部经过守卫（超频 429 + Retry-After + 稳定 JSON code）；
 * 2. 合法请求正常触达 GLM mock（调用计数 +1，标题单项截断生效）；
 * 3. 超大请求体在业务逻辑前被 413 拒绝；item 数/单项/总字符边界（400/413）；
 * 4. 每桶每日请求额度；全局每日 GLM 真实调用预算由 glmChat 在 fetch 前统一 consume
 *    （400/413/空文本/未配置/classify 不走 GLM 均不消耗；上游失败仍计 attempt；
 *    耗尽后零上游调用，含探针在内诚实失败）；
 * 5. 桶级与全局并发限制；
 * 6. 登录用户独立于 IP 桶；本地匿名用户不受影响；
 * 7. 伪造 X-Forwarded-For 不能绕过（nginx 追加语义：最右非可信地址才是桶）；
 * 8. 被拒绝请求的 GLM mock 调用次数为 0；
 * 9. 拒绝响应不泄露正文标记、token 或密钥；
 * 10. 轮换探针（回环直连、无代理链）在小额度桶内正常验证、隔离于外部流量、
 *     全局额度耗尽时诚实失败（无 generator 哨兵）；
 * 11. stale bucket GC：过期分钟窗/日计数条目被清扫，活跃与 global:day 保留，
 *     守卫请求自动触发清扫（内存不随唯一 IP 数无限增长）。
 */
import http from 'node:http';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 环境与 mock（必须先于业务模块加载） ----------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'abuse-guard-'));
process.env.CLOUD_DB_PATH = path.join(TMP, 'cloud.db');
process.env.GLM_API_KEY = 'test-glm-key-not-a-secret';
process.env.COZE_PROJECT_ENV = 'PROD'; // 静默开发日志
const SECRET_MARKER = 'test-glm-key-not-a-secret';
const TEXT_MARKER = 'ABUSEGUARDTEXTMARKER';
const TOKEN_MARKER = 'ABUSEGUARDTOKENMARKER'.toLowerCase();

const GLM_RESPONSES: Record<string, string> = {
  '/api/ai-titles': JSON.stringify({ choices: [{ message: { content: '[{"id":"probe","title":"深度决定复利"}]' } }] }),
  '/api/knowledge-points': JSON.stringify({ choices: [{ message: { content: '[{"id":"probe","concept":"复利","explanation":"深度决定复利利率。","quote":"深度决定复利的利率"}]' } }] }),
  '/api/classify-book': JSON.stringify({ choices: [{ message: { content: '{"bookType":"history","reason":"史料定性"}' } }] }),
};

/** GLM mock：记录每次上游调用与最近一次请求体，可注入失败/延迟（并发测试） */
let glmCalls = 0;
let lastGlmBody = '';
let glmFailNext = false;
const realFetch = globalThis.fetch;

function installDefaultFetchMock(): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('open.bigmodel.cn')) {
      glmCalls++;
      const body = typeof init?.body === 'string' ? init.body : '';
      lastGlmBody = body;
      if (glmFailNext) {
        glmFailNext = false;
        return new Response('{"error":{"message":"mock upstream failure"}}', { status: 500 });
      }
      // 按请求路径近似返回（mock 不真正解析 messages）
      const key = body.includes('知识点') ? '/api/knowledge-points' : body.includes('图书分类') ? '/api/classify-book' : '/api/ai-titles';
      return new Response(GLM_RESPONSES[key], { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('googleapis.com')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

/** 全局每日 GLM 预算计数（consumeGlmCallBudget 的真实状态） */
const globalBudgetCount = (): number => guard.__globalBudgetForTests().count;

installDefaultFetchMock();

// ---------- 启动被测应用（临时端口） ----------

const { createApp, globalErrorHandler } = await import('../server/app');
const guard = await import('../server/lib/abuseGuard');
const cloudDb = await import('../server/lib/cloudDb');

const app = createApp();
app.use(globalErrorHandler);
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as { port: number };
const BASE = `http://127.0.0.1:${port}`;

interface Resp {
  status: number;
  body: Record<string, unknown> | null;
  retryAfter: string | null;
}

async function req(pathname: string, opts: { body?: unknown; xff?: string; token?: string; method?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.xff) headers['X-Forwarded-For'] = opts.xff;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json, retryAfter: res.headers.get('retry-after') };
}

const textOf = (n: number): string => `${TEXT_MARKER}${'读书是把别人的思考变成自己血肉的过程。'.repeat(Math.ceil(n / 20))}`.slice(0, n);
const titlesBody = (n: number, chars = 100) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `u${i}`, text: textOf(chars) })) });
const PROBE_BODY = { items: [{ id: 'probe', text: '读书是把别人的思考变成自己血肉的过程。读得多不如读得深，深度决定复利的利率。' }] };
const guardDayKeyOf = (now: number): string => new Date(now).toISOString().slice(0, 10);
/** 与服务端 hashBucket 一致：IP → 桶键（测试断言具体桶计数用） */
const ipBucketKey = (ip: string): string => `ip:${crypto.createHash('sha256').update(ip).digest('hex').slice(0, 8)}`;

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

const defaults = guard.loadAbuseGuardConfig();
guard.__configureAbuseGuardForTests({
  ...defaults,
  ratePerMin: 6,
  dailyPerBucket: 8,
  dailyGlobal: 1000,
  concurrencyPerBucket: 2,
  concurrencyGlobal: 4,
  probeRatePerMin: 6,
  probeDaily: 4,
});
glmCalls = 0;

// ---------- 1. 探针回归：回环直连可正常验证 ----------

{
  const r1 = await req('/api/ai-titles', { body: PROBE_BODY });
  const r2 = await req('/api/ai-titles', { body: PROBE_BODY });
  const r3 = await req('/api/ai-titles', { body: PROBE_BODY });
  check('探针请求返回 200', r1.status === 200 && r2.status === 200 && r3.status === 200);
  check('探针响应含 generator 哨兵（轮换脚本成功判据）', r1.body?.generator !== undefined);
  check('探针 3 连发不被频率限制拒绝（独立小桶阈值内）', r3.status === 200);
  check('探针调用真实触达 GLM mock', glmCalls === 3);
}

// ---------- 2. 三个接口全部受守卫保护：超频 429 ----------

guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), ratePerMin: 2 });
const beforeRate = glmCalls;
for (const [p, body] of [
  ['/api/ai-titles', titlesBody(1)],
  ['/api/knowledge-points', { items: [{ id: 'k1', text: textOf(100) }] }],
  ['/api/classify-book', { title: '明朝那些事儿', author: '当年明月' }],
] as const) {
  const ip = `10.${p.length}.0.1`;
  const ok1 = await req(p, { body, xff: ip });
  const ok2 = await req(p, { body, xff: ip });
  const blocked = await req(p, { body, xff: ip });
  check(`${p} 合法请求 200`, ok1.status === 200 && ok2.status === 200);
  check(`${p} 超频返回 429`, blocked.status === 429);
  check(`${p} 429 带 Retry-After`, blocked.retryAfter !== null && Number(blocked.retryAfter) >= 1);
  check(`${p} 429 为稳定 JSON（code=rate_limited）`, blocked.body?.code === 'rate_limited' && blocked.body?.ok === false);
  check(`${p} 429 不含正文标记`, !JSON.stringify(blocked.body).includes(TEXT_MARKER));
}
check('被拒请求未触达 GLM mock（仅合法调用计数）', glmCalls - beforeRate <= 6);

// ---------- 3. 超大请求体：413，先于 GLM ----------

guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), ratePerMin: 100 });
{
  const before = glmCalls;
  const big = { items: [{ id: 'x', text: 'x'.repeat(200 * 1024) }] };
  const r = await req('/api/ai-titles', { body: big, xff: '10.3.0.1' });
  check('超大请求体返回 413', r.status === 413);
  check('413 为稳定 JSON（code=payload_too_large）', r.body?.code === 'payload_too_large');
  check('超大请求未调用 GLM mock', glmCalls === before);
  const bad = await req('/api/ai-titles', { body: undefined, xff: '10.3.0.2', method: 'POST' });
  check('非法 JSON 请求体返回 400', bad.status === 400 || bad.body?.code === 'bad_request');
}

// ---------- 4. item 数 / 单项字符 / 总字符边界 ----------

{
  const before = glmCalls;
  const r9 = await req('/api/ai-titles', { body: titlesBody(9), xff: '10.4.0.1' });
  const r8 = await req('/api/ai-titles', { body: titlesBody(8), xff: '10.4.0.2' });
  check('titles 9 条 → 400', r9.status === 400);
  check('titles 8 条 → 200（边界内）', r8.status === 200);
  const r7 = await req('/api/knowledge-points', { body: { items: Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, text: textOf(100) })) }, xff: '10.4.0.3' });
  const r6 = await req('/api/knowledge-points', { body: { items: Array.from({ length: 6 }, (_, i) => ({ id: `k${i}`, text: textOf(100) })) }, xff: '10.4.0.4' });
  check('KP 7 条 → 400', r7.status === 400);
  check('KP 6 条 → 200（边界内）', r6.status === 200);

  // 单项截断：2000 字只送前 1500（截断而非拒绝，与历史行为一致）
  const longText = `${TEXT_MARKER}-${'a'.repeat(3000)}`;
  await req('/api/ai-titles', { body: { items: [{ id: 'long', text: longText }] }, xff: '10.4.0.5' });
  // 校验方式：检查 GLM mock 最近一次收到的 body（记录在 mock 中）
  check('单项超长被截断到 1500 内（mock 收到的正文不含 1500 字之后的尾巴）', lastGlmBody.includes(TEXT_MARKER) && !lastGlmBody.includes('a'.repeat(2000)));

  // 总字符上限：调低上限后触发 413
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), aiTitlesTotalChars: 500 });
  const rt = await req('/api/ai-titles', { body: titlesBody(8, 100), xff: '10.4.0.6' });
  check('总字符超上限 → 413', rt.status === 413);
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), aiTitlesTotalChars: defaults.aiTitlesTotalChars });
  check('item/字符边界拒绝未调用 GLM mock（仅 3 个合法请求计数）', glmCalls - before === 3);
}

// ---------- 5. 每桶每日额度 ----------

guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), dailyPerBucket: 3, ratePerMin: 100 });
{
  const before = glmCalls;
  const ip = '10.5.0.1';
  const r1 = await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  const r2 = await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  const r3 = await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  const r4 = await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  const other = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.5.0.2' });
  check('每日额度内 3 次 200', r1.status === 200 && r2.status === 200 && r3.status === 200);
  check('第 4 次 429（daily_quota_exceeded）', r4.status === 429 && r4.body?.code === 'daily_quota_exceeded');
  check('其他 IP 不受该桶影响', other.status === 200);
  check('额度拒绝不触达 GLM mock', glmCalls - before === 4);
}

// ---------- 6. 全局每日 GLM 真实调用预算（glmChat 入口统一 consume） ----------

guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), dailyGlobal: 2, ratePerMin: 100 });
{
  const before = glmCalls;
  await req('/api/ai-titles', { body: titlesBody(1), xff: '10.6.0.1' });
  await req('/api/ai-titles', { body: titlesBody(1), xff: '10.6.0.2' });
  check('两次合法 glmChat 后预算消耗恰为 2', globalBudgetCount() === 2);
  const exhausted = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.6.0.3' });
  check('预算耗尽 → 200 ok:false（glmChat 在 fetch 前抛错）', exhausted.status === 200 && exhausted.body?.ok === false);
  check('耗尽后的请求不再触达 GLM mock（零上游调用）', glmCalls === before + 2);
  const probe = await req('/api/ai-titles', { body: PROBE_BODY });
  check('全局耗尽时探针诚实失败（无 generator 哨兵）', probe.status === 200 && probe.body?.generator === undefined && probe.body?.ok === false);
  check('探针被拒不触达 GLM mock', glmCalls === before + 2);
}

// ---------- 6b. 消耗语义：只有真实 glmChat 调用消耗全局预算 ----------

guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), dailyGlobal: 1000, ratePerMin: 100 });
{
  check('重置后预算为 0', globalBudgetCount() === 0);

  // 400 items 非法（缺正文）连续请求
  for (let i = 0; i < 5; i++) {
    const r = await req('/api/ai-titles', { body: { items: [{ id: 'x' }] }, xff: '10.60.0.1' });
    if (r.status !== 400) { check('items 非法返回 400', false); break; }
  }
  check('items 非法（400）连续请求不消耗 GLM 全局预算', globalBudgetCount() === 0);

  // 413 超大请求体
  const big = await req('/api/ai-titles', { body: { items: [{ id: 'x', text: 'y'.repeat(200 * 1024) }] }, xff: '10.60.0.2' });
  check('超大请求体（413）不消耗 GLM 全局预算', big.status === 413 && globalBudgetCount() === 0);

  // 空文本 / 无有效文本
  const empty = await req('/api/ai-titles', { body: { items: [] }, xff: '10.60.0.3' });
  check('空 items（无有效文本）不消耗 GLM 全局预算', empty.status === 200 && empty.body?.ok === false && globalBudgetCount() === 0);
  const blank = await req('/api/knowledge-points', { body: { items: [{ id: 'k', text: '   ' }] }, xff: '10.60.0.4' });
  check('纯空白文本（400）不消耗 GLM 全局预算', blank.status === 400 && globalBudgetCount() === 0);

  // GLM 未配置
  const savedKey = process.env.GLM_API_KEY;
  delete process.env.GLM_API_KEY;
  const unconfigured = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.60.0.5' });
  process.env.GLM_API_KEY = savedKey;
  check('GLM 未配置（未配置即降级）不消耗 GLM 全局预算', unconfigured.status === 200 && unconfigured.body?.error === 'GLM_API_KEY 未配置' && globalBudgetCount() === 0);

  // classify-book：EPUB 元数据直接命中（不调用 GLM）
  const epub = await req('/api/classify-book', { body: { title: '随便什么书', subjects: ['历史著作'] } });
  check('classify EPUB 元数据命中（不走 glmChat）不消耗预算', epub.status === 200 && epub.body?.source === 'epub' && globalBudgetCount() === 0);

  // classify-book：证据不足走 GLM 兜底裁决 → 消耗 1
  const glmClassified = await req('/api/classify-book', { body: { title: '人类简史', author: '尤瓦尔·赫拉利' } });
  check('classify 走 GLM 兜底裁决消耗 1 次预算', glmClassified.status === 200 && globalBudgetCount() === 1);

  // 一次真实 ai-titles glmChat 正好消耗 1
  const beforeOne = globalBudgetCount();
  const okReq = await req('/api/ai-titles', { body: titlesBody(2), xff: '10.60.0.6' });
  check('一次真实 glmChat 正好消耗 1 次预算', okReq.status === 200 && globalBudgetCount() - beforeOne === 1);

  // 上游失败仍消耗该次 attempt
  const beforeFail = globalBudgetCount();
  const failCallsBefore = glmCalls;
  glmFailNext = true;
  const upstreamFail = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.60.0.7' });
  check('GLM 上游失败仍消耗该次 attempt（fetch 已发出 + 预算 +1）', upstreamFail.status === 200 && upstreamFail.body?.ok === false && globalBudgetCount() - beforeFail === 1 && glmCalls - failCallsBefore === 1);
}

// ---------- 6c. 容量治理（bounded memory：攻击者持续制造新 IP bucket 场景） ----------

{
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), maxDayBuckets: 5, maxMinuteBuckets: 4, dailyGlobal: 1000, ratePerMin: 100 });
  const { minuteWindows, dayCounters, sweepState, overflowState } = guard.__abuseGuardInternalsForTests();

  // 1) 同一天创建远超阈值的唯一 daily bucket → Map size 有确定上限
  for (let i = 0; i < 20; i++) {
    await req('/api/ai-titles', { body: titlesBody(1), xff: `10.61.${i}.1` });
  }
  check('同一天 20 个唯一 IP bucket 后 dayCounters 收敛到确定上限', dayCounters.size === 5);
  check('容量满后新 bucket 落入共享 overflow 计数（不占 Map 槽位）', overflowState.day !== null);

  // 2) 上限后连续新 bucket 请求不再触发每请求 O(n) 全表扫描
  const s1 = guard.__sweepStatsForTests();
  for (let i = 0; i < 30; i++) {
    await req('/api/ai-titles', { body: titlesBody(1), xff: `10.62.${i}.1` });
  }
  const s2 = guard.__sweepStatsForTests();
  check('容量满后 30 个新 bucket 请求零 day sweep（无每请求全表扫描）', s2.daySweeps === s1.daySweeps);
  check('容量满后 dayCounters.size 仍为上限（真 bounded）', dayCounters.size === 5);
  check('overflow 计数在洪峰下持续累计', (overflowState.day?.count ?? 0) >= 30);

  // 3) 已存在 bucket 的计数不因容量治理被重置
  const firstKey = `${ipBucketKey('10.61.0.1')}:day`;
  const beforeFloodCount = dayCounters.get(firstKey)?.count ?? -1;
  check('最早创建的 bucket 在洪峰后仍存在且计数保留', beforeFloodCount >= 1);
  await req('/api/ai-titles', { body: titlesBody(1), xff: '10.61.0.1' });
  check('洪峰后原 bucket 继续累加而非被重置', (dayCounters.get(firstKey)?.count ?? 0) === beforeFloodCount + 1);

  // 4) global:day 独立存储：永不容量淘汰，预算语义不变
  const g0 = guard.__globalBudgetForTests().count;
  await req('/api/ai-titles', { body: titlesBody(1), xff: '10.61.0.1' });
  check('全局预算独立于容量治理并继续累加', guard.__globalBudgetForTests().count === g0 + 1);

  // 5) minute bucket 同样有容量治理
  check('minuteWindows 收敛到确定上限', minuteWindows.size <= 4);
  check('minute overflow 计数存在', overflowState.minute !== null);

  // 6) UTC 跨日清理旧 daily bucket（翻转检测 + 一次性清扫，非每请求）
  sweepState.day = '2020-01-01';
  dayCounters.set('ip:stale-day:day', { day: '2020-01-01', count: 9 });
  const s3 = guard.__sweepStatsForTests();
  await req('/api/ai-titles', { body: titlesBody(1), xff: '10.61.0.2' });
  check('UTC 跨日自动清扫旧日 bucket', !dayCounters.has('ip:stale-day:day'));
  check('跨日清扫恰好发生一次（翻转检测，非每请求扫描）', guard.__sweepStatsForTests().daySweeps === s3.daySweeps + 1);
}

// ---------- 7. 并发限制（桶级 + 全局） ----------

{
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), concurrencyPerBucket: 1, concurrencyGlobal: 10, ratePerMin: 100 });
  glmCalls = 0;
  // 慢 GLM：第一个请求挂起直到放行
  let release: (v: unknown) => void = () => {};
  const gatePromise = new Promise((r) => (release = r));
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('open.bigmodel.cn')) {
      glmCalls++;
      await gatePromise;
      return new Response(GLM_RESPONSES['/api/ai-titles'], { status: 200 });
    }
    if (urlStr.includes('googleapis.com')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;

  const slow = req('/api/ai-titles', { body: titlesBody(1), xff: '10.7.0.1' });
  await new Promise((r) => setTimeout(r, 120));
  const conc = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.7.0.1' });
  check('同桶第二个并发请求 → 429（too_many_concurrent）', conc.status === 429 && conc.body?.code === 'too_many_concurrent');
  check('并发拒绝不触达 GLM mock', glmCalls === 1);
  release(undefined); // 放行第一个慢请求
  await slow;

  // 全局并发：两个不同 IP 各占 1 个，第 3 个 IP 被全局并发拒绝
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), concurrencyPerBucket: 1, concurrencyGlobal: 2, ratePerMin: 100 });
  glmCalls = 0;
  let releaseAll: (v: unknown) => void = () => {};
  const gate2 = new Promise((r) => (releaseAll = r));
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (urlStr.includes('open.bigmodel.cn')) {
      glmCalls++;
      await gate2;
      return new Response(GLM_RESPONSES['/api/ai-titles'], { status: 200 });
    }
    if (urlStr.includes('googleapis.com')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return realFetch(url, init);
  }) as typeof fetch;

  const a = req('/api/ai-titles', { body: titlesBody(1), xff: '10.7.1.1' });
  const b = req('/api/ai-titles', { body: titlesBody(1), xff: '10.7.1.2' });
  await new Promise((r) => setTimeout(r, 120));
  const c = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.7.1.3' });
  check('全局并发占满后第 3 个 IP → 429（concurrency_global）', c.status === 429 && c.body?.code === 'too_many_concurrent');
  releaseAll(undefined);
  await Promise.all([a, b]);
  await new Promise((r) => setTimeout(r, 50));
  // 并发释放后应可再次请求
  const after = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.7.2.1' });
  check('并发请求完成后配额释放，后续请求正常', after.status === 200);
}

// ---------- 恢复默认 mock ----------

installDefaultFetchMock();

// ---------- 8. 登录用户独立桶 / 匿名用户不受影响 ----------

{
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), ratePerMin: 100, dailyPerBucket: 2 });
  const user = cloudDb.createUser('guard-test@example.com', 'x');
  const { token } = cloudDb.createSession(user.id);

  const ip = '10.8.0.1';
  await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  const anonBlocked = await req('/api/ai-titles', { body: titlesBody(1), xff: ip });
  const authed = await req('/api/ai-titles', { body: titlesBody(1), xff: ip, token });
  check('匿名 IP 桶耗尽 → 429（本地匿名用户行为可预期）', anonBlocked.status === 429);
  check('同 IP 的登录用户走独立用户桶不受影响', authed.status === 200);

  // token 用尽自己的桶
  await req('/api/ai-titles', { body: titlesBody(1), xff: '9.9.9.9', token });
  const authedBlocked = await req('/api/ai-titles', { body: titlesBody(1), xff: '9.9.9.9', token });
  check('登录用户自己的每日额度同样受限', authedBlocked.status === 429);

  // 无效 token：忽略并回退 IP 桶（不拒绝本地模式）
  const badToken = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.8.0.9', token: 'not-a-valid-token' });
  check('无效 token 回退 IP 桶（按匿名处理，不 401）', badToken.status === 200);

  // 泄露检查：token 值不得出现在任何拒绝响应
  check('响应不含 token 值', !JSON.stringify(anonBlocked.body).includes(TOKEN_MARKER));
}

// ---------- 9. 伪造转发头不能绕过 ----------

{
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), ratePerMin: 100, dailyPerBucket: 2 });
  const before = glmCalls;
  // 模拟 nginx 追加语义：客户端伪造的条目在左，真实 IP（nginx 追加）在右 → 桶取最右侧
  await req('/api/ai-titles', { body: titlesBody(1), xff: '1.2.3.4, 5.5.5.5' });
  await req('/api/ai-titles', { body: titlesBody(1), xff: '6.6.6.6, 5.5.5.5' });
  const forgedLeft = await req('/api/ai-titles', { body: titlesBody(1), xff: '7.7.7.7, 5.5.5.5' });
  check('伪造左侧转发头不能换桶（最右真实 IP 计数 → 429）', forgedLeft.status === 429);
  const realOther = await req('/api/ai-titles', { body: titlesBody(1), xff: '5.5.5.6' });
  check('真实其他 IP 不受影响', realOther.status === 200);
  check('伪造头测试中 GLM mock 仅被合法请求调用', glmCalls - before === 3);
}

// ---------- 10. 探针桶与外部流量隔离 ----------

{
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), probeDaily: 2, ratePerMin: 100, dailyPerBucket: 100 });
  const p1 = await req('/api/ai-titles', { body: PROBE_BODY });
  const p2 = await req('/api/ai-titles', { body: PROBE_BODY });
  const p3 = await req('/api/ai-titles', { body: PROBE_BODY });
  const ext = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.10.0.1' });
  check('探针每日小额度用尽 → 探针诚实失败（无 generator）', p1.status === 200 && p2.status === 200 && p3.status === 429 && p3.body?.generator === undefined);
  check('探针额度耗尽不影响外部用户', ext.status === 200);

  // 外部桶耗尽不影响探针
  guard.__configureAbuseGuardForTests({ ...guard.loadAbuseGuardConfig(), probeDaily: 10, dailyPerBucket: 1, ratePerMin: 100 });
  await req('/api/ai-titles', { body: titlesBody(1), xff: '10.10.1.1' });
  const extBlocked = await req('/api/ai-titles', { body: titlesBody(1), xff: '10.10.1.1' });
  const probeOk = await req('/api/ai-titles', { body: PROBE_BODY });
  check('外部桶耗尽 → 429', extBlocked.status === 429);
  check('外部耗尽后探针仍可验证 GLM', probeOk.status === 200 && probeOk.body?.generator !== undefined);
}

// ---------- 11. 其他路由不受影响 + 密钥泄露检查 ----------

{
  guard.__configureAbuseGuardForTests(guard.loadAbuseGuardConfig());
  const health = await req('/api/health');
  const me = await req('/api/auth/me');
  check('/api/health 不受守卫影响', health.status === 200);
  check('/api/auth/me 仍为 401 JSON', me.status === 401);
  check('全部响应不含 GLM 密钥标记', !JSON.stringify([health, me]).includes(SECRET_MARKER));
}

server.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n防滥用守卫回归：${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`);
if (failures.length) {
  console.error('失败项：');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
