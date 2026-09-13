/**
 * 章节完成轻提示（P0：给「刷」一个阶段感，但不做成游戏化系统）
 *
 * 触发规则（deterministic，无 AI）：
 * - 某章已读覆盖率达到 90%，或
 * - 本次读的内容包含该章最后一个节点（读到章尾）。
 * 每章每个 app 会话只提示一次；提示为非阻断 toast，4 秒后自动消失。
 * 提示文案所需信息（章标题 / 覆盖率）只存原始数据，翻译在组件层完成。
 *
 * 注意：本模块不反向依赖 store（避免循环导入）——调用方（store.addReadRanges）
 * 把刚合并好的 readRanges 传入，这里只做只读计算。
 */
import { create } from 'zustand';
import type { ReadRange, SourceDocument } from '../types';
import { getDocument } from './db';
import { buildRangesByChapter, mergeReadRanges } from './readState';
import { dfLog } from './dogfood';

export interface CompletionToastData {
  /** 去重/动画 key */
  key: string;
  chapterTitle: string;
  pct: number;
}

interface CompletionToastState {
  toast: CompletionToastData | null;
  show: (data: Omit<CompletionToastData, 'key'>) => void;
  clear: () => void;
}

let hideTimer: ReturnType<typeof setTimeout> | null = null;

export const useCompletionToast = create<CompletionToastState>((set) => ({
  toast: null,
  show: (data) => {
    if (hideTimer) clearTimeout(hideTimer);
    set({ toast: { ...data, key: `${Date.now()}` } });
    hideTimer = setTimeout(() => set({ toast: null }), 4200);
  },
  clear: () => {
    if (hideTimer) clearTimeout(hideTimer);
    set({ toast: null });
  },
}));

/** 已提示过的章节（bookId::chapterId → 本次会话提示时的覆盖率），每会话一次 */
const toasted = new Map<string, number>();
/** 文档缓存：章节完成度计算需要章内节点总数，按书缓存避免反复读 IndexedDB */
const docCache = new Map<string, Promise<SourceDocument | undefined>>();

/** 完成判定阈值：章内已读覆盖率达到该比例视为「本章基本读完」 */
export const CHAPTER_COMPLETE_PCT = 0.9;

function chapterTitleOf(doc: SourceDocument | undefined, chapterId: string): string {
  return doc?.chapters.find((c) => c.id === chapterId)?.title ?? '';
}

/**
 * 检查某书被本次阅读触达的章节是否达到「完成」状态；达到则弹一次轻提示。
 * 只读不写（readRanges 事实层由调用方先行写入），任何异常静默。
 *
 * @param touched 章节内本次读到的最大节点下标
 * @param readRanges 该书刚合并好的完整已读区间（Canonical Source 坐标）
 */
export async function checkChapterCompletion(
  bookId: string,
  touched: Map<string, number>,
  readRanges: ReadRange[],
): Promise<void> {
  try {
    if (!bookId || touched.size === 0) return;
    let docP = docCache.get(bookId);
    if (!docP) {
      docP = getDocument(bookId);
      docCache.set(bookId, docP);
    }
    const doc = await docP;
    if (!doc) return;
    const byChapter = buildRangesByChapter(mergeReadRanges(readRanges));
    for (const [chapterId, maxNode] of touched) {
      const chapter = doc.chapters.find((c) => c.id === chapterId);
      if (!chapter || chapter.nodes.length === 0) continue;
      const covered = byChapter.get(chapterId)?.reduce(
        (sum, r) => sum + r.endNode - r.startNode + 1,
        0,
      ) ?? 0;
      const pct = Math.min(1, covered / chapter.nodes.length);
      const lastNodeIndex = chapter.nodes[chapter.nodes.length - 1]?.index ?? -1;
      const reachedEnd = maxNode >= lastNodeIndex;
      if (pct < CHAPTER_COMPLETE_PCT && !reachedEnd) continue;
      const key = `${bookId}::${chapterId}`;
      const prev = toasted.get(key);
      // 已提示过且覆盖率没有从「基本读完」变成「全部读完」时不再打扰
      if (prev !== undefined && !(pct >= 1 && prev < 1)) continue;
      toasted.set(key, pct);
      const title = chapterTitleOf(doc, chapterId);
      dfLog('chapter_complete', { bookId, chapterId, pct: Math.round(pct * 100) });
      useCompletionToast.getState().show({ chapterTitle: title, pct: Math.round(pct * 100) });
    }
  } catch {
    /* 轻提示失败静默 */
  }
}
