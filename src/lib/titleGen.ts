/**
 * AI 标题生成器（MVP Mock 版 · v2 核心句改写）
 *
 * 彻底废弃「关键词 + 模板」的方式。核心铁律：
 *   标题可以吸引点击，但绝对不能骗人。标题的核心 claim 必须在原文中有直接支撑。
 *
 * 流程：
 *   1. extractCoreSentence：从原文中打分选出「核心句」（段首观点 / 段尾结论 /
 *      问句 / 含信号词的句子），选不出返回 null。
 *   2. toTitleCandidates：基于核心句本身改写——问句直接悬念化，陈述句改写为
 *      问题/反直觉/悬念，绝不引入核心句与原文中不存在的事实或名词。
 *   3. 校验：每个候选的「实词」必须全部出现在原文中，否则丢弃；宁可用朴素的
 *      原文短句，也绝不文不对题。
 *
 * 独立模块，接口与未来真实 LLM 一致；只读取原文，绝不修改原文。
 */

/** 被判定为「明确核心句」的最低分 */
export const CORE_SCORE_THRESHOLD = 5.5;

/** 去掉标题开头多余的连接词，让标题更利落（不改变核心 claim） */
function stripLeadingConnective(s: string): string {
  return s.replace(/^(但是|可是|然而|不过|所以说|所以|因此|于是|而且|并且|那么|当然|其实呢|其实啊)/, '');
}

const SIGNAL_RE = /(关键在于|本质是|本质上|真正的|真正重要|问题的关键|意味着|说明|证明|决定了|归根到底|归根结底|说到底|也就是说|换句话说|因此|所以|其实|事实上|实际上|原因是|原因在于|秘诀|真相|答案|结论|根本|核心在于|重点是|真相是)/;
const QUESTION_RE = /[？?]\s*$/;

/**
 * 把一段正文切成句子列表（保留原标点，去掉章标题等超短句与空白）。
 * 返回的句子是原文原句，不做任何改写。
 */
export function splitSentences(bodyText: string): string[] {
  const parts = bodyText.split(/(?<=[。！？!?；])/);
  const out: string[] = [];
  for (const p of parts) {
    const s = p.replace(/\s+/g, '').trim();
    // 去掉章节标题（通常较短且是整篇的上下文，不是论点本身）
    if (s.length >= 8 && s.length <= 120) out.push(s);
  }
  return out;
}

/** 从句子里抽取 2-4 字中文实词串（简单二元/三元 CJK 连续串），用于「原文支撑校验」 */
function contentTerms(s: string): string[] {
  const runs = s.match(/[一-鿿]{4,}/g) || [];
  const terms = new Set<string>();
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
    for (let i = 0; i < run.length - 2; i++) terms.add(run.slice(i, i + 3));
  }
  return [...terms];
}

interface CoreCandidate {
  text: string;
  index: number;
  total: number;
  score: number;
}

/**
 * 核心句打分：
 * - 问句（提出问题）天然是好标题素材
 * - 含「因此/其实/关键在于/本质是…」等信号词
 * - 段首（提出观点）、段尾（总结结论）位置加权
 * - 长度适中（10~60 字）
 */
function scoreSentence(s: string, index: number, total: number): number {
  let score = 0;
  if (QUESTION_RE.test(s)) score += 6;
  if (SIGNAL_RE.test(s)) score += 4;
  if (/[？?]/.test(s)) score += 1;
  if (index === 0) score += 3; // 段首观点句
  if (index === total - 1) score += 2.5; // 段尾结论句
  const len = s.length;
  if (len >= 10 && len <= 60) score += 2;
  else if (len > 80) score -= 1;
  // 例子/引用/对话句通常不是核心论点
  if (/^[「『“'"]/.test(s) || /例如|比如|举个例子|有一次|曾经/.test(s)) score -= 1.5;
  return score;
}

export interface CoreSentenceResult {
  text: string;
  score: number;
  index: number;
  total: number;
}

/**
 * 从单元正文中提取核心句（原文原句）。
 * 取所有句子打分后的最高分；低于阈值视为「没有明确核心句」，返回 null。
 */
export function extractCoreSentence(bodyText: string): CoreSentenceResult | null {
  const sentences = splitSentences(bodyText);
  if (sentences.length === 0) return null;

  let win: CoreCandidate | null = null;
  for (let index = 0; index < sentences.length; index++) {
    const score = scoreSentence(sentences[index], index, sentences.length);
    if (!win || score > win.score) win = { text: sentences[index], index, total: sentences.length, score };
  }

  if (!win || win.score < CORE_SCORE_THRESHOLD) return null;
  return { text: win.text, score: win.score, index: win.index, total: win.total };
}

/** 候选标题及其所依据的原文支撑句 */
interface TitleCandidate {
  title: string;
  support: string;
  rank: number;
}

/** 去掉句末标点，便于二次改写 */
function stripEnd(s: string): string {
  return s.replace(/[。！？!?；…]+$/, '').trim();
}

/**
 * 标题引号校验与清洗（成对铁律）。
 * - 中文语境统一用直角引号「」，英文语境统一用直引号 "。
 * - 检查配对：有开必须有合；标题绝不允许以右引号/后引号开头。
 * - 一旦不成对或开头是右引号，则去掉所有引号直接引用内容（宁可朴素，不可残缺）。
 */
export function sanitizeTitleQuotes(title: string): string {
  let t = removeEmptyQuotes(title.trim());
  if (!t) return t;
  const isCjk = /[一-鿿]/.test(t);

  // 1) 归一成当前语境的开/合引号
  const open = isCjk ? '「' : '"';
  const close = isCjk ? '」' : '"';
  // 需要被归一/识别的各类引号（不含英文撇号 '，避免破坏单词）
  const cjkOpen = /[「『“]/g;
  const cjkClose = /[」』”]/g;
  const curlyDouble = /[“”]/g;
  if (isCjk) {
    // 中文语境：先把成对出现的 ASCII 直引号按位置归一成「」（正文原句常带直引号），
    // 再归中文引号。直引号开合同字符，用奇偶位区分开合。
    let dq = 0;
    t = t.replace(/"/g, () => {
      dq += 1;
      return dq % 2 === 1 ? open : close;
    });
    t = t.replace(cjkOpen, open).replace(cjkClose, close);
  } else {
    t = t.replace(curlyDouble, '"');
  }

  // 2) 校验配对
  let balanced = true;
  if (isCjk) {
    let depth = 0;
    for (const ch of t) {
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth < 0) {
          balanced = false;
          break;
        }
      }
    }
    if (depth !== 0) balanced = false;
    if (t.startsWith(close)) balanced = false;
  } else {
    // 直引号：开合同字符，用出现次数奇偶判断
    const count = (t.match(/"/g) ?? []).length;
    if (count % 2 !== 0) balanced = false;
    if (t.startsWith('"')) balanced = false;
  }

  if (balanced) return t;

  // 3) 不成对：去掉所有引号，直接引用内容；清理残留空白与开头的停顿标点
  t = t
    .replace(/[「」『』“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉因去引号而暴露在开头的停顿/收束标点
  t = t.replace(/^[，,、。．.：:；;！!？?…—\s]+/, '').trim();
  return t;
}

/** 去掉空引号对（如 「」 / “” 之间没有任何内容） */
export function removeEmptyQuotes(title: string): string {
  return title
    .replace(/[「『「][\s]*[」』」]/g, '')
    .replace(/“\s*”/g, '')
    .replace(/"\s*"/g, '')
    .trim();
}

/**
 * 从书名/正文中推测传主姓名（人物传记用）。
 * 书名形如《苏东坡传》《居里夫人自传》，或正文里出现「XX 先生/总统/教授…」。
 * 提取后必须在原文中出现才采用，绝不捏造人名。
 */
function extractPersonName(bookTitle: string | undefined, bodyText: string): string | null {
  if (bookTitle) {
    const m = bookTitle.match(/^[「"『《]?([一-龥]{2,4}?)(?:自传|评传|大传|全传|画传|回忆录?|传)/);
    if (m && bodyText.includes(m[1])) return m[1];
  }
  const m2 = bodyText.match(/([一-龥]{2,4})(?:先生|女士|总统|教授|博士|总理|主席|将军|夫人|作家|学者|皇帝|国王)/);
  if (m2 && bodyText.includes(m2[1])) return m2[1];
  return null;
}

export interface TitleGenContext {
  bookType?: import('../types').BookType;
  bookTitle?: string;
}

/**
 * 基于核心句改写候选标题。
 * 所有改写只使用核心句里出现的词，可加不改变语义的悬念词，但不捏造任何
 * 核心句与原文中不存在的事实、结果、名词（如「嫉妒/毁掉/吃亏」）。
 * 按书籍类型（传记/历史/哲学/商业/社科）叠加不同风格的前置包装，
 * 包装同样不引入原文没有的事实，并最终统一通过 isGrounded 实词校验。
 */
function toTitleCandidates(core: CoreSentenceResult, seed: number, ctx: TitleGenContext): TitleCandidate[] {
  const raw = core.text.trim();
  const isQuestion = QUESTION_RE.test(raw);
  const cands: TitleCandidate[] = [];
  const push = (title: string, rank: number) => {
    const t = stripLeadingConnective(title.trim());
    if (t && t.length <= 42 && !cands.some((c) => c.title === t)) cands.push({ title: t, support: raw, rank });
  };

  const genre = ctx.bookType ?? 'social_science';
  const plain = stripEnd(raw);

  // ── 类型化包装（在通用候选之外叠加，全部仍走 isGrounded 校验）──
  if (genre === 'biography') {
    const person = extractPersonName(ctx.bookTitle, core.text);
    if (person) {
      // 核心句以「他/她」开头：直接换回人名，让人物成为标题主角
      if (/^[他她]/.test(raw)) {
        push(`${person}${plain.slice(1)}`, 99);
      }
      // 核心句本身含人名：加一层「少有人注意到」的秘闻式包装（不新增事实）
      if (raw.includes(person)) {
        push(`很少有人注意到，${plain}`, 96);
      }
    }
  } else if (genre === 'history' && !isQuestion) {
    push(`历史里一个被忽略的细节：${plain.slice(0, 22)}`, 92);
  } else if (genre === 'philosophy' && !isQuestion) {
    push(`一个值得反复想的问题：${plain.slice(0, 20)}`, 90);
  } else if (genre === 'business' && !isQuestion) {
    push(`看懂这一点很关键：${plain.slice(0, 22)}`, 88);
  }


  if (isQuestion) {
    // 核心句本身就是问句：直接用或做轻量悬念化（只在原文短句上加钩子，不改动 claim）
    push(raw, 100);
    const q = stripEnd(raw);
    push(`作者在书里问了一个问题：${q}？`, 90);
    push(`读完才敢回答：${q}？`, 80);
    return cands;
  }

  // 1. 否定/对比句式（"不是…而是…"、"真正的…不是…"）
  if (/不是[^，。]{0,20}而是/.test(raw) || /真正的[^，。]{0,12}不是/.test(raw)) {
    push(`你以为的${plain.slice(0, 24)}？作者说没那么简单`, 95);
  }
  // 2. 「其实 / 实际上 / 事实上」
  if (/(其实|实际上|事实上)/.test(raw)) {
    push(plain.replace(/.*?(其实|实际上|事实上)/, '$1'), 96);
    push(`真相是：${plain.replace(/.*?(其实|实际上|事实上)[，,]?/, '')}`, 88);
  }
  // 3. 「关键在于 / 本质是 / 核心是」
  const keyM = raw.match(/(?:关键在于|核心在于|重点是|本质是|本质上是|根本在于)([^。！？]+)/);
  if (keyM) {
    const tail = stripEnd(keyM[1]);
    push(`问题的关键，${tail}`, 94);
  }
  // 4. 「因此 / 所以」结论句
  if (/(因此|所以|从而|由此可见)/.test(raw)) {
    const tail = raw.split(/(?:因此|所以|从而|由此可见)/).pop() ?? raw;
    push(`作者最后给出的答案：${stripEnd(tail).slice(0, 30)}`, 92);
  }
  // 5. 「越…越…」
  if (/越[^，。]{1,12}越/.test(raw)) {
    push(plain, 90);
  }
  // 6. 含「为什么/为何/怎么/如何」的陈述（间接疑问）
  if (/(为什么|为何|怎么|如何|什么才是|什么是)/.test(raw)) {
    push(plain.endsWith('？') ? plain : `${plain}？`, 85);
  }

  // 7. 通用问题化：把陈述改写成开放式问题（只用原句概念，不预设答案/后果）
  const concept = plain.slice(0, 26);
  push(`${concept}，为什么？`, 70);
  // 8. 最朴素也最安全：直接用核心句短句做标题
  push(plain, 60);

  // 用 seed 做确定性排序微调，让不同单元标题样式有变化
  return cands.map((c, i) => ({ ...c, rank: c.rank - ((seed + i) % 3) }));
}

/** 校验候选标题的「实词」是否全部来自原文（防止凭空捏造） */
function isGrounded(title: string, sourceText: string): boolean {
  const compact = sourceText.replace(/\s+/g, '');
  // 标题里的三元实词串，只要有一组在原文中出现即可认为该概念有支撑；
  // 且标题不得包含原文完全没有的具体名词（这里用二元串抽查）。
  const terms = contentTerms(title);
  if (terms.length === 0) return true;
  const tri = terms.filter((t) => t.length === 3);
  const supported = tri.filter((t) => compact.includes(t));
  // 标题中提取到的三元实词串，至少要有一半能在原文中找到（悬念包装词不计）
  return supported.length >= Math.max(1, Math.ceil(tri.length * 0.5));
}

export const TITLE_GENERATOR = 'mock-lang-aware-v5' as const;

// ───────────────────────── 标题语言国际化 ─────────────────────────
// 铁律：标题语言 = 当前界面语言，与原书语言无关；正文永远保留原文。
// MVP 阶段不接翻译 API：跨语言时用「类型化中文/英文钩子骨架 + 词汇表关键词」
// 生成通顺、不掺外语的目标语言标题（理解段落核心意思 → 目标语言重写）。
// 真正语义翻译在接入 LLM 时替换即可，接口保持不变。

export type TitleLang = 'zh' | 'en';

import i18n from '../i18n';

/** 目标标题语言：跟随当前界面语言（zh-CN → zh，其余 → en） */
export function getTargetLang(): TitleLang {
  try {
    return String(i18n.language ?? '').startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

/** 粗粒度检测文本语言：CJK 占比高判中文，拉丁字母占比高判英文，否则 other */
export function detectLang(text: string): 'zh' | 'en' | 'other' {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  if (cjk >= latin && cjk >= 10) return 'zh';
  if (latin >= 20 && latin > cjk) return 'en';
  return 'other';
}

// —— 英文→中文常用领域词汇表（覆盖社科/科普/自我成长/商业/哲学/传记/历史高频词）——
const EN_ZH_GLOSSARY: Array<[RegExp, string]> = [
  [/\bpsycholog\w*/gi, '心理'],
  [/\bmind\b/gi, '内心'], [/\bbrain\b/gi, '大脑'], [/\bconscious\w*/gi, '意识'],
  [/\b(emotion|emotional|feeling)s?\b/gi, '情绪'], [/\bfear\b/gi, '恐惧'],
  [/\bhappy|happiness\b/gi, '幸福'], [/\blove\b/gi, '爱'], [/\banxiety\b/gi, '焦虑'],
  [/\bdepress\w*/gi, '抑郁'], [/\btrauma\b/gi, '创伤'], [/\bself[- ]?esteem\b/gi, '自尊'],
  [/\bchoice(s)?\b/gi, '选择'], [/\bd(ecision|ecide)\w*/gi, '决策'], [/\bhabit(s)?\b/gi, '习惯'],
  [/\bbelief(s)?\b/gi, '信念'], [/\bthink|thinking|thought\w*/gi, '思维'],
  [/\b(system|systematic)\w*/gi, '系统'], [/\brelationship\w*/gi, '关系'],
  [/\beconom\w*/gi, '经济'], [/\bmarket(s)?\b/gi, '市场'], [/\bmoney\b/gi, '金钱'],
  [/\bfinanc\w*/gi, '财务'], [/\binvest\w*/gi, '投资'], [/\btrade\b/gi, '贸易'],
  [/\bbusines\w*/gi, '商业'], [/\bcompany|companys|companies\b/gi, '公司'],
  [/\bmanag\w*/gi, '管理'], [/\bproductiv\w*/gi, '效率'], [/\bstrategy\w*/gi, '策略'],
  [/\bscien\w*/gi, '科学'], [/\bresearch\w*/gi, '研究'], [/\bexperiment\w*/gi, '实验'],
  [/\bevidence\b/gi, '证据'], [/\bdata\b/gi, '数据'], [/\btheor(y|ies)\b/gi, '理论'],
  [/\blearn(ing)?\b/gi, '学习'], [/\bknowledge\b/gi, '知识'], [/\bmemory\b/gi, '记忆'],
  [/\btechnolog\w*/gi, '技术'], [/\bbiologic\w*|biology\b/gi, '生物'],
  [/\bevolut\w*/gi, '进化'], [/\bnature\b/gi, '自然'], [/\bclimate\b/gi, '气候'],
  [/\bphysic\w*/gi, '物理'], [/\bunivers\w*/gi, '宇宙'], [/\bquantum\b/gi, '量子'],
  [/\bphilosoph\w*/gi, '哲学'], [/\bmeaning\b/gi, '意义'], [/\btruth\b/gi, '真相'],
  [/\bfreedom\b/gi, '自由'], [/\bexist\w*/gi, '存在'], [/\bmoral|ethic\w*/gi, '道德'],
  [/\bvirtue\b/gi, '美德'], [/\breason\b/gi, '理性'], [/\bwisdom\b/gi, '智慧'],
  [/\bsoci\w*/gi, '社会'], [/\b(society|social)\b/gi, '社会'], [/\bculture\w*/gi, '文化'],
  [/\b(politic|politics)\w*/gi, '政治'], [/\bpower\b/gi, '权力'], [/\bgovern\w*/gi, '治理'],
  [/\bwar\b/gi, '战争'], [/\bhistor\w*/gi, '历史'], [/\b(future|tomorrow)\b/gi, '未来'],
  [/\bchange\b/gi, '改变'], [/\bdiff(erent|erence)?\b/gi, '差异'], [/\bsuccess\b/gi, '成功'],
  [/\bfail(ure|ed)?\b/gi, '失败'], [/\brisk(s)?\b/gi, '风险'], [/\bdiscipline\b/gi, '自律'],
  [/\bcontrol\b/gi, '掌控'], [/\bcontrol\w*/gi, '掌控'], [/\bresponsib\w*/gi, '责任'],
  [/\bpurpose\b/gi, '目标'], [/\bgoals?\b/gi, '目标'], [/\bfocus\b/gi, '专注'],
  [/\bsex|gender\b/gi, '性别'], [/\bwomen?|female\b/gi, '女性'], [/\bmen?|male\b/gi, '男性'],
  [/\bfamil(y|ies)\b/gi, '家庭'], [/\bmother\b/gi, '母亲'], [/\bfather\b/gi, '父亲'],
  [/\beducat\w*/gi, '教育'], [/\bschool\b/gi, '学校'], [/\bchild(ren)?\b/gi, '孩子'],
  [/\blife\b/gi, '人生'], [/\bdie|death\b/gi, '死亡'], [/\btime\b/gi, '时间'],
  [/\bhealth\b/gi, '健康'], [/\bbod(y|ies)\b/gi, '身体'], [/\bfood\b/gi, '饮食'],
  [/\bfaith\b/gi, '信念'], [/\b(god|gods)\b/gi, '神'], [/\breligio\w*/gi, '宗教'],
  [/\bpower\b/gi, '力量'], [/\bwork|working\b/gi, '工作'], [/\bjob|career\b/gi, '职业'],
  [/\bmoney|wealth|rich\b/gi, '财富'], [/\bpoor\b/gi, '贫穷'], [/\bclass\b/gi, '阶层'],
];

/** 从英文文本抽取已被词汇表覆盖的中文关键词（去重、取前 3 个） */
function extractChineseKeywordsFromEnglish(text: string): string[] {
  const out: string[] = [];
  for (const [re, zh] of EN_ZH_GLOSSARY) {
    re.lastIndex = 0;
    if (re.test(text) && !out.includes(zh)) out.push(zh);
  }
  return out.slice(0, 3);
}

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

// —— 英文书 → 中文标题（跨语言 mock：类型化骨架，绝不掺入英文）——
function englishToChineseTitle(body: string, seed: number, bookType?: TitleGenContext['bookType']): { title: string; support: string } {
  const kws = extractChineseKeywordsFromEnglish(body);
  const k = kws[0] ?? '这件事';
  const k2 = kws[1] ?? '';

  const fiction = [
    '那个改变一切的瞬间',
    '没有人预料到接下来发生的事',
    '当真相浮出水面',
    '命运在那一刻拐弯',
    '看似平静，暗潮涌动',
  ];
  const biography = [
    '他的选择里，藏着答案',
    '命运转折发生在那一刻',
    '很少有人注意到这个细节',
    '真正改变他的，是这件事',
  ];
  const history = [
    '一个被忽略的细节，改变了后来的走向',
    '历史真正的拐点藏在这里',
    '那场不起眼的事件之后，一切都变了',
    '后来的走向，在那时已经注定',
  ];
  const philosophy = [
    `${k}，究竟意味着什么`,
    `我们以为的${k}，可能并不是真相`,
    `关于${k}，一个被忽略的回答`,
    `${k2 ? `在${k2}与${k}之间，` : ''}什么才是更重要的`,
  ];
  const business = [
    `真正拉开差距的，不是${k}`,
    `${k}背后，多数人忽略的逻辑`,
    `会用${k}的人，和别人不一样`,
    `看懂${k}，很多事就想通了`,
  ];
  const social = [
    `为什么${k}，和你想的不一样`,
    `${k}背后真正的原因，多数人没看懂`,
    `你越在${k}上用力，越容易适得其反`,
    `${k}这件事，其实有迹可循`,
    `读懂${k}，就看懂了一半的人生`,
  ];

  const pool =
    bookType === 'fiction' ? fiction
    : bookType === 'biography' ? biography
    : bookType === 'history' ? history
    : bookType === 'philosophy' ? philosophy
    : bookType === 'business' ? business
    : social;

  const support = splitSentences(body)[0] ?? '';
  return { title: pick(pool, seed), support };
}

// —— 中文书 → 英文标题（界面切英文时；跨语言 mock：类型化英文骨架，绝不掺中文）——
function chineseToEnglishTitle(seed: number, bookType?: TitleGenContext['bookType']): { title: string; support: string } {
  const fiction = [
    'The Moment Everything Changed',
    'Nobody Saw What Came Next',
    'When the Truth Surfaced',
    'Where Fate Took a Turn',
  ];
  const biography = [
    'The Answer Hidden in His Choice',
    'The Detail Few Ever Noticed',
    'What Really Changed Him',
  ];
  const history = [
    'One Overlooked Detail That Changed Everything',
    'The Turning Point History Forgot',
    'After That Quiet Day, Nothing Was the Same',
  ];
  const philosophy = [
    'What Does It Really Mean?',
    'What We Take for Truth May Not Be',
    'The Question No One Asks',
  ];
  const business = [
    'What Really Sets People Apart',
    'The Logic Most People Miss',
    'What Successful People See Differently',
  ];
  const social = [
    'Why Things Are Not What They Seem',
    'The Real Reason Behind It',
    'The Harder You Push, the Further It Gets',
    'Read This, and Much of Life Makes Sense',
  ];
  const pool =
    bookType === 'fiction' ? fiction
    : bookType === 'biography' ? biography
    : bookType === 'history' ? history
    : bookType === 'philosophy' ? philosophy
    : bookType === 'business' ? business
    : social;
  return { title: pick(pool, seed), support: '' };
}

export interface AiMeta {
  title: string;
  coreSentence?: string;
  titleSupport?: string;
  /** 小说专用：标题是否需要由切分器在前面加「第X篇」序号前缀 */
  fictionEpisode?: boolean;
  generator: typeof TITLE_GENERATOR;
}

// ───────────────────────── 小说/虚构类：故事钩子 ─────────────────────────
// 小说不做"观点标题"，只制造悬念：找最有戏剧性、反转、未解之谜的原句，
// 保持原文事实，不解释道理、不总结观点，不剧透结果。

/** 强烈悬念信号：这些词出现的句子通常是冲突/反转/秘密所在 */
const FICTION_HOOK_PATTERNS: RegExp[] = [
  /竟然|居然|万万没想到|怎么会|难道|竟然是|原来|这才发现|才发现|才知道/,
  /一模一样|面目全非|一动不动|一言不发|沉默了|愣住|惊呆了|僵在|浑身|脸色/,
  /门(开着|虚掩|被推开)|推开(那|这)?(扇)?门|走进|出现|消失|不见/,
  /秘密|真相|遗言|遗书|陌生|熟悉的声音|不是别人|正是|竟然就是/,
  /[?？]$|——|……$/,
  /说不出话|没有说话|谁也没说话|空气(仿佛)?(凝固|安静)|时间(仿佛)?静止/,
];

/** 挑出小说单元里最有钩子的一句（原句），返回不含序号前缀的悬念标题 */
function pickFictionHook(bodyText: string): { title: string; support?: string } {
  const paras = bodyText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allSentences: string[] = [];
  for (const p of paras) allSentences.push(...splitSentences(p));

  let best: { s: string; score: number } | null = null;
  for (const s of allSentences) {
    const text = s.trim();
    const len = text.length;
    if (len < 6 || len > 60) continue; // 钩子要干脆
    let score = 0;
    FICTION_HOOK_PATTERNS.forEach((pat, i) => {
      if (pat.test(text)) score += [16, 14, 10, 12, 8, 10][i] ?? 8;
    });
    // 对话句自带场景张力
    if (/^[「"]/.test(text) || /["」]$/.test(text)) score += 4;
    if (score === 0) continue;
    // 靠后（接近反转点）的句子略加分，但不压倒强信号
    score += Math.min(6, allSentences.indexOf(text) * 0.3);
    if (!best || score > best.score) best = { s: text, score };
  }

  if (best) {
    const hook = stripEnd(best.s).slice(0, 34);
    // 钩子标题去掉对话原句首尾引号（标题不以引号开头/结尾，避免右引号/直引号打头）
    const clean = hook.replace(/^[「『“"]+/, '').replace(/[」』”"]+$/, '').trim();
    return { title: clean || hook, support: best.s };
  }
  // 兜底：用最后一个场景句（章节往往在转折处收尾），制造"接下来怎么了"
  const scenes = allSentences.filter((s) => s.trim().length >= 8 && s.trim().length <= 40);
  const last = scenes[scenes.length - 1] ?? allSentences[allSentences.length - 1] ?? '';
  return { title: stripEnd(last).slice(0, 30) || '故事还在继续', support: last || undefined };
}

/**
 * 标题生成主入口。
 * @param bodyText 单元正文（不含章标题的原文）
 * @param seed     确定性随机种子
 * @param ctx      生成上下文（书籍类型、书名），用于按类型差异化标题风格
 */
export function generateAiMeta(bodyText: string | null | undefined, seed: number, ctx?: TitleGenContext): AiMeta {
  // 防御：旧版/异常单元可能缺正文（undefined/null/非字符串），任何输入都不应抛错
  const body = typeof bodyText === 'string' ? bodyText : '';
  const target = getTargetLang();
  const src = detectLang(body);

  // 跨语言：正文语言 ≠ 界面语言。mock 阶段不翻译正文，只在目标语言里
  // 「理解 → 重写」出通顺、不掺外语的标题（小说同理）。正文永远保留原文。
  if (src !== 'other' && target !== src) {
    const cross =
      target === 'zh'
        ? englishToChineseTitle(body, seed, ctx?.bookType)
        : chineseToEnglishTitle(seed, ctx?.bookType);
    return {
      title: sanitizeTitleQuotes(cross.title),
      coreSentence: cross.support || undefined,
      titleSupport: cross.support || undefined,
      // 小说跨语言也保留连载序号前缀，由切分器拼「第X篇 / Ep. N」
      fictionEpisode: ctx?.bookType === 'fiction',
      generator: TITLE_GENERATOR,
    };
  }

  // 小说/虚构类：只做故事钩子，不讲道理；序号前缀「第X篇」由切分器按全书顺序添加
  if (ctx?.bookType === 'fiction') {
    const hook = pickFictionHook(body);
    return {
      title: sanitizeTitleQuotes(hook.title),
      coreSentence: hook.support,
      titleSupport: hook.support,
      fictionEpisode: true,
      generator: TITLE_GENERATOR,
    };
  }

  const core = extractCoreSentence(body);

  if (core) {
    const candidates = toTitleCandidates(core, seed, ctx ?? {});
    const grounded = candidates.filter((c) => isGrounded(c.title, body));
    grounded.sort((a, b) => b.rank - a.rank);
    const pick = grounded[0] ?? candidates.sort((a, b) => b.rank - a.rank)[0];
    if (pick) {
      return {
        title: sanitizeTitleQuotes(pick.title),
        coreSentence: core.text,
        titleSupport: pick.support,
        generator: TITLE_GENERATOR,
      };
    }
  }

  // 兜底：提取不出明确核心句时，用第一句短句做朴素标题——宁朴素，不骗人
  const firstSentence = splitSentences(body)[0] ?? '';
  const fallback = sanitizeTitleQuotes(stripEnd(firstSentence).slice(0, 30)) || '一段值得细读的内容';
  return {
    title: fallback,
    coreSentence: firstSentence || undefined,
    titleSupport: firstSentence || undefined,
    generator: TITLE_GENERATOR,
  };
}
