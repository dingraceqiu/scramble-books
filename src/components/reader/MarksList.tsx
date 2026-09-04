import { useMemo, useState } from 'react';
import { ArrowLeft, Highlighter, StickyNote, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/useStore';
import { formatDateLocal, cn } from '../../lib/utils';
import type { HighlightColor } from '../../types';

const HL_DOT: Record<HighlightColor, string> = {
  yellow: '#e8c65e',
  green: '#a9c98d',
  blue: '#9dbdd6',
  pink: '#e2a8b4',
};

/** 某本书的划线与笔记列表（从书库进入），点击跳转 Reader 原文位置 */
export function MarksList({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const books = useStore((s) => s.books);
  const highlights = useStore((s) => s.highlights);
  const notes = useStore((s) => s.notes);
  const removeHighlight = useStore((s) => s.removeHighlight);
  const removeNote = useStore((s) => s.removeNote);
  const openBookReader = useStore((s) => s.openBookReader);
  const [tab, setTab] = useState<'all' | 'hl' | 'note'>('all');

  const book = books.find((b) => b.id === bookId);

  type Row =
    | { kind: 'hl'; id: string; text: string; color?: HighlightColor; chapterId?: string; nodeIndex?: number; createdAt: number }
    | { kind: 'note'; id: string; content: string; source?: string; chapterId?: string; nodeIndex?: number; createdAt: number };

  const rows = useMemo<Row[]>(() => {
    const hls: Row[] = highlights
      .filter((h) => h.bookId === bookId)
      .map((h) => ({
        kind: 'hl',
        id: h.id,
        text: h.text,
        color: h.color,
        chapterId: h.chapterId,
        nodeIndex: h.nodeIndex,
        createdAt: h.createdAt,
      }));
    const nts: Row[] = notes
      .filter((n) => n.bookId === bookId)
      .map((n) => ({
        kind: 'note',
        id: n.id,
        content: n.content,
        source: n.text,
        chapterId: n.chapterId,
        nodeIndex: n.nodeIndex,
        createdAt: n.createdAt,
      }));
    const all = [...hls, ...nts].filter((r) => tab === 'all' || r.kind === tab);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }, [highlights, notes, bookId, tab]);

  const hlCount = highlights.filter((h) => h.bookId === bookId).length;
  const noteCount = notes.filter((n) => n.bookId === bookId).length;

  const jump = (chapterId?: string, nodeIndex?: number) => {
    if (!chapterId || nodeIndex === undefined) {
      void openBookReader(bookId);
      return;
    }
    void openBookReader(bookId, { anchor: { chapterId, nodeIndex }, returnView: 'library' });
  };

  const tabs = [
    { key: 'all' as const, label: t('reader.highlights.all') },
    { key: 'hl' as const, label: t('study.statHighlights') },
    { key: 'note' as const, label: t('study.statNotes') },
  ];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-6 flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
      >
        <ArrowLeft size={16} /> {t('reader.backToLibrary')}
      </button>

      <h1 className="reading-text mb-1 text-xl font-bold text-ink">{book?.title ?? t('reader.marks')}</h1>
      <p className="mb-5 text-xs text-muted">
        {t('reader.highlights.summary', { highlights: hlCount, notes: noteCount })}
      </p>

      <div className="mb-5 inline-flex rounded-full bg-surface-2 p-0.5">
        {tabs.map((tabItem) => (
          <button
            key={tabItem.key}
            type="button"
            onClick={() => setTab(tabItem.key)}
            className={cn(
              'rounded-full px-4 py-1.5 text-sm transition-colors',
              tab === tabItem.key ? 'bg-accent font-medium text-white' : 'text-muted',
            )}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">{t('reader.highlights.emptyAll')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={`${r.kind}-${r.id}`}
              role="button"
              tabIndex={0}
              onClick={() => jump(r.chapterId, r.nodeIndex)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jump(r.chapterId, r.nodeIndex);
              }}
              className="group cursor-pointer rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line transition-shadow hover:shadow-lift"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
                  {r.kind === 'hl' ? (
                    <>
                      <Highlighter size={13} style={{ color: HL_DOT[r.color ?? 'yellow'] }} /> {t('study.statHighlights')}
                    </>
                  ) : (
                    <>
                      <StickyNote size={13} className="text-accent" /> {t('study.statNotes')}
                    </>
                  )}
                  <span className="text-muted/70">· {formatDateLocal(r.createdAt, i18n.language)}</span>
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (r.kind === 'hl') removeHighlight(r.id);
                    else removeNote(r.id);
                  }}
                  className="text-muted/50 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {r.kind === 'hl' ? (
                <blockquote
                  className="reading-text border-l-[3px] pl-3 text-sm leading-relaxed text-ink-soft"
                  style={{ borderColor: HL_DOT[r.color ?? 'yellow'] }}
                >
                  {r.text}
                </blockquote>
              ) : (
                <div>
                  <p className="reading-text mb-1.5 text-sm font-medium leading-relaxed text-ink">{r.content}</p>
                  {r.source && (
                    <blockquote className="reading-text border-l-[3px] border-accent/40 pl-3 text-xs leading-relaxed text-muted">
                      {r.source}
                    </blockquote>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
