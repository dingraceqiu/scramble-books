/**
 * 全局状态（zustand）
 * 内存态 + IndexedDB 持久化：启动时 hydrate，所有写操作 write-through。
 */
import { create } from 'zustand';
import {
  isSegmentable,
  type Book,
  type BookType,
  type Chapter,
  type FeedFilter,
  type Highlight,
  type HighlightColor,
  type Marks,
  type Note,
  type ParsedBook,
  type ReaderAnchor,
  type ReadingProgress,
  type ReadingUnit,
  type SourceDocument,
  type ViewName,
} from '../types';
import * as db from '../lib/db';
import { segmentBook, lastReadUnit } from '../lib/segmenter';
import { parseFile, parseTxtText } from '../lib/parsers';
import { pickNext, topicKeyOf } from '../lib/recommender';
import { SAMPLE_FILENAME, SAMPLE_TEXT } from '../lib/sample';
import { uid } from '../lib/utils';
import { classifyBookOnline, type OnlineClassifyResult } from '../lib/bookClassifier';
import { generateAiTitlesForBook } from '../lib/aiTitles';
import i18n from '../i18n';

export interface ProcessingTask {
  id: string;
  name: string;
  status: 'parsing' | 'segmenting' | 'done' | 'error';
  message?: string;
}

interface StoreState {
  hydrated: boolean;
  books: Book[];
  units: ReadingUnit[];
  progress: Record<string, ReadingProgress>;
  highlights: Highlight[];
  notes: Note[];
  marks: Marks;

  view: ViewName;
  filter: FeedFilter;
  search: string;
  feedSeed: number;

  readerId: string | null;
  readerQueue: string[];

  /** 连续阅读（Reader）当前打开的书；null 表示不在阅读页 */
  readerBookId: string | null;
  /** Reader 定位锚点（从 Feed 跳回原书时定位到具体章节/段落） */
  readerAnchor: ReaderAnchor | null;
  /** Reader 阅读页所在书的完整原文（Canonical Source Map），按需懒加载 */
  readerDoc: SourceDocument | null;
  /** 从哪个视图进入 Reader，退出时返回该视图 */
  readerReturnView: 'feed' | 'library';

  tasks: ProcessingTask[];

  hydrate: () => Promise<void>;
  ingestParsedBook: (
    parsed: ParsedBook,
    bookType?: BookType,
    onlineResult?: OnlineClassifyResult,
  ) => Promise<Book>;
  ingestFiles: (files: File[], bookType?: BookType) => Promise<void>;
  loadSample: () => Promise<void>;
  deleteBook: (bookId: string) => Promise<void>;
  /** 手动修改书籍类型，并按新类型重新切分 Feed 单元 */
  setBookType: (bookId: string, bookType: BookType) => Promise<void>;

  setView: (v: ViewName) => void;
  setFilter: (f: FeedFilter) => void;
  setSearch: (s: string) => void;
  reshuffle: () => void;

  /** 启动时后台升级：把仍是本地 mock 的标题批量换成 GLM 生成的真 AI 标题 */
  upgradeAiTitles: () => void;

  openReader: (unitId: string, queue?: string[]) => void;
  closeReader: () => void;
  nextUnit: () => void;
  /** 同书顺序下一篇（读完一章接着读下一章，绝不跳书） */
  nextUnitInBook: () => void;

  openBookReader: (
    bookId: string,
    opts?: { anchor?: ReaderAnchor | null; returnView?: 'feed' | 'library' | 'study' },
  ) => Promise<void>;
  closeBookReader: () => void;

  markRead: (unitId: string) => void;
  toggleFavorite: (unitId: string) => void;
  feedback: (unitId: string, dir: 1 | -1) => void;

  addHighlight: (
    unitId: string,
    text: string,
    opts?: { color?: HighlightColor; chapterId?: string; nodeIndex?: number },
  ) => void;
  removeHighlight: (id: string) => void;
  addNote: (
    unitId: string,
    content: string,
    sourceText?: string,
    opts?: { chapterId?: string; nodeIndex?: number },
  ) => void;
  removeNote: (id: string) => void;
}

/** 正在重切分的书 id（防重入：同一本书重切期间忽略后续类型切换点击） */
let retypingBookId: string | null = null;

export const useStore = create<StoreState>((set, get) => ({
  hydrated: false,
  books: [],
  units: [],
  progress: {},
  highlights: [],
  notes: [],
  marks: db.DEFAULT_MARKS,

  view: 'feed',
  filter: 'all',
  search: '',
  feedSeed: 0,

  readerId: null,
  readerQueue: [],

  readerBookId: null,
  readerAnchor: null,
  readerDoc: null,
  readerReturnView: 'library',

  tasks: [],

  hydrate: async () => {
    // 本地数据任何损坏/解析异常都不得白屏：加载失败时退回空数据，
    // 书库/Feed 显示空状态而非崩溃（书仍在 IndexedDB 里，可重新导入）。
    try {
      const data = await db.loadAll();
      set({ ...data, hydrated: true });
    } catch (err) {
      console.error('[hydrate] loadAll failed, starting with empty data', err);
      set({ hydrated: true });
    }
  },

  ingestParsedBook: async (parsed, bookType, onlineResult) => {
    const bookId = uid('book');
    // 类型策略：EPUB 元数据 / 联网综合判断优先；都查不到默认「社科成长」，
    // 保证导入的书总是进 Feed（用户需求：Feed 只来自自己的书）。
    // 用户可在书库类型标签下拉里手动改（改完触发重新切分）。
    const type: BookType = bookType ?? onlineResult?.bookType ?? 'social_science';
    const source: Book['bookTypeSource'] = bookType
      ? 'manual'
      : onlineResult?.source === 'epub'
        ? 'epub'
        : onlineResult?.source === 'online'
          ? 'online'
          : 'none';
    const book: Book = {
      id: bookId,
      title: parsed.title,
      author: parsed.author,
      format: parsed.format,
      bookType: type,
      bookTypeSource: source,
      coverDataUrl: parsed.coverDataUrl,
      coverUrl: onlineResult?.coverUrl,
      description: onlineResult?.description,
      createdAt: Date.now(),
      unitCount: 0,
      nodeCount: parsed.chapters.reduce((sum, c) => sum + c.nodes.length, 0),
      chapterCount: parsed.chapters.length,
    };
    // 切分 Feed 单元。关键：用深拷贝章节（markFrontMatter 会原地标记前置章，
    // 不能污染要存进 documents、供 Reader 阅读的原始 parsed.chapters）；
    // 切分是纯计算，任何异常都回退为「该书不进 Feed、只进连续阅读」，
    // 绝不让一本书因标题/切分边界报错而整体失败或白屏。
    let units: ReadingUnit[] = [];
    let segChapters: Chapter[] = parsed.chapters;
    try {
      if (isSegmentable(type)) {
        segChapters = parsed.chapters.map((c) => ({ ...c, nodes: [...c.nodes] }));
        const result = segmentBook(bookId, segChapters, {
          bookType: type,
          bookTitle: parsed.title,
        });
        if (Array.isArray(result)) units = result;
      }
    } catch (err) {
      console.error('[ingest] segment failed, fallback to reader-only', err);
      units = [];
      segChapters = parsed.chapters;
    }
    // 把切分时标记的 frontMatter（前置非正文）同步回要存库的原始章节，
    // 供 Reader 目录显示「前言」；正文数据本身不变。
    const fmFlagById = new Map(segChapters.map((c) => [c.id, c.frontMatter === true]));
    const docChapters = parsed.chapters.map((c) =>
      fmFlagById.has(c.id) ? { ...c, frontMatter: fmFlagById.get(c.id) } : c,
    );
    book.unitCount = units.length;
    await db.putBookWithContent(
      book,
      { bookId, chapters: docChapters },
      units,
    );
    set((s) => ({
      books: [...s.books, book],
      units: [...s.units, ...units],
      progress: { ...s.progress, [bookId]: { bookId, readUnitIds: [], updatedAt: Date.now() } },
    }));
    // 异步生成真 AI 标题（GLM）：mock 标题先顶上，生成好一批替换一批，失败静默降级
    if (units.length > 0) {
      void generateAiTitlesForBook(bookId, units, type, (updated) => {
        const byId = new Map(updated.map((u) => [u.id, u]));
        set((s) => ({ units: s.units.map((u) => byId.get(u.id) ?? u) }));
      });
    }
    return book;
  },

  ingestFiles: async (files, bookType) => {
    for (const file of files) {
      const task: ProcessingTask = { id: uid('task'), name: file.name, status: 'parsing' };
      set((s) => ({ tasks: [...s.tasks, task] }));
      const patch = (p: Partial<ProcessingTask>) =>
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, ...p } : t)) }));
      try {
        // 先让「解析中」状态渲染到屏幕上，再开始同步重活，避免大文件时界面假死
        await new Promise((r) => setTimeout(r, 60));
        const parsed = await parseFile(file);
        // 用户手动指定类型时直接使用；否则走在线分类（EPUB 元数据 → Google Books + 网页搜索综合），
        // 查不到返回 null → ingestParsedBook 落为「其他」，等用户手动改。
        let onlineResult: OnlineClassifyResult | undefined;
        let resolvedType: BookType | undefined;
        if (bookType) {
          resolvedType = bookType;
        } else {
          patch({ status: 'parsing', message: i18n.t('library.taskLookup') });
          try {
            onlineResult = await classifyBookOnline({
              title: parsed.title,
              author: parsed.author,
              subjects: parsed.subjects,
            });
          } catch {
            onlineResult = { bookType: null, source: 'none' };
          }
          resolvedType = onlineResult.bookType ?? undefined;
        }
        const isFiction = resolvedType === 'fiction';
        patch({
          status: 'segmenting',
          message: isFiction ? i18n.t('library.taskSegmentingFiction') : i18n.t('library.taskSegmenting'),
        });
        // 让 UI 有机会刷新到「处理中」状态
        await new Promise((r) => setTimeout(r, 30));
        const book = await get().ingestParsedBook(parsed, resolvedType, onlineResult);
        patch({
          status: 'done',
          message: isFiction
            ? i18n.t('library.taskDoneFiction', { count: parsed.chapters.length })
            : i18n.t('library.taskDone', { count: book.unitCount }),
        });
        setTimeout(() => {
          set((s) => ({ tasks: s.tasks.filter((t) => t.id !== task.id) }));
        }, 4000);
      } catch (err) {
        patch({ status: 'error', message: err instanceof Error ? err.message : i18n.t('library.taskFailed') });
        setTimeout(() => {
          set((s) => ({ tasks: s.tasks.filter((t) => t.id !== task.id) }));
        }, 6000);
      }
    }
  },

  loadSample: async () => {
    const parsed = parseTxtText(SAMPLE_TEXT, SAMPLE_FILENAME);
    await get().ingestParsedBook(parsed);
  },

  deleteBook: async (bookId) => {
    await db.deleteBookCascade(bookId);
    set((s) => ({
      books: s.books.filter((b) => b.id !== bookId),
      units: s.units.filter((u) => u.bookId !== bookId),
      highlights: s.highlights.filter((h) => h.bookId !== bookId),
      notes: s.notes.filter((n) => n.bookId !== bookId),
      progress: Object.fromEntries(Object.entries(s.progress).filter(([k]) => k !== bookId)),
    }));
  },

  setBookType: async (bookId, bookType) => {
    // 防重入：同一本书正在重切时忽略后续点击，避免并发切分/写库卡死
    if (retypingBookId === bookId) return;
    const book = get().books.find((b) => b.id === bookId);
    if (!book) return;
    const doc = await db.getDocument(bookId);
    if (!doc) return;
    retypingBookId = bookId;
    set((s) => ({ tasks: [...s.tasks, { id: `retype-${bookId}`, name: book.title, status: 'segmenting' }] }));

    try {
      // 归一化章节：非法章/非法节点直接剔除，保证切分与深拷贝都不会因脏数据抛错
      const safeChapters: Chapter[] = (Array.isArray(doc.chapters) ? doc.chapters : [])
        .filter((c) => c && Array.isArray(c.nodes))
        .map((c) => ({
          ...c,
          nodes: c.nodes.filter(
            (n) => n && typeof n.text === 'string' && (n.type === 'heading' || n.type === 'para' || n.type === 'list'),
          ),
        }));

      let units: ReadingUnit[] = [];
      // 深拷贝章节供切分使用（markFrontMatter 会原地打标）
      const chaptersCopy: Chapter[] = safeChapters.map((c) => ({ ...c, nodes: [...c.nodes] }));
      try {
        if (isSegmentable(bookType)) {
          // 让 UI 先渲染「处理中」，再开始同步重活，避免大书时界面假死
          await new Promise((r) => setTimeout(r, 30));
          const result = segmentBook(bookId, chaptersCopy, { bookType, bookTitle: book.title });
          if (Array.isArray(result)) units = result;
        }
      } catch (err) {
        // 切分失败：优雅降级为「该书只进连续阅读、不进 Feed」，绝不动旧数据、不崩
        console.error('[setBookType] resegment failed, fallback to reader-only', err);
        units = [];
      }

      // 把重新标记的 frontMatter 同步回存库文档（Reader 目录的「前言」标记随类型更新）
      const fmFlagById = new Map(chaptersCopy.map((c) => [c.id, c.frontMatter === true]));
      const updatedDoc: SourceDocument = {
        ...doc,
        chapters: safeChapters.map((c) => ({ ...c, frontMatter: fmFlagById.get(c.id) ?? c.frontMatter })),
      };
      const nodeCount = safeChapters.reduce((sum, c) => sum + c.nodes.length, 0);
      const updatedBook: Book = {
        ...book,
        bookType,
        bookTypeSource: 'manual',
        unitCount: units.length,
        nodeCount,
        chapterCount: safeChapters.length,
      };

      // 单事务批量写入（替代上千次独立事务，避免 IndexedDB 写风暴卡死）
      await db.replaceBookContent({ book: updatedBook, document: updatedDoc, units });

      // 内存态同步（划线/笔记按书已随重切清空）
      set((s) => ({
        books: s.books.map((b) => (b.id === bookId ? updatedBook : b)),
        units: [...s.units.filter((u) => u.bookId !== bookId), ...units],
        highlights: s.highlights.filter((h) => h.bookId !== bookId),
        notes: s.notes.filter((n) => n.bookId !== bookId),
        progress: { ...s.progress, [bookId]: { bookId, readUnitIds: [], updatedAt: Date.now() } },
      }));
      // 重切分后同样异步生成真 AI 标题
      if (units.length > 0) {
        void generateAiTitlesForBook(bookId, units, bookType, (updated) => {
          const byId = new Map(updated.map((u) => [u.id, u]));
          set((s) => ({ units: s.units.map((u) => byId.get(u.id) ?? u) }));
        });
      }
    } catch (err) {
      // 落库/更新失败：中止且不改动内存态，旧数据完整保留
      console.error('[setBookType] persist failed, aborting without state change', err);
    } finally {
      retypingBookId = null;
      set((s) => ({ tasks: s.tasks.filter((t) => t.id !== `retype-${bookId}`) }));
    }
  },

  setView: (v) => set({ view: v }),
  setFilter: (f) => set({ filter: f }),
  setSearch: (search) => set({ search }),
  reshuffle: () => set((s) => ({ feedSeed: s.feedSeed + 1 })),

  upgradeAiTitles: () => {
    const { units, books } = get();
    // 找出仍有 mock 标题的书（generator 以 mock 开头），按书分组后逐本后台升级。
    // 生成成功后 generator 变为 glm 模型名，下次启动不会再重复跑。
    const mockByBook = new Map<string, ReadingUnit[]>();
    for (const u of units) {
      if (u.ai?.generator?.startsWith('mock')) {
        const arr = mockByBook.get(u.bookId) ?? [];
        arr.push(u);
        mockByBook.set(u.bookId, arr);
      }
    }
    for (const [bookId, mockUnits] of mockByBook) {
      const book = books.find((b) => b.id === bookId);
      if (!book) continue;
      void generateAiTitlesForBook(bookId, mockUnits, book.bookType, (updated) => {
        const byId = new Map(updated.map((u) => [u.id, u]));
        set((s) => ({ units: s.units.map((u) => byId.get(u.id) ?? u) }));
      });
    }
  },

  openReader: (unitId, queue) => {
    set({ readerId: unitId, readerQueue: queue ?? [unitId] });
    get().markRead(unitId);
  },
  closeReader: () => set({ readerId: null, readerQueue: [] }),

  nextUnit: () => {
    const { units, books, readerId, readerQueue, progress, marks } = get();
    if (!readerId) return;
    const readSet = new Set(
      Object.values(progress).flatMap((p) => p.readUnitIds),
    );
    const bookTypeOf = (u: { bookId: string }) =>
      books.find((b) => b.id === u.bookId)?.bookType;
    const { nextId, queue } = pickNext(
      units,
      readerQueue,
      readerId,
      readSet,
      marks,
      bookTypeOf,
    );
    if (nextId) {
      set({ readerId: nextId, readerQueue: queue });
      get().markRead(nextId);
    }
  },

  nextUnitInBook: () => {
    const { units, readerId } = get();
    if (!readerId) return;
    const current = units.find((u) => u.id === readerId);
    if (!current) return;
    const bookUnits = units
      .filter((u) => u.bookId === current.bookId)
      .sort((a, b) => a.order - b.order);
    const idx = bookUnits.findIndex((u) => u.id === readerId);
    const next = bookUnits[idx + 1];
    if (next) {
      set({ readerId: next.id, readerQueue: [next.id] });
      get().markRead(next.id);
    }
  },

  openBookReader: async (bookId, opts) => {
    const { units, progress } = get();
    const doc = await db.getDocument(bookId);
    if (!doc) return;
    let anchor = opts?.anchor ?? null;
    if (!anchor) {
      // 默认「继续阅读」：定位到最后读到的单元（若有），否则从头开始
      const bookUnits = units.filter((u) => u.bookId === bookId);
      const last = lastReadUnit(
        bookUnits,
        progress[bookId]?.readUnitIds ?? [],
      );
      anchor = last?.sourceStart
        ? { chapterId: last.sourceStart.chapterId, nodeIndex: last.sourceStart.startNode }
        : null;
    }
    set({
      view: 'reader',
      readerBookId: bookId,
      readerAnchor: anchor,
      readerDoc: doc,
      readerReturnView: opts?.returnView ?? 'library',
    });
    // 阅读页是整页滚动的独立视图，等待渲染后滚动到锚点
    requestAnimationFrame(() => {
      if (anchor) {
        const el = document.getElementById(`reader-node-${anchor.chapterId}-${anchor.nodeIndex}`);
        el?.scrollIntoView({ block: 'center' });
      } else {
        window.scrollTo({ top: 0 });
      }
    });
  },

  closeBookReader: () => {
    set((s) => ({
      view: s.readerReturnView,
      readerBookId: null,
      readerAnchor: null,
      readerDoc: null,
    }));
  },

  markRead: (unitId) => {
    const { units, progress } = get();
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;
    const cur = progress[unit.bookId] ?? { bookId: unit.bookId, readUnitIds: [], updatedAt: 0 };
    if (cur.readUnitIds.includes(unitId)) return;
    const next: ReadingProgress = {
      ...cur,
      readUnitIds: [...cur.readUnitIds, unitId],
      updatedAt: Date.now(),
    };
    void db.putProgress(next);
    set((s) => ({ progress: { ...s.progress, [unit.bookId]: next } }));
  },

  toggleFavorite: (unitId) => {
    const marks = get().marks;
    const fav = !marks.favorites[unitId];
    const next: Marks = {
      ...marks,
      favorites: { ...marks.favorites, [unitId]: fav },
    };
    if (!fav) delete next.favorites[unitId];
    void db.putMarks(next);
    set({ marks: next });
  },

  feedback: (unitId, dir) => {
    const { units, marks } = get();
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;
    const prev = marks.unitFeedback[unitId];
    // 再次点击同向反馈 = 取消
    const newDir = prev === dir ? undefined : dir;
    const unitFeedback = { ...marks.unitFeedback };
    if (newDir === undefined) delete unitFeedback[unitId];
    else unitFeedback[unitId] = newDir;

    const bookScore = { ...marks.bookScore };
    const topicScore = { ...marks.topicScore };
    const delta = newDir === undefined ? -prev : newDir;
    // 反馈同时作用于「这本书」和「这一章主题」两个维度
    bookScore[unit.bookId] = (bookScore[unit.bookId] || 0) + delta;
    if (bookScore[unit.bookId] === 0) delete bookScore[unit.bookId];
    const topic = topicKeyOf(unit);
    topicScore[topic] = (topicScore[topic] || 0) + delta;
    if (topicScore[topic] === 0) delete topicScore[topic];
    const next: Marks = { ...marks, unitFeedback, bookScore, topicScore };
    void db.putMarks(next);
    set({ marks: next });
  },

  addHighlight: (unitId, text, opts) => {
    const { units } = get();
    const unit = units.find((u) => u.id === unitId);
    if (!unit || !text.trim()) return;
    const hl: Highlight = {
      id: uid('hl'),
      unitId,
      bookId: unit.bookId,
      text: text.trim(),
      color: opts?.color ?? 'yellow',
      chapterId: opts?.chapterId,
      nodeIndex: opts?.nodeIndex,
      createdAt: Date.now(),
    };
    void db.putHighlight(hl);
    set((s) => ({ highlights: [...s.highlights, hl] }));
  },

  removeHighlight: (id) => {
    void db.deleteHighlight(id);
    set((s) => ({ highlights: s.highlights.filter((h) => h.id !== id) }));
  },

  addNote: (unitId, content, sourceText, opts) => {
    const { units } = get();
    const unit = units.find((u) => u.id === unitId);
    if (!unit || !content.trim()) return;
    const note: Note = {
      id: uid('note'),
      unitId,
      bookId: unit.bookId,
      content: content.trim(),
      text: sourceText?.trim() || undefined,
      chapterId: opts?.chapterId,
      nodeIndex: opts?.nodeIndex,
      createdAt: Date.now(),
    };
    void db.putNote(note);
    set((s) => ({ notes: [...s.notes, note] }));
  },

  removeNote: (id) => {
    void db.deleteNote(id);
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
  },
}));

/** 派生：某书阅读覆盖率 0~1（按已读阅读单元数 / 总单元数；小说一章一单元）。 */
export function coverageOf(
  bookId: string,
  units: ReadingUnit[],
  progress: Record<string, ReadingProgress>,
): number {
  const own = units.filter((u) => u.bookId === bookId);
  if (own.length === 0) return 0;
  const p = progress[bookId];
  return (p?.readUnitIds.length ?? 0) / own.length;
}
