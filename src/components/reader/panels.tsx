import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReaderTheme } from '../../types';

/**
 * 抽屉容器：桌面右侧滑出 / 移动端底部弹出。
 * 不再由调用方决定方向——自动按视口响应：窄屏底部弹出、宽屏右侧滑出，
 * 保证移动端可完整触达。
 */
export function Drawer({
  title,
  onClose,
  children,
  theme = 'paper',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 侧栏主题，跟随阅读器当前主题 */
  theme?: ReaderTheme;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/45 animate-backdrop-in" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="reader-surface absolute inset-x-0 bottom-0 max-h-[85vh] rounded-t-3xl border-t border-[rgb(var(--reader-line))] p-5 shadow-2xl
                   sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-0 sm:max-h-none sm:h-full sm:w-full sm:max-w-sm sm:rounded-none sm:rounded-l-2xl sm:border-l sm:border-t-0
                   overflow-y-auto"
        data-reader-theme={theme}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="reading-text text-base font-bold r-text">{title}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 r-muted hover:bg-black/5"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
