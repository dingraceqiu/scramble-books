import { useEffect, useState } from 'react';
import { BookMarked, GraduationCap, Languages, Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/useStore';
import type { ViewName } from '../types';
import { LANGUAGE_STORAGE_KEY, type AppLanguage } from '../i18n';
import { FeedFlowIcon } from './icons/FeedFlowIcon';
import { BrandLogo } from './icons/Logo';
import { AccountButton } from './AccountPanel';

interface Props {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

type TabIcon = (props: { size?: number | string; className?: string; active?: boolean }) => React.ReactElement;

const TABS: { key: ViewName; icon: TabIcon; key2: 'feed' | 'library' | 'study' }[] = [
  { key: 'feed', icon: FeedFlowIcon as TabIcon, key2: 'feed' },
  { key: 'library', icon: BookMarked as unknown as TabIcon, key2: 'library' },
  { key: 'study', icon: GraduationCap as unknown as TabIcon, key2: 'study' },
];

export function Shell({ theme, onToggleTheme, children }: React.PropsWithChildren<Props>) {
  const { t, i18n } = useTranslation();
  const { view, setView } = useStore();
  const inReader = view === 'reader';

  const currentLang = (i18n.language?.startsWith('en') ? 'en' : 'zh-CN') as AppLanguage;
  const [lang, setLang] = useState<AppLanguage>(currentLang);

  useEffect(() => {
    setLang(currentLang);
  }, [currentLang]);

  const toggleLanguage = () => {
    const next: AppLanguage = lang === 'zh-CN' ? 'en' : 'zh-CN';
    setLang(next);
    void i18n.changeLanguage(next);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可
    }
  };

  return (
    <div className="min-h-screen bg-paper text-ink">
      {/* 顶部栏（桌面 + 移动） */}
      <header className="sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandLogo size={34} className="shrink-0 drop-shadow-sm" />
            <span className="flex flex-col leading-none">
              <span className="text-lg font-black tracking-tight">{t('brand.name')}</span>
              <span className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.28em] text-muted">
                {t('brand.tagline')}
              </span>
            </span>
          </div>

          {/* 桌面 Tab（连续阅读页隐藏，页面自带返回条） */}
          <nav className={`ml-6 hidden items-center gap-1 sm:flex ${inReader ? 'invisible' : ''}`}>
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = view === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setView(tab.key)}
                  className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm transition-colors ${
                    active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-ink'
                  }`}
                >
                  {tab.key === 'feed' ? (
                    <FeedFlowIcon size={15} active={active} />
                  ) : (
                    <Icon size={15} />
                  )}
                  {t(`nav.${tab.key2}`)}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggleLanguage}
              aria-label={t('language.label')}
              title={t('language.label')}
              className="flex items-center gap-1 rounded-full px-2.5 py-2 text-xs font-bold uppercase tracking-wide text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <Languages size={16} />
              <span className="hidden sm:inline">{lang === 'zh-CN' ? 'EN' : '中文'}</span>
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={t('theme.toggle')}
              title={t('theme.toggle')}
              className="rounded-full p-2 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <AccountButton />
          </div>
        </div>
      </header>

      <main>{children}</main>

      {/* 移动底部 Tab（连续阅读页隐藏，页面自带返回条） */}
      <nav
        className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-transform sm:hidden ${
          inReader ? 'translate-y-full' : 'translate-y-0'
        }`}
      >
        <div className="mx-auto flex max-w-md">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = view === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setView(tab.key)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] transition-colors ${
                  active ? 'text-accent' : 'text-muted'
                }`}
              >
                {tab.key === 'feed' ? (
                  <FeedFlowIcon size={20} active={active} />
                ) : (
                  <Icon size={20} />
                )}
                {t(`nav.${tab.key2}`)}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
