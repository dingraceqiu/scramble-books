/**
 * Dogfood 阅读行为日志（本地优先，仅用于产品验证，绝不上传）
 *
 * 目的：用真实使用数据回答「这个阅读工具到底好不好用」，而不是凭感觉设计。
 * 记录维度（P0 最小集）：session 开始/结束、Feed 卡片浏览与快速跳过、
 * Feed→Reader 次数、Reader 打开位置与时长、新增已读区间、Study/Quiz 进入、
 * AI 标题是否在展示（generator 字段）、章节完成提示。
 *
 * 存储：IndexedDB kv store 单键（dogfood:events），环形上限内追加；
 * 不进云端快照（kv 业务键不参与 replaceAllData）。提供导出 JSON。
 */
import { getKv, setKv } from './db';

export type DogfoodEvent = { t: number; type: string } & Record<string, unknown>;

/** 环形上限：超过后丢弃最旧事件（私人 dogfood 足够多次会话） */
export const DOGFOOD_CAP = 5000;
const KV_KEY = 'dogfood:events';
/** 低于该驻留时长的卡片浏览视为「快速跳过」 */
export const QUICK_SKIP_MS = 1500;

/** 纯函数：追加事件并执行环形上限（供测试与运行时共用） */
export function appendEvent(list: DogfoodEvent[], ev: DogfoodEvent, cap = DOGFOOD_CAP): DogfoodEvent[] {
  const next = [...list, ev];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** 纯函数：是否快速跳过 */
export function isQuickSkip(dwellMs: number): boolean {
  return dwellMs < QUICK_SKIP_MS;
}

export interface DogfoodSummary {
  totalEvents: number;
  sessions: number;
  cardViews: number;
  cardSkips: number;
  skipRate: number | null;
  feedToReader: number;
  readerOpens: number;
  readRangeAdds: number;
  nodesRead: number;
  studyOpens: number;
  quizStarts: number;
  quizAnswers: number;
  chapterCompletions: number;
  aiTitleViews: number;
  mockTitleViews: number;
}

/** 纯函数：从事件流汇总出一次 dogfood 体检结果 */
export function summarize(events: DogfoodEvent[]): DogfoodSummary {
  const s: DogfoodSummary = {
    totalEvents: events.length,
    sessions: 0,
    cardViews: 0,
    cardSkips: 0,
    skipRate: null,
    feedToReader: 0,
    readerOpens: 0,
    readRangeAdds: 0,
    nodesRead: 0,
    studyOpens: 0,
    quizStarts: 0,
    quizAnswers: 0,
    chapterCompletions: 0,
    aiTitleViews: 0,
    mockTitleViews: 0,
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'app_open':
        s.sessions++;
        break;
      case 'feed_card_viewed': {
        s.cardViews++;
        if (ev.quickSkip === true) s.cardSkips++;
        if (typeof ev.generator === 'string') {
          if (ev.generator.startsWith('mock')) s.mockTitleViews++;
          else s.aiTitleViews++;
        }
        break;
      }
      case 'feed_open_reader':
        s.feedToReader++;
        break;
      case 'reader_open':
        s.readerOpens++;
        break;
      case 'read_ranges_added':
        s.readRangeAdds++;
        s.nodesRead += typeof ev.nodes === 'number' ? ev.nodes : 0;
        break;
      case 'study_open':
        s.studyOpens++;
        break;
      case 'quiz_start':
        s.quizStarts++;
        break;
      case 'quiz_answer':
        s.quizAnswers++;
        break;
      case 'chapter_complete':
        s.chapterCompletions++;
        break;
    }
  }
  if (s.cardViews > 0) s.skipRate = s.cardSkips / s.cardViews;
  return s;
}

// ---------- 运行时（浏览器内） ----------

let buffer: DogfoodEvent[] | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sessionId = '';

/** 内存缓存加载（首个事件时懒加载一次） */
async function ensureBuffer(): Promise<DogfoodEvent[]> {
  if (buffer) return buffer;
  try {
    const saved = await getKv<DogfoodEvent[]>(KV_KEY);
    buffer = Array.isArray(saved) ? saved : [];
  } catch {
    buffer = [];
  }
  return buffer;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, 2000);
}

async function flushNow(): Promise<void> {
  if (!buffer) return;
  try {
    await setKv(KV_KEY, buffer);
  } catch {
    /* 存储失败静默：日志不能影响阅读 */
  }
}

/** 记录一条事件（永不抛错：日志失败不影响阅读主流程） */
export function dfLog(type: string, fields: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const ev: DogfoodEvent = { t: Date.now(), type, sessionId, ...fields };
  void ensureBuffer()
    .then((list) => {
      buffer = appendEvent(list, ev);
      scheduleFlush();
    })
    .catch(() => {});
}

/**
 * 开启一个 dogfood session：记录 app_open（含阅读连续性信息）并挂载
 * 关闭/切后台时的 session_end 上报。多次调用幂等。
 */
export function beginDogfoodSession(continuity: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  if (sessionId) return;
  sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();
  dfLog('app_open', continuity);

  const endSession = () => {
    if (!sessionId) return;
    dfLog('session_end', { durationMs: Date.now() - startedAt });
    sessionId = '';
    // 退出前立即落盘（pagehide 里异步事务可能被截断，尽力而为）
    void flushNow();
  };
  window.addEventListener('pagehide', endSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endSession();
  });
}

/** 导出 JSON（开发者查看用）：事件流 + 汇总 */
export async function exportDogfoodJson(): Promise<string> {
  const list = await ensureBuffer();
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), summary: summarize(list), events: list },
    null,
    2,
  );
}

/** 供调试面板/控制台快速查看的汇总 */
export async function dogfoodSummary(): Promise<DogfoodSummary> {
  const list = await ensureBuffer();
  return summarize(list);
}
