import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uid } from '../lib/utils';
import {
  DEFAULT_READER_SETTINGS,
  type Bookmark,
  type HighlightColor,
  type ReaderPosition,
  type ReaderSettings,
} from '../types';

interface ReaderPrefsState {
  settings: ReaderSettings;
  /** bookId -> 书签列表 */
  bookmarks: Record<string, Bookmark[]>;
  /** bookId -> 阅读位置 */
  positions: Record<string, ReaderPosition>;
  /** 划线默认颜色（菜单记忆） */
  highlightColor: HighlightColor;

  setSetting: <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => void;
  setHighlightColor: (c: HighlightColor) => void;

  addBookmark: (b: Omit<Bookmark, 'id' | 'createdAt'>) => Bookmark;
  removeBookmark: (bookId: string, bookmarkId: string) => void;
  /** 判断某书某段是否已加书签，返回书签 id（用于段落上的书签态） */
  bookmarkAt: (bookId: string, chapterId: string, nodeIndex: number) => Bookmark | undefined;

  savePosition: (p: ReaderPosition) => void;
  getPosition: (bookId: string) => ReaderPosition | undefined;
}

export const useReaderPrefs = create<ReaderPrefsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_READER_SETTINGS,
      bookmarks: {},
      positions: {},
      highlightColor: 'yellow',

      setSetting: (key, value) =>
        set((s) => ({ settings: { ...s.settings, [key]: value } })),
      setHighlightColor: (c) => set({ highlightColor: c }),

      addBookmark: (b) => {
        const bookmark: Bookmark = { ...b, id: uid('bm'), createdAt: Date.now() };
        set((s) => ({
          bookmarks: {
            ...s.bookmarks,
            [b.bookId]: [bookmark, ...(s.bookmarks[b.bookId] ?? [])],
          },
        }));
        return bookmark;
      },

      removeBookmark: (bookId, bookmarkId) =>
        set((s) => ({
          bookmarks: {
            ...s.bookmarks,
            [bookId]: (s.bookmarks[bookId] ?? []).filter((x) => x.id !== bookmarkId),
          },
        })),

      bookmarkAt: (bookId, chapterId, nodeIndex) =>
        (get().bookmarks[bookId] ?? []).find(
          (x) => x.chapterId === chapterId && x.nodeIndex === nodeIndex,
        ),

      savePosition: (p) =>
        set((s) => ({ positions: { ...s.positions, [p.bookId]: p } })),
      getPosition: (bookId) => get().positions[bookId],
    }),
    {
      name: 'scrollbook-reader-prefs',
      partialize: (s) => ({
        settings: s.settings,
        bookmarks: s.bookmarks,
        positions: s.positions,
        highlightColor: s.highlightColor,
      }),
    },
  ),
);

/** 字号档位 → 正文 px */
export const FONT_SIZE_PX = [16, 18, 20, 23];
/** 行距档位 → 行高系数 */
export const LINE_HEIGHT: Record<ReaderSettings['lineHeight'], number> = {
  compact: 1.7,
  normal: 1.95,
  loose: 2.25,
};
