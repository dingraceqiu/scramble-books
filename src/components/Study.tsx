import { useEffect, useMemo, useState } from 'react';
import { GraduationCap, Highlighter, StickyNote, Flame, BookOpen, ChevronRight, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { estimateReadingMinutes, cn } from '../lib/utils';
import { buildRecallQuestion, masteryByLevel } from '../lib/knowledge';
import { buildRangesByChapter } from '../lib/readState';
import { BookCover } from './BookCover';

export function Study() {
  const { t } = useTranslation();
  const books = useStore((s) => s.books);
  const units = useStore((s) => s.units);
  const progressMap = useStore((s) => s.progress);
  const highlights = useStore((s) => s.highlights);
  const notes = useStore((s) => s.notes);
  const openReader = useStore((s) => s.openReader);
  const openBookReader = useStore((s) => s.openBookReader);

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

      {/* 划线回顾：点击跳回原文位置 */}
      {highlights.length > 0 && (
        <>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {t('study.highlightsTitle')}
          </p>
          <div className="mb-10 flex flex-col gap-1.5">
            {[...highlights]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() =>
                    openBookReader(h.bookId, {
                      anchor:
                        h.chapterId && typeof h.nodeIndex === 'number'
                          ? { chapterId: h.chapterId, nodeIndex: h.nodeIndex }
                          : null,
                      returnView: 'study',
                    })
                  }
                  className="group flex items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface"
                >
                  <span aria-hidden className="mt-0.5 shrink-0 font-serif text-lg leading-none text-accent">
                    &ldquo;
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="reading-text block text-sm leading-relaxed text-ink [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                      {h.text}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {bookById.get(h.bookId)?.title ?? ''}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        </>
      )}

      {/* 我的笔记：点击跳回原文位置 */}
      {notes.length > 0 && (
        <>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {t('study.notesTitle')}
          </p>
          <div className="mb-10 flex flex-col gap-1.5">
            {[...notes]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() =>
                    openBookReader(n.bookId, {
                      anchor:
                        n.chapterId && typeof n.nodeIndex === 'number'
                          ? { chapterId: n.chapterId, nodeIndex: n.nodeIndex }
                          : null,
                      returnView: 'study',
                    })
                  }
                  className="group flex items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface"
                >
                  <StickyNote size={15} className="mt-1 shrink-0 text-[#d9a441]" />
                  <span className="min-w-0 flex-1">
                    <span className="reading-text block text-sm leading-relaxed text-ink [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">
                      {n.content}
                    </span>
                    {n.text && (
                      <span className="mt-0.5 block truncate text-xs italic text-muted">
                        {t('study.noteOnQuote', { quote: n.text })}
                      </span>
                    )}
                    <span className="block truncate text-xs text-muted">
                      {bookById.get(n.bookId)?.title ?? ''}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        </>
      )}

      {/* 知识点与测验（Learning Foundation：Source → KP → Level → Attempt → Mastery） */}
      <QuizSection />
    </div>
  );
}

/** 一道进行中的题（由 buildRecallQuestion 生成） */
interface ActiveQuestion {
  id: string;
  knowledgePointId: string;
  bookId: string;
  level: 1 | 2 | 3 | 4;
  question: string;
  options: string[];
  answerIndex: number;
  evidence: string;
}

/** Level 1（Recall）最小测验闭环：只考已读内容，每道题可回到原文 */
function QuizSection() {
  const { t } = useTranslation();
  const kps = useStore((s) => s.knowledgePoints);
  const progressMap = useStore((s) => s.progress);
  const attempts = useStore((s) => s.quizAttempts);
  const kpGenerating = useStore((s) => s.kpGenerating);
  const books = useStore((s) => s.books);
  const hasAnyRead = useStore((s) =>
    Object.values(s.progress).some((p) => (p.readRanges?.length ?? 0) > 0),
  );
  const ensureKnowledgePoints = useStore((s) => s.ensureKnowledgePoints);
  const recordAttempt = useStore((s) => s.recordAttempt);
  const openBookReader = useStore((s) => s.openBookReader);

  const [round, setRound] = useState<ActiveQuestion[]>([]);
  const [qIdx, setQIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);

  // 进入学习页自动补齐知识点（只从已读原文抽取；无读取时静默跳过）
  useEffect(() => {
    if (hasAnyRead && kps.length === 0 && !kpGenerating) {
      void ensureKnowledgePoints();
    }
  }, [hasAnyRead, kps.length, kpGenerating, ensureKnowledgePoints]);

  const bookTitle = useMemo(() => new Map(books.map((b) => [b.id, b.title])), [books]);
  const recall = masteryByLevel(attempts)[1];

  // 「只考已读」不变量（TD-03）：出题时强制校验 KP 与干扰项的 sourceRanges ⊆ readRanges。
  // 不依赖「KP 集合恰好都来自已读」这个上游假设——TD-01 落地后该假设会失效。
  const readRangesByChapter = useMemo(
    () => buildRangesByChapter(Object.values(progressMap).flatMap((p) => p.readRanges ?? [])),
    [progressMap],
  );

  const startRound = () => {
    const candidates = [...kps].sort(() => Math.random() - 0.5);
    const qs: ActiveQuestion[] = [];
    for (const kp of candidates) {
      if (qs.length >= 5) break;
      const q = buildRecallQuestion(kp, kps, { readRangesByChapter });
      if (q) qs.push(q);
    }
    setRound(qs);
    setQIdx(0);
    setPicked(null);
  };

  const answer = (i: number) => {
    const q = round[qIdx];
    if (!q || picked !== null) return;
    setPicked(i);
    recordAttempt({
      knowledgePointId: q.knowledgePointId,
      bookId: q.bookId,
      level: q.level,
      questionId: q.id,
      correct: i === q.answerIndex,
    });
  };

  const current = round[qIdx] ?? null;
  const kpById = useMemo(() => new Map(kps.map((k) => [k.id, k])), [kps]);
  const currentKp = current ? kpById.get(current.knowledgePointId) : undefined;

  return (
    <div className="mb-10">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
        {t('quiz.sectionTitle')}
      </p>

      {/* 掌握度概览（Coverage 与 Mastery 分开：这里只看 Mastery） */}
      <div className="mb-3 grid grid-cols-3 gap-3">
        <div className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
          <p className="reading-text text-2xl font-bold text-ink">{kps.length}</p>
          <p className="text-xs text-muted">{t('quiz.kpCount')}</p>
        </div>
        <div className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
          <p className="reading-text text-2xl font-bold text-ink">
            {recall.rate === null ? '–' : `${Math.round(recall.rate * 100)}%`}
          </p>
          <p className="text-xs text-muted">{t('quiz.recallRate')}</p>
        </div>
        <div className="rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
          <p className="reading-text text-2xl font-bold text-ink">{recall.attempts}</p>
          <p className="text-xs text-muted">{t('quiz.attempts')}</p>
        </div>
      </div>

      {/* 测验进行区 */}
      {current ? (
        <div className="mb-3 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
          <p className="reading-text mb-4 text-sm font-bold leading-relaxed text-ink">{current.question}</p>
          <div className="flex flex-col gap-2">
            {current.options.map((opt, i) => {
              const isAnswer = i === current.answerIndex;
              const showState = picked !== null;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={showState}
                  onClick={() => answer(i)}
                  className={cn(
                    'reading-text rounded-xl px-4 py-3 text-left text-sm leading-relaxed transition-colors ring-1',
                    !showState && 'bg-paper text-ink ring-line hover:ring-accent',
                    showState && isAnswer && 'bg-accent-soft text-ink ring-accent',
                    showState && !isAnswer && picked === i && 'bg-red-500/10 text-muted ring-red-400/40',
                    showState && !isAnswer && picked !== i && 'bg-paper text-muted ring-line opacity-60',
                  )}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          {picked !== null && (
            <div className="mt-4 rounded-xl bg-surface-2/60 p-4 text-sm">
              <p className={cn('mb-1 font-bold', picked === current.answerIndex ? 'text-accent' : 'text-red-500')}>
                {picked === current.answerIndex ? t('quiz.correct') : t('quiz.wrong')}
              </p>
              {currentKp && <p className="reading-text mb-2 text-xs leading-relaxed text-ink-soft">{currentKp.explanation}</p>}
              <p className="mb-3 text-[11px] text-muted">{t('quiz.evidence')}</p>
              <blockquote className="reading-text mb-3 border-l-2 border-accent pl-3 text-xs leading-relaxed text-ink-soft">
                {current.evidence}
              </blockquote>
              {currentKp && (
                <button
                  type="button"
                  onClick={() =>
                    void openBookReader(currentKp.bookId, {
                      anchor: {
                        chapterId: currentKp.sourceRanges[0]?.chapterId ?? currentKp.chapterId,
                        nodeIndex: currentKp.sourceRanges[0]?.startNode ?? 0,
                      },
                      returnView: 'study',
                    })
                  }
                  className="flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-1.5 text-xs text-ink-soft ring-1 ring-line transition-colors hover:text-accent"
                >
                  <BookOpen size={13} /> {t('quiz.viewSource')}
                </button>
              )}
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (qIdx + 1 < round.length) {
                  setQIdx(qIdx + 1);
                  setPicked(null);
                } else {
                  startRound();
                }
              }}
              disabled={picked === null}
              className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
            >
              {qIdx + 1 < round.length ? t('quiz.next') : t('quiz.finish')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-3 rounded-2xl bg-surface p-6 text-center shadow-sm ring-1 ring-line">
          {kpGenerating ? (
            <p className="text-sm text-muted">{t('quiz.generating')}</p>
          ) : kps.length === 0 ? (
            <p className="text-sm text-muted">{t('quiz.noKp')}</p>
          ) : (
            <button
              type="button"
              onClick={startRound}
              className="rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.03]"
            >
              {t('quiz.start')}
            </button>
          )}
        </div>
      )}

      {/* 知识点列表：每个都能跳回原文（Knowledge Point ↔ SourceRange） */}
      {kps.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {kps
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 30)
            .map((kp) => (
              <button
                key={kp.id}
                type="button"
                onClick={() =>
                  void openBookReader(kp.bookId, {
                    anchor: {
                      chapterId: kp.sourceRanges[0]?.chapterId ?? kp.chapterId,
                      nodeIndex: kp.sourceRanges[0]?.startNode ?? 0,
                    },
                    returnView: 'study',
                  })
                }
                className="group flex items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface"
              >
                <Sparkles size={14} className="mt-1 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="reading-text block truncate text-sm font-medium text-ink">{kp.concept}</span>
                  <span className="block truncate text-xs text-muted">
                    {bookTitle.get(kp.bookId) ?? ''} · {kp.explanation}
                  </span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
