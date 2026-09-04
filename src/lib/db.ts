/**
 * IndexedDB 本地持久层
 *
 * 私人阅读器：所有数据（书籍、原文、阅读单元、进度、划线、笔记、偏好）
 * 均保存在浏览器本地，不上传任何服务器。
 */
import { openDB, type IDBPDatabase } from 'idb';
import { generateAiMeta, TITLE_GENERATOR, getTargetLang } from './titleGen';
import { hashStr, estimateReadingMinutes } from './utils';
import type {
  Book,
  Highlight,
  Marks,
  Note,
  ReadingProgress,
  ReadingUnit,
  SourceDocument,
} from '../types';

const DB_NAME = 'inkread-db';
const DB_VERSION = 1;

export const STORES = {
  books: 'books',
  documents: 'documents',
  units: 'units',
  progress: 'progress',
  highlights: 'highlights',
  notes: 'notes',
  kv: 'kv',
} as const;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
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
      },
    });
  }
  return dbPromise;
}

export const DEFAULT_MARKS: Marks = { favorites: {}, unitFeedback: {}, bookScore: {}, topicScore: {} };

export async function loadAll(): Promise<{
  books: Book[];
  units: ReadingUnit[];
  progress: Record<string, ReadingProgress>;
  highlights: Highlight[];
  notes: Note[];
  marks: Marks;
}> {
  const db = await getDb();
  const [books, units, progressList, highlights, notes, marks] = await Promise.all([
    db.getAll(STORES.books) as Promise<Book[]>,
    db.getAll(STORES.units) as Promise<ReadingUnit[]>,
    db.getAll(STORES.progress) as Promise<ReadingProgress[]>,
    db.getAll(STORES.highlights) as Promise<Highlight[]>,
    db.getAll(STORES.notes) as Promise<Note[]>,
    (db.get(STORES.kv, 'marks') as Promise<Marks | undefined>),
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

        // 已按最新生成器产出且有核心句则保留；旧版本用新生成器重算
        const isLatest = base.ai?.generator === TITLE_GENERATOR && !!base.coreSentence;
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
  return {
    books: normalizedBooks.sort((a, b) => a.createdAt - b.createdAt),
    units: normalizedUnits.sort((a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId)),
    progress,
    highlights,
    notes,
    marks: normalizedMarks,
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
    [STORES.books, STORES.documents, STORES.units, STORES.progress, STORES.highlights, STORES.notes],
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
  await tx.done;
}

export async function putProgress(p: ReadingProgress): Promise<void> {
  const db = await getDb();
  await db.put(STORES.progress, p);
}

/**
 * 在【单个事务】内完成一本书的「改类型/重切分」全部写入：
 * 删除旧单元 → 写入新单元 → 更新文档前置标记 → 更新书记录 →
 * 重置进度 → 清理该书全部划线/笔记（重切后 unitId 全部失效）。
 * 避免对上千个单元逐条 await 独立事务导致主线程长时间卡死。
 */
export async function replaceBookContent(input: {
  book: Book;
  document: SourceDocument;
  units: ReadingUnit[];
}): Promise<void> {
  const { book, document, units } = input;
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
    readUnitIds: [],
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
}): Promise<void> {
  const d = await getDb();
  const stores = [
    STORES.books,
    STORES.documents,
    STORES.units,
    STORES.progress,
    STORES.highlights,
    STORES.notes,
  ];
  const tx = d.transaction(stores, 'readwrite');
  await Promise.all([
    tx.objectStore(STORES.books).clear(),
    tx.objectStore(STORES.documents).clear(),
    tx.objectStore(STORES.units).clear(),
    tx.objectStore(STORES.progress).clear(),
    tx.objectStore(STORES.highlights).clear(),
    tx.objectStore(STORES.notes).clear(),
  ]);
  for (const b of input.books) await tx.objectStore(STORES.books).put(b);
  for (const doc of input.documents) await tx.objectStore(STORES.documents).put(doc);
  for (const u of input.units) await tx.objectStore(STORES.units).put(u);
  for (const p of Object.values(input.progress)) {
    if (p && typeof p.bookId === 'string') await tx.objectStore(STORES.progress).put(p);
  }
  for (const h of input.highlights) await tx.objectStore(STORES.highlights).put(h);
  for (const n of input.notes) await tx.objectStore(STORES.notes).put(n);
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
    STORES.kv,
  ];
  const tx = d.transaction(stores, 'readwrite');
  await Promise.all(stores.map((name) => tx.objectStore(name).clear()));
  await tx.done;
}
