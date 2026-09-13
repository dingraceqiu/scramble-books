import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCompletionToast } from '../lib/chapterCompletion';

/** 章节完成轻提示：非阻断、自动消失、不可交互（只是阶段感，不是系统弹窗） */
export function CompletionToast() {
  const { t } = useTranslation();
  const toast = useCompletionToast((s) => s.toast);
  if (!toast) return null;
  return (
    <div
      key={toast.key}
      className="animate-fade-up pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 sm:bottom-16"
      role="status"
    >
      <div className="flex items-center gap-2.5 rounded-full bg-ink/90 px-4 py-2.5 text-paper shadow-lift backdrop-blur">
        <Sparkles size={15} className="shrink-0 text-amber-300" />
        <span className="reading-text text-sm font-medium">
          {t('completion.chapterDone', { chapter: toast.chapterTitle })}
        </span>
        <span className="shrink-0 rounded-full bg-paper/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums">
          {t('completion.coverage', { pct: toast.pct })}
        </span>
      </div>
    </div>
  );
}
