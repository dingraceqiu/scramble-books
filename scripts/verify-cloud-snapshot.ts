/** Cloud Snapshot V1/V2 compatibility and data-invariant regression suite. */
import assert from 'node:assert/strict';
import type {
  Book,
  CloudSnapshotV1,
  Highlight,
  KnowledgePoint,
  Note,
  ReadingUnit,
  SourceDocument,
} from '../src/types';
import {
  deriveUnitFields,
  deserializeCloudSnapshot,
  serializeCloudSnapshot,
  snapshotSizeDiagnostics,
} from '../src/lib/cloudSnapshot';
import * as db from '../src/lib/db';
import { coveredNodeCount } from '../src/lib/readState';
import { __resetAllDatabases } from './test-shims/idb.mjs';

function book(id: string, title: string, bookType: Book['bookType'] = 'social_science'): Book {
  return {
    id,
    title,
    author: 'Cloud Test',
    format: 'txt',
    bookType,
    createdAt: 1,
    unitCount: 0,
    nodeCount: 8,
    chapterCount: 2,
  };
}

const zhDoc: SourceDocument = {
  bookId: 'zh',
  chapters: [
    {
      id: 'zh-c1', index: 0, title: '第一章', nodes: [
        { id: 'zh-c1__n0', index: 0, type: 'heading', text: '第一章 选择' },
        { id: 'zh-c1__n1', index: 1, type: 'para', text: '中文原文必须逐字一致。' },
        { id: 'zh-c1__n2', index: 2, type: 'para', text: '第二段保留标点与 空格。' },
        { id: 'zh-c1__n3', index: 3, type: 'para', text: '章内后续单元会补上章标题。' },
      ],
    },
    {
      id: 'zh-c2', index: 1, title: '第二章', nodes: [
        { id: 'zh-c2__n0', index: 0, type: 'heading', text: '第二章 边界' },
        { id: 'zh-c2__n1', index: 1, type: 'para', text: '跨章范围也按文档顺序恢复。' },
        { id: 'zh-c2__n2', index: 2, type: 'list', text: '列表一：不能丢。' },
        { id: 'zh-c2__n3', index: 3, type: 'para', text: '收束。' },
      ],
    },
  ],
};

const enDoc: SourceDocument = {
  bookId: 'en',
  chapters: [{
    id: 'en-c1', index: 0, title: 'Chapter One', nodes: [
      { id: 'en-c1__n0', index: 0, type: 'para', text: 'A fiction unit starts without a heading.' },
      { id: 'en-c1__n1', index: 1, type: 'para', text: 'Its original punctuation stays intact.' },
    ],
  }],
};

function unit(
  id: string,
  bookId: string,
  order: number,
  document: SourceDocument,
  startChapterId: string,
  startNode: number,
  endChapterId: string,
  endNode: number,
  targetBook: Book,
): ReadingUnit {
  const startChapter = document.chapters.find((chapter) => chapter.id === startChapterId);
  const endChapter = document.chapters.find((chapter) => chapter.id === endChapterId);
  assert(startChapter && endChapter);
  const shell = {
    id,
    bookId,
    order,
    sourceStart: {
      chapterId: startChapterId,
      chapterTitle: startChapter.title,
      startNode,
      endNode,
    },
    sourceEnd: {
      chapterId: endChapterId,
      chapterTitle: endChapter.title,
      startNode,
      endNode,
    },
    coreSentence: bookId === 'zh' ? '中文原文必须逐字一致。' : 'Its original punctuation stays intact.',
    titleSupport: bookId === 'zh' ? '逐字一致' : 'punctuation stays intact',
    ai: {
      title: bookId === 'zh' ? `不重写原文 ${order}` : `Episode ${order + 1}`,
      estimatedReadingMinutes: 1,
      generator: 'glm-test-model',
    },
  };
  const derived = deriveUnitFields(shell, document, targetBook);
  assert(derived.sourceText !== undefined && derived.preview !== undefined);
  return {
    ...shell,
    ...(derived.headingText === undefined ? {} : { headingText: derived.headingText }),
    sourceText: derived.sourceText,
    preview: derived.preview,
  };
}

function fixture(): CloudSnapshotV1 {
  const zhBook = book('zh', '中文测试');
  const enBook = book('en', 'English test', 'fiction');
  const units = [
    unit('zh-u0', 'zh', 0, zhDoc, 'zh-c1', 0, 'zh-c1', 2, zhBook),
    unit('zh-u1', 'zh', 1, zhDoc, 'zh-c1', 3, 'zh-c1', 3, zhBook),
    unit('zh-cross', 'zh', 2, zhDoc, 'zh-c1', 3, 'zh-c2', 1, zhBook),
    unit('en-u0', 'en', 0, enDoc, 'en-c1', 0, 'en-c1', 1, enBook),
  ];
  // 模拟旧版/异常切分：坐标无法逐字推出展示字段，V2 必须保留 override。
  units.push({
    ...units[1],
    id: 'zh-legacy-override',
    order: 3,
    headingText: undefined,
    sourceText: '历史快照里的特殊拼接，不能猜。',
    preview: '历史预览',
  });
  const highlights: Highlight[] = [{
    id: 'hl-1', unitId: 'zh-u0', bookId: 'zh', text: '逐字一致',
    chapterId: 'zh-c1', nodeIndex: 1, createdAt: 10,
  }];
  const notes: Note[] = [{
    id: 'note-1', unitId: 'zh-u0', bookId: 'zh', content: '我的笔记', text: '逐字一致',
    chapterId: 'zh-c1', nodeIndex: 1, createdAt: 11,
  }];
  const knowledgePoints: KnowledgePoint[] = [{
    id: 'kp-1', bookId: 'zh', chapterId: 'zh-c1',
    sourceRanges: [{ chapterId: 'zh-c1', chapterTitle: '第一章', startNode: 1, endNode: 1 }],
    concept: '原文一致性', explanation: 'Feed 原文不可被改写', quote: '中文原文必须逐字一致。',
    generatedBy: 'glm-test-model', createdAt: 12,
  }];
  return {
    version: 1,
    books: [{ ...zhBook, unitCount: 4 }, { ...enBook, unitCount: 1, nodeCount: 2, chapterCount: 1 }],
    documents: [zhDoc, enDoc],
    units,
    progress: {
      zh: {
        bookId: 'zh',
        readRanges: [{ chapterId: 'zh-c1', startNode: 0, endNode: 2, via: 'feed', at: 20 }],
        readUnitIds: ['zh-u0'],
        updatedAt: 20,
      },
    },
    highlights,
    notes,
    marks: {
      favorites: { 'zh-u0': true }, unitFeedback: { 'zh-u1': 1 },
      bookScore: { zh: 2 }, topicScore: { test: 1 }, snoozedUntil: {}, partial: { 'zh-u1': 45 },
    },
    knowledgePoints,
    quizAttempts: [{
      id: 'attempt-1', knowledgePointId: 'kp-1', bookId: 'zh', level: 1,
      questionId: 'question-1', correct: true, createdAt: 13,
    }],
    readerPrefs: {
      settings: { fontSizeStep: 2 },
      bookmarks: [{ id: 'bm-1', bookId: 'zh', chapterId: 'zh-c1', nodeIndex: 1 }],
      positions: { zh: { chapterId: 'zh-c1', nodeIndex: 2 } },
      highlightColor: 'green',
    },
  };
}

function largeFixture(): CloudSnapshotV1 {
  const books: Book[] = [];
  const documents: SourceDocument[] = [];
  const units: ReadingUnit[] = [];
  for (let index = 0; index < 40; index += 1) {
    const id = `large-${index}`;
    const targetBook = book(id, `大书 ${index}`);
    const nodes = [
      { id: `${id}-c1__n0`, index: 0, type: 'heading' as const, text: `第 ${index} 章` },
      ...Array.from({ length: 20 }, (_, nodeIndex) => ({
        id: `${id}-c1__n${nodeIndex + 1}`,
        index: nodeIndex + 1,
        type: 'para' as const,
        text: `${index}-${nodeIndex}-` + '中英 mixed canonical source. '.repeat(80),
      })),
    ];
    const document: SourceDocument = {
      bookId: id,
      chapters: [{ id: `${id}-c1`, index: 0, title: `第 ${index} 章`, nodes }],
    };
    books.push({ ...targetBook, nodeCount: nodes.length, chapterCount: 1, unitCount: 1 });
    documents.push(document);
    units.push(unit(`${id}-u0`, id, 0, document, `${id}-c1`, 0, `${id}-c1`, 20, targetBook));
  }
  return {
    version: 1,
    books,
    documents,
    units,
    progress: {},
    highlights: [],
    notes: [],
    marks: { favorites: {}, unitFeedback: {}, bookScore: {}, topicScore: {} },
    knowledgePoints: [],
    quizAttempts: [],
    readerPrefs: {},
  };
}

async function run(): Promise<void> {
  const v1 = fixture();
  assert.deepEqual(deserializeCloudSnapshot(v1), v1, 'V1 快照应原样恢复');

  const v2 = serializeCloudSnapshot(v1);
  assert.equal(v2.version, 2, 'V1 应升级成 V2 wire format');
  assert.equal(v2.units[0].sourceText, undefined, '可重建 sourceText 应省略');
  assert.equal(v2.units[0].preview, undefined, '可重建 preview 应省略');
  assert.equal(v2.units[0].headingText, undefined, '可重建 headingText 应省略');
  const legacy = v2.units.find((candidate) => candidate.id === 'zh-legacy-override');
  assert.equal(legacy?.sourceText, '历史快照里的特殊拼接，不能猜。', '异常 sourceText 必须保留 override');
  assert.equal(legacy?.preview, '历史预览', '异常 preview 必须保留 override');
  assert.equal(legacy?.headingText, null, '显式缺失的 headingText 必须以 null 保真');

  const restored = deserializeCloudSnapshot(v2);
  assert.deepEqual(restored.documents, v1.documents, 'documents / Canonical Source 一致');
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.units)),
    JSON.parse(JSON.stringify(v1.units)),
    'unit sourceText/order/全部展示字段一致',
  );
  assert.deepEqual(restored.progress, v1.progress, 'readRanges/progress 一致');
  assert.deepEqual(restored.highlights, v1.highlights, 'highlights 一致');
  assert.deepEqual(restored.notes, v1.notes, 'notes 一致');
  assert.deepEqual(restored.knowledgePoints, v1.knowledgePoints, 'KP/sourceRanges 一致');
  assert.deepEqual(restored.quizAttempts, v1.quizAttempts, 'quizAttempts 一致');
  assert.deepEqual(restored.readerPrefs, v1.readerPrefs, 'Reader prefs 一致');
  assert.deepEqual(
    JSON.parse(JSON.stringify(deserializeCloudSnapshot(serializeCloudSnapshot(restored)).units)),
    JSON.parse(JSON.stringify(v1.units)),
    'V1→V2 migration 幂等',
  );

  // V2 恢复后写入真实 IndexedDB 路径，再做 presentation re-segmentation；readRanges 必须保留。
  __resetAllDatabases();
  await db.replaceAllData(restored);
  const beforeResegment = await db.loadAll();
  const preservedRanges = beforeResegment.progress.zh.readRanges;
  const narrowerUnits = [
    unit('zh-new-0', 'zh', 0, zhDoc, 'zh-c1', 0, 'zh-c1', 1, v1.books[0]),
    unit('zh-new-1', 'zh', 1, zhDoc, 'zh-c1', 2, 'zh-c1', 3, v1.books[0]),
  ];
  await db.replaceBookContent({
    book: { ...v1.books[0], unitCount: narrowerUnits.length },
    document: zhDoc,
    units: narrowerUnits,
    preserveReadRanges: preservedRanges,
  });
  const afterResegment = await db.loadAll();
  assert.deepEqual(afterResegment.progress.zh.readRanges, preservedRanges, '重切分不丢 readRanges');
  assert.equal(coveredNodeCount(afterResegment.progress.zh.readRanges), 3, '重切分前后已读节点数一致');

  // 旧 V1 只有 readUnitIds 的进度仍走既有持久化迁移。
  __resetAllDatabases();
  await db.replaceAllData({
    ...v1,
    progress: { zh: { bookId: 'zh', readUnitIds: ['zh-u0'], updatedAt: 99 } } as CloudSnapshotV1['progress'],
  });
  const migratedProgress = (await db.loadAll()).progress.zh;
  assert.equal(coveredNodeCount(migratedProgress.readRanges), 3, '旧 readUnitIds 应迁移为等价 readRanges');

  const smallV1 = snapshotSizeDiagnostics(v1, v1);
  const smallV2 = snapshotSizeDiagnostics(v2, v1);
  assert(smallV2.totalBytes < smallV1.totalBytes, '中英文/跨章夹具 V2 必须小于 V1');

  const largeV1 = largeFixture();
  const largeV2 = serializeCloudSnapshot(largeV1);
  const largeV1Bytes = snapshotSizeDiagnostics(largeV1, largeV1).totalBytes;
  const largeV2Bytes = snapshotSizeDiagnostics(largeV2, largeV1).totalBytes;
  assert.deepEqual(deserializeCloudSnapshot(largeV2).units, largeV1.units, '大书库 round-trip 一致');
  assert(largeV2Bytes < largeV1Bytes * 0.7, '大书库 V2 应显著小于 V1（至少缩小 30%）');

  const reduction = (1 - largeV2Bytes / largeV1Bytes) * 100;
  console.log('Cloud Snapshot 回归通过：');
  console.log(`  V1/V2 restore + migration + IndexedDB + re-segmentation: ✓`);
  console.log(`  中英文 / 跨章 / legacy override / 大书库: ✓`);
  console.log(`  大书库体积：${largeV1Bytes} → ${largeV2Bytes} bytes（缩小 ${reduction.toFixed(2)}%）`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
