/**
 * IndexedDB 本地持久层
 *
 * 私人阅读器：所有数据（书籍、原文、阅读单元、进度、划线、笔记、偏好）
 * 均保存在浏览器本地，不上传任何服务器。
 */
import { openDB, type IDBPDatabase } from 'idb';
import { generateAiMeta, TITLE_GENERATOR, getTargetLang } from './titleGen';
import { hashStr, estimateReadingMinutes } from './utils';
import { deriveReadUnitIds, mergeReadRanges, rangesFromUnits } from './readState';
import type {
  Book,
  Highlight,
  KnowledgePoint,
  Marks,
  Note,
  QuizAttempt,
  ReadRange,
  ReadingProgress,
  ReadingUnit,
  SourceDocument,
} from '../types';

const DB_NAME = 'inkread-db';
/** v2：新增学习层 store（knowledgePoints / quizAttempts） */
const DB_VERSION = 2;

export const STORES = {
  books: 'books',
  documents: 'documents',
  units: 'units',
  progress: 'progress',
  highlights: 'highlights',
  notes: 'notes',
  knowledgePoints: 'knowledgePoints',
  quizAttempts: 'quizAttempts',
  kv: 'kv',
} as const;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(STORES.books, { keyPath: 'id' });
          db.createObjectStore(STORES.documents, { keyPath: 'bookId' });
          const units = db.createObjectStore(STORES.units, { keyPath: 'id' });
          units.createIndex('bookId', 'bookId');
          db.createObjectStore(STORES.progress, { keyPath: 'bookId' });
          const hl = db.createObjectStore(STORES.highlights, { keyPath: 'id' });
          hl.createIndex('unitId', 'unitId');
          const notes = db.createObjectStore(STORES.notes, { keyPath: 'id' });
          notes.createIndex('unitId', 'unitId');
          db.createObjectStore(STORES.kv);
        }
        if (oldVersion < 2) {
          const kps = db.createObjectStore(STORES.knowledgePoints, { keyPath: 'id' });
          kps.createIndex('bookId', 'bookId');
          const attempts = db.createObjectStore(STORES.quizAttempts, { keyPath: 'id' });
          attempts.createIndex('bookId', 'bookId');
          attempts.createIndex('knowledgePointId', 'knowledgePointId');
        }
      },
    });
  }
  return dbPromise;
}

export const DEFAULT_MARKS: Marks = { favorites: {}, unitFeedback: {}, bookScore: {}, topicScore: {}, snoozedUntil: {}, partial: {} };

/** 旧格式进度迁移：缺 readRanges 时从 readUnitIds 推导（推送云端 / 落库前都必须经过这一步） */
function normalizeProgress(
  p: ReadingProgress,
  unitsByBook: Map<string, ReadingUnit[]>,
): ReadingProgress {
  const bookUnits = unitsByBook.get(p.bookId) ?? [];
  // 存量区间一律合并排序后再使用：不信任写入方的有序性（乱序/未合并的区间
  // 会让 isRangeCovered 的提前返回语义失效，导致已读被误判为未读）
  const readRanges = mergeReadRanges(
    Array.isArray(p.readRanges) && p.readRanges.length > 0
      ? p.readRanges
      : rangesFromUnits(bookUnits, p.readUnitIds ?? [], p.updatedAt || Date.now()),
  );
  return {
    bookId: p.bookId,
    readRanges,
    readUnitIds: deriveReadUnitIds(bookUnits, readRanges),
    updatedAt: p.updatedAt ?? 0,
  };
}

export async function loadAll(): Promise<{
  books: Book[];
  units: ReadingUnit[];
  progress: Record<string, ReadingProgress>;
  highlights: Highlight[];
  notes: Note[];
  marks: Marks;
  knowledgePoints: KnowledgePoint[];
  quizAttempts: QuizAttempt[];
}> {
  const db = await getDb();
  const [books, units, progressList, highlights, notes, marks, kps, attempts] = await Promise.all([
    db.getAll(STORES.books) as Promise<Book[]>,
    db.getAll(STORES.units) as Promise<ReadingUnit[]>,
    db.getAll(STORES.progress) as Promise<ReadingProgress[]>,
    db.getAll(STORES.highlights) as Promise<Highlight[]>,
    db.getAll(STORES.notes) as Promise<Note[]>,
    (db.get(STORES.kv, 'marks') as Promise<Marks | undefined>),
    db.getAll(STORES.knowledgePoints) as Promise<KnowledgePoint[]>,
    db.getAll(STORES.quizAttempts) as Promise<QuizAttempt[]>,
  ]);
  const progress: Record<string, ReadingProgress> = {};
  for (const p of progressList) progress[p.bookId] = p;
  // 旧版本数据兼容：补齐缺失的偏好字段、剔除已废弃的 ai.tags
  const normalizedMarks: Marks = marks
    ? {
        favorites: marks.favorites ?? {},
        unitFeedback: marks.unitFeedback ?? {},
        bookScore: marks.bookScore ?? {},
        topicScore: marks.topicScore ?? {},
        snoozedUntil: marks.snoozedUntil ?? {},
        partial: marks.partial ?? {},
      }
    : DEFAULT_MARKS;
  // 旧书补齐 bookType（默认社科成长）
  const normalizedBooks = books.map((b) => ({
    ...b,
    bookType: b.bookType ?? 'social_science',
  })) as Book[];
  const bookById = new Map(normalizedBooks.map((b) => [b.id, b]));

  const normalizedUnits = units
    .map((raw) => {
      try {
        // 旧版/异常单元可能字段缺失；先归一化到最小可用结构
        const u = raw as Partial<ReadingUnit> & { id: string };
        const base: ReadingUnit = {
          id: u.id,
          bookId: u.bookId ?? '',
          order: typeof u.order === 'number' ? u.order : 0,
          sourceText: typeof u.sourceText === 'string' ? u.sourceText : '',
          preview: typeof u.preview === 'string' ? u.preview : '',
          sourceStart: u.sourceStart ?? {
            chapterId: '',
            chapterTitle: '',
            startNode: 0,
            endNode: 0,
          },
          sourceEnd: u.sourceEnd ?? u.sourceStart ?? {
            chapterId: '',
            chapterTitle: '',
            startNode: 0,
            endNode: 0,
          },
          // 剥离历史遗留的 ai.tags
          ai: u.ai
            ? (Array.isArray((u.ai as { tags?: unknown }).tags)
              ? (() => { const a = { ...u.ai }; delete (a as { tags?: unknown }).tags; return a as ReadingUnit['ai']; })()
              : (u.ai as ReadingUnit['ai']))
            : undefined,
        } as ReadingUnit;
        const coreSentence =
          typeof (u as ReadingUnit).coreSentence === 'string' ? (u as ReadingUnit).coreSentence : undefined;
        if (coreSentence) base.coreSentence = coreSentence;
        const titleSupport =
          typeof (u as ReadingUnit).titleSupport === 'string' ? (u as ReadingUnit).titleSupport : undefined;
        if (titleSupport) base.titleSupport = titleSupport;

        // 生成代际判定：服务端模型（GLM 等）生成的标题永远视为最新，本地不再覆盖；
        // 本地 mock 标题只有与当前生成器版本一致且带核心句才算最新，否则用当前 mock 重算。
        // （此前只认 mock 版本号，导致 GLM 标题每次 hydrate 被打回 mock 再重调 API，反复翻转。）
        const gen = base.ai?.generator ?? '';
        const isLatest =
          (!!gen && !gen.startsWith('mock')) ||
          (gen === TITLE_GENERATOR && !!base.coreSentence);
        if (isLatest) return base;
        const book = bookById.get(base.bookId);
        const body = base.sourceText.includes('\n\n')
          ? base.sourceText.slice(base.sourceText.indexOf('\n\n') + 2)
          : base.sourceText;
        const meta = generateAiMeta(body, hashStr(base.bookId + base.order), {
          bookType: book?.bookType,
          bookTitle: book?.title,
        });
        // 小说连载标题需带「第X篇 / Ep.N」前缀（与切分器一致）
        const epPrefix =
          meta.fictionEpisode && !/^(第\d+篇|Ep\.\d+)/.test(meta.title)
            ? (getTargetLang() === 'zh' ? `第${(base.order ?? 0) + 1}篇 ` : `Ep.${(base.order ?? 0) + 1} · `)
            : '';
        return {
          ...base,
          coreSentence: meta.coreSentence,
          titleSupport: meta.titleSupport,
          ai: {
            title: epPrefix + meta.title,
            estimatedReadingMinutes: estimateReadingMinutes(base.sourceText),
            generator: meta.generator,
          },
        };
      } catch (err) {
        // 单个单元损坏绝不拖垮整个 hydrate：原样保底返回，书库与 Feed 都能正常渲染
        console.error('[db] normalize unit failed, keep raw', err);
        return raw as ReadingUnit;
      }
    })
    .filter((u): u is ReadingUnit => !!u && typeof u.id === 'string' && !!u.bookId);
  // 旧格式进度迁移（readUnitIds → readRanges），放在单元归一化之后，保证推云快照与内存态一致
  const unitsByBook = new Map<string, ReadingUnit[]>();
  for (const u of normalizedUnits) {
    const arr = unitsByBook.get(u.bookId);
    if (arr) arr.push(u);
    else unitsByBook.set(u.bookId, [u]);
  }
  const migratedProgress: Record<string, ReadingProgress> = {};
  for (const p of Object.values(progress)) {
    if (!p || typeof p.bookId !== 'string') continue;
    migratedProgress[p.bookId] = normalizeProgress(p, unitsByBook);
  }
  return {
    books: normalizedBooks.sort((a, b) => a.createdAt - b.createdAt),
    units: normalizedUnits.sort((a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId)),
    progress: migratedProgress,
    highlights,
    notes,
    marks: normalizedMarks,
    knowledgePoints: kps,
    quizAttempts: attempts,
  };
}

export async function putBookWithContent(
  book: Book,
  document: SourceDocument,
  units: ReadingUnit[],
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    [STORES.books, STORES.documents, STORES.units, STORES.progress],
    'readwrite',
  );
  await tx.objectStore(STORES.books).put(book);
  await tx.objectStore(STORES.documents).put(document);
  for (const u of units) await tx.objectStore(STORES.units).put(u);
  await tx.objectStore(STORES.progress).put({
    bookId: book.id,
    readRanges: [],
    readUnitIds: [],
    updatedAt: Date.now(),
  } satisfies ReadingProgress);
  await tx.done;
}

export async function putDocument(document: SourceDocument): Promise<void> {
  const db = await getDb();
  await db.put(STORES.documents, document);
}

export async function deleteBookCascade(bookId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    [
      STORES.books,
      STORES.documents,
      STORES.units,
      STORES.progress,
      STORES.highlights,
      STORES.notes,
      STORES.knowledgePoints,
      STORES.quizAttempts,
    ],
    'readwrite',
  );
  await tx.objectStore(STORES.books).delete(bookId);
  await tx.objectStore(STORES.documents).delete(bookId);
  await tx.objectStore(STORES.progress).delete(bookId);
  const unitStore = tx.objectStore(STORES.units);
  const unitKeys = await unitStore.index('bookId').getAllKeys(bookId);
  for (const key of unitKeys) await unitStore.delete(key);
  const hlStore = tx.objectStore(STORES.highlights);
  const noteStore = tx.objectStore(STORES.notes);
  const allHl = (await hlStore.getAll()) as Highlight[];
  const allNotes = (await noteStore.getAll()) as Note[];
  for (const h of allHl) if (h.bookId === bookId) await hlStore.delete(h.id);
  for (const n of allNotes) if (n.bookId === bookId) await noteStore.delete(n.id);
  // 学习层：书删了，知识点与作答记录一并级联清理
  const kpStore = tx.objectStore(STORES.knowledgePoints);
  const kpKeys = await kpStore.index('bookId').getAllKeys(bookId);
  for (const key of kpKeys) await kpStore.delete(key);
  const attemptStore = tx.objectStore(STORES.quizAttempts);
  const attemptKeys = await attemptStore.index('bookId').getAllKeys(bookId);
  for (const key of attemptKeys) await attemptStore.delete(key);
  await tx.done;
}

export async function putProgress(p: ReadingProgress): Promise<void> {
  const db = await getDb();
  await db.put(STORES.progress, p);
}

/**
 * 在【单个事务】内完成一本书的「改类型/重切分」全部写入：
 * 删除旧单元 → 写入新单元 → 更新文档前置标记 → 更新书记录 →
 * 保留已读区间 → 清理该书全部划线/笔记（重切后 unitId 全部失效）。
 * 避免对上千个单元逐条 await 独立事务导致主线程长时间卡死。
 *
 * Reading State 说明：重切分只改变呈现层（ReadingUnit）边界，Canonical Source 的
 * 章节与节点不变，readRanges 依然精确有效——重切分绝不清空阅读历史，
 * 只把派生缓存 readUnitIds 按新单元重算。
 */
export async function replaceBookContent(input: {
  book: Book;
  document: SourceDocument;
  units: ReadingUnit[];
  /** 重切分前该书的已读区间（事实层，原样保留） */
  preserveReadRanges?: ReadRange[];
}): Promise<void> {
  const { book, document, units } = input;
  const readRanges = input.preserveReadRanges ?? [];
  const db = await getDb();
  const tx = db.transaction(
    [
      STORES.books,
      STORES.documents,
      STORES.units,
      STORES.progress,
      STORES.highlights,
      STORES.notes,
    ],
    'readwrite',
  );
  const unitStore = tx.objectStore(STORES.units);
  const hlStore = tx.objectStore(STORES.highlights);
  const noteStore = tx.objectStore(STORES.notes);

  // 旧单元按 bookId 索引批量删除（不逐条删，走 index 游标键）
  const oldKeys = await unitStore.index('bookId').getAllKeys(book.id);
  for (const k of oldKeys) await unitStore.delete(k);
  for (const u of units) await unitStore.put(u);

  // 该书划线/笔记在重切后全部失效（按书清理，与旧 unitId 无关）
  const allHl = (await hlStore.getAll()) as Highlight[];
  for (const h of allHl) if (h.bookId === book.id) await hlStore.delete(h.id);
  const allNotes = (await noteStore.getAll()) as Note[];
  for (const n of allNotes) if (n.bookId === book.id) await noteStore.delete(n.id);

  await tx.objectStore(STORES.books).put(book);
  await tx.objectStore(STORES.documents).put(document);
  await tx.objectStore(STORES.progress).put({
    bookId: book.id,
    readRanges,
    readUnitIds: deriveReadUnitIds(units, readRanges),
    updatedAt: Date.now(),
  } satisfies ReadingProgress);

  await tx.done;
}

export async function putHighlight(h: Highlight): Promise<void> {
  const db = await getDb();
  await db.put(STORES.highlights, h);
}

export async function deleteHighlight(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORES.highlights, id);
}

export async function putNote(n: Note): Promise<void> {
  const db = await getDb();
  await db.put(STORES.notes, n);
}

export async function deleteNote(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORES.notes, id);
}

export async function putMarks(marks: Marks): Promise<void> {
  const db = await getDb();
  await db.put(STORES.kv, marks, 'marks');
}

/** 通用 kv 读取（用于联网元数据缓存等） */
export async function getKv<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDb();
  return (await db.get(STORES.kv, key)) as T | undefined;
}

/** 通用 kv 写入 */
export async function setKv(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put(STORES.kv, value, key);
}

/** 读取一本书的完整原文（阅读详情页使用） */
export async function getDocument(bookId: string): Promise<SourceDocument | undefined> {
  const db = await getDb();
  return (await db.get(STORES.documents, bookId)) as SourceDocument | undefined;
}

/** 读取全部书籍原文（云端同步整库快照使用） */
export async function getAllDocuments(): Promise<SourceDocument[]> {
  const db = await getDb();
  return (await db.getAll(STORES.documents)) as SourceDocument[];
}

/** 写入/更新一个 Feed 单元 */
export async function putUnit(unit: ReadingUnit): Promise<void> {
  const db = await getDb();
  await db.put(STORES.units, unit);
}

/** 删除一本书的全部 Feed 单元（用于改类型后重新切分） */
export async function deleteUnitsByBook(bookId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORES.units, 'readwrite');
  const unitStore = tx.objectStore(STORES.units);
  const keys = await unitStore.index('bookId').getAllKeys(bookId);
  for (const key of keys) await unitStore.delete(key);
  await tx.done;
}

/** 更新一本书的记录（用于改类型等） */
export async function putBook(book: Book): Promise<void> {
  const db = await getDb();
  await db.put(STORES.books, book);
}

/** 读取一本书的全部 Feed 单元（按 order 升序） */
export async function getUnitsByBook(bookId: string): Promise<ReadingUnit[]> {
  const db = await getDb();
  const rows = (await db.getAllFromIndex(STORES.units, 'bookId', bookId)) as ReadingUnit[];
  return rows.sort((a, b) => a.order - b.order);
}

// ---------- 云端同步：整库替换 / 清空 ----------

/**
 * 用云端快照整体替换本地 IndexedDB 数据（登录后拉取）。
 * 单事务清空全部业务 store 后写入云端内容；kv 中的非业务缓存（如 cls: 分类缓存）保留。
 */
export async function replaceAllData(input: {
  books: Book[];
  documents: SourceDocument[];
  units: ReadingUnit[];
  progress: Record<string, ReadingProgress>;
  highlights: Highlight[];
  notes: Note[];
  marks: Marks;
  knowledgePoints?: KnowledgePoint[];
  quizAttempts?: QuizAttempt[];
}): Promise<void> {
  const d = await getDb();
  const stores = [
    STORES.books,
    STORES.documents,
    STORES.units,
    STORES.progress,
    STORES.highlights,
    STORES.notes,
    STORES.knowledgePoints,
    STORES.quizAttempts,
  ];
  const tx = d.transaction(stores, 'readwrite');
  await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
  for (const b of input.books) await tx.objectStore(STORES.books).put(b);
  for (const doc of input.documents) await tx.objectStore(STORES.documents).put(doc);
  for (const u of input.units) await tx.objectStore(STORES.units).put(u);
  // 云端旧格式进度迁移（readUnitIds → readRanges），与本地 loadAll 同一套规则
  const unitsByBook = new Map<string, ReadingUnit[]>();
  for (const u of input.units) {
    const arr = unitsByBook.get(u.bookId);
    if (arr) arr.push(u);
    else unitsByBook.set(u.bookId, [u]);
  }
  for (const p of Object.values(input.progress)) {
    if (p && typeof p.bookId === 'string') {
      await tx.objectStore(STORES.progress).put(normalizeProgress(p, unitsByBook));
    }
  }
  for (const h of input.highlights) await tx.objectStore(STORES.highlights).put(h);
  for (const n of input.notes) await tx.objectStore(STORES.notes).put(n);
  for (const kp of input.knowledgePoints ?? []) {
    if (kp && typeof kp.id === 'string') await tx.objectStore(STORES.knowledgePoints).put(kp);
  }
  for (const a of input.quizAttempts ?? []) {
    if (a && typeof a.id === 'string') await tx.objectStore(STORES.quizAttempts).put(a);
  }
  await tx.done;
  // marks 存在 kv store（不参与上面的事务）
  await putMarks(input.marks);
}

/** 清空全部本地业务数据（登出时「不保留本地数据」）。kv 缓存一并清除。 */
export async function clearAllData(): Promise<void> {
  const d = await getDb();
  const stores = [
    STORES.books,
    STORES.documents,
    STORES.units,
    STORES.progress,
    STORES.highlights,
    STORES.notes,
    STORES.knowledgePoints,
    STORES.quizAttempts,
    STORES.kv,
  ];
  const tx = d.transaction(stores, 'readwrite');
  await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
  await tx.done;
}

// ---------- 学习层：知识点 / 作答记录 ----------

/** 批量写入知识点（抽取流程分批回写） */
export async function putKnowledgePoints(kps: KnowledgePoint[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORES.knowledgePoints, 'readwrite');
  for (const kp of kps) await tx.objectStore(STORES.knowledgePoints).put(kp);
  await tx.done;
}

/** 批量写入作答记录 */
export async function putQuizAttempts(attempts: QuizAttempt[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORES.quizAttempts, 'readwrite');
  for (const a of attempts) await tx.objectStore(STORES.quizAttempts).put(a);
  await tx.done;
}
