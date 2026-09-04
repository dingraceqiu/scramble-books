/**
 * 前置非正文内容检测（Front Matter Detection）
 *
 * 书籍正文之前常有：封面/扉页、版权页（ISBN、出版社、版权所有）、
 * 目录（Contents）、推荐语、序言/前言/致谢、人物表等。
 *
 * 这些内容：
 * - Reader 连续阅读时仍然完整展示（用户正常翻书能看到）；
 * - 但不进入 Feed 切分——Feed 单元只从「正文」开始生成。
 *
 * 判定规则（章节级）：
 * 1. 显式前置标题（版权页/目录/序言/致谢/题词等）→ frontMatter；
 * 2. 正文起点：识别到第一个「正式章节」标题（第一章 / Chapter 1 / 第1回 …）后，
 *    其后所有章节都视为正文；
 * 3. 正文起点之前的、无标题或标题不成章节的短章（版权页/目录/题词页）→ frontMatter；
 * 4. 小说尤其严格：第一个 Feed 单元必须从第一章开始，前面一切（含"序章/楔子"若
 *    是独立短页）跳过。
 */
import type { Chapter, BookType } from '../types';

/** 正式章节标题：第一章 / 第1章 / 第一回 / Chapter 1 / Chapter One / 卷一 等 */
const REAL_CHAPTER_RE =
  /^\s*(第\s*[0-9一二三四五六七八九十百千零两]+\s*[章回节]|chapter\s+(\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|第\s*[0-9一二三四五六七八九十百千零两]+\s*卷|卷\s*[0-9一二三四五六七八九十]+)/i;

/** 显式前置内容标题 */
const FRONT_TITLE_RE =
  /^\s*(封面|扉页|扉子|书名页|版权页|版权信息|版权所有|版权声明|图书在版编目|cip\s*数据|内容简介|作者简介|内容提要|目录|目\s*录|contents|table of contents|目次|序|序言|序章|前\s*言|前\s*记|引\s*子|楔\s*子|推荐序|推荐语|编者的话|编者按|出?版?说明|出版后记|致\s*谢|鸣\s*谢|献\s*词|题\s*词|题记|导读|代序|译序|译后记|修订后记|人?物?表|人物介绍|人物设定|主要人物|dramatis\s*personae|cast of characters|about the (author|book)|copyright|all rights reserved|isbn|prologue|foreword|preface|introduction|acknowledg|dedication|epigraph|contents?)\b/i;

/** 版权页/目录的正文特征（用于无标题章节兜底判定） */
const COPYRIGHT_BODY_RE =
  /(isbn\s*[0-9-]|版权所有|侵权必究|出版社|出版发行|印\s*刷|开\s*本|版\s*次|印\s*次|定\s*价|字\s*数|书\s*号|c[nıi]p\s*数据|all rights reserved|copyright\s*[©(]|published by)/i;

/** 目录特征：大量「章节名 …… 页码」或多行短条目（支持英文点线与中文省略号） */
const TOC_BODY_RE =
  /((^|\n)\s*(第\s*[0-9一二三四五六七八九十]+\s*[章回节]|chapter\s+\d+).{0,40}?[.·…･]{3,}\s*\d+\s*)|((^|\n)\s*.{2,30}\s*[.·…･]{3,}\s*\d{1,4}\s*($|\n))/i;

/** 一行是否像目录条目：「标题 …… 页码」 */
const TOC_LINE_RE = /[.·…･]{3,}\s*\d{1,4}\s*$/;

/** 计算章节正文总字数 */
function chapterWordCount(ch: Chapter): number {
  return ch.nodes.reduce((sum, n) => sum + (n.type === 'heading' ? 0 : n.text.length), 0);
}

/** 章节是否含目录特征 */
function looksLikeToc(ch: Chapter): boolean {
  const body = ch.nodes.map((n) => n.text).join('\n');
  if (TOC_BODY_RE.test(body)) return true;
  // 很多短行、且多数行以点线/省略号 + 页码结尾
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 3) {
    const dotty = lines.filter((l) => TOC_LINE_RE.test(l)).length;
    if (dotty >= 2 && dotty / lines.length >= 0.4) return true;
  }
  return false;
}

/** 章节是否像版权页 */
function looksLikeCopyright(ch: Chapter): boolean {
  const body = ch.nodes.map((n) => n.text).join('\n').slice(0, 600);
  return COPYRIGHT_BODY_RE.test(body);
}

/**
 * 标记每一章是否为前置内容（就地修改并返回同一数组）。
 * @param chapters 按阅读顺序排列的章节
 * @param bookType 书籍类型（小说更严格）
 */
export function markFrontMatter(chapters: Chapter[], bookType?: BookType): Chapter[] {
  // 1. 找到第一个「正式章节」的位置
  let firstRealIdx = chapters.findIndex((ch) => REAL_CHAPTER_RE.test(ch.title.trim()));

  // 2. 若一本书完全没有「第X章」式标题（很多社科书章节是主题式标题），
  //    则退化为：跳过显式前置标题 + 版权页/目录特征章，其余都算正文。
  const hasRealChapterPattern = firstRealIdx >= 0;
  if (!hasRealChapterPattern) firstRealIdx = chapters.length; // 没有显式正文起点

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const title = ch.title.trim();
    const words = chapterWordCount(ch);

    let front = false;

    if (hasRealChapterPattern && i < firstRealIdx) {
      // 正文起点之前的章节：全部视为前置（含无标题版权页、目录、序言、题词）
      front = true;
    } else if (FRONT_TITLE_RE.test(title)) {
      // 显式前置标题。正文之后的"序言"通常不存在，但若出现仍以前置处理
      // 例外：正文章节标题本身可能含"序"字？正式章节已被 REAL_CHAPTER_RE 命中，不会走到这
      front = true;
    } else if (!hasRealChapterPattern && i < 6 && (looksLikeCopyright(ch) || looksLikeToc(ch))) {
      // 全书无「第X章」式标题（社科/历史书常见主题式章节名）：
      // 书的前几章里，任何带版权页/目录特征的章节都判前置，不依赖标题名。
      front = true;
    } else if (!title || /^(未命名|untitled|chapter|章节?)$/i.test(title)) {
      // 无标题 / 占位标题章：用版权页/目录特征兜底；且这类短章只在书的前几章出现才判前置
      if (i < Math.min(firstRealIdx, 6) && (looksLikeCopyright(ch) || looksLikeToc(ch))) {
        front = true;
      } else if (words < 120 && i < Math.min(firstRealIdx, 4) && looksLikeCopyright(ch)) {
        front = true;
      }
    }

    // 小说特殊处理：序章/楔子/引子若非常短（< 600 字），视为前置（独立短页）；
    // 若是有实质内容的长序（> 1500 字，常见于小说的"序章"作为故事一部分），保留进 Feed。
    if (bookType === 'fiction' && front === false && /^\s*(序章|楔子|引子|prologue)/i.test(title)) {
      if (words < 1500) front = true;
    }

    ch.frontMatter = front;
  }

  return chapters;
}

/** 供切分使用：返回应进入 Feed 的章节（过滤掉前置内容） */
export function bodyChapters(chapters: Chapter[]): Chapter[] {
  return chapters.filter((ch) => !ch.frontMatter);
}
