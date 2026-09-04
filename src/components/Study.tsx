import { GraduationCap, Highlighter, StickyNote, Flame, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { estimateReadingMinutes, cn } from '../lib/utils';

export function Study() {
  const { t } = useTranslation();
  const books = useStore((s) => s.books);
  const units = useStore((s) => s.units);
  const progressMap = useStore((s) => s.progress);
  const highlights = useStore((s) => s.highlights);
  const notes = useStore((s) => s.notes);

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
