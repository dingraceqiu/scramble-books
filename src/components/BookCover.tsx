import type { Book } from '../types';

/** 书籍封面：EPUB 原生封面 → 在线封面（Google Books）→ 无封面时撞色方块（黑底奶字，杂志刊头感） */
export function BookCover({ book, size = 'md' }: { book: Book; size?: 'sm' | 'md' | 'lg' }) {
  const dims =
    size === 'lg' ? 'h-40 w-28 text-4xl' : size === 'sm' ? 'h-14 w-10 text-lg' : 'h-24 w-[4.5rem] text-2xl';

  const title = typeof book.title === 'string' ? book.title : '';
  const coverSrc = book.coverDataUrl || book.coverUrl;
  if (coverSrc) {
    return (
      <img
        src={coverSrc}
        alt={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`${dims} shrink-0 rounded-lg object-cover shadow-card ring-1 ring-line`}
      />
    );
  }
  return (
    <div
      className={`${dims} flex shrink-0 items-center justify-center rounded-lg bg-ink font-black text-paper shadow-card ring-1 ring-line`}
    >
      {title.trim().charAt(0) || 'B'}
    </div>
  );
}
