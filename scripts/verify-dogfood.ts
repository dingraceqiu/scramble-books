/**
 * Dogfood 日志与 Feed 现场恢复回归测试（P0）。
 *
 * 覆盖：
 *   1. 事件环形上限（永不无限膨胀）
 *   2. 快速跳过判定阈值
 *   3. summarize 汇总口径（Feed→Reader 次数 / 跳过率 / AI 标题曝光）
 *   4. Feed 现场保存与恢复（store 层 feedState / pendingModalUnitId）
 *
 * 运行：pnpm verify:dogfood
 * 需要 test-shims（内存 IndexedDB + i18n 替身）。
 */
import type { DogfoodEvent } from '../src/lib/dogfood.ts';
import {
  DOGFOOD_CAP,
  QUICK_SKIP_MS,
  appendEvent,
  isQuickSkip,
  summarize,
} from '../src/lib/dogfood.ts';
import { useStore } from '../src/store/useStore.ts';

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

// ---------- 1. 环形上限 ----------
let list: DogfoodEvent[] = [];
for (let i = 0; i < DOGFOOD_CAP + 500; i++) {
  list = appendEvent(list, { t: i, type: 'feed_card_viewed', quickSkip: false });
}
check(`环形上限：事件数封顶 ${DOGFOOD_CAP}`, list.length === DOGFOOD_CAP);
check('环形上限：保留的是最新事件', list[list.length - 1].t === DOGFOOD_CAP + 499);
check('环形上限：不修改入参数组', appendEvent([], { t: 0, type: 'x' }).length === 1);

// ---------- 2. 快速跳过 ----------
check('快速跳过：低于阈值为 true', isQuickSkip(QUICK_SKIP_MS - 1));
check('快速跳过：达到阈值不算跳过', !isQuickSkip(QUICK_SKIP_MS));
check('快速跳过：长驻留不算跳过', !isQuickSkip(60_000));

// ---------- 3. summarize 汇总 ----------
const events: DogfoodEvent[] = [
  { t: 1, type: 'app_open', books: 2 },
  { t: 2, type: 'feed_card_viewed', quickSkip: false, generator: 'glm-4-flash' },
  { t: 3, type: 'feed_card_viewed', quickSkip: true, generator: 'mock-heuristic-v3' },
  { t: 4, type: 'feed_open_reader', unitId: 'u1', bookId: 'b1' },
  { t: 5, type: 'reader_open', bookId: 'b1' },
  { t: 6, type: 'read_ranges_added', bookId: 'b1', via: 'feed', nodes: 12 },
  { t: 7, type: 'read_ranges_added', bookId: 'b1', via: 'reader', nodes: 8 },
  { t: 8, type: 'study_open' },
  { t: 9, type: 'quiz_start', questions: 5 },
  { t: 10, type: 'quiz_answer', level: 1, correct: true },
  { t: 11, type: 'chapter_complete', bookId: 'b1', chapterId: 'c1', pct: 95 },
  { t: 12, type: 'session_end', durationMs: 60_000 },
];
const s = summarize(events);
check('汇总：session 数', s.sessions === 1);
check('汇总：卡片浏览数', s.cardViews === 2);
check('汇总：跳过数', s.cardSkips === 1);
check('汇总：跳过率', s.skipRate === 0.5);
check('汇总：Feed→Reader 次数', s.feedToReader === 1);
check('汇总：Reader 打开次数', s.readerOpens === 1);
check('汇总：新增已读节点数', s.nodesRead === 20);
check('汇总：Study/Quiz 进入', s.studyOpens === 1 && s.quizStarts === 1 && s.quizAnswers === 1);
check('汇总：AI 标题曝光 / mock 曝光', s.aiTitleViews === 1 && s.mockTitleViews === 1);
check('汇总：章节完成提示', s.chapterCompletions === 1);

// ---------- 4. Feed 现场保存 / 恢复（store 层） ----------
useStore.getState().saveFeedState({ visibleCount: 36, scrollY: 2400 });
check('Feed 现场：保存后可读回', useStore.getState().feedState?.scrollY === 2400);
useStore.getState().saveFeedState(null);
check('Feed 现场：消费后清除', useStore.getState().feedState === null);
useStore.getState().setPendingModalUnitId('unit-abc');
check('弹层恢复：可记录待恢复单元', useStore.getState().pendingModalUnitId === 'unit-abc');
useStore.getState().setPendingModalUnitId(null);
check('弹层恢复：用后即清', useStore.getState().pendingModalUnitId === null);

// ---------- 结果 ----------
console.log(`\ndogfood: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('FAILED:', failures.join(' | '));
  process.exit(1);
}
