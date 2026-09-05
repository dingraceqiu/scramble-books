import { useEffect, useRef, useState } from 'react';
import { BookText, CheckCircle2, ChevronDown, FileText, Highlighter, Loader2, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore, coverageOf } from '../store/useStore';
import { BookCover } from './BookCover';
import { MarksList } from './reader/MarksList';
import { formatDateLocal, estimateReadingMinutes } from '../lib/utils';
import type { BookType } from '../types';

/** 手动改类型时可选的类型（上传时自动推测，不在此列） */
const TYPE_OPTIONS: BookType[] = [
  'social_science',
  'biography',
  'history',
  'business',
  'philosophy',
  'fiction',
  'other',
];

export function Library() {
  const { t, i18n } = useTranslation();
  const {
    books, units, progress, tasks,
    ingestFiles, loadSample, deleteBook, openBookReader, setBookType,
  } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [marksBookId, setMarksBookId] = useState<string | null>(null);
  /** 正在改类型的书 id（打开类型下拉） */
  const [typeMenuId, setTypeMenuId] = useState<string | null>(null);
  const typeMenuRef = useRef<HTMLDivElement | null>(null);

  // 点击类型菜单外部时关闭
  useEffect(() => {
    if (!typeMenuId) return;
    const onDocClick = (e: MouseEvent) => {
      if (typeMenuRef.current && !typeMenuRef.current.contains(e.target as Node)) {
        setTypeMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [typeMenuId]);

  if (marksBookId) {
    return <MarksList bookId={marksBookId} onBack={() => setMarksBookId(null)} />;
  }

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const accepted = [...files].filter((f) => /\.(epub|txt)$/i.test(f.name));
    if (accepted.length === 0) return;
    // 上传后自动推测类型，不弹框；猜错了可在书库里随时手动改
    void ingestFiles(accepted);
  };

  const startReading = (bookId: string) => {
    // 书库点书 → 进入连续阅读页（自动定位到上次读到的位置）
    void openBookReader(bookId, { returnView: 'library' });
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pb-28 pt-4 sm:px-6">
      {/* 上传区 */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`mb-6 flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-accent/60'
        }`}
      >
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Upload size={22} />
        </div>
        <p className="mb-1 text-sm font-medium text-ink">{t('library.dropText')}</p>
        <p className="mb-4 text-xs text-muted">{t('library.dropSubtext')}</p>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted">
          <Wand2 size={12} /> {t('library.uploadHint')}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".epub,.txt"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <button
        type="button"
        onClick={() => void loadSample()}
        className="mb-8 flex w-full items-center justify-center gap-2 rounded-2xl bg-surface py-3 text-sm text-ink-soft ring-1 ring-line transition-colors hover:text-accent"
      >
        <Sparkles size={15} className="text-accent" />
        {t('library.sampleCta')}
      </button>

      {/* 解析任务 */}
      {tasks.length > 0 && (
        <div className="mb-6 space-y-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`flex items-center gap-3 rounded-xl bg-surface px-4 py-3 text-sm ring-1 ${
                task.status === 'error' ? 'ring-red-400' : 'ring-line'
              }`}
            >
              {task.status === 'error' ? (
                <FileText size={16} className="shrink-0 text-red-500" />
              ) : task.status === 'done' ? (
                <FileText size={16} className="shrink-0 text-accent" />
              ) : (
                <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
              )}
              <span className="truncate text-ink">{task.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted">
                {task.status === 'error' || task.status === 'done' ? task.message : t('library.parsing')}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 书库列表 */}
      <div className="mb-4 flex items-center gap-2">
        <BookText size={17} className="text-accent" />
        <h2 className="reading-text text-lg font-bold text-ink">{t('library.title')}</h2>
        <span className="text-sm text-muted">{books.length}</span>
      </div>

      {books.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">{t('library.empty')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {books.map((book) => {
            const coverage = coverageOf(book, progress);
            const pct = Math.round(coverage * 100);
            const readIds = new Set(progress[book.id]?.readUnitIds ?? []);
            const readMinutes = units
              .filter((u) => u.bookId === book.id && readIds.has(u.id))
              .reduce((sum, u) => sum + estimateReadingMinutes(u.sourceText), 0);
            return (
              <div
                key={book.id}
                role="button"
                tabIndex={0}
                onClick={() => startReading(book.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    startReading(book.id);
                  }
                }}
                className="flex cursor-pointer gap-4 rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line transition-shadow hover:shadow-card-hover"
              >
                <BookCover book={book} size="md" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <h3 className="reading-text flex min-w-0 items-center gap-1.5 text-base font-bold text-ink">
                    <span className="truncate">{book.title}</span>
                    <span
                      className="relative shrink-0"
                      ref={typeMenuId === book.id ? typeMenuRef : undefined}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={typeMenuId === book.id}
                        title={t('library.changeType')}
                        onClick={() => setTypeMenuId(typeMenuId === book.id ? null : book.id)}
                        className="group/type flex items-center gap-0.5 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-soft transition-colors hover:bg-line hover:text-ink"
                      >
                        {t(`bookType.${book.bookType ?? 'social_science'}`)}
                        <ChevronDown
                          size={10}
                          className="opacity-0 transition-opacity group-hover/type:opacity-70"
                        />
                      </button>
                      {typeMenuId === book.id && (
                        <div
                          role="menu"
                          className="absolute left-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl bg-surface py-1 text-left shadow-card-hover ring-1 ring-line"
                        >
                          {TYPE_OPTIONS.map((value) => (
                            <button
                              key={value}
                              type="button"
                              role="menuitemradio"
                              aria-checked={book.bookType === value}
                              onClick={() => {
                                if (value !== book.bookType) {
                                  void setBookType(book.id, value);
                                }
                                setTypeMenuId(null);
                              }}
                              className={`flex w-full items-center justify-between px-3 py-2 text-xs transition-colors hover:bg-surface-2 ${
                                (book.bookType ?? 'social_science') === value
                                  ? 'font-semibold text-accent'
                                  : 'text-ink-soft'
                              }`}
                            >
                              {t(`bookType.${value}`)}
                              {(book.bookType ?? 'social_science') === value && (
                                <CheckCircle2 size={13} />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </span>
                  </h3>
                  <p className="mb-2 truncate text-xs text-muted">{book.author || t('common.unknownAuthor')}</p>
                  <p className="mb-2 text-xs text-muted">
                    {book.bookType === 'other'
                      ? t('library.chaptersOnly', { chapters: book.chapterCount })
                      : book.bookType === 'fiction'
                        ? t('library.chaptersFiction', { chapters: book.chapterCount, units: book.unitCount })
                        : t('library.unitsChapters', { chapters: book.chapterCount, units: book.unitCount })}
                    {' · '}
                    {t('library.importedOn', { date: formatDateLocal(book.createdAt, i18n.language) })}
                  </p>
                  <div className="mb-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-accent transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[11px] font-medium text-accent">{pct}%</span>
                  </div>
                  <p className="text-[11px] text-muted">
                    {readMinutes > 0
                      ? t('library.readMinutes', { count: readMinutes })
                      : t('library.notStarted')}
                  </p>
                  <div className="mt-auto flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startReading(book.id);
                      }}
                      className="rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                    >
                      {pct === 0 ? t('library.startReading') : pct === 100 ? t('library.reread') : t('library.continueReading')}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMarksBookId(book.id);
                      }}
                      className="flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-line"
                    >
                      <Highlighter size={13} /> {t('library.marksList')}
                    </button>
                    {confirmId === book.id ? (
                      <div
                        className="ml-auto flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            void deleteBook(book.id);
                            setConfirmId(null);
                          }}
                          className="rounded-full bg-red-500/90 px-2.5 py-1.5 text-xs text-white"
                        >
                          {t('common.confirm')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className="rounded-full px-2.5 py-1.5 text-xs text-muted"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={t('library.deleteBook')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmId(book.id);
                        }}
                        className="ml-auto rounded-full p-2 text-muted transition-colors hover:bg-surface-2 hover:text-red-500"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
