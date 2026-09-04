/**
 * Semantic Reading Unit 切分器（MVP 算法近似版）
 *
 * 切分宗旨（产品铁律）：
 * 一个单元 = 一个【完整的论点 / 案例 / 论证单元】。读者只刷到这一篇，
 * 也要知道作者在讲什么——禁止无头无脑的碎片。
 *
 * 为此两条硬规则：
 * 1. 宁可大而完整，不可短而破碎：软阈值 8 段 / 1400 字之后才允许在自然
 *    断点收束；硬上限 18 段 / 3200 字强制收束。
 * 2. 每一篇都自带章节标题：章内切出的后续单元会把章标题拼到正文开头
 *    （章标题本身就是 Canonical Source 的一个节点），保证任何一篇都有上下文。
 *
 * 切分启发式（可整体替换为未来的 AI 语义切分，接口保持不变）：
 * - 硬边界：章节边界、遇到新标题、列表块结束
 * - 软边界：段落数/字数达到软阈值后，遇句末收束标点、长论述段结尾则收束
 * - 标题归入紧随其后的单元
 */
import type { Chapter, ReadingUnit, SourceNode } from '../types';
import { estimateReadingMinutes, hashStr, uid } from './utils';
import { generateAiMeta, extractCoreSentence, getTargetLang } from './titleGen';
import { markFrontMatter, bodyChapters } from './frontmatter';

/** 软阈值：达到后允许在自然断点收束 */
const SOFT_PARAS = 10;
const SOFT_CHARS = 1800;
/** 硬上限：超过后必须收束 */
const HARD_PARAS = 22;
const HARD_CHARS = 3800;
/** 收束单元的最小篇幅：至少这么多段才允许「见到核心句就收」 */
const MIN_PARAS_EARLY_CLOSE = 4;
/** 达到软阈值后若还没出现明确核心句，最多再多取这么多段去补一个论点 */
const EXTEND_TOLERANCE_PARAS = 4;
/** 达到该长度的段落视为「论述充分」，可作为软边界 */
const LONG_PARA = 260;
/**
 * 最小正文长度：一个单元的正文（不含标题）至少要这么多字，否则视为「只有标题
 * 没有内容」的碎片，必须并入相邻单元，绝不单独进 Feed。
 */
const MIN_UNIT_BODY_CHARS = 120;
/** 章节合并阈值：整章正文少于这么多字时并入下一/上一正文章（小节标题页常见） */
const MIN_CHAPTER_BODY_CHARS = 80;
/** 句末收束标点 */
const CLOSING_PUNCT = /[。！？…」』”’.!?]["'”’』」]*$/;

interface RawUnit {
  chapter: Chapter;
  /** 章节内节点下标区间（闭区间，含可能的标题节点） */
  startNode: number;
  endNode: number;
  headingText?: string;
  nodes: SourceNode[];
}

/**
 * 判断刚收录段落后是否可以收束当前单元。
 * 核心思想：围绕「明确核心句」组织单元——有论点就收，没有就多取一段补论点。
 */
function isBoundaryAfter(
  cur: SourceNode,
  next: SourceNode | undefined,
  paraCount: number,
  charCount: number,
  bodyText: string,
): boolean {
  if (!next) return true;
  if (next.type === 'heading') return true;

  const reachedSoft = paraCount >= SOFT_PARAS || charCount >= SOFT_CHARS;
  const reachedHard = paraCount >= HARD_PARAS || charCount >= HARD_CHARS;
  const hasStrongCore = !!extractCoreSentence(bodyText);

  if (reachedHard) {
    return true; // 硬上限强制收束，避免无限膨胀
  }
  // 软阈值之前：已经有明确核心句 + 段落不再过于零碎 -> 论点完整，提前收束
  if (!reachedSoft) {
    return paraCount >= MIN_PARAS_EARLY_CLOSE && hasStrongCore && CLOSING_PUNCT.test(cur.text);
  }
  // 达到软阈值：没有明确核心句时容忍多取几段补一个论点（受硬上限兜底）
  if (!hasStrongCore) {
    return paraCount >= SOFT_PARAS + EXTEND_TOLERANCE_PARAS && CLOSING_PUNCT.test(cur.text);
  }
  // 已有明确核心句 + 软阈值之上：在自然断点收束
  if (cur.type === 'list' && next.type !== 'list') return true;
  if (cur.type === 'para' && cur.text.length >= LONG_PARA) return true;
  return CLOSING_PUNCT.test(cur.text);
}

function segmentChapter(chapter: Chapter): RawUnit[] {
  const units: RawUnit[] = [];
  const nodes = chapter.nodes;
  let i = 0;

  while (i < nodes.length) {
    let headingText: string | undefined;
    const start = i;

    // 标题归入本单元
    if (nodes[i].type === 'heading') {
      headingText = nodes[i].text;
      i++;
    }
    // 连续多个标题（小节标题页常见：章标题 + 小节标题），全部归入本单元
    while (i < nodes.length && nodes[i].type === 'heading') {
      i++;
    }

    let paraCount = 0;
    let charCount = 0;
    const bodyParts: string[] = [];
    while (i < nodes.length) {
      const node = nodes[i];
      if (node.type === 'heading') break; // 下一单元的标题
      paraCount++;
      charCount += typeof node.text === 'string' ? node.text.length : 0;
      bodyParts.push(node.text);
      i++;
      if (isBoundaryAfter(node, nodes[i], paraCount, charCount, bodyParts.join('\n\n'))) break;
    }

    if (paraCount === 0) {
      // 只有标题没有正文：标题节点并入下一单元（绝不单独成片）
      if (i >= nodes.length) {
        // 章节以标题结尾：挂到上一个单元
        if (units.length > 0) {
          const prev = units[units.length - 1];
          prev.nodes = [...prev.nodes, ...nodes.slice(start, i)];
          prev.endNode = i - 1;
        }
        // 整章纯标题（无正文）：交由 mergeTinyChapters 跨章处理
        else {
          units.push({ chapter, startNode: start, endNode: i - 1, headingText, nodes: nodes.slice(start, i) });
        }
      }
      // i 停在下一个 heading 上，下一轮循环自然归入下一单元
      continue;
    }
    units.push({
      chapter,
      startNode: start,
      endNode: i - 1,
      headingText,
      nodes: nodes.slice(start, i),
    });
  }

  // 章节尾部碎片单元（正文少于 3 段或低于最小正文字数）合并回上一单元，
  // 保证每篇都足够完整、绝不出「只有标题没有正文」的卡片
  while (units.length >= 2) {
    const last = units[units.length - 1];
    const prev = units[units.length - 2];
    const lastBodyChars = rawUnitBodyChars(last);
    const lastParaCount = last.nodes.filter((n) => n.type !== 'heading').length;
    if (lastParaCount < 3 || lastBodyChars < MIN_UNIT_BODY_CHARS) {
      prev.nodes = [...prev.nodes, ...last.nodes];
      prev.endNode = last.endNode;
      units.pop();
    } else break;
  }
  // 章节开头的碎片单元（典型：章首只有一个小节标题 + 极短引语）并入下一单元
  while (units.length >= 2) {
    const first = units[0];
    const second = units[1];
    const firstBodyChars = rawUnitBodyChars(first);
    if (firstBodyChars < MIN_UNIT_BODY_CHARS) {
      second.nodes = [...first.nodes, ...second.nodes];
      second.startNode = first.startNode;
      second.headingText = first.headingText ?? second.headingText;
      units.shift();
    } else break;
  }
  // 极端情况：整章只有一个碎片单元（纯标题章），保留它交由段级合并处理
  return units;
}

/** 计算 RawUnit 正文（不含标题节点）字符数 */
function rawUnitBodyChars(raw: RawUnit): number {
  return raw.nodes
    .filter((n) => n.type !== 'heading')
    .reduce((sum, n) => sum + (typeof n.text === 'string' ? n.text.length : 0), 0);
}

/** 章节正文（非标题节点）总字符数 */
function chapterBodyChars(chapter: Chapter): number {
  return chapter.nodes
    .filter((n) => n.type !== 'heading')
    .reduce((sum, n) => sum + (typeof n.text === 'string' ? n.text.length : 0), 0);
}

/**
 * 合并「小章」：解析器把小节标题（如「CHINAJOY 2007高峰论坛」）切成了独立章节，
 * 这些章只有标题、没有正文，会产出无内容卡片。把正文低于阈值的章并入相邻正文章：
 * 优先并入后一章（标题作为下一章内容的开头），末尾小章并入前一章。
 * 注意：返回的章只用于 Feed 切分（不改 Reader 的原章节结构）；搬运的节点保留其
 * 原章节 id 标记（`__ownerChapterId/Title`，非持久字段），供单元锚点正确归属。
 */
const NODE_OWNER_CHAPTER = Symbol('ownerChapter');

function mergeTinyChapters(chapters: Chapter[]): Chapter[] {
  if (chapters.length <= 1) return chapters;
  const withOwner = (c: Chapter): Chapter => ({
    ...c,
    nodes: c.nodes
      .filter((n) => n && (n.type === 'heading' || (typeof n.text === 'string' && n.text.trim().length > 0)))
      .map((n) => {
        const node = { ...n } as SourceNode & { [NODE_OWNER_CHAPTER]?: Chapter };
        if (!node[NODE_OWNER_CHAPTER]) node[NODE_OWNER_CHAPTER] = c;
        return node;
      }),
  });
  const merged: Chapter[] = chapters.map(withOwner);

  let changed = true;
  while (changed && merged.length >= 2) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (chapterBodyChars(merged[i]) >= MIN_CHAPTER_BODY_CHARS) continue;
      // 小章：优先向后合并（其标题通常引出下一章正文）；若是最后一章，向前合并
      if (i < merged.length - 1) {
        merged[i + 1] = { ...merged[i + 1], nodes: [...merged[i].nodes, ...merged[i + 1].nodes] };
      } else {
        merged[i - 1] = { ...merged[i - 1], nodes: [...merged[i - 1].nodes, ...merged[i].nodes] };
      }
      merged.splice(i, 1);
      changed = true;
      break;
    }
  }
  return merged;
}

/** 取节点归属的原章节（跨章搬运后用于锚点），默认 fallback */
function nodeOwner(node: SourceNode, fallback: Chapter): Chapter {
  return (node as SourceNode & { [NODE_OWNER_CHAPTER]?: Chapter })[NODE_OWNER_CHAPTER] ?? fallback;
}

function buildPreview(text: string): string {
  const plain = text.replace(/\s+/g, '');
  if (plain.length <= 160) return plain;
  const cut = plain.slice(0, 160);
  const lastStop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('；'));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut) + '…';
}

/**
 * 将整本书切分为 ReadingUnit 列表。
 * sourceText 由 Canonical Source 节点原文逐字拼接，AI 字段独立生成。
 */
export interface SegmentOptions {
  bookType?: import('../types').BookType;
  bookTitle?: string;
}

/**
 * 小说/虚构类切分：按叙事边界，一章一个单元（章节过长时在章内按场景软细分，
 * 但绝不跨章、不混用不同章节内容）。标题由 titleGen 产出故事钩子，
 * 这里负责按「全书阅读顺序」加「第X篇」序号前缀。
 */
function segmentFiction(bookId: string, chapters: Chapter[]): ReadingUnit[] {
  const units: ReadingUnit[] = [];
  let order = 0;

  for (const chapter of chapters) {
    const chapterHeading =
      chapter.nodes.find((n) => n.type === 'heading')?.text ?? chapter.title;
    // 章内单元（复用非小说切分，天然不跨章）；小说通常一章只切出 1 个
    const rawUnits = segmentChapter(chapter);

    for (const raw of rawUnits) {
      const bodyNodes = raw.nodes.filter((n) => n.type !== 'heading');
      const bodyText = bodyNodes.map((n) => n.text).join('\n\n');
      const sourceText = raw.nodes.map((n) => n.text).join('\n\n');

      const ai = generateAiMeta(bodyText || sourceText, hashStr(bookId + order), {
        bookType: 'fiction',
      });
      // 序号 X = 该单元在全书中的阅读顺序（从 1 起）；前缀跟随界面语言
      const episodePrefix = getTargetLang() === 'zh' ? `第${order + 1}篇 ` : `Ep.${order + 1} · `;
      const episodeTitle = ai.fictionEpisode
        ? `${episodePrefix}${ai.title}`
        : ai.title;

      units.push({
        id: uid('unit'),
        bookId,
        order,
        sourceStart: {
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          startNode: raw.startNode,
          endNode: raw.endNode,
        },
        sourceEnd: {
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          startNode: raw.startNode,
          endNode: raw.endNode,
        },
        headingText: raw.nodes[0]?.type === 'heading' ? raw.headingText : chapterHeading,
        sourceText,
        preview: buildPreview(bodyText || sourceText),
        coreSentence: ai.coreSentence,
        titleSupport: ai.titleSupport,
        ai: {
          title: episodeTitle,
          estimatedReadingMinutes: estimateReadingMinutes(sourceText),
          generator: ai.generator,
        },
      });
      order += 1;
    }
  }
  return units;
}

/**
 * 切分全书。
 * - 小说/虚构类（fiction）：一章一单元（追更连载），标题为「第X篇 + 故事钩子」。
 * - 其他类型：按语义完整论点切分（见 segmentChapter）。
 */
export function segmentBook(
  bookId: string,
  chapters: Chapter[],
  options?: SegmentOptions,
): ReadingUnit[] {
  // 标记前置非正文（版权页/目录/序言等），切分只从正文开始。
  // Reader 仍读完整 chapters；这里只决定哪些章进 Feed。
  markFrontMatter(chapters, options?.bookType);
  // 正文章：合并「只有标题/极短」的小章（小节标题被解析器误切成独立章节的情况），
  // 避免产出只有标题没有正文的卡片。仅用于 Feed 切分，不改 Reader 的原章节结构。
  const feedChapters = mergeTinyChapters(bodyChapters(chapters));

  // 小说/虚构类：按章节顺序连载，单元边界即叙事边界
  if (options?.bookType === 'fiction') {
    return segmentFiction(bookId, feedChapters).filter(
      (u) => u.sourceText.replace(/\s/g, '').length >= MIN_UNIT_BODY_CHARS,
    );
  }

  const units: ReadingUnit[] = [];
  let order = 0;
  const titleCtx = { bookType: options?.bookType, bookTitle: options?.bookTitle };

  for (const chapter of feedChapters) {
    const rawUnits = segmentChapter(chapter);
    const chapterHeading = chapter.nodes.find((n) => n.type === 'heading')?.text ?? chapter.title;

    for (const raw of rawUnits) {
      const startsWithHeading = raw.nodes[0]?.type === 'heading';
      const bodyText = raw.nodes.filter((n) => n.type !== 'heading').map((n) => n.text).join('\n\n');

      // 每一篇都自带章节标题：若本单元不是以章标题开头（章内后续单元），
      // 把章标题拼到正文最前，保证读者随时知道「这一篇在讲哪一章」。
      let sourceText: string;
      let headingText: string | undefined;
      if (startsWithHeading) {
        sourceText = raw.nodes.map((n) => n.text).join('\n\n');
        headingText = raw.headingText;
      } else {
        sourceText = `${chapterHeading}\n\n${raw.nodes.map((n) => n.text).join('\n\n')}`;
        headingText = chapterHeading;
      }

      // 跨章合并的小章：锚点定位到单元第一个节点真正所属的原章节
      const startOwner = raw.nodes[0] ? nodeOwner(raw.nodes[0], chapter) : chapter;
      const range = {
        chapterId: startOwner.id,
        chapterTitle: startOwner.title,
        startNode: raw.startNode,
        endNode: raw.endNode,
      };

      const ai = generateAiMeta(bodyText || sourceText, hashStr(bookId + order), titleCtx);
      // 最终防线：正文（不含标题）低于最小字数阈值的碎片单元不进 Feed
      const bodyChars = bodyText.replace(/\s/g, '').length;
      if (bodyChars < MIN_UNIT_BODY_CHARS) continue;

      units.push({
        id: uid('unit'),
        bookId,
        order: order++,
        headingText,
        sourceStart: range,
        sourceEnd: range,
        sourceText,
        preview: buildPreview(bodyText || sourceText),
        coreSentence: ai.coreSentence,
        titleSupport: ai.titleSupport,
        ai: {
          title: ai.title,
          estimatedReadingMinutes: estimateReadingMinutes(sourceText),
          generator: ai.generator,
        },
      });
    }
  }
  return units;
}

// ───────────────────────── Reader（连续阅读）辅助 ─────────────────────────

/**
 * 根据章节 id 与节点下标，找到该段落所属的阅读单元。
 * 同章内按 sourceStart.startNode / sourceEnd.endNode 区间匹配；找不到返回 null。
 */
export function unitAtNode(
  units: ReadingUnit[],
  chapterId: string,
  nodeIndex: number,
): ReadingUnit | null {
  const inChapter = units
    .filter((u) => u.sourceStart && u.sourceEnd && u.sourceStart.chapterId === chapterId)
    .sort((a, b) => a.sourceStart.startNode - b.sourceStart.startNode);
  for (const u of inChapter) {
    if (nodeIndex >= u.sourceStart.startNode && nodeIndex <= u.sourceEnd.endNode) {
      return u;
    }
  }
  // 章标题（index 0）若落在首个单元之前，归入该章第一个单元
  return inChapter[0] ?? null;
}

/** 找一本书最后读到的单元（用于「继续阅读」定位），没有则返回该书第一个单元 */
export function lastReadUnit(
  bookUnits: ReadingUnit[],
  readUnitIds: string[],
): ReadingUnit | null {
  const sorted = [...bookUnits].sort((a, b) => a.order - b.order);
  if (sorted.length === 0) return null;
  const read = new Set(readUnitIds);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (read.has(sorted[i].id)) return sorted[i];
  }
  return sorted[0];
}

/** 在某章的节点文本中，找到包含划线文本的节点下标（供 Reader 高亮包裹） */
export function findHighlightNode(
  chapter: Chapter,
  highlightText: string,
): number {
  const key = highlightText.replace(/\s+/g, '').slice(0, 12);
  if (!key) return -1;
  for (const n of chapter.nodes) {
    if (n.type === 'heading') continue;
    if (n.text.replace(/\s+/g, '').includes(key)) return n.index;
  }
  return -1;
}
