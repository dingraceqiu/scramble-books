import type { BookType } from '../types';

/**
 * 书籍类型在线分类客户端（走自己的 Express 后端，后端再聚合 Google Books + 通用搜索）。
 *
 * 策略：EPUB 元数据优先 → 联网综合判断 → 都查不到则返回 null（调用方落为「其他」，等用户手改）。
 * 不在前端做关键词猜测：准确率优先于覆盖率。
 */

export interface OnlineClassifyResult {
  bookType: BookType | null;
  source: 'epub' | 'online' | 'none';
  coverUrl?: string;
  description?: string;
}

const CACHE_PREFIX = 'cls:';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 天
const REQUEST_TIMEOUT = 15000;

interface CacheEntry {
  result: OnlineClassifyResult | null;
  at: number;
}

async function getCache(key: string): Promise<CacheEntry | null> {
  try {
    const { getKv } = await import('./db');
    return (await getKv<CacheEntry>(key)) ?? null;
  } catch {
    return null;
  }
}

async function setCache(key: string, entry: CacheEntry): Promise<void> {
  try {
    const { setKv } = await import('./db');
    await setKv(key, entry);
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/**
 * 联网识别书籍类型。失败/查不到时返回 bookType=null（绝不抛错、绝不本地瞎猜）。
 */
export async function classifyBookOnline(input: {
  title: string;
  author?: string;
  subjects?: string[];
  language?: string;
}): Promise<OnlineClassifyResult> {
  const title = (input.title || '').trim();
  const author = (input.author || '').trim();
  if (!title) return { bookType: null, source: 'none' };

  const key = CACHE_PREFIX + `${title}__${author}`.toLowerCase();
  const cached = await getCache(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.result ?? { bookType: null, source: 'none' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch('/api/classify-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        author: author || undefined,
        subjects: (input.subjects ?? []).filter(Boolean),
        language: input.language,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`classify http ${res.status}`);
    const data = (await res.json()) as {
      bookType?: BookType | null;
      source?: 'epub' | 'online' | 'none';
      coverUrl?: string;
      description?: string;
    };
    const result: OnlineClassifyResult = {
      bookType: data.bookType ?? null,
      source: data.source ?? 'none',
      coverUrl: data.coverUrl || undefined,
      description: data.description || undefined,
    };
    await setCache(key, { result, at: Date.now() });
    return result;
  } catch {
    // 网络/服务异常：缓存"查不到"一小段时间，避免反复重试拖慢上传
    await setCache(key, { result: { bookType: null, source: 'none' }, at: Date.now() - CACHE_TTL + 1000 * 60 * 10 });
    return { bookType: null, source: 'none' };
  } finally {
    clearTimeout(timer);
  }
}
