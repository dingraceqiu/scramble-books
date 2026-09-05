/**
 * Reading State（事实层）工具
 *
 * 架构铁律：Source 是事实层；ReadingUnit 是呈现层；Knowledge Point 是学习层。
 * 「我读过哪些原文」的事实记录是 ReadingProgress.readRanges（原文坐标系：
 * chapterId + 节点区间），Feed / Reader / 覆盖率 / Quiz 全部从这里推导。
 * ReadingProgress.readUnitIds 只是派生缓存（呈现层投影），不是事实来源。
 */
import type { ReadRange, ReadingUnit } from '../types';

/**
 * 合并已读区间：同章内重叠或相邻（next.start <= cur.end + 1）的区间并为一段；
 * via / at 取时间较新的一方。返回按 chapterId + startNode 排序的新数组。
 */
export function mergeReadRanges(ranges: ReadRange[]): ReadRange[] {
  const sorted = [...ranges]
    .filter((r) => r && typeof r.chapterId === 'string')
    .sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.startNode - b.startNode);
  const out: ReadRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.chapterId === r.chapterId && r.startNode <= last.endNode + 1) {
      last.endNode = Math.max(last.endNode, r.endNode);
      if ((r.at ?? 0) >= (last.at ?? 0)) {
        last.via = r.via;
        last.at = r.at;
      }
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** 按章分组（输入需已合并） */
export function buildRangesByChapter(ranges: ReadRange[]): Map<string, ReadRange[]> {
  const map = new Map<string, ReadRange[]>();
  for (const r of ranges) {
    const arr = map.get(r.chapterId);
    if (arr) arr.push(r);
    else map.set(r.chapterId, [r]);
  }
  return map;
}

/**
 * 判断 [start, end] 是否被已读区间完全覆盖（ranges 需同章内按 startNode 升序）。
 * 区间已合并时无空洞：遇到起点大于 start 的段仍盖不住，即存在未读缺口。
 */
export function isRangeCovered(
  chapterRanges: ReadRange[] | undefined,
  start: number,
  end: number,
): boolean {
  if (!chapterRanges || chapterRanges.length === 0) return false;
  for (const r of chapterRanges) {
    if (r.startNode > start) return false;
    if (r.endNode >= end) return true;
  }
  return false;
}

/** 一个单元覆盖的原文子区间列表（通常是一段；跨章合并单元为两段） */
export function unitSpans(unit: ReadingUnit): Array<{ chapterId: string; start: number; end: number }> {
  const st = unit.sourceStart;
  const en = unit.sourceEnd;
  if (!st || !en) return [];
  if (st.chapterId === en.chapterId) {
    return [{ chapterId: st.chapterId, start: st.startNode, end: en.endNode }];
  }
  return [
    { chapterId: st.chapterId, start: st.startNode, end: st.endNode },
    { chapterId: en.chapterId, start: en.startNode, end: en.endNode },
  ];
}

/** 单元是否已读 = 其 Source Range 被已读区间完全覆盖 */
export function isUnitRead(unit: ReadingUnit, byChapter: Map<string, ReadRange[]>): boolean {
  const spans = unitSpans(unit);
  if (spans.length === 0) return false;
  return spans.every((s) => isRangeCovered(byChapter.get(s.chapterId), s.start, s.end));
}

/** 已读区间 → 章节 → 已读节点下标集合（Reader 渲染 r-read 用） */
export function readNodeSetFromRanges(ranges: ReadRange[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const r of ranges) {
    let set = map.get(r.chapterId);
    if (!set) {
      set = new Set<number>();
      map.set(r.chapterId, set);
    }
    for (let n = r.startNode; n <= r.endNode; n++) set.add(n);
  }
  return map;
}

/**
 * 迁移：旧版 readUnitIds → readRanges。历史数据无法区分来源，统一记 via='feed'。
 * 只有仍能找到对应单元的 id 才能还原区间；重切分后失效的 id 直接丢弃。
 */
export function rangesFromUnits(
  bookUnits: ReadingUnit[],
  readUnitIds: string[],
  at: number,
): ReadRange[] {
  if (!readUnitIds || readUnitIds.length === 0) return [];
  const byId = new Map(bookUnits.map((u) => [u.id, u]));
  const ranges: ReadRange[] = [];
  for (const id of readUnitIds) {
    const u = byId.get(id);
    if (!u) continue;
    for (const s of unitSpans(u)) {
      ranges.push({ chapterId: s.chapterId, startNode: s.start, endNode: s.end, via: 'feed', at });
    }
  }
  return mergeReadRanges(ranges);
}

/** 由 readRanges 推导派生缓存：被完全覆盖的单元 id 列表 */
export function deriveReadUnitIds(bookUnits: ReadingUnit[], ranges: ReadRange[]): string[] {
  const byChapter = buildRangesByChapter(ranges);
  return bookUnits.filter((u) => isUnitRead(u, byChapter)).map((u) => u.id);
}

/** 已读区间覆盖的节点总数（跨章区间重复计数可忽略：同章内已合并） */
export function coveredNodeCount(ranges: ReadRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.endNode - r.startNode + 1), 0);
}

/**
 * 最小区间形状：ReadRange 与 SourceRange 的公共子集。
 * 区间代数（差集/合并）不关心 via / at / chapterTitle，只在此坐标系上运算。
 */
export interface NodeSpan {
  chapterId: string;
  startNode: number;
  endNode: number;
}

/** NodeSpan 版合并（同章内重叠或相邻并为一段，输出按 chapterId + startNode 排序） */
function mergeSpans(spans: NodeSpan[]): NodeSpan[] {
  const sorted = [...spans]
    .filter((s) => s && typeof s.chapterId === 'string')
    .sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.startNode - b.startNode);
  const out: NodeSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.chapterId === s.chapterId && s.startNode <= last.endNode + 1) {
      last.endNode = Math.max(last.endNode, s.endNode);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * 区间差集：返回 minuend 中未被 subtrahend 覆盖的部分（逐章相减，结果已合并）。
 *
 * TD-01 基础运算：KP 抽取窗口 = readRanges − 已有 KP 覆盖区间。
 * 输入输出只依赖 Canonical Source 坐标，与 ReadingUnit 切分无关——
 * 这是「Learning 不依赖 Presentation」不变量的算术保证。
 */
export function subtractRanges(minuend: NodeSpan[], subtrahend: NodeSpan[]): NodeSpan[] {
  const holesByChapter = new Map<string, Array<{ start: number; end: number }>>();
  for (const s of mergeSpans(subtrahend)) {
    const arr = holesByChapter.get(s.chapterId);
    if (arr) arr.push({ start: s.startNode, end: s.endNode });
    else holesByChapter.set(s.chapterId, [{ start: s.startNode, end: s.endNode }]);
  }
  const out: NodeSpan[] = [];
  for (const m of mergeSpans(minuend)) {
    const holes = holesByChapter.get(m.chapterId);
    if (!holes || holes.length === 0) {
      out.push({ chapterId: m.chapterId, startNode: m.startNode, endNode: m.endNode });
      continue;
    }
    let cursor = m.startNode;
    for (const h of holes) {
      if (cursor > m.endNode) break;
      if (h.end < cursor) continue;
      if (h.start > m.endNode) break;
      if (h.start > cursor) {
        out.push({ chapterId: m.chapterId, startNode: cursor, endNode: h.start - 1 });
      }
      cursor = Math.max(cursor, h.end + 1);
    }
    if (cursor <= m.endNode) {
      out.push({ chapterId: m.chapterId, startNode: cursor, endNode: m.endNode });
    }
  }
  return out;
}
