/**
 * 书籍类型在线分类（后端代理）
 *
 * 策略（准确率优先，宁可返回 null 让用户手改，也不乱猜）：
 * 1. EPUB 自带元数据（dc:subject / dc:type）——出版方/编辑正式标注，最高优先级
 * 2. 联网综合判断：Google Books categories + Google Books 简介 + 通用网页搜索结果
 * 3. 多来源投票，证据不足 → 返回 null（前端落为「其他」）
 *
 * 本模块运行在 Express 端（使用 coze-coding-dev-sdk 联网搜索，不暴露到前端）。
 */
import { SearchClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { glmAvailable, glmChat, glmModelName, extractJson } from './glm';

export type OnlineBookType =
  | 'social_science'
  | 'biography'
  | 'history'
  | 'fiction'
  | 'philosophy'
  | 'business'
  | 'other';

export interface ClassifyRequest {
  title: string;
  author?: string;
  /** EPUB dc:subject / dc:type 原始值 */
  subjects?: string[];
  language?: string;
}

export interface ClassifyResponse {
  /** 判定类型；null = 无法确认，前端应落为「其他」等用户手改 */
  bookType: OnlineBookType | null;
  /** 结论来源：epub 元数据 / google 分类 / google 简介 / 网页搜索 / 综合 */
  source: 'epub' | 'online' | 'none';
  /** 判定依据（调试/展示用） */
  evidence: string[];
  /** 顺带从 Google Books 拿到的封面/简介 */
  coverUrl?: string;
  description?: string;
}

/**
 * 在线描述文本 → 类型信号。
 * 这不是「关键词猜测类型」，而是解读在线资料中出版方/书店/百科如何正式归类这本书
 * （如「是一部长篇小说」「人物传记」「经济学著作」「豆瓣图书标签: 历史」）。
 */
interface TypeSignal {
  type: OnlineBookType;
  /** 强信号：出现在标题/标签/定性介绍中（「该小说」「人物传记」「经济学著作」） */
  strong: RegExp;
  /** 弱信号：正文描述中的宽泛词，仅多源共现时加分 */
  weak?: RegExp;
}

function signals(): TypeSignal[] {
  return [
    {
      type: 'fiction',
      // 强：小说/长篇/短篇/图像小说/虚构/故事集/科幻/悬疑/言情/武侠/奇幻文学体裁词
      strong:
        /长篇小说|中篇小说|短篇小说|图像小说|小\s*说|虚构作品|虚构文学|魔幻现实|现实主义文学|文学巨著|文学代表作|长篇(?:文学)?作品|故事集|科幻小说|悬疑小说|推理小说|言情小说|武侠小说|玄幻|奇幻小说|长篇作品|novel|fiction|fictional|literary fiction|short stor(y|ies)|\bromance novel\b|graphic novel|magical realism/i,
      // 弱：泛指「故事/文学/剧集原著」——单独出现不算，避免一切叙事类内容都被判小说
      weak: /\bromance\b|\bmystery\b|thriller|\bfantasy\b|science fiction|\bsaga\b/,
    },
    {
      type: 'biography',
      strong:
        /人物传记|名人传记|自传体|传记作品|传记文学|个人传记|官方传记|授权传记|传记作家|传记类|回忆录|口述史|生平事迹|评传|大传|全传|画传|biography|autobiography|memoir|life story of|official biography|authorized biography/i,
      weak: /生平|早年经历|传\s*记|传记/,
    },
    {
      type: 'history',
      strong:
        /历史著作|历史学(?:著作|作品|读物|家)?|史学|史料|历史读物|通史|断代史|编年史|纪实文学|经典历史|历史\s*[（(]|历史学教授|历史学家创作|history book|historical (?:study|account|work|nonfiction)|chronicle|historian/i,
      weak: /历史|纪实|史书/,
    },
    {
      type: 'philosophy',
      strong:
        /哲学著作|哲学(?:经典|作品|读物|思想|入门)|思想家|形而上学|存在主义(?:哲学)?|伦理学|认识论|哲学教授|哲学家(?:创作|的|写)|philosophy (?:book|classic|work|professor)|philosophical (?:work|classic|essay)|existentialism|metaphysics|philosopher/i,
      weak: /哲学|哲学家|philosophy|philosophical|ethics/,
    },
    {
      type: 'business',
      strong:
        /经济学(?:著作|经典|入门|通识|读物|奖|家|教授)|经济管理|商业(?:管理|著作|经典|思维)|管理学(?:著作|经典|大师)?|营销(?:学|心得|手记|大师)|投资学|金融学(?:著作|读物)?|创业(?:指南|心得)|商业模式|营销心得|经营|经济学奖得主|economics (?:book|textblock|classic|professor|prize|nobel)|business (?:book|guide|classic)|management book|personal finance|economist|nobel.*economics/i,
      weak: /经济学|经济|商业|管理|营销|投资|金融|创业|economics|business|management|marketing|finance|investing|entrepreneur/,
    },
    {
      type: 'social_science',
      strong:
        /心理学(?:著作|通俗|入门|读物|家|教授|荣誉)|社会心理学|社会学(?:著作|经典|教授)?|科普(?:著作|读物|作品|书)?|自我成长|自我提升|心灵成长|自助读物|行为经济学|实验经济学|心理学家|心理学身份|psychology (?:book|professor|professor)|popular psychology|self-help book|social science|popular science|behavioral (?:science|economics)|psychologist/i,
      weak: /心理学|社会学|科普|成长|psychology|sociology|self-?help|cognitive/,
    },
  ];
}

/** 强否定信号：出现这些词时，小说类型即使有弱信号也不应成立 */
const FICTION_DENY = /非虚构|non-?fiction|纪实文学|学术著作|教材|论文集|research|academic|textbook/i;

/** Google Books categories → 类型（作为一个高权重投票来源） */
function mapGoogleCategories(categories: string[]): OnlineBookType | null {
  const text = categories.join(' | ').toLowerCase();
  if (!text.trim()) return null;
  if (/fiction|literary|literature|novel|romance|mystery|detective|thriller|short stor|fantasy|poetry|drama/.test(text)) return 'fiction';
  if (/biograph|autobiograph|memoir/.test(text)) return 'biography';
  if (/histor/.test(text)) return 'history';
  if (/philosoph/.test(text)) return 'philosophy';
  if (/business|econom|finance|management|marketing|entrepreneur|invest/.test(text)) return 'business';
  if (/self-help|self help|psycholog|social science|sociolog|popular science|personal growth|motivational/.test(text)) return 'social_science';
  return null;
}

/** EPUB dc:subject / dc:type → 类型（出版方正式标注，直接采信） */
function mapEpubSubjects(subjects: string[]): OnlineBookType | null {
  const text = subjects.join(' | ');
  if (!text.trim()) return null;
  for (const s of signals()) {
    if (s.strong.test(text)) return s.type;
  }
  return null;
}

/**
 * 从在线文本计票。
 * @param strongW 强信号（体裁定性词）权重
 * @param weakW   弱信号（宽泛词）权重，需多个来源共现才够
 */
function tally(
  votes: Map<OnlineBookType, number>,
  ev: string[],
  text: string,
  strongW: number,
  weakW: number,
): void {
  for (const s of signals()) {
    if (s.strong.test(text)) {
      votes.set(s.type, (votes.get(s.type) ?? 0) + strongW);
      ev.push(`强信号「${s.type}」+${strongW}`);
    } else if (s.weak && s.weak.test(text)) {
      votes.set(s.type, (votes.get(s.type) ?? 0) + weakW);
      ev.push(`弱信号「${s.type}」+${weakW}`);
    }
  }
  // 小说否定信号
  if (FICTION_DENY.test(text)) {
    votes.set('fiction', Math.max(0, (votes.get('fiction') ?? 0) - 6));
    ev.push('非虚构信号：小说 -6');
  }
  // 跨学科/边界情况裁决：
  // - 「历史学家/历史著作/基于史料（实录/正史/编年史）」是根本性的历史归类，
  //   即使被网络平台称作"历史小说/通俗历史"（如《明朝那些事儿》）也归历史。
  if (/历史学家|历史著作|历史学教授|通俗历史|历史读物|参考《?明史|正史|史料记载|historian/.test(text)) {
    votes.set('history', (votes.get('history') ?? 0) + 4);
    ev.push('史料/历史著作定性：history +4');
  }
  // - 「心理学家/心理学教授/行为经济学」是根本性的社科归类
  //   （卡尼曼虽获诺贝尔经济学奖，《思考快与慢》是心理学/行为科学经典，
  //    "经济学奖"投出的 business 票需由心理学定性压过，bias +4 与史料定性同级）
  if (/心理学家|心理学教授|心理学研究|心理学荣誉|行为经济学|认知心理学|psychologist|psychology professor|behavioral economics/i.test(text)) {
    votes.set('social_science', (votes.get('social_science') ?? 0) + 4);
    ev.push('心理学者/行为科学定性：social_science +4');
  }
}

async function fetchGoogleBooks(title: string, author: string): Promise<{
  categories: string[];
  description?: string;
  coverUrl?: string;
} | null> {
  const q = encodeURIComponent(
    [title ? `intitle:${title}` : '', author ? `inauthor:${author}` : ''].filter(Boolean).join(' '),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=3`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        volumeInfo?: {
          categories?: string[];
          description?: string;
          imageLinks?: { thumbnail?: string; smallThumbnail?: string };
        };
      }>;
    };
    const vol = data.items?.[0]?.volumeInfo;
    if (!vol) return null;
    const coverRaw = vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail;
    return {
      categories: (vol.categories ?? []).filter(Boolean),
      description: vol.description?.slice(0, 1200),
      coverUrl: coverRaw ? coverRaw.replace(/^http:\/\//, 'https://') : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 合法类型集合（GLM 返回值校验用） */
const GLM_VALID_TYPES = new Set<string>([
  'social_science', 'biography', 'history', 'fiction', 'philosophy', 'business', 'other',
]);

/**
 * GLM 兜底裁决：规则投票证据不足时，把书名/作者/已有资料交给大模型判断。
 * 自部署环境没有扣子搜索凭证、Google Books 也不可达，GLM 是唯一稳定的在线判定来源。
 * 任何异常都返回 null（调用方继续走「判为未知」），绝不阻塞导入。
 */
async function glmClassify(
  req: ClassifyRequest,
  description: string | undefined,
  evidence: string[],
): Promise<OnlineBookType | null> {
  if (!glmAvailable()) return null;
  const typeGuide =
    'social_science=社科/心理学/科普/自我成长; biography=人物传记/回忆录; history=历史/纪实; ' +
    'fiction=小说/虚构文学; philosophy=哲学; business=商业/经济/管理; other=以上都不是/无法判断';
  const lines = [
    `书名：${req.title}`,
    req.author ? `作者：${req.author}` : '',
    req.subjects?.length ? `出版标注：${req.subjects.join(' / ')}` : '',
    description ? `资料：${description.slice(0, 600)}` : '',
  ].filter(Boolean);
  try {
    const raw = await glmChat(
      [
        {
          role: 'system',
          content:
            '你是图书分类专家。根据书名、作者和资料判断这本书属于哪个类型。' +
            `候选类型（格式 类型=含义）：${typeGuide}。` +
            '宁可判 other 也不要把叙事散文/随笔集误判为小说。只输出 JSON：{"bookType":"...","reason":"一句话依据"}',
        },
        { role: 'user', content: lines.join('\n') },
      ],
      { temperature: 0.1, timeoutMs: 30000, maxTokens: 200 },
    );
    const parsed = extractJson<{ bookType?: string; reason?: string }>(raw);
    const t = parsed?.bookType?.trim();
    if (t && GLM_VALID_TYPES.has(t)) {
      evidence.push(`GLM(${glmModelName()}) 判定：${t}（${parsed?.reason?.slice(0, 60) ?? ''}）`);
      return t as OnlineBookType;
    }
    evidence.push('GLM 返回无法解析，放弃');
  } catch (e) {
    evidence.push(`GLM 调用失败：${(e as Error).message?.slice(0, 80)}`);
  }
  return null;
}

/**
 * 综合联网信息判定书籍类型。
 * @param headers Express 请求头（透传给 SDK 做链路追踪/鉴权）
 */
export async function classifyBook(
  req: ClassifyRequest,
  headers?: Record<string, string>,
): Promise<ClassifyResponse> {
  const title = (req.title || '').trim();
  const author = (req.author || '').trim();
  const subjects = (req.subjects ?? []).map(s => s.trim()).filter(Boolean);
  const evidence: string[] = [];

  // 1) EPUB 元数据直接采信
  const epubType = mapEpubSubjects(subjects);
  if (epubType) {
    evidence.push(`EPUB 元数据：${subjects.join(' / ')} → ${epubType}`);
    return { bookType: epubType, source: 'epub', evidence };
  }
  if (!title) {
    return { bookType: null, source: 'none', evidence: ['缺少书名，无法联网查询'] };
  }

  const votes = new Map<OnlineBookType, number>();
  let coverUrl: string | undefined;
  let description: string | undefined;

  // 2a) Google Books
  const gb = await fetchGoogleBooks(title, author);
  if (gb) {
    const catType = mapGoogleCategories(gb.categories);
    if (catType) {
      votes.set(catType, (votes.get(catType) ?? 0) + 4);
      evidence.push(`Google Books categories「${gb.categories.join(' / ')}」→ ${catType} +4`);
    }
    if (gb.description) {
      description = gb.description;
      // 出版社官方简介里的体裁定性词可信度高（强4弱1）
      tally(votes, evidence, gb.description, 4, 1);
      evidence.push('Google Books 简介已计入');
    }
    coverUrl = gb.coverUrl;
  } else {
    evidence.push('Google Books 无结果或请求失败');
  }

  // 2b) 通用网页搜索（书名+作者 是哪类书）。
  // 搜索引擎对「书名 作者 小说/传记/豆瓣」类查询返回的标题+摘要里通常含明确定性词
  // （如「该小说…」「人物传记」「豆瓣图书标签: 历史」）。
  try {
    const config = new Config({ timeout: 12000 });
    const client = new SearchClient(config, headers ? HeaderUtils.extractForwardHeaders(headers) : undefined);
    const query = author
      ? `《${title}》 ${author} 豆瓣 图书 简介`
      : `《${title}》 豆瓣 图书 简介`;
    const resp = await client.webSearch(query, 8, true);
    // 每个搜索结果是一个独立来源（出版社/书店/百科/豆瓣）。
    // 逐条计票：同一来源标题+摘要中出现的体裁定性词独立计票，
    // 避免把所有摘要拼成大段文本后体裁词被稀释、或不同来源的弱信号被叠加放大。
    let sourceCount = 0;
    const pieces: string[] = [];
    if (resp.summary) pieces.push(resp.summary);
    for (const item of resp.web_items ?? []) {
      const piece = [item.title, item.snippet].filter(Boolean).join('\n');
      if (piece.trim()) pieces.push(piece);
    }
    for (const piece of pieces) {
      const before = new Map(votes);
      tally(votes, evidence, piece.slice(0, 1200), 3, 1);
      // 该来源贡献了任何强信号才算一个有效来源
      if ([...votes.entries()].some(([k, v]) => v > (before.get(k) ?? 0))) sourceCount++;
    }
    if (sourceCount > 0) {
      evidence.push(`网页搜索 ${sourceCount} 个来源已计入`);
    } else {
      evidence.push('网页搜索无有效文本');
    }
  } catch (e) {
    evidence.push(`网页搜索失败：${(e as Error).message?.slice(0, 80)}`);
  }

  // 3) 投票裁决：第一名需达到置信阈值，且明显领先第二名。
  // 阈值 5：两个独立来源出现同一体裁定性（3+?），或一个来源强信号 + Google categories 等高权重票。
  // 只有单一来源弱信号（1~3 分）判未知，宁可让用户手改也不乱标。
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0 || sorted[0][1] < 5) {
    evidence.push(`证据不足（最高票 ${sorted[0]?.[1] ?? 0} < 5），交由 GLM 裁决`);
    const glmType = await glmClassify(req, description, evidence);
    if (glmType) return { bookType: glmType, source: 'online', evidence, coverUrl, description };
    return { bookType: null, source: 'none', evidence, coverUrl, description };
  }
  const [topType, topScore] = sorted[0];
  const secondScore = sorted[1]?.[1] ?? 0;
  // 领先差阈值 2：体裁边界书（如"通俗历史小说"）若历史有史料定性加权（+4），
  // 会自然以 ≥2 分胜出；平票则交 GLM 裁决。
  if (sorted.length > 1 && topScore - secondScore < 2) {
    evidence.push(`票数接近（${topType}=${topScore} vs ${sorted[1][0]}=${secondScore}），交由 GLM 裁决`);
    const glmType = await glmClassify(req, description, evidence);
    if (glmType) return { bookType: glmType, source: 'online', evidence, coverUrl, description };
    return { bookType: null, source: 'none', evidence, coverUrl, description };
  }
  evidence.push(`最终投票：${topType}（${topScore} 分，领先 ${topScore - secondScore}）`);
  return { bookType: topType, source: 'online', evidence, coverUrl, description };
}
