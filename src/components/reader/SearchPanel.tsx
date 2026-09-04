import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Chapter, ReaderTheme } from '../../types';
import { Drawer } from './panels';

interface SearchHit {
  chapterId: string;
  chapterTitle: string;
  nodeIndex: number;
  snippet: string;
}

export function SearchPanel({
  open,
  onClose,
  chapters,
  onJump,
  theme,
}: {
  open: boolean;
  onClose: () => void;
  chapters: Chapter[];
  onJump: (chapterId: string, nodeIndex: number, query?: string) => void;
  theme: ReaderTheme;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');

  const hits = useMemo<SearchHit[]>(() => {
    const query = q.trim();
    if (query.length < 2) return [];
    const out: SearchHit[] = [];
    for (const ch of chapters) {
      for (const n of ch.nodes) {
        if (n.type === 'heading') continue;
        const text = typeof n.text === 'string' ? n.text : '';
        if (!text) continue;
        const idx = text.indexOf(query);
        if (idx === -1) continue;
        const start = Math.max(0, idx - 18);
        const end = Math.min(text.length, idx + query.length + 30);
        out.push({
          chapterId: ch.id,
          chapterTitle: ch.title,
          nodeIndex: n.index,
          snippet: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
        });
        if (out.length >= 60) return out;
      }
    }
    return out;
  }, [q, chapters]);

  if (!open) return null;

  return (
    <Drawer title={t('reader.search')} onClose={onClose} theme={theme}>
      <div className="mb-4 flex items-center gap-2 rounded-full bg-black/5 px-4 py-2.5">
        <Search size={16} className="shrink-0 text-black/40" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('reader.searchPlaceholder')}
          className="w-full bg-transparent text-sm text-black/80 outline-none placeholder:text-black/30"
        />
      </div>
      {q.trim().length >= 2 && <p className="mb-2 text-xs text-black/40">{t('reader.searchMatches', { count: hits.length })}</p>}
      <div className="space-y-1.5">
        {hits.map((h, i) => (
          <button
            key={`${h.chapterId}-${h.nodeIndex}-${i}`}
            type="button"
            onClick={() => {
              onJump(h.chapterId, h.nodeIndex, q.trim());
              onClose();
            }}
            className="block w-full rounded-xl bg-black/[0.04] p-3 text-left transition-colors hover:bg-black/[0.07]"
          >
            <p className="mb-1 text-[11px] font-medium text-[#e85d2c]">{h.chapterTitle}</p>
            <p className="reading-text line-clamp-2 text-sm leading-relaxed text-black/75">{h.snippet}</p>
          </button>
        ))}
        {q.trim().length >= 2 && hits.length === 0 && (
          <p className="py-8 text-center text-sm text-black/40">{t('reader.searchNoResult', { keyword: q.trim() })}</p>
        )}
      </div>
    </Drawer>
  );
}
