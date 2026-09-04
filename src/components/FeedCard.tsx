import { Clock, EyeOff, Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Book, ReadingUnit } from '../types';
import { formatReadingMinutes } from '../lib/utils';
import { sanitizeTitleQuotes } from '../lib/titleGen';

interface Props {
  unit: ReadingUnit;
  book: Book | undefined;
  read: boolean;
  favorited: boolean;
  feedback: 1 | -1 | undefined;
  index: number;
  onOpen: () => void;
  onFavorite: () => void;
  onFeedback: (dir: 1 | -1) => void;
}

/** 卡片封面轮换底色（奶油色卡，像杂志内页跳色） */
const COVER_BG = ['bg-cover-0', 'bg-cover-1', 'bg-cover-2'];

export function FeedCard({
  unit,
  book,
  read,
  favorited,
  feedback,
  index,
  onOpen,
  onFavorite,
  onFeedback,
}: Props) {
  const { t, i18n } = useTranslation();
  const muted = feedback === -1;
  const coverBg = COVER_BG[index % COVER_BG.length];

  return (
    <article
      onClick={onOpen}
      className="animate-fade-up mb-3.5 cursor-pointer break-inside-avoid overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line transition-all duration-300 hover:-translate-y-1 hover:shadow-lift sm:mb-4"
      style={{ animationDelay: `${Math.min(index % 12, 12) * 35}ms` }}
    >
      {/* ===== 封面区：大字报（像长文被做成海报图） ===== */}
      <div className={`relative ${coverBg} px-4 pb-3.5 pt-3.5 ${muted ? 'opacity-55 saturate-50' : ''}`}>
        {/* 顶部小字：AI 拟 + 已读 */}
        <div className="mb-2.5 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-soft/70">
          <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 tracking-normal">{t('card.aiTitle', { generator: unit.ai.generator })}</span>
          {read && (
            <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 tracking-normal">{t('common.read')}</span>
          )}
        </div>

        {/* 标题（小红书笔记式：精致粗体，不做夸张海报大字；纯文字排版，不用封面图） */}
        <h3 className="text-[16px] font-bold leading-[1.4] tracking-[-0.01em] text-ink sm:text-[17px]">
          {sanitizeTitleQuotes(unit.ai.title)}
        </h3>

        {/* 底部贴纸：编号 + 时长 */}
        <div className="mt-3 flex items-center justify-between text-[11px] font-semibold tracking-[0.1em] text-ink-soft/80">
          <span>{t('card.note', { index: String(unit.order + 1).padStart(2, '0') })}</span>
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {formatReadingMinutes(unit.ai.estimatedReadingMinutes, i18n.language)}
          </span>
        </div>
      </div>

      {/* ===== 正文区：作者原文预览 ===== */}
      <div className="px-4 pb-3 pt-3">
        <p className="reading-text line-clamp-4 text-[13.5px] leading-[1.75] text-ink-soft">
          {unit.preview}
        </p>

        {/* 来源行 */}
        <div className="mt-3 truncate text-[12px] text-muted">
          {book?.title ?? t('common.unknownBook')}
          {book?.author && book.author !== '未知作者' && book.author !== 'Unknown author'
            ? ` · ${book.author}`
            : ''}
        </div>
      </div>

      {/* ===== 底部操作：仅收藏 + 不感兴趣 ===== */}
      <div
        className="flex items-center justify-end gap-1.5 border-t border-line px-3 py-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label={muted ? t('card.cancelReduce') : t('card.reduceHint')}
          title={muted ? t('card.reduced') : t('card.reduceHint')}
          onClick={() => onFeedback(-1)}
          className={`flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-surface-2 ${
            muted ? 'text-muted' : 'text-muted hover:text-ink'
          }`}
        >
          <EyeOff size={15} />
          {muted && <span>{t('card.reduced')}</span>}
        </button>
        <button
          type="button"
          aria-label={favorited ? t('card.favorited') : t('card.favorite')}
          title={favorited ? t('card.favorited') : t('card.favorite')}
          onClick={onFavorite}
          className={`rounded-full p-1.5 transition-all hover:bg-surface-2 active:scale-125 ${
            favorited ? 'text-accent' : 'text-muted hover:text-ink'
          }`}
        >
          <Heart size={17} fill={favorited ? 'currentColor' : 'none'} />
        </button>
      </div>
    </article>
  );
}
