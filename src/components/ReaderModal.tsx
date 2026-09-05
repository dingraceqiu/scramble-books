import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Clock,
  EyeOff,
  Heart,
  Highlighter,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { formatReadingMinutes } from '../lib/utils';
import { sanitizeTitleQuotes } from '../lib/titleGen';

export function ReaderModal() {
  const { t, i18n } = useTranslation();
  const {
    readerId, units, books, progress, highlights, notes, marks,
    closeReader, nextUnit, nextUnitInBook, markRead, snoozeUnit, setPartialRead,
    toggleFavorite, feedback, openBookReader,
    addHighlight, removeHighlight, addNote, removeNote,
  } = useStore();

  const unit = units.find((u) => u.id === readerId) ?? null;
  const book = unit ? books.find((b) => b.id === unit.bookId) : undefined;

  // 同书顺序下一篇（「继续读这本书」按钮用）；已是本书最后一篇时为 null
  const nextInBook = useMemo(() => {
    if (!unit) return null;
    const bookUnits = units
      .filter((u) => u.bookId === unit.bookId)
      .sort((a, b) => a.order - b.order);
    const idx = bookUnits.findIndex((u) => u.id === unit.id);
    return bookUnits[idx + 1] ?? null;
  }, [units, unit]);
  const articleRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [sel, setSel] = useState<{ text: string; x: number; y: number; nodeIndex?: number } | null>(null);
  /** 恢复进度提示（打开时若有上次进度则显示，滚动后消失） */
  const [resumePct, setResumePct] = useState<number | null>(null);
  const partialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 恢复滚动进行中：抑制 onScroll 的副作用（清提示/存进度/标已读） */
  const restoringRef = useRef(false);

  const unitHighlights = useMemo(
    () => highlights.filter((h) => h.unitId === readerId).sort((a, b) => b.createdAt - a.createdAt),
    [highlights, readerId],
  );
  const unitNotes = useMemo(
    () => notes.filter((n) => n.unitId === readerId).sort((a, b) => b.createdAt - a.createdAt),
    [notes, readerId],
  );

  // 切换单元时：恢复上次阅读位置（若有）、清空选区与草稿
  useEffect(() => {
    const el = scrollRef.current;
    const pct = readerId ? useStore.getState().marks.partial?.[readerId] : undefined;
    setResumePct(pct != null && pct >= 5 && pct < 95 ? pct : null);
    // 恢复滚动本身会触发 onScroll，用标志位避免把进度提示瞬间清掉、把恢复位置当作用户浏览
    restoringRef.current = true;
    requestAnimationFrame(() => {
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTo({ top: pct != null && max > 0 ? (max * pct) / 100 : 0 });
        // 内容完整可见、无需滚动的短笔记：打开即等于读完
        if (max <= 0 && unit && readerId) {
          const alreadyRead = useStore
            .getState()
            .progress[unit.bookId]?.readUnitIds.includes(readerId);
          if (!alreadyRead) markRead(readerId, 'feed');
          if (useStore.getState().marks.partial?.[readerId] != null) setPartialRead(readerId, null);
        }
      }
      setTimeout(() => {
        restoringRef.current = false;
      }, 200);
    });
    setSel(null);
    setNoteDraft('');
  }, [readerId]);

  /**
   * 弹层内滚动上报：滚到 95% 记为已读（写入 readRanges 事实层）并清除进度；
   * 中途退出则防抖保存百分比，下次打开恢复到同一位置。
   */
  const handleModalScroll = () => {
    const el = scrollRef.current;
    if (!el || !unit || restoringRef.current) return;
    setResumePct(null);
    const max = el.scrollHeight - el.clientHeight;
    const pct = max <= 0 ? 100 : Math.round((el.scrollTop / max) * 100);
    if (pct >= 95) {
      const alreadyRead = useStore.getState().progress[book?.id ?? '']?.readUnitIds.includes(unit.id);
      if (!alreadyRead) markRead(unit.id, 'feed');
      if (useStore.getState().marks.partial?.[unit.id] != null) setPartialRead(unit.id, null);
      return;
    }
    if (pct < 5) return;
    if (partialTimer.current) clearTimeout(partialTimer.current);
    partialTimer.current = setTimeout(() => setPartialRead(unit.id, pct), 800);
  };

  // 弹层打开时锁定背景滚动
  useEffect(() => {
    if (unit) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [unit]);

  const paragraphs = useMemo(() => {
    if (!unit) return [] as { type: 'heading' | 'body'; text: string }[];
    const parts = unit.sourceText.split('\n\n').filter(Boolean);
    return parts.map((text, i) => ({
      type: i === 0 && unit.headingText && text === unit.headingText ? ('heading' as const) : ('body' as const),
      text,
    }));
  }, [unit]);

  if (!unit || !book) return null;

  const readIds = progress[book.id]?.readUnitIds ?? [];
  const bookUnits = units.filter((u) => u.bookId === book.id);
  const coveragePct = Math.round((readIds.length / Math.max(1, bookUnits.length)) * 100);
  const isFav = !!marks.favorites[unit.id];
  const fb = marks.unitFeedback[unit.id];

  const handleSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !articleRef.current) {
      setSel(null);
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 2) {
      setSel(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!articleRef.current.contains(range.commonAncestorContainer)) {
      setSel(null);
      return;
    }
    // 定位选区所在段落 → 映射回 SourceNode 下标。补齐 Source Range 后，
    // 弹层里划的线/写的笔记才能在 Reader 原文位置回显、且学习页可精确跳回原文。
    // 注意：非小说单元若不以章标题开头，切分器会把章标题拼到 sourceText 最前
    // （segmenter.ts），此时段落 0 不在节点区间内，后续段落下标整体前移一位；
    // 解析器保证节点文本不含空行，段落数与区间节点数的差值可精确判定该情形。
    const rangeSize = unit.sourceEnd.endNode - unit.sourceStart.startNode + 1;
    const partCount = unit.sourceText.split('\n\n').filter(Boolean).length;
    const prependedHeading = partCount === rangeSize + 1;
    const nodeIndexFor = (pIdx: number): number | undefined => {
      if (pIdx < 0) return undefined;
      if (prependedHeading) {
        // 拼接的章标题段：真实标题节点不在本单元区间内，不猜下标（跳转仍落到单元起点）
        return pIdx === 0 ? undefined : (unit.sourceStart.startNode ?? 0) + pIdx - 1;
      }
      return (unit.sourceStart.startNode ?? 0) + pIdx;
    };
    const ancestor =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    const block = ancestor?.closest('p, h3');
    const blocks = articleRef.current.querySelectorAll('p, h3');
    const pIdx = block ? Array.prototype.indexOf.call(blocks, block) : -1;
    const rect = range.getBoundingClientRect();
    const panelRect = scrollRef.current?.getBoundingClientRect();
    setSel({
      text: text.slice(0, 200),
      x: rect.left + rect.width / 2 - (panelRect?.left ?? 0),
      y: rect.top - (panelRect?.top ?? 0) + (scrollRef.current?.scrollTop ?? 0),
      nodeIndex: nodeIndexFor(pIdx),
    });
  };

  const saveHighlight = () => {
    if (sel) {
      addHighlight(unit.id, sel.text, {
        chapterId: unit.sourceStart.chapterId,
        nodeIndex: sel.nodeIndex,
      });
      window.getSelection()?.removeAllRanges();
      setSel(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="animate-backdrop-in absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={closeReader}
      />
      <div className="absolute inset-0 flex items-end justify-center sm:items-center sm:p-6">
        <div className="animate-modal-in relative flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl bg-surface shadow-lift sm:h-[92vh] sm:rounded-3xl">
          {/* 头部 */}
          <header className="flex items-center gap-3 border-b border-line px-5 py-3.5 sm:px-7">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-muted">
                {t('readerModal.unitMeta', {
                  book: book.title,
                  author: book.author && book.author !== '未知作者' && book.author !== 'Unknown author' ? book.author : '',
                  order: unit.order + 1,
                })}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {t('readerModal.coverage', { percent: coveragePct })}
                {readIds.includes(unit.id) && (
                  <span className="ml-2 inline-flex items-center gap-0.5 text-accent">
                    <Check size={11} /> {t('readerModal.readBadge')}
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                const id = unit.id;
                const target = units.find((u) => u.id === id);
                closeReader();
                if (target) {
                  void openBookReader(target.bookId, {
                    anchor: {
                      chapterId: target.sourceStart.chapterId,
                      nodeIndex: target.sourceStart.startNode,
                    },
                    returnView: 'feed',
                  });
                }
              }}
              title={t('readerModal.backToBookHint')}
              className="flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-xs text-ink-soft transition-colors hover:text-accent"
            >
              <BookOpen size={14} />
              <span className="hidden sm:inline">{t('readerModal.backToBook')}</span>
            </button>
            <button
              type="button"
              onClick={closeReader}
              aria-label={t('common.close')}
              className="shrink-0 rounded-full p-2 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X size={18} />
            </button>
          </header>

          {/* 正文滚动区 */}
          <div ref={scrollRef} onScroll={handleModalScroll} className="relative flex-1 overflow-y-auto px-5 py-6 sm:px-10 sm:py-8">
            {/* AI 标题区（大字报式，与原文严格分区） */}
            <div className="mb-7">
              <span className="mb-3 inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-paper">
                <Sparkles size={11} />
                {t('readerModal.aiTitle', { time: formatReadingMinutes(unit.ai.estimatedReadingMinutes, i18n.language) })}
              </span>
              <h2 className="text-[26px] font-black leading-[1.3] tracking-tight text-ink sm:text-[30px]">
                {sanitizeTitleQuotes(unit.ai.title)}
              </h2>
            </div>

            {/* 原文分隔签 */}
            <div className="mb-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">{t('common.authorOriginal')}</span>
              <span className="h-px flex-1 bg-line" />
            </div>

            {/* 上次阅读位置提示：滚动后自动消失 */}
            {resumePct != null && (
              <div className="mb-4 inline-block rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
                {t('feed.partialHint', { pct: resumePct })}
              </div>
            )}

            {/* 原文 */}
            <div
              ref={articleRef}
              onMouseUp={handleSelection}
              onTouchEnd={handleSelection}
              className="reading-text text-[16px] leading-[1.95] text-ink sm:text-[17px]"
            >
              {paragraphs.map((p, i) =>
                p.type === 'heading' ? (
                  <h3 key={i} className="mb-5 border-l-[3px] border-accent pl-3 text-xl font-black tracking-tight text-ink">
                    {p.text}
                  </h3>
                ) : (
                  <p key={i} className="reading-text mb-4 text-justify indent-8">
                    {p.text}
                  </p>
                ),
              )}
            </div>

            {/* 划选区 */}
            {unitHighlights.length > 0 && (
              <section className="mt-8">
                <h4 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Highlighter size={14} className="text-accent" />
                  {t('readerModal.myHighlights', { count: unitHighlights.length })}
                </h4>
                <ul className="space-y-2">
                  {unitHighlights.map((h) => (
                    <li
                      key={h.id}
                      className="group flex items-start gap-2 rounded-xl border-l-[3px] border-accent bg-accent-soft/50 px-3 py-2 text-sm leading-relaxed text-ink-soft"
                    >
                      <span className="flex-1">{h.text}</span>
                      <button
                        type="button"
                        aria-label={t('readerMenu.deleteHighlight')}
                        onClick={() => removeHighlight(h.id)}
                        className="mt-0.5 shrink-0 text-muted opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 笔记区 */}
            <section className="mt-8">
              <h4 className="mb-3 flex items-center gap-1.5 text-sm font-medium text-ink">
                <StickyNote size={14} className="text-accent" />
                {t('readerModal.myNotes')}
              </h4>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder={t('note.placeholder')}
                rows={3}
                className="w-full resize-none rounded-xl border border-line bg-paper p-3 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-accent"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={!noteDraft.trim()}
                  onClick={() => {
                    addNote(unit.id, noteDraft, undefined, {
                      chapterId: unit.sourceStart.chapterId,
                      nodeIndex: unit.sourceStart.startNode,
                    });
                    setNoteDraft('');
                  }}
                  className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-40"
                >
                  {t('note.save')}
                </button>
              </div>
              <ul className="mt-3 space-y-2">
                {unitNotes.map((n) => (
                  <li key={n.id} className="group flex items-start gap-2 rounded-xl bg-surface-2/60 px-3 py-2.5 text-sm leading-relaxed text-ink-soft">
                    <span className="flex-1 whitespace-pre-wrap">{n.content}</span>
                    <button
                      type="button"
                      aria-label={t('note.delete')}
                      onClick={() => removeNote(n.id)}
                      className="mt-0.5 shrink-0 text-muted opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <div className="h-24" />
          </div>

          {/* 划线浮层 */}
          {sel && (
            <button
              type="button"
              onClick={saveHighlight}
              className="absolute z-10 flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-xs font-medium text-paper shadow-lift"
              style={{
                top: Math.max(60, sel.y - 44),
                left: Math.min(Math.max(40, sel.x), (scrollRef.current?.clientWidth ?? 400) - 120),
              }}
            >
              <Highlighter size={13} />
              {t('readerMenu.highlight')}
            </button>
          )}

          {/* 底部操作条 */}
          <footer className="flex items-center gap-1 border-t border-line bg-surface px-4 py-3 sm:px-7">
            <button
              type="button"
              aria-label={t('common.favorite')}
              onClick={() => toggleFavorite(unit.id)}
              className={`rounded-full p-2.5 transition-colors hover:bg-surface-2 ${isFav ? 'text-accent' : 'text-muted'}`}
            >
              <Heart size={19} fill={isFav ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              aria-label={fb === 1 ? t('card.moreLiked') : t('card.moreHint')}
              title={fb === 1 ? t('card.moreLiked') : t('card.moreHint')}
              onClick={() => feedback(unit.id, 1)}
              className={`flex items-center gap-1 rounded-full px-2.5 py-2 text-xs font-medium transition-colors hover:bg-surface-2 ${
                fb === 1 ? 'text-accent' : 'text-muted'
              }`}
            >
              <Sparkles size={18} />
              {fb === 1 && <span>{t('card.moreLiked')}</span>}
            </button>
            <button
              type="button"
              aria-label={fb === -1 ? t('card.undoReduce') : t('card.reduceHint')}
              title={fb === -1 ? t('card.reduced') : t('card.reduceHint')}
              onClick={() => feedback(unit.id, -1)}
              className={`flex items-center gap-1 rounded-full px-2.5 py-2 text-xs font-medium transition-colors hover:bg-surface-2 ${
                fb === -1 ? 'text-accent' : 'text-muted'
              }`}
            >
              <EyeOff size={18} />
              {fb === -1 && <span>{t('card.reduced')}</span>}
            </button>
            <button
              type="button"
              aria-label={t('card.snooze')}
              title={t('card.snoozeHint')}
              onClick={() => {
                snoozeUnit(unit.id);
                closeReader();
              }}
              className="flex items-center gap-1 rounded-full px-2.5 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2"
            >
              <Clock size={18} />
              <span className="hidden md:inline">{t('card.snooze')}</span>
            </button>
            {nextInBook && (
              <button
                type="button"
                onClick={nextUnitInBook}
                className="ml-auto flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
              >
                <BookOpen size={15} />
                {t('feed.nextInBook')}
              </button>
            )}
            <button
              type="button"
              onClick={nextUnit}
              className={`flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-card transition-transform hover:scale-[1.03] ${
                nextInBook ? '' : 'ml-auto'
              }`}
            >
              {t('feed.nextRandom')}
              <ArrowRight size={16} />
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
