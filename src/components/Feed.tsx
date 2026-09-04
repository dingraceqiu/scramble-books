import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { recommend } from '../lib/recommender';
import { FeedCard } from './FeedCard';
import { BrandLogo } from './icons/Logo';
import type { FeedFilter, ReadingUnit } from '../types';

const FILTERS: { key: FeedFilter }[] = [
  { key: 'all' },
  { key: 'unread' },
  { key: 'read' },
  { key: 'favorites' },
];

/** 首批渲染卡片数 / 每次滚动加载数——大书（上千单元）也不卡顿 */
const PAGE_SIZE = 12;

/** 响应式栏数（与原 Tailwind 断点一致：默认 2 栏 / md 3 栏 / 2xl 4 栏） */
function useColumnCount(): number {
  const get = () =>
    typeof window === 'undefined' ? 2 : window.innerWidth >= 1536 ? 4 : window.innerWidth >= 768 ? 3 : 2;
  const [cols, setCols] = useState(get);
  useEffect(() => {
    const onResize = () => setCols(get());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return cols;
}

export function Feed() {
  const { t } = useTranslation();
  const {
    books, units, progress, marks, filter, search, feedSeed,
    setFilter, setSearch, reshuffle, setView, openReader,
    toggleFavorite, feedback,
  } = useStore();

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const columnCount = useColumnCount();

  const readSet = useMemo(
    () => new Set(Object.values(progress).flatMap((p) => p.readUnitIds)),
    [progress],
  );

  const bookMap = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);

  const ordered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    let candidates = units;
    if (filter === 'unread') candidates = units.filter((u) => !readSet.has(u.id));
    if (filter === 'read') candidates = units.filter((u) => readSet.has(u.id));
    if (filter === 'favorites') candidates = units.filter((u) => marks.favorites[u.id]);
    if (kw) {
      candidates = candidates.filter((u) => {
        const book = bookMap.get(u.bookId);
        return (
          u.ai.title.toLowerCase().includes(kw) ||
          (book?.title.toLowerCase().includes(kw) ?? false) ||
          u.sourceText.toLowerCase().includes(kw)
        );
      });
    }
    // feedSeed 作为洗牌种子参与排序：点「换一批」才重新洗牌，其余重算保持顺序稳定
    const bookTypeOf = (u: { bookId: string }) => bookMap.get(u.bookId)?.bookType;
    return recommend(candidates, {
      readUnitIds: readSet,
      marks,
      candidates,
      bookTypeOf,
      seed: feedSeed,
      progress,
    });
  }, [units, marks, filter, search, readSet, bookMap, feedSeed, progress]);

  // 切换筛选 / 搜索 / 换一批时回到首批
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, search, feedSeed]);

  // 无限滚动：哨兵进入视口时追加一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, ordered.length));
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ordered.length]);

  // 注意：以下 useMemo 必须在「书架为空」的提前 return 之前调用，保证 hooks 顺序一致
  const visible = ordered.slice(0, visibleCount);

  // 稳定瀑布流：按序号轮转分配到固定栏。往下滑加载新卡片时，
  // 已有卡片永远留在原位（CSS 多栏会在加卡片时重新平衡、导致卡片跳栏）。
  const columns = useMemo(() => {
    const cols: Array<Array<{ unit: ReadingUnit; gi: number }>> = Array.from(
      { length: columnCount },
      () => [],
    );
    visible.forEach((unit, i) => cols[i % columnCount].push({ unit, gi: i }));
    return cols;
  }, [visible, columnCount]);

  if (books.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <div className="mb-5 flex items-center justify-center">
          <BrandLogo size={76} className="drop-shadow-card" />
        </div>
        <h2 className="reading-text mb-2 text-2xl font-bold text-ink">{t('feed.emptyTitle')}</h2>
        <p className="mb-8 text-sm leading-relaxed text-muted">{t('feed.emptyBody')}</p>
        <button
          type="button"
          onClick={() => setView('library')}
          className="flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-medium text-white shadow-card transition-transform hover:scale-[1.03]"
        >
          <Upload size={16} />
          {t('feed.emptyCta')}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-3 pb-28 pt-4 sm:px-6">
      {/* 搜索 + 筛选 */}
      <div className="sticky top-0 z-10 -mx-3 mb-4 bg-paper/90 px-3 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('feed.searchPlaceholder')}
              className="w-full rounded-full border border-line bg-surface py-2 pl-9 pr-4 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-accent"
            />
          </div>
          <button
            type="button"
            onClick={reshuffle}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-sm text-ink-soft transition-colors hover:border-accent hover:text-accent"
          >
            <RefreshCw size={14} />
            <span className="hidden sm:inline">{t('feed.reshuffle')}</span>
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-ink text-paper'
                  : 'bg-surface text-muted ring-1 ring-line hover:text-ink'
              }`}
            >
              {t(`feed.filters.${f.key}`)}
            </button>
          ))}
          <span className="ml-auto hidden text-xs text-muted sm:inline">
            {t('feed.unitCount', { count: ordered.length, coverage: totalCoverage() })}
          </span>
        </div>
      </div>

      {ordered.length === 0 ? (
        <div className="py-20 text-center text-sm text-muted">
          {filter === 'favorites' ? (
            t('feed.emptyFilter.favorites')
          ) : filter === 'unread' ? (
            t('feed.emptyFilter.unread')
          ) : filter === 'read' ? (
            t('feed.emptyFilter.read')
          ) : (
            t('feed.emptyFilter.search')
          )}
        </div>
      ) : (
        <>
          <div className="flex gap-3 sm:gap-4">
            {columns.map((col, ci) => (
              <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3 sm:gap-4">
                {col.map(({ unit, gi }) => (
                  <FeedCard
                    key={unit.id}
                    unit={unit}
                    index={gi}
                    book={bookMap.get(unit.bookId)}
                    read={readSet.has(unit.id)}
                    favorited={!!marks.favorites[unit.id]}
                    feedback={marks.unitFeedback[unit.id]}
                    onOpen={() => openReader(unit.id, ordered.map((u) => u.id))}
                    onFavorite={() => toggleFavorite(unit.id)}
                    onFeedback={(dir) => feedback(unit.id, dir)}
                  />
                ))}
              </div>
            ))}
          </div>
          {visibleCount < ordered.length && (
            <div ref={sentinelRef} className="py-10 text-center text-xs text-muted">
              {t('feed.loadingMore')}
            </div>
          )}
        </>
      )}
    </div>
  );

  function totalCoverage(): string {
    const total = units.length;
    if (total === 0) return '0%';
    const readCount = units.filter((u) => readSet.has(u.id)).length;
    return `${Math.round((readCount / total) * 100)}%`;
  }
}
