import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  Bookmark as BookmarkIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  List,
  StickyNote,
  Share2,
  X,
  Flame,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import { useReaderPrefs, FONT_SIZE_PX, LINE_HEIGHT } from '../store/useReaderPrefs';
import type { Chapter, HighlightColor, SourceNode } from '../types';
import { unitAtNode } from '../lib/segmenter';
import { coverageOfNodes, readNodeSetFromRanges } from '../lib/readState';
import { formatReadingMinutes, estimateReadingMinutes, cn } from '../lib/utils';
import { SettingsPanel } from './reader/SettingsPanel';
import { BookmarkPanel } from './reader/MarksPanels';
import { SearchPanel } from './reader/SearchPanel';

const HL_COLORS: { key: HighlightColor; cls: string; dot: string }[] = [
  { key: 'yellow', cls: 'hl-yellow', dot: '#e8c65e' },
  { key: 'green', cls: 'hl-green', dot: '#a9c98d' },
  { key: 'blue', cls: 'hl-blue', dot: '#9dbdd6' },
  { key: 'pink', cls: 'hl-pink', dot: '#e2a8b4' },
];

interface FlashingRange {
  chapterId: string;
  startNode: number;
  endNode: number;
}

interface SelectionMenu {
  x: number;
  y: number;
  text: string;
  chapterId: string;
  nodeIndex: number;
}

export function ReaderView() {
  const { t, i18n } = useTranslation();
  const bookId = useStore((s) => s.readerBookId);
  const doc = useStore((s) => s.readerDoc);
  const anchor = useStore((s) => s.readerAnchor);
  const books = useStore((s) => s.books);
  const units = useStore((s) => s.units);
  const progressMap = useStore((s) => s.progress);
  const highlights = useStore((s) => s.highlights);
  const notes = useStore((s) => s.notes);
  const closeBookReader = useStore((s) => s.closeBookReader);
  const markNodesRead = useStore((s) => s.markNodesRead);
  const addHighlight = useStore((s) => s.addHighlight);
  const addNote = useStore((s) => s.addNote);

  const settings = useReaderPrefs((s) => s.settings);
  const bookmarks = useReaderPrefs((s) => s.bookmarks);
  const highlightColor = useReaderPrefs((s) => s.highlightColor);
  const savePosition = useReaderPrefs((s) => s.savePosition);
  const getPosition = useReaderPrefs((s) => s.getPosition);
  const addBookmark = useReaderPrefs((s) => s.addBookmark);
  const removeBookmark = useReaderPrefs((s) => s.removeBookmark);
  const bookmarkAt = useReaderPrefs((s) => s.bookmarkAt);
  const setHighlightColor = useReaderPrefs((s) => s.setHighlightColor);

  const book = books.find((b) => b.id === bookId);
  const bookUnits = useMemo(() => units.filter((u) => u.bookId === bookId), [units, bookId]);
  const bookProgress = bookId ? progressMap[bookId] : undefined;
  const bookHighlights = useMemo(() => highlights.filter((h) => h.bookId === bookId), [highlights, bookId]);
  const bookNotes = useMemo(() => notes.filter((n) => n.bookId === bookId), [notes, bookId]);

  // 章节/节点归一化：过滤异常章节与非法节点，保证渲染链不被坏数据打断
  const chapters: Chapter[] = useMemo(
    () =>
      (Array.isArray(doc?.chapters) ? doc!.chapters : [])
        .filter((c): c is Chapter => !!c && Array.isArray(c.nodes))
        .map((c) => ({
          ...c,
          title: typeof c.title === 'string' ? c.title : '',
          nodes: c.nodes.filter((n): n is SourceNode => !!n && typeof n.text === 'string' && typeof n.index === 'number'),
        })),
    [doc],
  );

  // 章 → 已读节点集合：直接来自 readRanges（事实层）。
  // Feed 里读过的单元区间、Reader 里滚动过的段落，在这里是同一套坐标。
  const readNodeSet = useMemo(
    () => readNodeSetFromRanges(bookProgress?.readRanges ?? []),
    [bookProgress],
  );

  // 章节进度（全节点宇宙，与书级覆盖率 coverageOfNodes / book.nodeCount 同一口径：
  // 标题节点也是 Exposure 的一部分，各章之和恰等于顶栏百分比）
  const chapterStats = useMemo(() => {
    const stats = new Map<string, { read: number; total: number }>();
    for (const ch of chapters) {
      const set = readNodeSet.get(ch.id);
      let read = 0;
      let total = 0;
      for (const n of ch.nodes) {
        total++;
        if (set?.has(n.index)) read++;
      }
      stats.set(ch.id, { read, total });
    }
    return stats;
  }, [chapters, readNodeSet]);

  const totalNodes = useMemo(
    () => Array.from(chapterStats.values()).reduce((sum, s) => sum + s.total, 0),
    [chapterStats],
  );
  // 顶栏与书库/弹层共用同一权威口径（Canonical Source：已读节点数 / book.nodeCount），
  // nodeCount 异常时回退到当前文档统计，保证渲染层不因坏数据归零
  const overallPct = Math.round(
    coverageOfNodes(bookProgress?.readRanges, book?.nodeCount || totalNodes) * 100,
  );
  const readMinutes = useMemo(() => {
    const readIds = new Set(bookProgress?.readUnitIds ?? []);
    return bookUnits
      .filter((u) => readIds.has(u.id))
      .reduce((sum, u) => sum + estimateReadingMinutes(u.sourceText), 0);
  }, [bookUnits, bookProgress]);

  const [activeChapter, setActiveChapter] = useState<string | null>(chapters[0]?.id ?? null);
  const [flashing, setFlashing] = useState<FlashingRange | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<SelectionMenu | null>(null);
  const [noteDraft, setNoteDraft] = useState<SelectionMenu | null>(null);
  const [noteText, setNoteText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoreTried = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const jumpTo = useCallback(
    (chapterId: string, nodeIndex: number, query?: string, flash = false) => {
      const el = document.getElementById(`reader-node-${chapterId}-${nodeIndex}`);
      if (el) {
        el.scrollIntoView({ behavior: flash ? 'auto' : 'smooth', block: 'center' });
        if (flash) {
          setFlashing({ chapterId, startNode: nodeIndex, endNode: nodeIndex });
          window.setTimeout(() => setFlashing(null), 2600);
        }
      }
      if (query) setSearchQuery(query);
      else if (!query && query !== undefined) setSearchQuery('');
    },
    [],
  );

  // 打开时恢复滚动位置 / 锚点
  useEffect(() => {
    if (!bookId || restoreTried.current || chapters.length === 0) return;
    restoreTried.current = true;
    requestAnimationFrame(() => {
      if (anchor) {
        const el = document.getElementById(`reader-node-${anchor.chapterId}-${anchor.nodeIndex}`);
        el?.scrollIntoView({ behavior: 'auto', block: 'center' });
        setFlashing({
          chapterId: anchor.chapterId,
          startNode: anchor.nodeIndex,
          endNode: anchor.nodeIndex + 2,
        });
        window.setTimeout(() => setFlashing(null), 2400);
      } else {
        const pos = getPosition(bookId);
        if (pos) {
          const el = document.getElementById(`reader-node-${pos.chapterId}-${pos.nodeIndex}`);
          el?.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
      }
    });
  }, [bookId, chapters.length, anchor, getPosition]);

  // 滚动：联动目录 + 节流保存位置
  const handleScroll = useCallback(() => {
    if (!bookId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const container = scrollRef.current;
      if (!container) return;
      const headingEls = container.querySelectorAll<HTMLElement>('[data-chapter-heading]');
      let current: string | null = null;
      const top = container.getBoundingClientRect().top + 120;
      headingEls.forEach((el) => {
        if (el.getBoundingClientRect().top <= top) current = el.dataset.chapterHeading ?? current;
      });
      if (current) setActiveChapter(current);
      // 找最靠近视口顶部的正文节点作为位置记忆
      const nodeEls = container.querySelectorAll<HTMLElement>('[data-chapter][data-node]');
      let bestChapter = '';
      let bestNode = 0;
      let bestDist = Infinity;
      nodeEls.forEach((el) => {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top - top);
        if (d < bestDist && r.bottom > top) {
          bestDist = d;
          bestChapter = el.dataset.chapter!;
          bestNode = Number(el.dataset.node);
        }
      });
      if (bestChapter) {
        savePosition({ bookId, chapterId: bestChapter, nodeIndex: bestNode, updatedAt: Date.now() });
      }
    }, 400);
  }, [bookId, savePosition]);

  // IntersectionObserver：已读上报（事实层 = readRanges，批量合并成连续区间）
  useEffect(() => {
    if (!bookId || chapters.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const seen: Array<{ chapterId: string; nodeIndex: number }> = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const chapterId = el.dataset.chapter;
          const nodeIndex = Number(el.dataset.node);
          if (!chapterId || Number.isNaN(nodeIndex)) continue;
          seen.push({ chapterId, nodeIndex });
        }
        if (seen.length > 0) markNodesRead(bookId, seen, 'reader');
      },
      { root: scrollRef.current, rootMargin: '0px 0px -35% 0px', threshold: 0.1 },
    );
    const nodes = document.querySelectorAll('[data-chapter][data-node]');
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [bookId, markNodesRead, chapters.length]);

  // 划词
  const handleSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setMenu(null);
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2) {
      setMenu(null);
      return;
    }
    let node: HTMLElement | null = sel.anchorNode?.parentElement ?? null;
    while (node && !node.dataset?.chapter) node = node.parentElement;
    if (!node) {
      setMenu(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setMenu({
      x: rect.left + rect.width / 2,
      y: rect.top,
      text,
      chapterId: node.dataset.chapter!,
      nodeIndex: Number(node.dataset.node),
    });
  }, []);

  const doHighlight = useCallback(
    (m: SelectionMenu, color: HighlightColor) => {
      const unit = unitAtNode(bookUnits, m.chapterId, m.nodeIndex);
      if (unit) addHighlight(unit.id, m.text, { color, chapterId: m.chapterId, nodeIndex: m.nodeIndex });
      setHighlightColor(color);
      setMenu(null);
      window.getSelection()?.removeAllRanges();
    },
    [bookUnits, addHighlight, setHighlightColor],
  );

  const doNote = useCallback(() => {
    if (!menu) return;
    setNoteText('');
    setNoteDraft(menu);
    setMenu(null);
  }, [menu]);

  const submitNote = useCallback(() => {
    if (!noteDraft || !noteText.trim()) {
      setNoteDraft(null);
      return;
    }
    const unit = unitAtNode(bookUnits, noteDraft.chapterId, noteDraft.nodeIndex);
    if (unit) addNote(unit.id, noteText.trim(), noteDraft.text, { chapterId: noteDraft.chapterId, nodeIndex: noteDraft.nodeIndex });
    setNoteDraft(null);
    setNoteText('');
    window.getSelection()?.removeAllRanges();
  }, [noteDraft, noteText, bookUnits, addNote]);

  const doShare = useCallback(async (m: SelectionMenu) => {
    const shareText = `「${m.text}」——《${book?.title ?? ''}》`;
    try {
      if (navigator.share) await navigator.share({ text: shareText });
      else await navigator.clipboard.writeText(shareText);
    } catch {
      /* 用户取消 */
    }
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  }, [book?.title]);

  const toggleBookmark = useCallback(
    (chapterId: string, node: SourceNode) => {
      if (!bookId) return;
      const existing = bookmarkAt(bookId, chapterId, node.index);
      if (existing) removeBookmark(bookId, existing.id);
      else
        addBookmark({
          bookId,
          chapterId,
          nodeIndex: node.index,
          snippet: node.text.slice(0, 60),
        });
    },
    [bookId, bookmarkAt, removeBookmark, addBookmark],
  );

  // 划线/笔记映射（用于段落内 mark 包裹）
  interface TextMark {
    text: string;
    hl?: HighlightColor;
    note?: boolean;
  }
  const marksByNode = useMemo(() => {
    const map = new Map<string, TextMark[]>();
    const push = (chapterId: string | undefined, nodeIndex: number | undefined, item: TextMark) => {
      if (!chapterId || nodeIndex === undefined || !item.text) return;
      const key = `${chapterId}-${nodeIndex}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    };
    for (const h of bookHighlights) push(h.chapterId, h.nodeIndex, { text: h.text, hl: h.color ?? 'yellow' });
    for (const n of bookNotes) push(n.chapterId, n.nodeIndex, { text: n.text ?? n.content, note: true });
    return map;
  }, [bookHighlights, bookNotes]);

  // 段落内标记包裹（若段落文本包含划线/笔记/搜索词，拆分渲染）
  const renderNodeText = (node: SourceNode, chapterId: string) => {
    const marks = marksByNode.get(`${chapterId}-${node.index}`) ?? [];
    type Seg = { text: string; hl?: HighlightColor; note?: boolean; search?: boolean };
    let segs: Seg[] = [{ text: typeof node.text === 'string' ? node.text : '' }];
    const wrap = (target: string, apply: (s: Seg) => Seg) => {
      if (!target) return;
      const next: Seg[] = [];
      for (const seg of segs) {
        if (seg.hl || seg.note || seg.search) {
          next.push(seg);
          continue;
        }
        let rest = seg.text;
        for (;;) {
          const idx = rest.indexOf(target);
          if (idx === -1) {
            if (rest) next.push({ text: rest });
            break;
          }
          if (idx > 0) next.push({ text: rest.slice(0, idx) });
          next.push(apply({ text: target }));
          rest = rest.slice(idx + target.length);
        }
      }
      segs = next;
    };
    for (const m of marks) {
      if (m.hl) wrap(m.text, (s) => ({ ...s, hl: m.hl }));
      if (m.note) wrap(m.text, (s) => ({ ...s, note: true }));
    }
    if (searchQuery) wrap(searchQuery, (s) => ({ ...s, search: true }));
    return segs.map((seg, i) => {
      const hlCls = seg.hl ? HL_COLORS.find((c) => c.key === seg.hl)?.cls ?? 'hl-yellow' : '';
      const noteCls = seg.note ? 'hl-yellow' : '';
      const searchCls = seg.search ? 'r-search-hit' : '';
      const cls = [hlCls, noteCls, searchCls].filter(Boolean).join(' ');
      return cls ? (
        <mark key={i} className={cls}>
          {seg.text}
        </mark>
      ) : (
        <span key={i}>{seg.text}</span>
      );
    });
  };

  const renderNode = (chapter: Chapter, node: SourceNode) => {
    const isRead = readNodeSet.get(chapter.id)?.has(node.index) ?? false;
    const isFlashing =
      flashing && flashing.chapterId === chapter.id && node.index >= flashing.startNode && node.index <= flashing.endNode;
    const isHeading = node.type === 'heading';
    const bm = bookmarkAt(bookId!, chapter.id, node.index);

    if (isHeading) {
      return (
        <h3
          key={`${chapter.id}-${node.index}`}
          id={`reader-node-${chapter.id}-${node.index}`}
          data-chapter-heading={chapter.id}
          data-chapter={chapter.id}
          data-node={node.index}
          className="reader-article mt-12 mb-5 scroll-mt-24 text-xl font-bold tracking-tight text-[var(--reader-ink)] first:mt-2"
        >
          {node.text}
        </h3>
      );
    }

    return (
      <div
        key={`${chapter.id}-${node.index}`}
        id={`reader-node-${chapter.id}-${node.index}`}
        data-chapter={chapter.id}
        data-node={node.index}
        className="group relative"
      >
        <button
          type="button"
          onClick={() => toggleBookmark(chapter.id, node)}
          className={cn(
            'absolute -left-7 top-1.5 hidden opacity-0 transition-opacity group-hover:opacity-100 md:block',
            bm && 'opacity-100',
          )}
          aria-label={bm ? t('reader.removeBookmark') : t('reader.addBookmark')}
        >
          <BookmarkIcon size={14} className={bm ? 'fill-[#e85d2c] text-[#e85d2c]' : 'text-[var(--reader-muted)]'} />
        </button>
        <p
          className={cn(
            'reader-article r-text scroll-mt-24 rounded-md px-1 transition-colors duration-500',
            isRead && 'r-read',
            isFlashing && 'ring-2 ring-[#e85d2c]/60 ring-offset-2 ring-offset-transparent',
          )}
        >
          {renderNodeText(node, chapter.id)}
        </p>
      </div>
    );
  };

  const tocList = (
    <div className="space-y-0.5">
      {chapters.map((ch, i) => {
        const st = chapterStats.get(ch.id);
        const pct = st && st.total > 0 ? Math.round((st.read / st.total) * 100) : 0;
        const hasBm = (bookmarks[bookId!] ?? []).some((b) => b.chapterId === ch.id);
        return (
          <button
            key={ch.id}
            type="button"
            onClick={() => {
              const firstPara = ch.nodes.find((n) => n.type !== 'heading') ?? ch.nodes[0];
              jumpTo(ch.id, firstPara.index);
              setTocOpen(false);
            }}
            className={cn(
              'block w-full rounded-lg px-3 py-2 text-left transition-colors',
              activeChapter === ch.id ? 'bg-[#e85d2c]/10' : 'hover:bg-black/[0.04]',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'reading-text line-clamp-1 text-sm',
                  activeChapter === ch.id ? 'font-medium text-[#e85d2c]' : 'text-black/70',
                  ch.frontMatter && 'italic opacity-60',
                )}
              >
                {ch.title || t('reader.searchResultChapter', { chapter: i + 1 })}
              </span>
              {ch.frontMatter && (
                <span className="shrink-0 rounded bg-black/[0.05] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-black/40">
                  {t('reader.frontmatter')}
                </span>
              )}
              {hasBm && <BookmarkIcon size={11} className="shrink-0 fill-[#e85d2c] text-[#e85d2c]" />}
              {!ch.frontMatter && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-black/35">{pct}%</span>
              )}
            </div>
            <div className="r-bar-track mt-1.5 h-1 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full bg-[#e85d2c] transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );

  /** 回到 Feed 瀑布流（发现入口） */
  const goToFeed = useCallback(() => {
    useStore.setState({
      view: 'feed',
      readerBookId: null,
      readerAnchor: null,
      readerDoc: null,
    });
  }, []);

  if (!book || !doc || !bookId) {
    // 兜底：书籍/文档缺失时给可返回的空状态，而不是整块白屏
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-paper px-6 text-center">
        <p className="font-display text-lg font-bold text-ink">{t('reader.notFoundTitle')}</p>
        <p className="mt-2 max-w-xs text-sm text-muted">{t('reader.notFoundDesc')}</p>
        <button
          type="button"
          onClick={closeBookReader}
          className="mt-6 rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-105"
        >
          {t('reader.backToLibrary')}
        </button>
      </div>
    );
  }

  const readerTheme = settings.theme;

  return (
    <div
      className="reader-surface fixed inset-0 z-40 flex flex-col"
      data-reader-theme={readerTheme}
      style={
        {
          '--rfs': `${FONT_SIZE_PX[settings.fontSizeStep]}px`,
          '--rlh': LINE_HEIGHT[settings.lineHeight],
          '--rff':
            settings.fontFamily === 'serif'
              ? "'Noto Serif SC', Georgia, serif"
              : "'Noto Sans SC', system-ui, sans-serif",
        } as React.CSSProperties
      }
    >
      {/* 顶栏 */}
      <header className="z-20 flex items-center gap-2 border-b border-[var(--reader-line)] px-3 py-2.5 sm:px-5">
        <button
          type="button"
          onClick={closeBookReader}
          className="flex items-center gap-1 rounded-full px-2 py-1.5 text-sm text-[var(--reader-ink)] transition-colors hover:bg-black/5"
        >
          <ArrowLeft size={17} />
          <span className="hidden sm:inline">{t('reader.backToLibrary')}</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="reading-text truncate text-sm font-medium text-[var(--reader-ink)]">{book.title}</p>
          <p className="font-mono text-[10px] tracking-wider text-[var(--reader-muted)]">
            {t('reader.progress', { percent: overallPct })} · {formatReadingMinutes(readMinutes, i18n.language)}
          </p>
        </div>
        {/* 全书进度条 */}
        <div className="r-bar-track hidden h-1 w-28 overflow-hidden rounded-full sm:block">
          <div className="h-full rounded-full bg-[#e85d2c] transition-all duration-500" style={{ width: `${overallPct}%` }} />
        </div>
        <button type="button" onClick={() => setSearchOpen(true)} className="rounded-full p-2 text-[var(--reader-ink)] hover:bg-black/5" aria-label={t('reader.search')}>
          <SearchIcon size={18} />
        </button>
        <button type="button" onClick={() => setBookmarksOpen(true)} className="rounded-full p-2 text-[var(--reader-ink)] hover:bg-black/5" aria-label={t('reader.bookmarks')}>
          <BookmarkIcon size={18} />
        </button>
        <button type="button" onClick={() => setTocOpen(true)} className="rounded-full p-2 text-[var(--reader-ink)] hover:bg-black/5 md:hidden" aria-label={t('reader.toc')}>
          <List size={18} />
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} className="rounded-full p-2 text-[var(--reader-ink)] hover:bg-black/5" aria-label={t('reader.settingsTitle')}>
          <SettingsIcon size={18} />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* 桌面目录 */}
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-[var(--reader-line)] p-4 md:block">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--reader-muted)]">{t('reader.toc')}</p>
          {tocList}
          <button
            type="button"
            onClick={goToFeed}
            className="mt-6 flex w-full items-center gap-2 rounded-full bg-[#e85d2c]/10 px-4 py-2.5 text-sm font-medium text-[#e85d2c] transition-colors hover:bg-[#e85d2c]/20"
          >
            <Flame size={15} />
            {t('reader.relatedFeed')}
          </button>
        </aside>

        {/* 正文 */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onMouseUp={handleSelection}
          onTouchEnd={handleSelection}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          <article className="mx-auto max-w-3xl px-5 pb-40 pt-8 sm:px-8">
            <div className="mb-10 border-b border-[var(--reader-line)] pb-8 text-center">
              <h1 className="reading-text text-2xl font-bold tracking-tight text-[var(--reader-ink)] sm:text-3xl">{book.title}</h1>
              {book.author && <p className="mt-3 text-sm text-[var(--reader-muted)]">{book.author}</p>}
            </div>
            {chapters.map((chapter) => (
              <section key={chapter.id} className="reader-section">
                {chapter.nodes.map((node) => renderNode(chapter, node))}
              </section>
            ))}
            <div className="mt-16 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--reader-muted)]">{t('reader.finished')}</p>
            </div>
          </article>
        </div>
      </div>

      {/* 划词菜单 */}
      {menu && (
        <div
          className="fixed z-50 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-[#1c1a17] px-1.5 py-1.5 text-white shadow-xl"
          style={{ left: menu.x, top: Math.max(menu.y - 52, 8) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {HL_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => doHighlight(menu, c.key)}
              className="flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110"
              style={{ backgroundColor: c.dot }}
              aria-label={t('reader.menuHighlight', { color: t(`reader.color${c.key[0].toUpperCase()}${c.key.slice(1)}`) })}
            >
              {highlightColor === c.key && <Check size={13} className="text-black/60" />}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-white/20" />
          <button type="button" onClick={doNote} className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs hover:bg-white/10">
            <StickyNote size={14} /> {t('reader.menuNote')}
          </button>
          <button type="button" onClick={() => doShare(menu)} className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs hover:bg-white/10">
            <Share2 size={14} /> {t('reader.menuShare')}
          </button>
          <button type="button" onClick={() => setMenu(null)} className="rounded-full p-1.5 hover:bg-white/10" aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* 笔记输入弹层 */}
      {noteDraft && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setNoteDraft(null)}>
          <div
            className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-sm font-medium text-black/80">
                <StickyNote size={15} className="text-[#e85d2c]" /> {t('reader.noteEditorTitle')}
              </p>
              <button type="button" onClick={() => setNoteDraft(null)} className="text-black/40 hover:text-black/70">
                <X size={17} />
              </button>
            </div>
            <blockquote className="mb-3 line-clamp-3 rounded-lg bg-black/[0.04] p-3 text-xs leading-relaxed text-black/55">
              {noteDraft.text}
            </blockquote>
            <textarea
              autoFocus
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={t('reader.notePlaceholder')}
              rows={4}
              className="reading-text w-full resize-none rounded-lg border border-black/10 p-3 text-sm outline-none focus:border-[#e85d2c]"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNoteDraft(null)}
                className="rounded-full px-4 py-2 text-sm text-black/50 hover:bg-black/5"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={submitNote}
                disabled={!noteText.trim()}
                className="rounded-full bg-[#e85d2c] px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 面板 */}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={readerTheme} />
      <BookmarkPanel
        open={bookmarksOpen}
        onClose={() => setBookmarksOpen(false)}
        bookId={bookId}
        onJump={jumpTo}
        theme={readerTheme}
      />
      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        chapters={chapters}
        onJump={jumpTo}
        theme={readerTheme}
      />

      {/* 移动目录抽屉 */}
      {tocOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTocOpen(false)} />
          <div className="reader-surface absolute bottom-0 left-0 right-0 max-h-[75vh] overflow-y-auto rounded-t-2xl p-5" data-reader-theme={readerTheme}>
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--reader-muted)]">{t('reader.toc')}</p>
              <button type="button" onClick={() => setTocOpen(false)} className="text-[var(--reader-muted)]">
                <ChevronDown size={18} />
              </button>
            </div>
            {tocList}
            <button
              type="button"
              onClick={() => {
                setTocOpen(false);
                goToFeed();
              }}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-[#e85d2c]/10 px-4 py-2.5 text-sm font-medium text-[#e85d2c]"
            >
              <Flame size={15} /> {t('reader.relatedFeed')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
