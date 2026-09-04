import { GraduationCap, Highlighter, StickyNote, Flame, BookOpen, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { estimateReadingMinutes, cn } from '../lib/utils';
import { BookCover } from './BookCover';

export function Study() {
  const { t } = useTranslation();
  const books = useStore((s) => s.books);
  const units = useStore((s) => s.units);
  const progressMap = useStore((s) => s.progress);
  const highlights = useStore((s) => s.highlights);
  const notes = useStore((s) => s.notes);
  const openReader = useStore((s) => s.openReader);

  const readSet = new Set(Object.values(progressMap).flatMap((p) => p.readUnitIds));

  const readUnitCount = Object.values(progressMap).reduce((sum, p) => sum + p.readUnitIds.length, 0);
  const readMinutes = units
    .filter((u) => progressMap[u.bookId]?.readUnitIds.includes(u.id))
    .reduce((sum, u) => sum + estimateReadingMinutes(u.sourceText), 0);
  const totalBooks = books.length;

  const stats = [
    { icon: BookOpen, label: t('study.statBooks'), value: `${totalBooks}` },
    { icon: Flame, label: t('study.statUnits'), value: `${readUnitCount}` },
    { icon: Highlighter, label: t('study.statHighlights'), value: `${highlights.length}` },
    { icon: StickyNote, label: t('study.statNotes'), value: `${notes.length}` },
  ];

  const bookById = new Map(books.map((b) => [b.id, b]));

  // 在读的书：已开始但未读完，按最近阅读时间排序
  const readingBooks = books
    .map((b) => {
      const readCount = progressMap[b.id]?.readUnitIds.length ?? 0;
      const bookUnits = units.filter((u) => u.bookId === b.id).sort((a, x) => a.order - x.order);
      return { book: b, readCount, total: b.unitCount || bookUnits.length, bookUnits };
    })
    .filter((x) => x.readCount > 0 && x.total > 0 && x.readCount < x.total)
    .sort(
      (a, b) =>
        (progressMap[b.book.id]?.updatedAt ?? 0) - (progressMap[a.book.id]?.updatedAt ?? 0),
    );

  // 读过的笔记：跨书汇总，按书名分组排序（同书内按单元顺序）
  const readNotes = units
    .filter((u) => readSet.has(u.id))
    .sort((a, b) => {
      const ta = bookById.get(a.bookId)?.title ?? '';
      const tb = bookById.get(b.bookId)?.title ?? '';
      return ta.localeCompare(tb) || a.order - b.order;
    });

  const continueBook = (entry: (typeof readingBooks)[number]) => {
    const next = entry.bookUnits.find((u) => !readSet.has(u.id)) ?? entry.bookUnits[0];
    if (next) openReader(next.id, entry.bookUnits.map((u) => u.id));
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#e85d2c] text-white">
          <GraduationCap size={22} />
        </span>
        <div>
          <h1 className="reading-text text-xl font-bold tracking-tight text-ink">{t('study.title')}</h1>
          <p className="text-xs text-muted">{t('study.subtitle')}</p>
        </div>
      </div>

      {/* 总览统计 */}
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
            <s.icon size={18} className="mb-2 text-[#e85d2c]" />
            <p className="reading-text text-2xl font-bold text-ink">{s.value}</p>
            <p className="text-xs text-muted">{s.label}</p>
          </div>
        ))}
      </div>

      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
        {t('study.readingTime')}
      </p>
      <div className="mb-10 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
        <p className="reading-text text-3xl font-bold text-ink">
          {readMinutes < 60 ? `${readMinutes}` : `${Math.floor(readMinutes / 60)}`}
          <span className="ml-1 text-base font-normal text-muted">
            {readMinutes < 60 ? t('common.minutes') : t('common.hours')}
          </span>
        </p>
        <p className="mt-1 text-xs text-muted">{t('study.readingTimeNote')}</p>
      </div>

      {/* 在读的书 */}
      {readingBooks.length > 0 && (
        <>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {t('study.inProgressTitle')}
          </p>
          <div className="mb-10 flex flex-col gap-2">
            {readingBooks.map(({ book, readCount, total, bookUnits }) => {
              const pct = Math.round((readCount / Math.max(total, 1)) * 100);
              return (
                <button
                  key={book.id}
                  type="button"
                  onClick={() => continueBook({ book, readCount, total, bookUnits })}
                  className="group flex items-center gap-3 rounded-2xl bg-surface p-3 text-left shadow-sm ring-1 ring-line transition-colors hover:ring-accent"
                >
                  <BookCover book={book} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="reading-text truncate text-sm font-bold text-ink">{book.title}</p>
                    <p className="truncate text-xs text-muted">{book.author}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-muted">
                        {t('study.unitProgress', { read: readCount, total })}
                      </span>
                    </div>
                  </div>
                  <ChevronRight
                    size={16}
                    className="shrink-0 text-muted transition-colors group-hover:text-accent"
                  />
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 读过的笔记 */}
      {readNotes.length > 0 && (
        <>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {t('study.readNotesTitle')}
          </p>
          <div className={cn('mb-10 flex flex-col gap-1.5')}>
            {readNotes.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => openReader(u.id, [u.id])}
                className="group flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface"
              >
                <span className="shrink-0 font-mono text-[10px] tracking-[0.15em] text-muted">
                  {String(u.order + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="reading-text block truncate text-sm font-medium text-ink">
                    {u.ai.title}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {bookById.get(u.bookId)?.title ?? ''}
                  </span>
                </span>
                <ChevronRight
                  size={14}
                  className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                />
              </button>
            ))}
          </div>
        </>
      )}

      {/* Quiz 占位 */}
      <div
        className={cn(
          'relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#f3e7d3] to-[#f6ddd0] p-8 text-center',
          'dark:from-[#2e261c] dark:to-[#33261f]',
        )}
      >
        <GraduationCap size={40} className="mx-auto mb-4 text-[#e85d2c]" />
        <h2 className="reading-text mb-2 text-lg font-bold text-ink">{t('study.quizComing')}</h2>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted">{t('study.quizBody')}</p>
        <span className="mt-5 inline-block rounded-full bg-[#e85d2c] px-5 py-2 text-sm font-medium text-white">
          {t('study.quizBadge')}
        </span>
      </div>
    </div>
  );
}
