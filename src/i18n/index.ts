import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from '../locales/en.json';
import zhCN from '../locales/zh-CN.json';

/** 支持的语言代码（第一期：简中、英文；架构保留 RTL 扩展空间） */
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

/** 语言是否为 RTL（未来阿拉伯语/希伯来语用，第一期均为 LTR） */
export function isRtl(lng: string): boolean {
  return ['ar', 'he', 'fa'].some((code) => lng.startsWith(code));
}

/** 将 <html> 的 lang / dir 同步到当前语言（RTL 架构预留） */
export function applyDocumentLanguage(lng: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lng;
  document.documentElement.dir = isRtl(lng) ? 'rtl' : 'ltr';
}

export const LANGUAGE_STORAGE_KEY = 'scramble-books-lang';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnEmptyString: false,
  });

applyDocumentLanguage(i18n.language);

i18n.on('languageChanged', (lng) => {
  applyDocumentLanguage(lng);
});

export default i18n;
