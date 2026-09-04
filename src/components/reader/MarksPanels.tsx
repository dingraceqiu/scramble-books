import { Bookmark as BookmarkIcon, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReaderPrefs } from '../../store/useReaderPrefs';
import type { Bookmark, ReaderTheme } from '../../types';
import { Drawer } from './panels';

/** 稳定引用的空数组：避免 selector 返回新字面量导致 getSnapshot 无限重渲染 */
const NO_BOOKMARKS: Bookmark[] = [];

export function BookmarkPanel({
  open,
  onClose,
  bookId,
  onJump,
  theme,
}: {
  open: boolean;
  onClose: () => void;
  bookId: string;
  onJump: (chapterId: string, nodeIndex: number) => void;
  theme: ReaderTheme;
}) {
  const { t } = useTranslation();
  // selector 必须返回稳定引用：无书签时回退到模块级常量数组，不能每次 new []
  const bookmarks = useReaderPrefs((s) => s.bookmarks[bookId] ?? NO_BOOKMARKS);
  const removeBookmark = useReaderPrefs((s) => s.removeBookmark);
  if (!open) return null;

  return (
    <Drawer title={`${t('reader.bookmarks')} · ${bookmarks.length}`} onClose={onClose} theme={theme}>
      {bookmarks.length === 0 ? (
        <p className="py-10 text-center text-sm text-black/40">{t('reader.bookmarkHint')}</p>
      ) : (
        <div className="space-y-2">
          {bookmarks.map((bm: Bookmark) => (
            <div key={bm.id} className="group flex items-start gap-2 rounded-xl bg-black/[0.04] p-3">
              <BookmarkIcon size={15} className="mt-0.5 shrink-0 text-[#e85d2c]" />
              <button
                type="button"
                onClick={() => {
                  onJump(bm.chapterId, bm.nodeIndex);
                  onClose();
                }}
                className="reading-text min-w-0 flex-1 text-left text-sm leading-relaxed text-black/80"
              >
                <span className="line-clamp-2">{bm.snippet}</span>
              </button>
              <button
                type="button"
                onClick={() => removeBookmark(bookId, bm.id)}
                className="shrink-0 text-black/30 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                aria-label={t('reader.removeBookmark')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
