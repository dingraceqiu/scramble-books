/**
 * AI 标题批量生成（服务端 GLM）。
 *
 * 导入/重新切分后异步执行：把单元原文分批送到 /api/ai-titles，用返回的
 * AI 标题替换本地 mock 标题并回写 IndexedDB。任何失败都静默降级——
 * 保留 mock 标题，绝不阻塞导入、绝不丢数据。
 */
import { apiUrl } from './cloudApi';
import { putUnit } from './db';
import type { BookType, ReadingUnit } from '../types';

const BATCH_SIZE = 6;

/** 防重入：同一本书同时只跑一个生成任务 */
const inflight = new Set<string>();

/**
 * 为一本书的单元生成 AI 标题。
 * @param onUpdated 每批更新后回调（携带新对象；调用方负责替换 store 里的旧引用）
 */
export async function generateAiTitlesForBook(
  bookId: string,
  units: ReadingUnit[],
  bookType: BookType,
  onUpdated?: (updated: ReadingUnit[]) => void,
): Promise<void> {
  if (inflight.has(bookId)) return;
  inflight.add(bookId);
  try {
    const pending = units.filter((u) => u.sourceText?.trim());
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const updated = await requestBatch(batch, bookType);
      if (updated.length > 0) {
        for (const u of updated) await putUnit(u);
        onUpdated?.(updated);
      }
    }
  } catch {
    // 整体失败：静默保留 mock 标题
  } finally {
    inflight.delete(bookId);
  }
}

async function requestBatch(
  batch: ReadingUnit[],
  bookType: BookType,
): Promise<ReadingUnit[]> {
  try {
    const resp = await fetch(apiUrl('/api/ai-titles'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: batch.map((u) => ({
          id: u.id,
          text: u.sourceText,
          coreSentence: u.coreSentence,
          bookType,
        })),
      }),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      ok?: boolean;
      generator?: string;
      results?: Array<{ id?: string; title?: string }>;
    };
    if (!data.ok || !Array.isArray(data.results)) return [];
    const generator = data.generator || 'glm';
    const titleById = new Map<string, string>();
    for (const r of data.results) {
      if (r?.id && r.title) titleById.set(r.id, r.title);
    }
    const out: ReadingUnit[] = [];
    for (const u of batch) {
      const title = titleById.get(u.id);
      if (!title) continue;
      out.push({ ...u, ai: { ...u.ai, title, generator } });
    }
    return out;
  } catch {
    return [];
  }
}
