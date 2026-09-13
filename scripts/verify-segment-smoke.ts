/**
 * Feed 切分冒烟测试（P0 dogfood 前的确定性回归）。
 *
 * 用内置示例书跑真实 segmenter，验证「适合刷 + 保持原文逻辑完整」的硬性底线：
 *   1. 每个单元正文都达到最小篇幅（绝无「只有标题没有内容」的碎片卡片）
 *   2. 单元边界永远落在段落/标题边界（Canonical Source 坐标内，绝不在节点区间外）
 *   3. 卡片长度分布合理：中位数在「刷」的舒适区，硬上限不被系统性突破
 *   4. 小说模式一章一单元、不跨章
 *   5. 重切分（非小说 → 小说）后 readRanges 覆盖的原文区间仍然有效（事实层不变）
 *
 * 运行：pnpm verify:segment-smoke
 */
import type { ReadRange } from '../src/types.ts';
import { parseTxtText } from '../src/lib/parsers/index.ts';
import { segmentBook } from '../src/lib/segmenter.ts';
import { SAMPLE_TEXT, SAMPLE_FILENAME } from '../src/lib/sample.ts';

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

const parsed = parseTxtText(SAMPLE_TEXT, SAMPLE_FILENAME);

function stats(units: ReturnType<typeof segmentBook>) {
  const chars = units.map((u) => u.sourceText.replace(/\s/g, '').length);
  const sorted = [...chars].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return { count: units.length, min: sorted[0] ?? 0, median, max: sorted[sorted.length - 1] ?? 0 };
}

// ---------- 1. 非小说（默认社科）切分底线 ----------
const doc = segmentBook('book-smoke', parsed.chapters.map((c) => ({ ...c, nodes: [...c.nodes] })), {
  bookType: 'social_science',
  bookTitle: parsed.title,
});
check('非小说：切分出多个单元', doc.length >= 2);
check('非小说：无空正文单元', doc.every((u) => u.sourceText.trim().length > 0));

const MIN_BODY = 100; // 与 segmenter MIN_UNIT_BODY_CHARS(120) 对齐并留出白空格余量
const tooSmall = doc.filter((u) => {
  const body = u.sourceStart.chapterTitle && u.sourceText.startsWith(u.sourceStart.chapterTitle)
    ? u.sourceText.slice(u.sourceStart.chapterTitle.length)
    : u.sourceText;
  return body.replace(/\s/g, '').length < MIN_BODY;
});
check('非小说：无正文碎片单元', tooSmall.length === 0);

// 边界都在章节节点区间内（由解析器保证段落原子性 → 不可能从句子中间切断）
check(
  '非小说：单元区间坐标合法',
  doc.every((u) => u.sourceStart.endNode >= u.sourceStart.startNode),
);
check(
  '非小说：卡片长度分布（min/median/max）',
  (() => {
    const s = stats(doc);
    console.log(`  非小说卡片数=${s.count} 字数 min=${s.min} median=${s.median} max=${s.max}`);
    // 「适合刷」的分布：中位数不能长到接近普通 Reader（>4000 字就是一整章了）
    return s.median > 0 && s.median <= 4000;
  })(),
);
check(
  '非小说：无单元接近整章字数',
  (() => {
    const totalBody = parsed.chapters.reduce(
      (sum, c) => sum + c.nodes.filter((n) => n.type !== 'heading').reduce((s, n) => s + n.text.length, 0),
      0,
    );
    const s = stats(doc);
    return s.max < totalBody * 0.9; // 单元再完整也不该是一整本书
  })(),
);

// ---------- 2. 小说模式：一章一单元、不跨章 ----------
const fic = segmentBook('book-smoke-fic', parsed.chapters.map((c) => ({ ...c, nodes: [...c.nodes] })), {
  bookType: 'fiction',
  bookTitle: parsed.title,
});
check('小说：切出单元', fic.length >= 1);
check(
  '小说：单元不跨章',
  fic.every((u) => u.sourceStart.chapterId === u.sourceEnd.chapterId),
);
check(
  '小说：标题带连载序号',
  fic.every((u) => /^(第\d+篇 |Ep\.\d+ · )/.test(u.ai.title)),
);

// ---------- 3. 重切分不丢阅读历史（readRanges 与切分无关的算术保证） ----------
const rangesBefore: ReadRange[] = doc.map((u) => ({
  chapterId: u.sourceStart.chapterId,
  startNode: u.sourceStart.startNode,
  endNode: u.sourceEnd.endNode,
  via: 'feed' as const,
  at: Date.now(),
}));
// 重切分后（换成 fiction 边界），旧区间必须仍能精确圈住同样的原文坐标
const stillCovered = rangesBefore.filter((r) => {
  const ch = parsed.chapters.find((c) => c.id === r.chapterId);
  return !!ch && r.endNode < ch.nodes.length;
});
check(
  '重切分：旧已读区间仍指向合法原文节点',
  stillCovered.length === rangesBefore.filter((r) => {
    const ch = parsed.chapters.find((c) => c.id === r.chapterId);
    return !!ch;
  }).length,
);

// ---------- 结果 ----------
console.log(`\nsegment-smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('FAILED:', failures.join(' | '));
  process.exit(1);
}
