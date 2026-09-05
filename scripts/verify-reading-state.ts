/**
 * Reading State / Learning Foundation 纵切验证（纯逻辑层，无 DOM / IndexedDB）。
 *
 * 运行：pnpm verify:readstate   （= tsx scripts/verify-reading-state.ts）
 * 对应产品验收清单：
 *   1. ReadingUnit 重切分不丢阅读历史（事实层 readRanges 不变）
 *   2. Feed → Reader 互认（同一份 readRanges 两个方向都能推导）
 *   3. 部分阅读不误标整个单元为已读
 *   4. 旧数据迁移：readUnitIds → readRanges 不丢失、不扩大
 *   5. 跨章单元 / 区间合并精度（KP grounding 的坐标基础）
 *   6. TD-01 目标判定演示：KP eligibility = KP.sourceRanges ⊆ readRanges
 *      今天就能用 isRangeCovered 表达，不必再绕回 ReadingUnit
 */
import type { Chapter, ReadRange, ReadingUnit, SourceNode } from '../src/types.ts';
import {
  buildRangesByChapter,
  coveredNodeCount,
  coverageOfNodes,
  deriveReadUnitIds,
  isRangeCovered,
  isUnitRead,
  mergeReadRanges,
  rangesFromUnits,
  readNodeSetFromRanges,
  unitSpans,
} from '../src/lib/readState.ts';

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

// ---------- 测试夹具 ----------

function makeChapter(id: string, paras: number): Chapter {
  const nodes: SourceNode[] = [];
  for (let i = 0; i < paras; i++) {
    nodes.push({
      id: `${id}__n${i}`,
      index: i,
      type: i === 0 ? 'heading' : 'para',
      text: i === 0 ? `第 ${id} 章标题` : `段落${i}的内容，足够长以像真实正文。`,
    });
  }
  return { id, index: 0, title: `章 ${id}`, nodes };
}

function makeUnit(
  bookId: string,
  order: number,
  chapter: Chapter,
  start: number,
  end: number,
): ReadingUnit {
  return {
    id: `unit_${bookId}_${order}`,
    bookId,
    order,
    sourceStart: { chapterId: chapter.id, chapterTitle: chapter.title, startNode: start, endNode: start },
    sourceEnd: { chapterId: chapter.id, chapterTitle: chapter.title, startNode: start, endNode: end },
    sourceText: '测试原文',
    preview: '测试原文',
    ai: { title: `标题${order}`, estimatedReadingMinutes: 1, generator: 'mock-test' },
  };
}

/** 模拟 markRead（Feed 打开单元）：单元区间整体写入 */
function feedRead(unit: ReadingUnit, at = Date.now()): ReadRange[] {
  return unitSpans(unit).map((s) => ({
    chapterId: s.chapterId,
    startNode: s.start,
    endNode: s.end,
    via: 'feed' as const,
    at,
  }));
}

/** 模拟 markNodesRead（Reader 滚动）：零散节点合并为连续区间 */
function readerMark(chapterId: string, nodes: number[], at = Date.now()): ReadRange[] {
  return mergeReadRanges(
    nodes.map((n) => ({ chapterId, startNode: n, endNode: n, via: 'reader' as const, at })),
  );
}

// ---------- 1. ReadingUnit 重切分不丢阅读历史 ----------

function testResegment(): void {
  console.log('1. 重切分不变性');
  const ch = makeChapter('ch1', 12);
  const v1 = [makeUnit('b1', 0, ch, 0, 4), makeUnit('b1', 1, ch, 5, 11)];
  // 用户在旧切分下读完了第一篇（节点 0–4）+ 第二篇的前两段（5–6）
  let ranges = mergeReadRanges([...feedRead(v1[0]), ...readerMark('ch1', [5, 6])]);

  const nodeSetBefore = readNodeSetFromRanges(ranges);
  const coveredBefore = coveredNodeCount(ranges);

  // 重切分：呈现层边界变化，事实层 readRanges 原样保留（setBookType/replaceBookContent 行为）
  const v2 = [makeUnit('b1', 0, ch, 0, 2), makeUnit('b1', 1, ch, 3, 7), makeUnit('b1', 2, ch, 8, 11)];

  // 邻接区间 [0..4] 与 [5..6] 应合并为一段 [0..6]，节点覆盖不变
  check('重切分后事实层合并为单段且覆盖 0–6', ranges.length === 1 && ranges[0].startNode === 0 && ranges[0].endNode === 6);
  const nodeSetAfter = readNodeSetFromRanges(ranges);
  check(
    '节点集合一致',
    coveredBefore === coveredNodeCount(ranges) &&
      [0, 4, 5, 6].every((n) => nodeSetAfter.get('ch1')?.has(n)) &&
      ![7, 8, 11].some((n) => nodeSetAfter.get('ch1')?.has(n)) &&
      nodeSetBefore.get('ch1')?.size === nodeSetAfter.get('ch1')?.size,
  );
  const cacheV2 = deriveReadUnitIds(v2, ranges);
  check('新切分下派生缓存正确（0–2 全覆盖已读；3–7 部分未读；8–11 未读）', cacheV2.length === 1 && cacheV2[0] === v2[0].id);
  check('部分覆盖的单元不被判已读', isUnitRead(v2[1], buildRangesByChapter(ranges)) === false);
  check('未读单元不被判已读', isUnitRead(v2[2], buildRangesByChapter(ranges)) === false);
}

// ---------- 2. Feed → Reader 互认 ----------

function testCrossRecognition(): void {
  console.log('2. Feed / Reader 互认');
  const ch = makeChapter('ch2', 10);
  const u1 = makeUnit('b2', 0, ch, 1, 5); // 0 是标题节点
  const u2 = makeUnit('b2', 1, ch, 6, 9);

  // 方向 A：Feed 里读过 u1 → Reader 对应节点应显示已读
  let ranges = feedRead(u1);
  const readerView = readNodeSetFromRanges(ranges);
  check('Feed 已读 → Reader 节点已读', [1, 3, 5].every((n) => readerView.get('ch2')?.has(n)));

  // 方向 B：Reader 里滚过 u2 的节点（乱序、分散上报）→ Feed 单元应判已读
  ranges = mergeReadRanges([...ranges, ...readerMark('ch2', [7, 6, 9, 8])]);
  const byChapter = buildRangesByChapter(ranges);
  check('Reader 已读（乱序上报）→ Feed 单元已读', isUnitRead(u2, byChapter));
  // [1..5] 与 [6..9] 邻接合并为一段 [1..9]，无碎片
  check('合并后区间连续无碎片', ranges.filter((r) => r.chapterId === 'ch2').length === 1 && ranges[0].endNode === 9);
}

// ---------- 3. 部分阅读不误标 ----------

function testPartialReading(): void {
  console.log('3. 部分阅读');
  const ch = makeChapter('ch3', 12);
  const u = makeUnit('b3', 0, ch, 1, 10);

  let ranges = readerMark('ch3', [1, 2, 3]);
  let byChapter = buildRangesByChapter(ranges);
  check('只读前 3/10 个节点 → 单元未读', isUnitRead(u, byChapter) === false);
  check('派生缓存不含该单元', deriveReadUnitIds([u], ranges).length === 0);

  ranges = mergeReadRanges([...ranges, ...readerMark('ch3', [4, 5, 6, 7, 8, 9, 10])]);
  byChapter = buildRangesByChapter(ranges);
  check('补完剩余节点 → 单元已读', isUnitRead(u, byChapter));
}

// ---------- 4. 旧数据迁移：readUnitIds → readRanges ----------

function testMigration(): void {
  console.log('4. 旧数据迁移');
  const ch = makeChapter('ch4', 12);
  const u1 = makeUnit('b4', 0, ch, 0, 5);
  const u2 = makeUnit('b4', 1, ch, 6, 11);
  // 旧格式：两个已读单元 + 一个重切分后已失效的幽灵 id
  const oldIds = [u1.id, u2.id, 'unit_b4_ghost'];
  const ranges = rangesFromUnits([u1, u2], oldIds, 1700000000000);

  check('迁移后覆盖范围 = 原单元覆盖之和（不扩大）', coveredNodeCount(ranges) === 12);
  check('区间已合并且来源标记为 feed', ranges.length === 1 && ranges[0].via === 'feed');
  const cache = deriveReadUnitIds([u1, u2], ranges);
  check('迁移后派生缓存还原出全部真实已读单元', cache.length === 2);
  check('幽灵 id 不产生任何已读区间', !ranges.some((r) => r.startNode > 11 || r.endNode > 11));
}

// ---------- 5. 跨章单元与区间精度（KP grounding 的坐标基础） ----------

function testCrossChapterPrecision(): void {
  console.log('5. 跨章区间精度');
  const chA = makeChapter('chA', 6);
  const chB = makeChapter('chB', 6);
  const cross: ReadingUnit = {
    ...makeUnit('b5', 0, chA, 3, 5),
    sourceEnd: { chapterId: chB.id, chapterTitle: chB.title, startNode: 0, endNode: 2 },
  };

  let ranges = mergeReadRanges([...readerMark('chA', [3, 4, 5]), ...readerMark('chB', [0, 1])]);
  check('跨章单元只读了一章 → 未读', isUnitRead(cross, buildRangesByChapter(ranges)) === false);
  ranges = mergeReadRanges([...ranges, ...readerMark('chB', [2])]);
  check('两章都读完 → 已读', isUnitRead(cross, buildRangesByChapter(ranges)));

  // 邻接区间应合并（0–2 与 3–5 → 0–5），不留碎片
  const merged = mergeReadRanges([
    { chapterId: 'chC', startNode: 0, endNode: 2, via: 'feed', at: 1 },
    { chapterId: 'chC', startNode: 3, endNode: 5, via: 'reader', at: 2 },
  ]);
  check('邻接区间合并为一段，via/at 取较新者', merged.length === 1 && merged[0].endNode === 5 && merged[0].via === 'reader');
}

// ---------- 6. TD-01 目标判定演示：KP eligibility 直接基于 sourceRanges ----------

function testKpEligibilityBasis(): void {
  console.log('6. KP eligibility 目标判定（TD-01）');
  const ch = makeChapter('ch6', 12);
  // MVP 现状：单元 (0..9) 部分已读 → 整个单元不进 KP 抽取
  const ranges = mergeReadRanges([...readerMark('ch6', [0, 1, 2])]);
  const byChapter = buildRangesByChapter(ranges);
  // TD-01 目标：一个只来自节点 3–5 的 KP，判定其 sourceRanges 是否 ⊆ readRanges
  const kpRange = { chapterId: 'ch6', startNode: 3, endNode: 5 };
  check('KP 范围未读 → isRangeCovered 为 false（不应出题）', isRangeCovered(byChapter.get('ch6'), kpRange.startNode, kpRange.endNode) === false);
  const ranges2 = mergeReadRanges([...ranges, ...readerMark('ch6', [3, 4, 5])]);
  check('KP 范围读完 → isRangeCovered 为 true（可出题）', isRangeCovered(buildRangesByChapter(ranges2).get('ch6'), kpRange.startNode, kpRange.endNode));
}

function testCoverageOfNodes(): void {
  console.log('7. Coverage 唯一口径（coverageOfNodes，Canonical Source 全节点宇宙）');
  const rr = (chapterId: string, startNode: number, endNode: number): ReadRange => ({
    chapterId, startNode, endNode, via: 'reader', at: 1,
  });
  check('空 readRanges → 0', coverageOfNodes([], 10) === 0);
  check('undefined readRanges → 0', coverageOfNodes(undefined, 10) === 0);
  check('nodeCount 为 0/负 → 0（坏数据不产生 NaN/负数）', coverageOfNodes([rr('c', 0, 1)], 0) === 0 && coverageOfNodes([rr('c', 0, 1)], -3) === 0);
  check('部分阅读 5/10 → 0.5', Math.abs(coverageOfNodes([rr('c', 0, 4)], 10) - 0.5) < 1e-9);
  check(
    '未合并/相邻区间先合并再计数（[0..3]+[3..5] = 6 节点，不是 7）',
    Math.abs(coverageOfNodes([rr('c', 0, 3), rr('c', 3, 5)], 10) - 0.6) < 1e-9,
  );
  check('乱序输入同样正确（不信任写入方有序性）', Math.abs(coverageOfNodes([rr('c', 3, 5), rr('c', 0, 2)], 10) - 0.6) < 1e-9);
  check('超过全书节点数收敛到 1', coverageOfNodes([rr('c', 0, 11)], 10) === 1);
  check('跨章求和正确（章 A 3 节点 + 章 B 2 节点 / 10）', Math.abs(coverageOfNodes([rr('a', 0, 2), rr('b', 0, 1)], 10) - 0.5) < 1e-9);
}

// ---------- 运行 ----------

testResegment();
testCrossRecognition();
testPartialReading();
testMigration();
testCrossChapterPrecision();
testKpEligibilityBasis();
testCoverageOfNodes();

console.log(`\n${passed} 项断言通过${failures.length > 0 ? `，${failures.length} 项失败` : '，全部通过 ✓'}`);
if (failures.length > 0) {
  process.exit(1);
}
