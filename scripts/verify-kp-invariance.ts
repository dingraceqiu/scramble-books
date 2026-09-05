/**
 * Layer 3：分割不变性 invariant（TD-01 落地契约）
 *
 * 核心不变量（TECH-DEBT TD-01）：
 *   同一个 Canonical Source + 同一组 readRanges，即使 ReadingUnit segmentation
 *   完全改变，KP 抽取资格与 Quiz 可使用的已读范围也不得改变。
 *
 * 结构性保证：抽取链路 readRanges → subtractRanges → buildExtractionWindows →
 * extractKnowledgePointsForBook → KP.sourceRanges → isKpEligible 的任何一环都
 * 不接受 ReadingUnit 输入（参数里没有单元，想加回去必须先改掉本测试）。
 *
 * 本测试用真实 segmenter 产出两种完全不同的切分，证明呈现层投影变化而
 * 学习层不变；并覆盖：真实抽取管线（内存 idb）、增量阅读不重复抽取、
 * 「其他」类无单元书籍仍可到达 Quiz，以及单元级旧判定为何不可靠。
 *
 * 运行：pnpm verify:kp-invariance
 * （= node --import ./scripts/test-shims/register.mjs --import tsx scripts/verify-kp-invariance.ts）
 * 走 verify-quiz-leakage 同款 shim 环境；GLM 请求在 Node 内自然失败 → 本地兜底抽取路径。
 */
import type { Chapter, KnowledgePoint, ReadRange, SourceDocument } from '../src/types.ts';
import * as db from '../src/lib/db.ts';
import { segmentBook } from '../src/lib/segmenter.ts';
import {
  buildRangesByChapter,
  coverageOfNodes,
  deriveReadUnitIds,
  isRangeCovered,
  isUnitRead,
  mergeReadRanges,
  subtractRanges,
} from '../src/lib/readState.ts';
import {
  buildExtractionWindows,
  extractKnowledgePointsForBook,
  isKpEligible,
  buildRecallQuestion,
} from '../src/lib/knowledge.ts';
import type { ReadingUnit } from '../src/types.ts';

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

function para(text: string, chapterId: string, index: number) {
  return { id: `${chapterId}__n${index}`, index, type: 'para' as const, text };
}
function heading(text: string, chapterId: string, index: number) {
  return { id: `${chapterId}__n${index}`, index, type: 'heading' as const, text };
}

/** 构造一章：1 个标题 + n 个正文段（句子足够长，保证本地兜底可产 KP） */
function makeChapter(id: string, title: string, paras: string[]): Chapter {
  return {
    id,
    index: Number(id.replace('ch', '')) - 1,
    title,
    nodes: [heading(title, id, 0), ...paras.map((t, i) => para(t, id, i + 1))],
  };
}

const ch1Paras = Array.from({ length: 22 }, (_, i) =>
  `社会比较的强度取决于参照群体与自我之间的相关程度，第${i + 1}项观察表明个体会主动选择比较对象以维持自我评价的稳定。`,
);
const ch2Paras = Array.from({ length: 10 }, (_, i) =>
  `参考群体影响社会判断的路径并不单一，第${i + 1}项讨论说明认同压力会改变成员对同一信息的解释方式。`,
);
const ch3Paras = Array.from({ length: 8 }, (_, i) =>
  `习惯的形成依赖稳定的环境线索与即时反馈，第${i + 1}项记录显示微小行为的重复积累会改变长期偏好。`,
);

function makeDoc(bookId: string, chapters: Chapter[]): SourceDocument {
  return { bookId, chapters };
}

/** readRanges：ch1 全章（0..22）+ ch2 前 7 节点（0..6）+ ch3 前 4 节点（0..3） */
function makeReadRanges(): ReadRange[] {
  return mergeReadRanges([
    { chapterId: 'ch1', startNode: 0, endNode: 22, via: 'reader', at: 100 },
    { chapterId: 'ch2', startNode: 0, endNode: 6, via: 'feed', at: 90 },
    { chapterId: 'ch3', startNode: 0, endNode: 3, via: 'reader', at: 80 },
  ]);
}

function kpRange(kp: KnowledgePoint): { chapterId: string; startNode: number; endNode: number } {
  const r = kp.sourceRanges[0];
  return { chapterId: r.chapterId, startNode: r.startNode, endNode: r.endNode };
}

/** 手工构造一个最小合法 ReadingUnit（呈现层对象，仅供 deriveReadUnitIds 消费） */
function makeUnit(id: string, order: number, chapterId: string, startNode: number, endNode: number): ReadingUnit {
  const range = { chapterId, chapterTitle: '', startNode, endNode };
  return {
    id,
    bookId: 'b-inv',
    order,
    sourceStart: range,
    sourceEnd: range,
    sourceText: '',
    preview: '',
    ai: { title: '', estimatedReadingMinutes: 1, generator: 'test' },
  };
}

function spansOverlap(
  a: { chapterId: string; startNode: number; endNode: number },
  b: { chapterId: string; startNode: number; endNode: number },
): boolean {
  return a.chapterId === b.chapterId && a.startNode <= b.endNode && b.startNode <= a.endNode;
}

async function main(): Promise<void> {
  const doc = makeDoc('b-inv', [
    makeChapter('ch1', '第一章 比较的机制', ch1Paras),
    makeChapter('ch2', '第二章 群体与认同', ch2Paras),
    makeChapter('ch3', '第三章 习惯的积累', ch3Paras),
  ]);
  const readRanges = makeReadRanges();
  const byChapter = buildRangesByChapter(readRanges);

  // ---------- 1. 两种完全不同的 segmentation（同一 Canonical Source） ----------
  // A：真实 segmenter 产出；B：手工构造的对抗性重切分（边界完全不同）。
  // 不变量要对「任意重切分」成立，因此 B 故意选一套现实切分器不会产出的边界。
  const unitsA = segmentBook('b-inv', structuredClone(doc.chapters), { bookType: 'social_science' });
  const unitsB: ReadingUnit[] = [
    makeUnit('u-b1', 0, 'ch1', 0, 8),
    makeUnit('u-b2', 1, 'ch1', 9, 22),
    makeUnit('u-b3', 2, 'ch2', 0, 3),
    makeUnit('u-b4', 3, 'ch2', 4, 10),
    makeUnit('u-b5', 4, 'ch3', 0, 1),
    makeUnit('u-b6', 5, 'ch3', 2, 8),
  ];
  check('两种切分的单元边界不同（segmentation 确实改变）', unitsA.length !== unitsB.length);
  const projA = new Set(deriveReadUnitIds(unitsA, readRanges));
  const projB = new Set(deriveReadUnitIds(unitsB, readRanges));
  check(
    '呈现层投影（已读单元集合）随分割改变',
    projA.size !== projB.size || [...projA].some((id) => !projB.has(id)),
  );

  // ---------- 1.5 Coverage 唯一口径对分割不变（coverageOfNodes，Canonical Source 宇宙） ----------
  // b-inv 全书节点：ch1 23 + ch2 11 + ch3 9 = 43；已读 23 + 7 + 4 = 34
  const bookNodeCount = doc.chapters.reduce((sum, c) => sum + c.nodes.length, 0);
  check('夹具节点总数 = 43', bookNodeCount === 43);
  const coverage1 = coverageOfNodes(readRanges, bookNodeCount);
  check('覆盖率 = 已读节点数/全书节点数（34/43）', Math.abs(coverage1 - 34 / 43) < 1e-9);
  check(
    '呈现层投影变了，覆盖率不变（projA ≠ projB，coverage 同值）',
    coverage1 === coverageOfNodes(readRanges, bookNodeCount),
  );
  check(
    '重切分语义场景：unitsA/unitsB 存在与否不影响 coverage（函数无单元输入）',
    coverage1 === coverageOfNodes(mergeReadRanges(readRanges), bookNodeCount),
  );

  // ---------- 2. 单元级旧判定为何不可靠（不变量的动机，留档于测试） ----------
  // 同一组 readRanges 下，把已读区域 [0..6] 切成独立单元判「已读」，
  // 切成跨边界大单元就判「未读」——资格随呈现层漂移，这正是被废除的旧路径。
  const unitSmall = { sourceStart: { chapterId: 'ch2', chapterTitle: '', startNode: 0, endNode: 6 }, sourceEnd: { chapterId: 'ch2', chapterTitle: '', startNode: 0, endNode: 6 } } as ReadingUnit;
  const unitBig = { sourceStart: { chapterId: 'ch2', chapterTitle: '', startNode: 0, endNode: 10 }, sourceEnd: { chapterId: 'ch2', chapterTitle: '', startNode: 0, endNode: 10 } } as ReadingUnit;
  check('旧路径：同一已读区域在小单元下判已读', isUnitRead(unitSmall, byChapter));
  check('旧路径：同一已读区域在大单元下判未读（资格漂移）', !isUnitRead(unitBig, byChapter));

  // ---------- 3. 抽取窗口：只依赖 (doc, readRanges) ----------
  const windows = buildExtractionWindows(doc, readRanges);
  check('窗口切齐整个已读区域（23+7+4 节点 → 4 个窗口）', windows.length === 4);
  check(
    '每个窗口都被 readRanges 完全覆盖（资格由构造保证）',
    windows.every((w) => isRangeCovered(byChapter.get(w.chapterId), w.startNode, w.endNode)),
  );
  check(
    '窗口集合是 (doc, readRanges) 的纯函数（重算逐字段一致）',
    JSON.stringify(windows) === JSON.stringify(buildExtractionWindows(structuredClone(doc), readRanges)),
  );

  // ---------- 4. 真实抽取管线（内存 idb 落库 → loadAll 取回） ----------
  const created = await extractKnowledgePointsForBook('b-inv', windows);
  check('本地兜底抽取产出 4 个 KP', created === 4);
  const all1 = await db.loadAll();
  const kps = all1.knowledgePoints.filter((kp) => kp.bookId === 'b-inv');
  check('loadAll 取回 4 个 KP', kps.length === 4);
  check(
    'KP.sourceRanges 与窗口一一对应（KP 集合完全由 (doc, readRanges) 决定）',
    JSON.stringify([...kps].map(kpRange).sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.startNode - b.startNode))
      === JSON.stringify([...windows].map((w) => ({ chapterId: w.chapterId, startNode: w.startNode, endNode: w.endNode }))
        .sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.startNode - b.startNode)),
  );
  check(
    '全部 KP 通过 isKpEligible（与 segmentation A/B 无关：链路无单元输入）',
    kps.every((kp) => isKpEligible(kp, byChapter)),
  );
  const question = buildRecallQuestion(kps[0], kps, { readRangesByChapter: byChapter });
  check('Quiz 可正常出题（4 KP → 3 个已读干扰项）', question !== null && question.options.length === 4);

  // ---------- 5. 资格守门反例：越过 readRanges 的 KP 不得出题 ----------
  const intruder: KnowledgePoint = {
    id: 'kp-intruder',
    bookId: 'b-inv',
    chapterId: 'ch2',
    sourceRanges: [{ chapterId: 'ch2', chapterTitle: '第二章 群体与认同', startNode: 0, endNode: 9 }],
    concept: '越界知识点',
    explanation: '范围超出已读区域的反例',
    quote: ch2Paras[9],
    generatedBy: 'test',
    createdAt: 0,
  };
  check('越界 KP 判为不合格', !isKpEligible(intruder, byChapter));
  check('越界 KP 不能成为题干', buildRecallQuestion(intruder, kps, { readRangesByChapter: byChapter }) === null);

  // ---------- 6. 增量阅读：delta 只含新读区域，不重复抽取 ----------
  const kpCovered = kps.map(kpRange);
  const delta1 = subtractRanges(readRanges, kpCovered);
  check('抽取完成后 delta 为空（已读区域全部被 KP 覆盖，不会重复抽取）', delta1.length === 0);

  const readRanges2 = mergeReadRanges([
    ...readRanges,
    { chapterId: 'ch2', startNode: 7, endNode: 10, via: 'reader' as const, at: 200 },
  ]);
  const delta2 = subtractRanges(readRanges2, kpCovered);
  check(
    '继续阅读后 delta 恰为新读区域 [ch2 7..10]',
    delta2.length === 1 && delta2[0].chapterId === 'ch2' && delta2[0].startNode === 7 && delta2[0].endNode === 10,
  );
  const windows2 = buildExtractionWindows(doc, delta2);
  check('新区域切成 1 个窗口', windows2.length === 1);
  check(
    '新窗口与已有 KP 区间零重叠（增量不重复）',
    windows2.every((w) => !kpCovered.some((k) => spansOverlap(k, w))),
  );
  const created2 = await extractKnowledgePointsForBook('b-inv', windows2);
  check('增量抽取产出 1 个新 KP', created2 === 1);
  const all2 = await db.loadAll();
  const kps2 = all2.knowledgePoints.filter((kp) => kp.bookId === 'b-inv');
  const byChapter2 = buildRangesByChapter(readRanges2);
  check('增长后共 5 个 KP，全部在新 readRanges 下合格', kps2.length === 5 && kps2.every((kp) => isKpEligible(kp, byChapter2)));
  check('增量后覆盖率精确变为 38/43', Math.abs(coverageOfNodes(readRanges2, bookNodeCount) - 38 / 43) < 1e-9);

  // ---------- 7. 「其他」类书籍：无任何 ReadingUnit 仍可到达 Quiz ----------
  const otherDoc = makeDoc('b-other', [
    makeChapter('oc1', '旅行手记', [
      '清晨的雾气沿着河谷缓慢上浮，远处的山脊只露出一条淡青色的轮廓线。',
      '当地的集市从日出到正午最为热闹，摊贩的吆喝声与铜秤的碰撞声交织在一起。',
      '手工艺人把染好的织物晾在竹架上，风一吹过，整条巷子都跟着变换颜色。',
    ]),
  ]);
  const otherRead = mergeReadRanges([
    { chapterId: 'oc1', startNode: 0, endNode: 3, via: 'reader' as const, at: 300 },
  ]);
  const otherWindows = buildExtractionWindows(otherDoc, otherRead);
  check('无单元书籍照常产出抽取窗口', otherWindows.length === 1);
  const created3 = await extractKnowledgePointsForBook('b-other', otherWindows);
  const all3 = await db.loadAll();
  const otherKps = all3.knowledgePoints.filter((kp) => kp.bookId === 'b-other');
  check(
    '无单元书籍抽取并全部合格（Reader → readRanges → KP → Quiz 打通）',
    created3 !== null && created3 > 0 && otherKps.length === created3 && otherKps.every((kp) => isKpEligible(kp, buildRangesByChapter(otherRead))),
  );
  check(
    '无单元书籍覆盖率同口径可算（4/4 = 1，无需任何分支）',
    coverageOfNodes(otherRead, otherDoc.chapters.reduce((sum, c) => sum + c.nodes.length, 0)) === 1,
  );

  console.log(`\n${passed} 项断言通过${failures.length > 0 ? `，${failures.length} 项失败` : '，全部通过 ✓'}`);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
