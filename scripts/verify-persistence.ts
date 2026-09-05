/**
 * Layer 2：Persistence integration —— 状态经过 IndexedDB / normalize / 重切分 /
 * 快照 round-trip 之后仍然正确（不测纯函数，测 db.ts 全链路）。
 *
 * 运行：pnpm verify:persistence
 * （= node --import tsx --import ./scripts/test-shims/register.mjs scripts/verify-persistence.ts）
 * 'idb' 由 scripts/test-shims/idb.mjs（内存实现）顶替，其余全是业务源码。
 */
import type { Book, Chapter, KnowledgePoint, ReadRange, ReadingUnit, SourceDocument } from '../src/types.ts';
import * as db from '../src/lib/db.ts';
import { coveredNodeCount } from '../src/lib/readState.ts';
import { __resetAllDatabases } from './test-shims/idb.mjs';

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

// ---------- 夹具 ----------

function makeBook(id: string, title: string): Book {
  return {
    id,
    title,
    author: '测试作者',
    format: 'txt',
    bookType: 'social_science',
    createdAt: Date.now(),
    unitCount: 0,
    nodeCount: 12,
    chapterCount: 1,
  };
}

function makeDoc(bookId: string): SourceDocument {
  const chapterId = `${bookId}-ch1`;
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    id: `${chapterId}__n${i}`,
    index: i,
    type: i === 0 ? ('heading' as const) : ('para' as const),
    text: i === 0 ? '章标题' : `段落${i}`,
  }));
  const chapter: Chapter = { id: chapterId, index: 0, title: '第一章', nodes };
  return { bookId, chapters: [chapter] };
}

function makeUnit(bookId: string, order: number, start: number, end: number): ReadingUnit {
  const chapterId = `${bookId}-ch1`;
  return {
    id: `${bookId}-unit-${order}`,
    bookId,
    order,
    sourceStart: { chapterId, chapterTitle: '第一章', startNode: start, endNode: start },
    sourceEnd: { chapterId, chapterTitle: '第一章', startNode: start, endNode: end },
    sourceText: '测试原文',
    preview: '测试原文',
    ai: { title: `标题${order}`, estimatedReadingMinutes: 1, generator: 'mock-test' },
  };
}

const chapterIdOf = (bookId: string) => `${bookId}-ch1`;

// ---------- 场景 ----------

async function lifecycle(): Promise<void> {
  console.log('1. 建库 → 导入 → 阅读生命周期');
  __resetAllDatabases();

  const book = makeBook('b1', '第一本书');
  const doc = makeDoc('b1');
  const unitsV1 = [makeUnit('b1', 0, 0, 5), makeUnit('b1', 1, 6, 11)];
  await db.putBookWithContent(book, doc, unitsV1);

  let all = await db.loadAll();
  check('导入后初始进度为空区间', (all.progress['b1']?.readRanges?.length ?? -1) === 0);
  check('初始派生缓存为空', (all.progress['b1']?.readUnitIds?.length ?? -1) === 0);

  // Feed 读第一篇 + Reader 读第二篇前半（乱序节点）
  const ranges: ReadRange[] = [
    { chapterId: chapterIdOf('b1'), startNode: 0, endNode: 5, via: 'feed', at: 1000 },
    { chapterId: chapterIdOf('b1'), startNode: 8, endNode: 8, via: 'reader', at: 1001 },
    { chapterId: chapterIdOf('b1'), startNode: 6, endNode: 7, via: 'reader', at: 1002 },
  ];
  await db.putProgress({ bookId: 'b1', readRanges: ranges, readUnitIds: [], updatedAt: 2000 });

  all = await db.loadAll();
  const p1 = all.progress['b1'];
  // 归一化保证：入库的乱序/未合并区间在 loadAll 后必然合并排序（[0–5]+[6–7]+[8] → 0–8）
  check(
    'reload 后区间已合并排序且覆盖不变',
    p1?.readRanges?.length === 1 &&
      p1.readRanges[0].startNode === 0 &&
      p1.readRanges[0].endNode === 8 &&
      coveredNodeCount(p1.readRanges) === 9,
  );
  check('reload 后派生缓存重建（第二篇 9–11 未读 → 未入缓存）', p1?.readUnitIds?.length === 1);

  // 补完第二篇剩余节点
  await db.putProgress({
    bookId: 'b1',
    readRanges: [...ranges, { chapterId: chapterIdOf('b1'), startNode: 9, endNode: 11, via: 'reader', at: 1003 }],
    readUnitIds: [],
    updatedAt: 3000,
  });
  all = await db.loadAll();
  check('补完后 reload 派生缓存含两个单元', all.progress['b1']?.readUnitIds?.length === 2 && coveredNodeCount(all.progress['b1']?.readRanges ?? []) === 12);
}

async function legacyMigration(): Promise<void> {
  console.log('2. 旧格式迁移（loadAll normalize）');
  __resetAllDatabases();

  const book = makeBook('b2', '旧数据书');
  await db.putBookWithContent(book, makeDoc('b2'), [makeUnit('b2', 0, 0, 5), makeUnit('b2', 1, 6, 11)]);
  // 直接写入旧 shape（无 readRanges），模拟升级前客户端留下的记录
  await db.putProgress({
    bookId: 'b2',
    readUnitIds: ['b2-unit-0'],
    updatedAt: 123,
  } as unknown as Parameters<typeof db.putProgress>[0]);

  const all = await db.loadAll();
  const p = all.progress['b2'];
  check('旧 readUnitIds 迁移为 readRanges', (p?.readRanges?.length ?? 0) === 1);
  check('迁移覆盖恰好等于原单元跨度（0–5，不扩大）', coveredNodeCount(p?.readRanges ?? []) === 6);
  check('迁移后派生缓存与原已读一致', JSON.stringify(p?.readUnitIds) === JSON.stringify(['b2-unit-0']));
}

async function resegmentPreserves(): Promise<void> {
  console.log('3. 重切分保留阅读历史（replaceBookContent preserveReadRanges）');
  __resetAllDatabases();

  const book = makeBook('b3', '重切分书');
  await db.putBookWithContent(book, makeDoc('b3'), [makeUnit('b3', 0, 0, 5), makeUnit('b3', 1, 6, 11)]);
  const ranges: ReadRange[] = [
    { chapterId: chapterIdOf('b3'), startNode: 0, endNode: 7, via: 'feed', at: 1 },
  ];
  await db.putProgress({ bookId: 'b3', readRanges: ranges, readUnitIds: [], updatedAt: 2 });

  // presentation re-segmentation：节点不变，单元边界变化（0–3 / 4–7 / 8–11）
  const unitsV2 = [makeUnit('b3', 0, 0, 3), makeUnit('b3', 1, 4, 7), makeUnit('b3', 2, 8, 11)];
  await db.replaceBookContent({
    book: { ...book, bookType: 'philosophy' },
    document: makeDoc('b3'),
    units: unitsV2,
    preserveReadRanges: ranges,
  });

  let all = await db.loadAll();
  check('重切分后 readRanges 完整保留', JSON.stringify(all.progress['b3']?.readRanges) === JSON.stringify(ranges));
  check('新单元派生缓存：0–3、4–7 已读，8–11 未读', all.progress['b3']?.readUnitIds?.length === 2);
  check('节点覆盖不因重切分改变', coveredNodeCount(all.progress['b3']?.readRanges ?? []) === 8);

  // 对照：不带 preserve 的 replace（真正的整本替换语义）应清空——两种 API 语义必须不同
  await db.replaceBookContent({
    book,
    document: makeDoc('b3'),
    units: unitsV2,
  });
  all = await db.loadAll();
  check('不带 preserve 的整本替换语义仍清空进度', (all.progress['b3']?.readRanges?.length ?? -1) === 0);
}

async function snapshotRoundTrip(): Promise<void> {
  console.log('4. 快照 round-trip（导出 → 清空 → 导入 → 水合）');
  __resetAllDatabases();

  const book = makeBook('b4', '同步书');
  await db.putBookWithContent(book, makeDoc('b4'), [makeUnit('b4', 0, 0, 11)]);
  const ranges: ReadRange[] = [
    { chapterId: chapterIdOf('b4'), startNode: 0, endNode: 4, via: 'feed', at: 1 },
  ];
  await db.putProgress({ bookId: 'b4', readRanges: ranges, readUnitIds: [], updatedAt: 2 });
  await db.putHighlight({
    id: 'hl1', unitId: 'b4-unit-0', bookId: 'b4', text: '一条划线', chapterId: chapterIdOf('b4'), nodeIndex: 2, createdAt: 3,
  });
  const kp: KnowledgePoint = {
    id: 'kp1', bookId: 'b4', chapterId: chapterIdOf('b4'),
    sourceRanges: [{ chapterId: chapterIdOf('b4'), chapterTitle: '第一章', startNode: 0, endNode: 4 }],
    concept: '概念', explanation: '解释', quote: '原文句', generatedBy: 'test', createdAt: 4,
  };
  await db.putKnowledgePoints([kp]);
  await db.putQuizAttempts([{
    id: 'att1', knowledgePointId: 'kp1', bookId: 'b4', level: 1, questionId: 'q1', correct: true, createdAt: 5,
  }]);
  await db.putMarks({ favorites: { 'b4-unit-0': true }, unitFeedback: {}, bookScore: {}, topicScore: {} });

  // 导出快照（sync.ts buildSnapshot 的等价物）
  const before = await db.loadAll();
  const snapshot = {
    version: 1 as const,
    books: before.books,
    documents: await db.getAllDocuments(),
    units: before.units,
    progress: before.progress,
    highlights: before.highlights,
    notes: before.notes,
    marks: before.marks,
    knowledgePoints: before.knowledgePoints,
    quizAttempts: before.quizAttempts,
    readerPrefs: {},
  };

  await db.clearAllData();
  let after = await db.loadAll();
  check('清空后无数据', after.books.length === 0 && after.progress['b4'] === undefined);

  await db.replaceAllData({
    books: snapshot.books,
    documents: snapshot.documents,
    units: snapshot.units,
    progress: snapshot.progress,
    highlights: snapshot.highlights,
    notes: snapshot.notes,
    marks: snapshot.marks,
    knowledgePoints: snapshot.knowledgePoints,
    quizAttempts: snapshot.quizAttempts,
  });
  after = await db.loadAll();

  check(
    '快照恢复：全部书籍原样回来',
    JSON.stringify(after.books.map((b) => b.id)) === JSON.stringify(snapshot.books.map((b) => b.id)),
  );
  check('快照恢复：readRanges 逐字节一致', JSON.stringify(after.progress['b4']?.readRanges) === JSON.stringify(ranges));
  check('快照恢复：划线一致', after.highlights.length === 1 && after.highlights[0].nodeIndex === 2);
  check('快照恢复：知识点一致', JSON.stringify(after.knowledgePoints) === JSON.stringify(snapshot.knowledgePoints));
  check('快照恢复：作答记录一致', JSON.stringify(after.quizAttempts) === JSON.stringify(snapshot.quizAttempts));
  check('快照恢复：收藏一致', after.marks.favorites['b4-unit-0'] === true);
  check('快照恢复：半覆盖单元不进派生缓存（0–4 已读 / 单元 0–11）', after.progress['b4']?.readUnitIds?.length === 0);
}

async function cascadeDelete(): Promise<void> {
  console.log('5. 级联删除隔离');
  __resetAllDatabases();

  for (const id of ['b5', 'b6']) {
    await db.putBookWithContent(makeBook(id, `书${id}`), makeDoc(id), [makeUnit(id, 0, 0, 11)]);
    await db.putProgress({
      bookId: id,
      readRanges: [{ chapterId: chapterIdOf(id), startNode: 0, endNode: 3, via: 'feed', at: 1 }],
      readUnitIds: [],
      updatedAt: 2,
    });
    await db.putKnowledgePoints([{
      id: `kp-${id}`, bookId: id, chapterId: chapterIdOf(id),
      sourceRanges: [], concept: 'c', explanation: 'e', generatedBy: 'test', createdAt: 3,
    }]);
    await db.putQuizAttempts([{
      id: `att-${id}`, knowledgePointId: `kp-${id}`, bookId: id, level: 1, questionId: 'q', correct: false, createdAt: 4,
    }]);
  }
  await db.deleteBookCascade('b5');
  const all = await db.loadAll();
  check('删除书消失', all.books.every((b) => b.id !== 'b5'));
  check('其进度消失', all.progress['b5'] === undefined);
  check('其知识点消失', !all.knowledgePoints.some((k) => k.bookId === 'b5'));
  check('其作答消失', !all.quizAttempts.some((a) => a.bookId === 'b5'));
  check('另一本书完全不受影响', all.progress['b6']?.readRanges?.length === 1 && all.books.some((b) => b.id === 'b6'));
}

// CJS 包内的 .ts 脚本经 tsx/esbuild 转换后不支持 top-level await（Node 26 / tsx 4.21 实测），
// 汇总与退出码放进 main()，避免异步用例未完成就打印「通过」。
async function main(): Promise<void> {
  await lifecycle();
  await legacyMigration();
  await resegmentPreserves();
  await snapshotRoundTrip();
  await cascadeDelete();
}

main()
  .then(() => {
    console.log(`\n${passed} 项断言通过${failures.length > 0 ? `，${failures.length} 项失败` : '，全部通过 ✓'}`);
    if (failures.length > 0) {
      process.exit(1);
    }
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
