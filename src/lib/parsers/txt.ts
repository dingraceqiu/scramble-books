/**
 * TXT 书籍解析器
 *
 * 职责：纯文本 -> Canonical Source Map（Chapter -> SourceNode）
 * - 自动识别 UTF-8 / GBK 编码
 *  - 按中文章回体标题（第X章/回/节/卷、楔子、序章、后记等）切章
 * - 按行合并硬换行（中文 TXT 常见的 40 字折行），恢复自然段落
 */
import type { Chapter, ParsedBook, SourceNode } from '../../types';
import { uid } from '../utils';

/** 章回体标题正则：行首出现「第三章 …」「楔子」「序章」等 */
const CHAPTER_RE = new RegExp(
  '(?:^|\\n)[ \\t\\u3000]*(第[0-9零一二三四五六七八九十百千万〇两]+[章回节卷篇部][^\\n]{0,40}' +
    '|楔子|序章|序言|前言|引言|导言|后记|尾声|结语|跋|番外[^\\n]{0,20})[ \\t\\u3000]*(?=\\n|$)',
  'g',
);

/** 句子结束标点（用于判断硬换行合并） */
const SENTENCE_END = /[。！？…」』”’.!?…]["'”’』」]*$/;
/** 列表/条目起始 */
const LIST_START = /^\s*(?:[0-9０-９]+[.、）)]|[一二三四五六七八九十]+[、.）)]|（[一二三四五六七八九十0-9]+）|[•·▪-])/;
/** 引号/对白起始 */
const QUOTE_START = /^\s*[「『“"'‘（(【]/;
/** 句内标点（用于判断短行是否为小标题） */
const INNER_PUNCT = /[。！？，、；：,.!?;:"“”‘’]/;

function decodeBuffer(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  // 乱码字符超过 0.5% 则尝试中文 GBK 系编码
  if (replacementCount > utf8.length * 0.005) {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      try {
        return new TextDecoder('gbk').decode(buf);
      } catch {
        return utf8;
      }
    }
  }
  return utf8;
}

/** 将章节正文行合并为段落节点 */
function linesToNodes(lines: string[], chapterId: string): SourceNode[] {
  const nodes: SourceNode[] = [];
  const push = (type: SourceNode['type'], text: string) => {
    nodes.push({ id: `${chapterId}__n${nodes.length}`, index: nodes.length, type, text });
  };

  for (const raw of lines) {
    const line = raw.replace(new RegExp('^[ \\t\\u3000]+|[ \\t\\u3000]+$', 'g'), '');
    if (!line) continue;
    const last = nodes[nodes.length - 1];

    // 独立小标题：短行、无句内标点、不以引号/列表开头，
    // 且前面有已收束的正文段落（章节标题在切章时已单独处理，此处首行按正文）
    const looksLikeHeading =
      line.length <= 20 &&
      !INNER_PUNCT.test(line) &&
      !QUOTE_START.test(line) &&
      !LIST_START.test(line) &&
      last !== undefined &&
      (last.type === 'list' || last.type === 'heading' || (last.type === 'para' && SENTENCE_END.test(last.text)));

    // 硬换行合并：上一段未以句末标点结束，本行是正文延续
    const canMerge =
      last !== undefined &&
      last.type === 'para' &&
      !SENTENCE_END.test(last.text) &&
      !looksLikeHeading &&
      !QUOTE_START.test(line) &&
      !LIST_START.test(line) &&
      last.text.length < 160 &&
      line.length <= 120;

    if (LIST_START.test(line)) {
      push('list', line);
    } else if (looksLikeHeading) {
      push('heading', line);
    } else if (canMerge && last) {
      last.text += line;
    } else {
      push('para', line);
    }
  }
  return nodes;
}

interface ChapterSlice {
  title: string | null;
  body: string;
}

function splitChapters(content: string): ChapterSlice[] {
  const matches: { title: string; index: number; length: number }[] = [];
  CHAPTER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHAPTER_RE.exec(content)) !== null) {
    matches.push({ title: m[0].trim(), index: m.index, length: m[0].length });
  }
  if (matches.length === 0) return [{ title: null, body: content }];

  const slices: ChapterSlice[] = [];
  // 第一章之前的内容若足够长，作为「前言」
  const preamble = content.slice(0, matches[0].index).trim();
  if (preamble.replace(/\s/g, '').length > 80) {
    slices.push({ title: '前言', body: preamble });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    slices.push({ title: matches[i].title, body: content.slice(start, end) });
  }
  return slices;
}

function titleFromFilename(filename: string): { title: string; author: string } {
  const base = filename.replace(/\.[^.]+$/, '');
  const bookMatch = base.match(/《(.+?)》/);
  if (bookMatch) return { title: bookMatch[1], author: '未知作者' };
  if (/\s*[-_–—]\s*/.test(base)) {
    const [a, b] = base.split(/\s*[-_–—]\s*/);
    if (a && b) return { title: a.trim(), author: b.trim() };
  }
  return { title: base.trim() || '未命名书籍', author: '未知作者' };
}

export function parseTxtText(content: string, filename: string): ParsedBook {
  const { title, author } = titleFromFilename(filename);
  const slices = splitChapters(content.replace(/\r\n?/g, '\n'));
  const chapters: Chapter[] = [];

  for (const slice of slices) {
    const chapterId = uid('ch');
    const lines = slice.body.split('\n');
    const bodyNodes = linesToNodes(lines, chapterId);
    // 章节标题作为首个 heading 节点（正文首行若重复标题则去重）
    const nodes: SourceNode[] = [];
    if (slice.title) {
      nodes.push({ id: `${chapterId}__n0`, index: 0, type: 'heading', text: slice.title });
    }
    for (const n of bodyNodes) {
      if (n.type === 'heading' && slice.title && n.text === slice.title) continue;
      n.index = nodes.length;
      n.id = `${chapterId}__n${nodes.length}`;
      nodes.push(n);
    }
    if (nodes.length === 0) continue;
    chapters.push({ id: chapterId, index: chapters.length, title: slice.title ?? '正文', nodes });
  }

  return { title, author, format: 'txt', chapters };
}

export function parseTxtBuffer(buf: ArrayBuffer, filename: string): ParsedBook {
  return parseTxtText(decodeBuffer(buf), filename);
}
