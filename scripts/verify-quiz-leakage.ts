/**
 * TD-03 回归契约：Quiz 的「只考已读」必须覆盖题目的一切字段。
 *
 * 构造已读 / 未读 KP 混合的干扰项池，连续生成大量题目，断言未读 Source 的文本
 * 不出现在 options / evidence 的任何位置；未读 KP 也不能成为题干。
 * 这条契约在 buildRecallQuestion 内部强制（eligibility ctx），TD-01 落地改
 * KP-range eligibility 时最容易被破坏的就是这里。
 *
 * 运行：pnpm verify:quiz-leakage
 * （= node --import tsx --import ./scripts/test-shims/register.mjs scripts/verify-quiz-leakage.ts）
 */
import type { KnowledgePoint, ReadRange } from '../src/types.ts';
import { buildRecallQuestion, isKpEligible } from '../src/lib/knowledge.ts';
import { buildRangesByChapter } from '../src/lib/readState.ts';

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

function makeKp(
  id: string,
  bookId: string,
  concept: string,
  quote: string,
  ranges: Array<{ chapterId: string; startNode: number; endNode: number }>,
): KnowledgePoint {
  return {
    id,
    bookId,
    chapterId: ranges[0]?.chapterId ?? 'ch-x',
    sourceRanges: ranges.map((r) => ({ ...r, chapterTitle: r.chapterId })),
    concept,
    explanation: `解释：${concept}（依据：${quote.slice(0, 10)}…）`,
    quote,
    generatedBy: 'test',
    createdAt: Date.now(),
  };
}

// 已读区域：ch-read 的节点 0–19
const readRanges: ReadRange[] = [
  { chapterId: 'ch-read', startNode: 0, endNode: 19, via: 'feed', at: Date.now() },
];
const readRangesByChapter = buildRangesByChapter(readRanges);

// 已读 KP（sourceRanges ⊆ readRanges）
const kpA = makeKp('kp-A', 'book-1', '已读概念甲', '已读原文句子甲，包含独有词蓝鲸迁徙路线。', [
  { chapterId: 'ch-read', startNode: 2, endNode: 5 },
]);
const kpB = makeKp('kp-B', 'book-1', '已读概念乙', '已读原文句子乙，包含独有词季风环流模型。', [
  { chapterId: 'ch-read', startNode: 8, endNode: 12 },
]);

// 未读 KP（模拟未来 TD-01 落地时的漏网数据：来源在未读区域）
const kpC = makeKp('kp-C', 'book-1', '未读概念丙', '未读原文句子丙，包含独有词暗物质晕旋转曲线。', [
  { chapterId: 'ch-unread', startNode: 0, endNode: 4 },
]);
const kpD = makeKp('kp-D', 'book-2', '未读概念丁', '未读原文句子丁，包含独有词贝壳生长纹年轮。', [
  { chapterId: 'ch-read', startNode: 50, endNode: 60 }, // 同章但远超已读区间
]);
// 额外的已读干扰项（保证合格干扰项 ≥3，题目能生成）
const kpE = makeKp('kp-E', 'book-1', '已读概念戊', '已读原文句子戊，包含独有词潮汐锁定轨道。', [
  { chapterId: 'ch-read', startNode: 13, endNode: 16 },
]);
const kpF = makeKp('kp-F', 'book-1', '已读概念己', '已读原文句子己，包含独有词细胞自噬机制。', [
  { chapterId: 'ch-read', startNode: 17, endNode: 19 },
]);

const UNREAD_TEXTS = [kpC.quote!, kpD.quote!, kpC.concept, kpD.concept, kpC.explanation, kpD.explanation];

// ---------- 1. 资格判定本身 ----------

check('已读 KP 资格通过', isKpEligible(kpA, readRangesByChapter));
check('跨章未读 KP 资格拒绝', !isKpEligible(kpC, readRangesByChapter));
check('同章超区间 KP 资格拒绝', !isKpEligible(kpD, readRangesByChapter));

// ---------- 2. 泄漏契约：干扰项池里混入未读 KP，反复出题 ----------

const pool = [kpB, kpC, kpD, kpE, kpF];
let rounds = 0;
let sawB = false;
for (let i = 0; i < 300; i++) {
  const q = buildRecallQuestion(kpA, [...pool].sort(() => Math.random() - 0.5), { readRangesByChapter });
  if (!q) continue;
  rounds += 1;
  const optionText = q.options.join('\n');
  for (const bad of UNREAD_TEXTS) {
    check(`第 ${rounds} 题 options 未含未读文本「${bad.slice(6, 14)}…」`, !optionText.includes(bad));
  }
  check(`第 ${rounds} 题 evidence 未含未读文本`, !UNREAD_TEXTS.some((bad) => q.evidence.includes(bad)));
  check(`第 ${rounds} 题题干是已读 KP`, q.knowledgePointId === 'kp-A');
  check(`第 ${rounds} 题 answerIndex 指向已读原文`, q.options[q.answerIndex] === kpA.quote);
  if (q.options.some((o) => o === kpB.quote)) sawB = true;
  if (failures.length > 0) break; // 首个泄漏即失败，无需继续
}
check(`连续 ${rounds} 轮出题全部通过泄漏断言`, rounds > 100);
check('已读干扰项仍会正常出现（没有把池子过滤空）', sawB);

// ---------- 3. 未读 KP 不能成为题干 ----------

check('未读 KP 作为题干 → 出题返回 null', buildRecallQuestion(kpC, pool, { readRangesByChapter }) === null);
check('同章超区间 KP 作为题干 → 出题返回 null', buildRecallQuestion(kpD, pool, { readRangesByChapter }) === null);

// ---------- 4. 全部已读时功能不受损 ----------

const allRead = buildRecallQuestion(kpA, [kpB], { readRangesByChapter });
check('全已读池子正常出题（干扰项不足 3 个时按设计拒绝）', allRead === null); // 只有 1 个干扰项 → null 是预期
const enoughPool = buildRecallQuestion(kpA, [kpB, kpE, kpF], { readRangesByChapter });
check('4 个已读 KP 池子可正常出题', enoughPool !== null && enoughPool.options.length === 4);

console.log(`\n${passed} 项断言通过${failures.length > 0 ? `，${failures.length} 项失败` : '，全部通过 ✓'}`);
if (failures.length > 0) {
  process.exit(1);
}
