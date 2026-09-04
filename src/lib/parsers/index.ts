/** 文件解析统一入口：按扩展名分发到 EPUB / TXT 解析器 */
import type { ParsedBook } from '../../types';
import { parseEpubBuffer } from './epub';
import { parseTxtBuffer, parseTxtText } from './txt';

export async function parseFile(file: File): Promise<ParsedBook> {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const buf = await file.arrayBuffer();
  if (ext === 'epub') return parseEpubBuffer(buf);
  if (ext === 'txt') return parseTxtBuffer(buf, file.name);
  throw new Error(`暂不支持的文件格式：${ext || '未知'}（MVP 支持 EPUB / TXT）`);
}

export { parseEpubBuffer, parseTxtBuffer, parseTxtText };
