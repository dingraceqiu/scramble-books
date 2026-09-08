/**
 * Cloud Snapshot V2 codec and size diagnostics.
 *
 * V2 is deliberately a wire/storage-only format. IndexedDB and all UI consumers continue to
 * receive complete ReadingUnit objects. A derived field is omitted only after reconstruction
 * from the exact Canonical Source compares equal; legacy/cross-chapter anomalies are retained as
 * per-unit overrides instead of being guessed away.
 */
import type {
  Book,
  CloudReadingUnitV2,
  CloudSnapshot,
  CloudSnapshotV1,
  CloudSnapshotV2,
  ReadingUnit,
  SourceDocument,
  SourceNode,
} from '../types';

export const SNAPSHOT_FIELDS = [
  'books',
  'documents',
  'units',
  'progress',
  'highlights',
  'notes',
  'marks',
  'knowledgePoints',
  'quizAttempts',
  'readerPrefs',
] as const;

export type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

export interface SnapshotSizeDiagnostics {
  version: 1 | 2;
  totalBytes: number;
  fieldBytes: Record<SnapshotField, number>;
  largestBooks: Array<{ bookId: string; title: string; bytes: number }>;
  duplicateText: {
    documentsTextBytes: number;
    unitSourceTextBytes: number;
    safelyOmittableUnitSourceTextBytes: number;
  };
}

interface DerivedUnitFields {
  sourceText?: string;
  preview?: string;
  headingText?: string;
}

interface UnitSourceSlice {
  nodes: SourceNode[];
  startChapterTitle: string;
  chapterHeading: string;
}

const encoder = new TextEncoder();

export function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function textByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function buildPreview(text: string): string {
  const plain = text.replace(/\s+/g, '');
  if (plain.length <= 160) return plain;
  const cut = plain.slice(0, 160);
  const lastStop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('；'),
  );
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut) + '…';
}

function sourceSliceForUnit(
  unit: Pick<ReadingUnit, 'sourceStart' | 'sourceEnd'>,
  document: SourceDocument | undefined,
): UnitSourceSlice | undefined {
  if (!document) return undefined;
  const startChapterIndex = document.chapters.findIndex(
    (chapter) => chapter.id === unit.sourceStart.chapterId,
  );
  const endChapterIndex = document.chapters.findIndex(
    (chapter) => chapter.id === unit.sourceEnd.chapterId,
  );
  if (
    startChapterIndex < 0 ||
    endChapterIndex < startChapterIndex ||
    !Number.isInteger(unit.sourceStart.startNode) ||
    !Number.isInteger(unit.sourceEnd.endNode)
  ) {
    return undefined;
  }

  const nodes: SourceNode[] = [];
  for (let chapterIndex = startChapterIndex; chapterIndex <= endChapterIndex; chapterIndex += 1) {
    const chapter = document.chapters[chapterIndex];
    const startNode = chapterIndex === startChapterIndex ? unit.sourceStart.startNode : 0;
    const endNode =
      chapterIndex === endChapterIndex
        ? unit.sourceEnd.endNode
        : Math.max(-1, ...chapter.nodes.map((node) => node.index));
    const selected = chapter.nodes
      .filter((node) => node.index >= startNode && node.index <= endNode)
      .sort((a, b) => a.index - b.index);
    if (selected.length === 0 && startNode <= endNode) return undefined;
    nodes.push(...selected);
  }
  if (nodes.length === 0) return undefined;

  const startChapter = document.chapters[startChapterIndex];
  return {
    nodes,
    startChapterTitle: startChapter.title,
    chapterHeading:
      startChapter.nodes.find((node) => node.type === 'heading')?.text ?? startChapter.title,
  };
}

/** Rebuild the three presentation fields that are eligible for V2 omission. */
export function deriveUnitFields(
  unit: Pick<ReadingUnit, 'sourceStart' | 'sourceEnd'>,
  document: SourceDocument | undefined,
  book: Book | undefined,
): DerivedUnitFields {
  const slice = sourceSliceForUnit(unit, document);
  if (!slice) return {};
  const rawText = slice.nodes.map((node) => node.text).join('\n\n');
  const firstNode = slice.nodes[0];
  const sourceText =
    book?.bookType !== 'fiction' && firstNode.type !== 'heading'
      ? `${slice.chapterHeading}\n\n${rawText}`
      : rawText;
  const bodyText = slice.nodes
    .filter((node) => node.type !== 'heading')
    .map((node) => node.text)
    .join('\n\n');
  return {
    sourceText,
    preview: buildPreview(bodyText || sourceText),
    headingText: firstNode.type === 'heading' ? firstNode.text : slice.chapterHeading,
  };
}

function serializeUnit(
  unit: ReadingUnit,
  document: SourceDocument | undefined,
  book: Book | undefined,
): CloudReadingUnitV2 {
  const {
    sourceText,
    preview,
    headingText,
    ...wireUnit
  } = unit;
  const derived = deriveUnitFields(unit, document, book);
  const result: CloudReadingUnitV2 = wireUnit;
  if (derived.sourceText !== sourceText) result.sourceText = sourceText;
  if (derived.preview !== preview) result.preview = preview;
  if (derived.headingText !== headingText) result.headingText = headingText ?? null;
  return result;
}

/** Convert a complete local/V1 snapshot into V2 without changing local persistence. */
export function serializeCloudSnapshot(snapshot: CloudSnapshotV1): CloudSnapshotV2 {
  const documentsByBook = new Map(snapshot.documents.map((document) => [document.bookId, document]));
  const booksById = new Map(snapshot.books.map((book) => [book.id, book]));
  return {
    version: 2,
    books: snapshot.books,
    documents: snapshot.documents,
    units: snapshot.units.map((unit) =>
      serializeUnit(unit, documentsByBook.get(unit.bookId), booksById.get(unit.bookId)),
    ),
    progress: snapshot.progress,
    highlights: snapshot.highlights,
    notes: snapshot.notes,
    marks: snapshot.marks,
    knowledgePoints: snapshot.knowledgePoints,
    quizAttempts: snapshot.quizAttempts,
    readerPrefs: snapshot.readerPrefs,
  };
}

function deserializeUnit(
  unit: CloudReadingUnitV2,
  document: SourceDocument | undefined,
  book: Book | undefined,
): ReadingUnit {
  const derived = deriveUnitFields(unit, document, book);
  const sourceText = unit.sourceText ?? derived.sourceText;
  const preview = unit.preview ?? derived.preview;
  if (sourceText === undefined || preview === undefined) {
    throw new Error(`Cloud Snapshot V2 单元 ${unit.id} 缺少可恢复的 Canonical Source`);
  }
  const headingText =
    unit.headingText === null
      ? undefined
      : (unit.headingText ?? derived.headingText);
  const {
    sourceText: _sourceTextOverride,
    preview: _previewOverride,
    headingText: _headingOverride,
    ...base
  } = unit;
  void _sourceTextOverride;
  void _previewOverride;
  void _headingOverride;
  return {
    ...base,
    ...(headingText === undefined ? {} : { headingText }),
    sourceText,
    preview,
  };
}

/** Read either cloud version into the complete V1-shaped data required by IndexedDB. */
export function deserializeCloudSnapshot(snapshot: CloudSnapshot): CloudSnapshotV1 {
  if (snapshot.version === 1) return snapshot;
  if (snapshot.version !== 2) {
    throw new Error(`不支持的 Cloud Snapshot 版本：${String((snapshot as { version?: unknown }).version)}`);
  }
  const documentsByBook = new Map(snapshot.documents.map((document) => [document.bookId, document]));
  const booksById = new Map(snapshot.books.map((book) => [book.id, book]));
  return {
    version: 1,
    books: snapshot.books,
    documents: snapshot.documents,
    units: snapshot.units.map((unit) =>
      deserializeUnit(unit, documentsByBook.get(unit.bookId), booksById.get(unit.bookId)),
    ),
    progress: snapshot.progress,
    highlights: snapshot.highlights,
    notes: snapshot.notes,
    marks: snapshot.marks,
    knowledgePoints: snapshot.knowledgePoints,
    quizAttempts: snapshot.quizAttempts,
    readerPrefs: snapshot.readerPrefs,
  };
}

function fieldValue(snapshot: CloudSnapshot, field: SnapshotField): unknown {
  if (field === 'knowledgePoints') return snapshot.knowledgePoints ?? [];
  if (field === 'quizAttempts') return snapshot.quizAttempts ?? [];
  return snapshot[field];
}

/** Pure diagnostics used by the browser log, regression tests, and the standalone CLI. */
export function snapshotSizeDiagnostics(
  wireSnapshot: CloudSnapshot,
  fullSnapshot?: CloudSnapshotV1,
): SnapshotSizeDiagnostics {
  const complete = fullSnapshot ?? deserializeCloudSnapshot(wireSnapshot);
  const fieldBytes = Object.fromEntries(
    SNAPSHOT_FIELDS.map((field) => [field, jsonByteLength(fieldValue(wireSnapshot, field))]),
  ) as Record<SnapshotField, number>;
  const booksById = new Map(complete.books.map((book) => [book.id, book]));
  const wireUnitsByBook = new Map<string, CloudSnapshot['units']>();
  for (const unit of wireSnapshot.units) {
    const units = wireUnitsByBook.get(unit.bookId) ?? [];
    units.push(unit);
    wireUnitsByBook.set(unit.bookId, units);
  }
  const largestBooks = complete.books
    .map((book) => {
      const document = complete.documents.find((candidate) => candidate.bookId === book.id);
      const bookUnitIds = new Set(complete.units.filter((unit) => unit.bookId === book.id).map((unit) => unit.id));
      const knowledgePointIds = new Set(
        (complete.knowledgePoints ?? [])
          .filter((point) => point.bookId === book.id)
          .map((point) => point.id),
      );
      const scoped = {
        book,
        document,
        units: wireUnitsByBook.get(book.id) ?? [],
        progress: complete.progress[book.id],
        highlights: complete.highlights.filter((highlight) => highlight.bookId === book.id),
        notes: complete.notes.filter((note) => note.bookId === book.id),
        knowledgePoints: (complete.knowledgePoints ?? []).filter((point) => point.bookId === book.id),
        quizAttempts: (complete.quizAttempts ?? []).filter(
          (attempt) => attempt.bookId === book.id || knowledgePointIds.has(attempt.knowledgePointId),
        ),
        marks: {
          favorites: Object.fromEntries(
            Object.entries(complete.marks.favorites ?? {}).filter(([unitId]) => bookUnitIds.has(unitId)),
          ),
          unitFeedback: Object.fromEntries(
            Object.entries(complete.marks.unitFeedback ?? {}).filter(([unitId]) => bookUnitIds.has(unitId)),
          ),
          bookScore: complete.marks.bookScore?.[book.id],
        },
      };
      return { bookId: book.id, title: booksById.get(book.id)?.title ?? book.id, bytes: jsonByteLength(scoped) };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  const documentsByBook = new Map(complete.documents.map((document) => [document.bookId, document]));
  let safelyOmittableUnitSourceTextBytes = 0;
  for (const unit of complete.units) {
    const derived = deriveUnitFields(unit, documentsByBook.get(unit.bookId), booksById.get(unit.bookId));
    if (derived.sourceText === unit.sourceText) {
      safelyOmittableUnitSourceTextBytes += textByteLength(unit.sourceText);
    }
  }
  return {
    version: wireSnapshot.version,
    totalBytes: jsonByteLength(wireSnapshot),
    fieldBytes,
    largestBooks,
    duplicateText: {
      documentsTextBytes: complete.documents.reduce(
        (total, document) => total + document.chapters.reduce(
          (chapterTotal, chapter) => chapterTotal + chapter.nodes.reduce(
            (nodeTotal, node) => nodeTotal + textByteLength(node.text),
            0,
          ),
          0,
        ),
        0,
      ),
      unitSourceTextBytes: complete.units.reduce(
        (total, unit) => total + textByteLength(unit.sourceText),
        0,
      ),
      safelyOmittableUnitSourceTextBytes,
    },
  };
}
