/** 通用工具函数 */

/** 轻量 className 拼接（过滤 falsy） */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function uid(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${rnd}` : rnd;
}

/** 简单稳定的字符串哈希（用于模板选择等确定性逻辑） */
export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function formatMinutes(min: number): string {
  if (min < 1) return '约 1 分钟';
  if (min < 60) return `约 ${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${m} 分`;
}

/** 阅读时长本地化：中文「约 X 分钟 / 约 X 小时 Y 分」，英文 "~X min / ~Xh Ym" */
export function formatReadingMinutes(min: number, lng: string): string {
  const en = lng.startsWith('en');
  const mins = Math.max(1, Math.round(min));
  if (mins < 60) {
    return en ? `~${mins} min` : `约 ${mins} 分钟`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (en) return m === 0 ? `~${h} hr` : `~${h}h ${m}m`;
  return m === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${m} 分`;
}

/** 日期本地化 */
export function formatDateLocal(ts: number, lng: string): string {
  const locale = lng.startsWith('en') ? 'en-US' : 'zh-CN';
  return new Date(ts).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 中文阅读速度约 400 字/分钟，英文约 220 词/分钟 */
export function estimateReadingMinutes(text: string | null | undefined): number {
  // 防御：旧版/异常单元的 sourceText 可能缺失或不是字符串，任何输入都不应抛错
  const safe = typeof text === 'string' ? text : '';
  const cjk = (safe.match(/[一-鿿]/g) || []).length;
  const words = (safe.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;
  const minutes = cjk / 400 + words / 220;
  return Math.max(1, Math.round(minutes));
}
