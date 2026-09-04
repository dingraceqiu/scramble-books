import { useTranslation } from 'react-i18next';
import { useReaderPrefs } from '../../store/useReaderPrefs';
import type { ReaderTheme } from '../../types';
import { Drawer } from './panels';
import { LANGUAGE_STORAGE_KEY, type AppLanguage } from '../../i18n';

const FONT_FAMILIES: ('serif' | 'sans')[] = ['serif', 'sans'];
const LINE_HEIGHTS: ('compact' | 'normal' | 'loose')[] = ['compact', 'normal', 'loose'];
const READER_THEMES: ReaderTheme[] = ['paper', 'carbon', 'eye'];
const THEME_SWATCH: Record<ReaderTheme, string> = {
  paper: '#fbf8f2',
  carbon: '#1c1a16',
  eye: '#e2ead9',
};
const FONT_SIZE_KEYS = ['sizeSmall', 'sizeMedium', 'sizeLarge', 'sizeXLarge'] as const;
const LANGS: AppLanguage[] = ['zh-CN', 'en'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-black/5 py-4 last:border-0">
      <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-black/45">{label}</p>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (k: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-full bg-black/5 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.key)}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
            value === o.key ? 'bg-[#e85d2c] font-medium text-white shadow-sm' : 'text-black/60'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel({
  open,
  onClose,
  theme,
}: {
  open: boolean;
  onClose: () => void;
  theme: ReaderTheme;
}) {
  const { t, i18n } = useTranslation();
  const { settings, setSetting } = useReaderPrefs();
  if (!open) return null;

  const currentLang = (i18n.language?.startsWith('en') ? 'en' : 'zh-CN') as AppLanguage;
  const changeLanguage = (lng: AppLanguage) => {
    void i18n.changeLanguage(lng);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
    } catch {
      // 隐私模式下 localStorage 可能不可用
    }
  };

  return (
    <Drawer title={t('reader.settingsTitle')} onClose={onClose} theme={theme}>
      <Row label={t('reader.settings.fontSize')}>
        <Segmented
          options={FONT_SIZE_KEYS.map((k, i) => ({ key: i, label: t(`reader.settings.${k}`) }))}
          value={settings.fontSizeStep}
          onChange={(k) => setSetting('fontSizeStep', k)}
        />
      </Row>
      <Row label={t('reader.settings.fontFamily')}>
        <Segmented
          options={FONT_FAMILIES.map((key) => ({ key, label: t(`reader.settings.${key}`) }))}
          value={settings.fontFamily}
          onChange={(k) => setSetting('fontFamily', k)}
        />
      </Row>
      <Row label={t('reader.settings.lineHeight')}>
        <Segmented
          options={LINE_HEIGHTS.map((key) => ({ key, label: t(`reader.settings.${key}`) }))}
          value={settings.lineHeight}
          onChange={(k) => setSetting('lineHeight', k)}
        />
      </Row>
      <Row label={t('reader.settings.theme')}>
        <div className="flex gap-3">
          {READER_THEMES.map((key) => (
            <button key={key} type="button" onClick={() => setSetting('theme', key)} className="flex flex-col items-center gap-1.5">
              <span
                className={`h-11 w-11 rounded-full border-2 transition-all ${
                  settings.theme === key ? 'scale-105 border-[#e85d2c]' : 'border-black/10'
                }`}
                style={{ backgroundColor: THEME_SWATCH[key] }}
              />
              <span className="text-xs text-black/60">{t(`reader.settings.${key}`)}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row label={t('language.label')}>
        <Segmented
          options={LANGS.map((lng) => ({ key: lng, label: t(`language.${lng === 'zh-CN' ? 'zhCN' : 'en'}`) }))}
          value={currentLang}
          onChange={(k) => changeLanguage(k)}
        />
      </Row>
    </Drawer>
  );
}
