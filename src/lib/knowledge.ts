/**
 * Learning Foundation：知识点抽取 / Level 1 测验 / Mastery 推导
 *
 * 数据铁律（对应产品构想）：
 * - Quiz 只能考已读内容：抽取资格从 readRanges 直接推导（readRanges → eligible Source
 *   Range → KP extraction → KP.sourceRanges → isKpEligible），不经过 ReadingUnit——
 *   同一 Canonical Source + 同一组 readRanges，无论切分如何变化，KP 资格与出题范围不变；
 * - KP 必须能回到原文：sourceRanges 记录来源；quote 必须逐字存在于原文，否则降级为无题 KP；
 * - AI 是编辑不是作者：GLM 只做抽取，quote 校验不过关就丢弃；GLM 不可用时本地兜底；
 * - Mastery 由 Attempts 推导，绝不存单一总分。
 */
import { apiUrl } from './cloudApi';
import { putKnowledgePoints } from './db';
import { isRangeCovered } from './readState';
import type { NodeSpan } from './readState';
import { extractCoreSentence } from './titleGen';
import { uid } from './utils';
import i18n from '../i18n';
import type {
  Chapter,
  KnowledgePoint,
  LearningLevel,
  QuizAttempt,
  ReadRange,
  SourceDocument,
} from '../types';

const KP_BATCH = 6;
/** 抽取窗口大小上限（软性控制 GLM 单次输入质量） */
const WINDOW_MAX_NODES = 12;
const WINDOW_MAX_CHARS = 2200;
/** 本地兜底抽取器标识（GLM 成功时为模型名） */
export const LOCAL_KP_GENERATOR = 'mock-kp-v1';

/** 防重入：同一本书同时只跑一个抽取任务 */
const inflight = new Set<string>();

function stripForCompare(s: string): string {
  return s.replace(/\s+/g, '').replace(/[「」『』“”"'‘’。！？!?，,、；;：:.…—-]/g, '');
}

/** quote 忠实度校验：必须是原文逐字摘录（去空白与标点后包含即视为逐字） */
function quoteInText(quote: string, text: string): boolean {
  const q = stripForCompare(quote);
  if (q.length < 6) return false;
  return stripForCompare(text).includes(q);
}

// ---------- 抽取窗口（readRanges 的直接投影，TD-01） ----------

/**
 * 知识点抽取窗口：由 readRanges 直接推导的一段已读原文（与 ReadingUnit 无关）。
 * text 是窗口内 SourceNode 原文逐字拼接（\n\n 连接），只作抽取输入，不落库。
 */
export interface KpWindow {
  chapterId: string;
  chapterTitle: string;
  startNode: number;
  endNode: number;
  text: string;
}

function makeWindow(chapter: Chapter, startNode: number, endNode: number): KpWindow {
  const nodes = chapter.nodes.slice(startNode, endNode + 1);
  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    startNode,
    endNode,
    text: nodes.map((n) => n.text).join('\n\n'),
  };
}

/**
 * 把已读区间切成抽取窗口：只依赖 Canonical Source 与区间本身，输入里没有 ReadingUnit——
 * 切分算法/书籍类型变化不会影响窗口集合（分割不变性的结构性保证）。
 * frontMatter 是 Canonical Source 的稳定属性（导入时判定），按它过滤同样不破坏不变性。
 */
export function buildExtractionWindows(doc: SourceDocument, ranges: ReadonlyArray<NodeSpan>): KpWindow[] {
  const byId = new Map(doc.chapters.map((c) => [c.id, c] as const));
  const windows: KpWindow[] = [];
  for (const range of ranges) {
    const chapter = byId.get(range.chapterId);
    if (!chapter || chapter.frontMatter) continue;
    let start = range.startNode;
    let count = 0;
    let charCount = 0;
    for (let i = range.startNode; i <= range.endNode; i++) {
      const text = typeof chapter.nodes[i]?.text === 'string' ? chapter.nodes[i].text : '';
      if (count > 0 && (count >= WINDOW_MAX_NODES || charCount + text.length > WINDOW_MAX_CHARS)) {
        windows.push(makeWindow(chapter, start, i - 1));
        start = i;
        count = 0;
        charCount = 0;
      }
      charCount += text.length;
      count += 1;
    }
    if (count > 0) windows.push(makeWindow(chapter, start, range.endNode));
  }
  // 全空节点的窗口不产 KP（避免对空白区域反复空转抽取）
  return windows.filter((w) => w.text.replace(/\s/g, '').length > 0);
}

// ---------- 知识点抽取 ----------

/**
 * 本地兜底抽取：用核心句当知识点（concept 取句子前段，quote 为原句）。
 * 语言跟随原文；质量弱于 GLM，但保证离线闭环可用。
 */
function localKnowledgePoint(bookId: string, window: KpWindow): KnowledgePoint | null {
  const body = window.text;
  const core = extractCoreSentence(body)?.text ?? body.split(/(?<=[。！？!?])/)[0] ?? '';
  const sentence = core.trim();
  if (sentence.length < 8) return null;
  const concept = sentence.replace(/[。！？!?…]+$/, '').slice(0, 20);
  return {
    id: uid('kp'),
    bookId,
    chapterId: window.chapterId,
    sourceRanges: [
      {
        chapterId: window.chapterId,
        chapterTitle: window.chapterTitle,
        startNode: window.startNode,
        endNode: window.endNode,
      },
    ],
    concept,
    explanation: sentence,
    quote: sentence,
    generatedBy: LOCAL_KP_GENERATOR,
    createdAt: Date.now(),
  };
}

interface ServerKp {
  id?: string;
  concept?: string;
  explanation?: string;
  quote?: string;
}

function windowKey(w: NodeSpan): string {
  return `${w.chapterId}#${w.startNode}-${w.endNode}`;
}

async function requestServerKps(
  batch: KpWindow[],
): Promise<Array<{ window: KpWindow; concept: string; explanation: string; quote?: string; generator: string }> | null> {
  try {
    const resp = await fetch(apiUrl('/api/knowledge-points'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: batch.map((w) => ({ id: windowKey(w), text: w.text.slice(0, 2500) })),
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { ok?: boolean; generator?: string; results?: ServerKp[] };
    if (!data.ok || !Array.isArray(data.results)) return null;
    const byKey = new Map(batch.map((w) => [windowKey(w), w] as const));
    const generator = data.generator || 'glm';
    const out: Array<{ window: KpWindow; concept: string; explanation: string; quote?: string; generator: string }> = [];
    for (const r of data.results) {
      const window = r?.id ? byKey.get(r.id) : undefined;
      if (!window || !r.concept?.trim() || !r.explanation?.trim()) continue;
      out.push({
        window,
        concept: r.concept.trim().slice(0, 40),
        explanation: r.explanation.trim().slice(0, 300),
        // quote 忠实度后校验：不是原文逐字摘录的一律丢弃（宁缺毋滥）
        quote: r.quote && quoteInText(r.quote, window.text) ? r.quote.trim().slice(0, 200) : undefined,
        generator,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 为一批抽取窗口生成知识点，分批执行，GLM 优先、本地兜底。
 * @param bookId 书 id
 * @param windows 抽取窗口（调用方用 subtractRanges(readRanges, 已有KP覆盖) 推导后传入，
 *                这里不再判定「是否已读」也看不到 ReadingUnit）
 * @param onSaved 每批落库后回调
 * @returns 本轮新增数量（该书有任务在跑时返回 null）
 */
export async function extractKnowledgePointsForBook(
  bookId: string,
  windows: KpWindow[],
  onSaved?: (saved: KnowledgePoint[]) => void,
): Promise<number | null> {
  if (inflight.has(bookId)) return null;
  const pending = windows.filter((w) => w.text.replace(/\s/g, '').length > 0);
  if (pending.length === 0) return 0;
  inflight.add(bookId);
  let created = 0;
  try {
    for (let i = 0; i < pending.length; i += KP_BATCH) {
      const batch = pending.slice(i, i + KP_BATCH);
      const serverResult = await requestServerKps(batch);
      const saved: KnowledgePoint[] = [];
      const handled = new Set<string>();
      if (serverResult && serverResult.length > 0) {
        for (const r of serverResult) {
          handled.add(windowKey(r.window));
          saved.push({
            id: uid('kp'),
            bookId,
            chapterId: r.window.chapterId,
            sourceRanges: [
              {
                chapterId: r.window.chapterId,
                chapterTitle: r.window.chapterTitle,
                startNode: r.window.startNode,
                endNode: r.window.endNode,
              },
            ],
            concept: r.concept,
            explanation: r.explanation,
            quote: r.quote,
            generatedBy: r.generator,
            createdAt: Date.now(),
          });
        }
      }
      // 服务端失败或某窗口没拿到结果 → 本地兜底，保证离线也有知识点
      for (const w of batch) {
        if (handled.has(windowKey(w))) continue;
        const kp = localKnowledgePoint(bookId, w);
        if (kp) saved.push(kp);
      }
      if (saved.length > 0) {
        await putKnowledgePoints(saved);
        created += saved.length;
        onSaved?.(saved);
      }
    }
  } finally {
    inflight.delete(bookId);
  }
  return created;
}

// ---------- Level 1 测验（Recall：识别原文表述） ----------

/**
 * 「只考已读」不变量（TD-03）：KP 的全部 sourceRanges 都被 readRanges 覆盖才算合格。
 * 未提供 readRangesByChapter 时视为不检查（兼容旧调用），Quiz 出题路径必须传入。
 */
export function isKpEligible(
  kp: KnowledgePoint,
  readRangesByChapter?: Map<string, ReadRange[]>,
): boolean {
  if (!readRangesByChapter) return true;
  return (kp.sourceRanges ?? []).every((r) =>
    isRangeCovered(readRangesByChapter.get(r.chapterId), r.startNode, r.endNode),
  );
}

/**
 * 为一个知识点生成 Level 1 识别题：四选一，找出作者原文表述。
 * 正确项 = quote（原文逐字摘录）；干扰项 = 其他知识点的 quote（优先同书）。
 * 铁律（TD-03 回归契约，见 scripts/verify-quiz-leakage.ts）：提供 readRangesByChapter
 * 时，题干 KP 与全部干扰项都必须通过「只考已读」检查——未读 Source 的文本不得进入
 * 题目的任何一个字段。quote 缺失的知识点不出题（保证每道题都能回到原文）。
 */
export function buildRecallQuestion(
  kp: KnowledgePoint,
  distractorPool: KnowledgePoint[],
  eligibility?: { readRangesByChapter?: Map<string, ReadRange[]> },
): {
  id: string;
  knowledgePointId: string;
  bookId: string;
  level: LearningLevel;
  question: string;
  options: string[];
  answerIndex: number;
  evidence: string;
} | null {
  if (!kp.quote) return null;
  const readRangesByChapter = eligibility?.readRangesByChapter;
  if (!isKpEligible(kp, readRangesByChapter)) return null;
  const pool = distractorPool.filter(
    (d) =>
      d.id !== kp.id &&
      d.quote &&
      isKpEligible(d, readRangesByChapter) &&
      stripForCompare(d.quote) !== stripForCompare(kp.quote!),
  );
  const sameBook = pool.filter((d) => d.bookId === kp.bookId);
  const picked: string[] = [];
  for (const d of [...sameBook, ...pool]) {
    if (picked.length >= 3) break;
    if (d.quote && !picked.some((p) => stripForCompare(p) === stripForCompare(d.quote!))) {
      picked.push(d.quote);
    }
  }
  if (picked.length < 3) return null;

  const options = [kp.quote, ...picked];
  // Fisher-Yates 洗牌（会话内随机即可，不影响任何持久数据）
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return {
    id: uid('q'),
    knowledgePointId: kp.id,
    bookId: kp.bookId,
    level: 1,
    question: i18n.t('quiz.recallQuestion', { concept: kp.concept }),
    options,
    answerIndex: options.indexOf(kp.quote),
    evidence: kp.quote,
  };
}

// ---------- Mastery（由 Attempts 推导，绝不存单一总分） ----------

export interface LevelMastery {
  level: LearningLevel;
  /** 作答次数 */
  attempts: number;
  /** 答对次数 */
  correct: number;
  /** 正确率 0~1；无作答为 null（未测量 ≠ 0 分） */
  rate: number | null;
  /** 最近一次作答时间 */
  lastAt: number;
}

/** 按层级聚合一本书（或全部书）的掌握度 */
export function masteryByLevel(attempts: QuizAttempt[], bookId?: string): Record<LearningLevel, LevelMastery> {
  const rows = bookId ? attempts.filter((a) => a.bookId === bookId) : attempts;
  const emptyRow = (): LevelMastery => ({ level: 1, attempts: 0, correct: 0, rate: null, lastAt: 0 });
  const out: Record<LearningLevel, LevelMastery> = {
    1: { ...emptyRow(), level: 1 },
    2: { ...emptyRow(), level: 2 },
    3: { ...emptyRow(), level: 3 },
    4: { ...emptyRow(), level: 4 },
  };
  for (const a of rows) {
    const m = out[a.level];
    if (!m) continue;
    m.attempts += 1;
    if (a.correct) m.correct += 1;
    m.lastAt = Math.max(m.lastAt, a.createdAt);
  }
  for (const m of Object.values(out)) {
    if (m.attempts > 0) m.rate = m.correct / m.attempts;
  }
  return out;
}

/** 某个知识点在某层级的掌握度（供「已掌握 N 个知识点」统计） */
export function kpMastery(attempts: QuizAttempt[], knowledgePointId: string, level: LearningLevel): LevelMastery {
  const rows = attempts.filter((a) => a.knowledgePointId === knowledgePointId && a.level === level);
  const correct = rows.filter((a) => a.correct).length;
  return {
    level,
    attempts: rows.length,
    correct,
    rate: rows.length > 0 ? correct / rows.length : null,
    lastAt: rows.reduce((m, a) => Math.max(m, a.createdAt), 0),
  };
}
