/**
 * 推荐系统（MVP 简化版）
 *
 * 基于两个维度的偏好打分，不使用标签：
 * - bookId 级：用户对某本书的显式反馈与收藏，聚合成书籍偏好分（bookScore）
 * - topic 级：以「章节主题」为 topic（归一化的章节标题），
 *   同一章内切出的阅读单元共享同一主题，反馈聚合成主题偏好分（topicScore）
 *
 * 其他信号：
 * - 已读内容强降权（避免重复推荐已读完的内容，但不藏起来）
 * - 收藏加权；单元级「多/少推荐」反馈加权
 * - 新鲜度随机分
 * - 贪心重排保证书籍多样性：同一本书不连续刷屏
 */
import type { BookType, Marks, ReadingUnit } from '../types';

export interface RecommendOptions {
  readUnitIds: Set<string>;
  marks: Marks;
  /** 过滤后的候选集（调用方负责筛选/搜索） */
  candidates?: ReadingUnit[];
  /** 已在 Feed 中展示的单元 id（下一篇时排除） */
  excludeIds?: Set<string>;
  limit?: number;
  /** unitId → 书籍类型（用于区分小说的顺序追更逻辑）；缺省按非小说处理 */
  bookTypeOf?: (u: ReadingUnit) => BookType | undefined;
  /**
   * 新鲜度洗牌种子。同一 seed 下排序完全确定：数据更新（同步/标题回写/进度变化）
   * 触发重算时卡片不再到处跳；只有 seed 变化（用户点「换一批」）才重新洗牌。
   */
  seed?: number;
}

/**
 * 归一化章节标题为主题 key。
 * 去掉「第一章 / 第1节 / Chapter 3」之类的序号与空白标点，保留主题文字；
 * 无法提取主题时退化为章节 id，保证同章单元仍聚在一起。
 */
export function topicKeyOf(u: ReadingUnit): string {
  const raw = u.sourceStart.chapterTitle ?? '';
  const stripped = raw
    .replace(/第\s*[0-9零一二三四五六七八九十百千]+\s*[章回节卷篇部分]/g, '')
    .replace(/chapter\s*\d+/gi, '')
    .replace(/[\s·•\-—_:：、，。.!！?？]/g, '')
    .trim();
  return stripped || u.sourceStart.chapterId || '';
}

/**
 * 由 (seed, unitId) 确定性导出 [0,1) 伪随机数（FNV-1a 变体）。
 * 用它代替 Math.random() 做新鲜度扰动：排序结果可复现，Feed 不会随机跳变。
 */
function unitNoise(seed: number, id: string): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function scoreUnit(u: ReadingUnit, read: Set<string>, marks: Marks, seed = 0): number {
  let s = unitNoise(seed, u.id) * 2; // 新鲜度扰动（确定性：随 seed 变化，不随重算变化）
  if (read.has(u.id)) s -= 30;
  if (marks.favorites[u.id]) s += 4;
  const fb = marks.unitFeedback[u.id];
  if (fb === 1) s += 3;
  if (fb === -1) s -= 8;
  // 书籍级偏好
  s += (marks.bookScore[u.bookId] || 0) * 2.5;
  // 主题（章节）级偏好
  s += (marks.topicScore[topicKeyOf(u)] || 0) * 2;
  return s;
}

/**
 * 贪心重排：按分数取候选，若与上一条同书且仍有其他书可选，则顺延，
 * 保证瀑布流中书籍混杂、有多样性。
 */
function diversify(ranked: ReadingUnit[]): ReadingUnit[] {
  const result: ReadingUnit[] = [];
  const remaining = [...ranked];
  let lastBookId = '';

  while (remaining.length > 0) {
    let pickIdx = 0;
    if (remaining[0].bookId === lastBookId) {
      const alt = remaining.findIndex((u) => u.bookId !== lastBookId);
      // 替补分数差距不大（<3）时优先换书，否则尊重分数
      if (alt > 0 && alt < 12) pickIdx = alt;
    }
    const [picked] = remaining.splice(pickIdx, 1);
    result.push(picked);
    lastBookId = picked.bookId;
  }
  return result;
}

/**
 * 小说的「下一篇」：同一本书中 order 最小的未读单元。
 * 硬规则——用户还没读第 N 篇，第 N+1 篇及以后绝不出现（防剧透）。
 * 已全部读完的书返回 null（不在 Feed 重复出现，除非用户主动重看）。
 */
function nextFictionEpisode(bookUnits: ReadingUnit[], read: Set<string>): ReadingUnit | null {
  const sorted = [...bookUnits].sort((a, b) => a.order - b.order);
  for (const u of sorted) {
    if (!read.has(u.id)) return u;
  }
  return null;
}

/**
 * Feed 推荐主入口。
 *
 * 两类内容共用同一条 Feed，但排序逻辑不同：
 * - 小说（fiction）：按顺序推进、追更驱动。每本小说最多只露出「下一篇」（硬顺序，
 *   不剧透）；用户正在追（已读过几篇）的小说，其下一篇优先级最高；多本小说交替。
 * - 社科/传记等非小说：随机发现、多样性、兴趣驱动（scoreUnit + diversify）。
 */
export function recommend(allUnits: ReadingUnit[], opts: RecommendOptions): ReadingUnit[] {
  const exclude = opts.excludeIds ?? new Set<string>();
  const read = opts.readUnitIds;
  const bookTypeOf =
    opts.bookTypeOf ?? ((u: ReadingUnit): BookType | undefined => (u as ReadingUnit & { _bt?: BookType })._bt);
  const base = (opts.candidates ?? allUnits).filter((u) => !exclude.has(u.id));

  // ── 小说：按书分组，每本只取「下一篇」未读（硬解锁顺序）────────────
  const byFictionBook = new Map<string, ReadingUnit[]>();
  const nonFiction: ReadingUnit[] = [];
  for (const u of base) {
    if (bookTypeOf(u) === 'fiction') {
      const arr = byFictionBook.get(u.bookId) ?? [];
      arr.push(u);
      byFictionBook.set(u.bookId, arr);
    } else {
      nonFiction.push(u);
    }
  }

  const following: ReadingUnit[] = []; // 正在追的小说（已读过至少 1 篇）
  const newNovels: ReadingUnit[] = []; // 新加入、尚未开始的小说
  for (const bookUnits of byFictionBook.values()) {
    const next = nextFictionEpisode(bookUnits, read);
    if (!next) continue; // 已读完
    const started = bookUnits.some((u) => read.has(u.id));
    (started ? following : newNovels).push(next);
  }
  // 追更中的小说排最前（多本追更交替，下方 merged 处理）；新小说稍后再露

  // ── 非小说：兴趣/多样性推荐 ──────────────────────────────────────
  const scoredNonFiction = diversify(
    nonFiction
      .map((u) => ({ u, s: scoreUnit(u, read, opts.marks, opts.seed ?? 0) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.u),
  );

  // ── 混合：追更的「下一篇」插到最前（多本追更可占前几条），其余交错 ──
  // 规则：前 following.length 条位置留给追更篇，但每两条追更之间插入非小说内容，
  // 避免连续都是小说；新小说与非小说一起按发现流排布。
  const merged: ReadingUnit[] = [];
  let fi = 0;
  let ni = 0;
  const discovery = [...newNovels, ...scoredNonFiction];
  // 追更篇优先，且与发现流交错
  while (fi < following.length || ni < discovery.length) {
    if (fi < following.length) {
      merged.push(following[fi]);
      fi++;
      // 追更篇之后插一条发现内容，保持混合节奏
      if (ni < discovery.length) {
        merged.push(discovery[ni]);
        ni++;
      }
    } else if (ni < discovery.length) {
      merged.push(discovery[ni]);
      ni++;
    }
  }

  return opts.limit ? merged.slice(0, opts.limit) : merged;
}

/** 阅读器「下一篇」：在当前队列中前进，队尾则实时推荐下一条 */
export function pickNext(
  allUnits: ReadingUnit[],
  queue: string[],
  currentId: string,
  readUnitIds: Set<string>,
  marks: Marks,
  bookTypeOf?: (u: ReadingUnit) => BookType | undefined,
): { nextId: string | null; queue: string[] } {
  const current = allUnits.find((u) => u.id === currentId);
  // 小说：严格按本书阅读顺序推进下一篇（不跳到随机推荐，防剧透）
  if (current && bookTypeOf?.(current) === 'fiction') {
    const seq = allUnits
      .filter((u) => u.bookId === current.bookId)
      .sort((a, b) => a.order - b.order);
    const pos = seq.findIndex((u) => u.id === currentId);
    const nextInBook = seq[pos + 1];
    if (nextInBook) {
      const newQueue = queue.includes(nextInBook.id) ? queue : [...queue, nextInBook.id];
      return { nextId: nextInBook.id, queue: newQueue };
    }
    // 本书读完：回到混合 Feed 推荐
  }

  const idx = queue.indexOf(currentId);
  if (idx >= 0 && idx + 1 < queue.length) {
    return { nextId: queue[idx + 1], queue };
  }
  const exclude = new Set(queue);
  exclude.add(currentId);
  const next = recommend(allUnits, { readUnitIds, marks, excludeIds: exclude, limit: 1, bookTypeOf });
  if (next.length === 0) {
    // 全部读完：放开已读限制再来一轮
    const fallback = recommend(allUnits, {
      readUnitIds: new Set(),
      marks,
      excludeIds: new Set([currentId]),
      limit: 1,
    });
    return { nextId: fallback[0]?.id ?? null, queue };
  }
  return { nextId: next[0].id, queue: [...queue, next[0].id] };
}
