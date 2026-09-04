/**
 * 核心数据模型
 *
 * 原则：AI 生成字段（ai_*）与 Canonical Source（原文）严格分离，
 * AI 永远不修改 source_text 中的任何一个字。
 */

/** 书籍类型：决定是否做 Feed 切分与标题风格 */
export type BookType =
  | 'biography' // 人物传记
  | 'history' // 历史/纪实
  | 'social_science' // 社科/科普/自我成长（默认）
  | 'fiction' // 小说/虚构（进 Feed，但严格按章顺序追更、绝不剧透）
  | 'philosophy' // 哲学
  | 'business' // 商业/经济
  | 'other'; // 其他（不进 Feed 切分，仅 Reader 连续阅读）

export const BOOK_TYPE_LABELS: Record<BookType, string> = {
  biography: '人物传记',
  history: '历史纪实',
  social_science: '社科成长',
  fiction: '小说',
  philosophy: '哲学',
  business: '商业经济',
  other: '其他',
};

/** 适合 Feed 切分的类型；"其他"类只进连续阅读，不进瀑布流 */
export const FEED_SEGMENTABLE_TYPES: BookType[] = [
  'biography',
  'history',
  'social_science',
  'philosophy',
  'business',
  'fiction',
];

export function isSegmentable(type: BookType | undefined): boolean {
  return type ? FEED_SEGMENTABLE_TYPES.includes(type) : true;
}


/** 书籍元数据 */
export interface Book {
  id: string;
  title: string;
  author: string;
  format: 'epub' | 'txt';
  /** 书籍类型（默认 social_science） */
  bookType: BookType;
  /** 封面图片 dataURL（EPUB 提取 / 无封面时为空） */
  coverDataUrl?: string;
  /** 在线来源的封面图 URL（Google Books 等） */
  coverUrl?: string;
  /** 书籍简介（在线元数据） */
  description?: string;
  /** 类型来源：EPUB 元数据 / 在线综合判断 / 未确认(默认其他) / 手动修改。旧值 local/google 仍兼容 */
  bookTypeSource?: 'local' | 'google' | 'epub' | 'online' | 'none' | 'manual';
  createdAt: number;
  /** 切分后的单元数量（冗余字段，便于书库展示） */
  unitCount: number;
  /** 原文节点总数 */
  nodeCount: number;
  chapterCount: number;
}

/** 原文节点类型：标题 / 正文段落 / 列表项 */
export type NodeType = 'heading' | 'para' | 'list';

/** Canonical Source 最小单元：一个段落 / 标题 / 列表项 */
export interface SourceNode {
  /** 格式：`${chapterId}__n${index}` */
  id: string;
  index: number;
  type: NodeType;
  /** 作者原文，不允许任何模块修改 */
  text: string;
}

/** 章节：包含若干有序原文节点 */
export interface Chapter {
  id: string;
  index: number;
  title: string;
  nodes: SourceNode[];
  /**
   * 前置非正文标记：版权页/目录/序言/推荐语/扉页等。
   * Reader 中仍正常展示（用户翻书能看到），但 Feed 切分时整章跳过。
   */
  frontMatter?: boolean;
}

/** 一本书的完整 Canonical Source Map：Book -> Chapter -> SourceNode */
export interface SourceDocument {
  bookId: string;
  chapters: Chapter[];
}

/** 原文定位：章节内的节点下标区间（闭区间） */
export interface SourceRange {
  chapterId: string;
  chapterTitle: string;
  startNode: number;
  endNode: number;
}

/**
 * 语义阅读单元（Semantic Reading Unit）
 * sourceText 直接引用 Canonical Source，是切分区间内原文的逐字拼接。
 */
export interface ReadingUnit {
  id: string;
  bookId: string;
  /** 全书内的顺序序号，从 0 开始 */
  order: number;
  /** 单元起始标题（若该单元以章节标题开头） */
  headingText?: string;
  sourceStart: SourceRange;
  sourceEnd: SourceRange;
  /** 作者原文（逐字拼接，AI 不可修改） */
  sourceText: string;
  /** 供卡片展示的原文预览（原文前若干字，非 AI 生成） */
  preview: string;
  /** 核心句：从原文中提取的论点句（原文原句），用于生成标题、验证标题有据可依 */
  coreSentence?: string;
  /** 标题支撑：支撑标题 claim 的原文片段，确保标题不骗人 */
  titleSupport?: string;
  /** —— AI 生成内容，与原文严格分离 —— */
  ai: {
    title: string;
    estimatedReadingMinutes: number;
    /** 生成器标识，未来替换为真实 LLM 时可追溯 */
    generator: string;
  };
}

/** 阅读进度：按书记录已读单元 */
export interface ReadingProgress {
  bookId: string;
  readUnitIds: string[];
  updatedAt: number;
}

/** 划线高亮 */
export interface Highlight {
  id: string;
  unitId: string;
  bookId: string;
  /** 划选的原文内容 */
  text: string;
  /** 高亮颜色 */
  color?: HighlightColor;
  /** 所在章节与节点（用于列表跳转到原文位置） */
  chapterId?: string;
  nodeIndex?: number;
  createdAt: number;
}

/** 笔记 */
export interface Note {
  id: string;
  unitId: string;
  bookId: string;
  content: string;
  /** 记笔记时划选的原文（可选，用于列表回显） */
  text?: string;
  /** 所在章节与节点（用于列表跳转到原文位置） */
  chapterId?: string;
  nodeIndex?: number;
  createdAt: number;
}

/** 用户偏好（收藏 / 显式反馈 / 书籍与主题偏好分） */
export interface Marks {
  /** 收藏的单元 id */
  favorites: Record<string, boolean>;
  /** 单元级反馈：1 多推荐 / -1 少推荐 */
  unitFeedback: Record<string, 1 | -1>;
  /** 书籍级偏好分，按 bookId 累加 */
  bookScore: Record<string, number>;
  /** 主题级偏好分，按 topic（归一化章节主题）累加 */
  topicScore: Record<string, number>;
}

/** 解析器输出：元信息 + 章节原文 */
export interface ParsedBook {
  title: string;
  author: string;
  format: Book['format'];
  coverDataUrl?: string;
  /** EPUB 元数据 dc:subject 主题词（用于类型推测） */
  subjects?: string[];
  chapters: Chapter[];
}

export type FeedFilter = 'all' | 'unread' | 'read' | 'favorites';
export type ViewName = 'feed' | 'library' | 'study' | 'reader';

/** Reader 连续阅读定位锚点：定位到某章的某个原文节点 */
export interface ReaderAnchor {
  chapterId: string;
  nodeIndex: number;
}

/** 划线颜色（多色高亮） */
export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/** Reader 阅读主题：浅色米纸 / 深色暖碳 / 护眼绿 */
export type ReaderTheme = 'paper' | 'carbon' | 'eye';

/** Reader 阅读设置（持久化到本地） */
export interface ReaderSettings {
  /** 字号档位：0 小 / 1 中 / 2 大 / 3 特大 */
  fontSizeStep: number;
  /** 正文字体：serif 衬线 / sans 无衬线 */
  fontFamily: 'serif' | 'sans';
  /** 行距：compact 紧凑 / normal 标准 / loose 宽松 */
  lineHeight: 'compact' | 'normal' | 'loose';
  /** 阅读主题 */
  theme: ReaderTheme;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSizeStep: 1,
  fontFamily: 'serif',
  lineHeight: 'normal',
  theme: 'paper',
};

/** 书签：定位到某书某章某段落 */
export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: string;
  /** 章内节点下标 */
  nodeIndex: number;
  /** 该段落原文摘录（前若干字），便于列表识别 */
  snippet: string;
  createdAt: number;
}

/** 每本书的阅读滚动位置记忆（按书持久化） */
export interface ReaderPosition {
  bookId: string;
  chapterId: string;
  nodeIndex: number;
  /** 该节点内的滚动偏移比例（0~1），用于精确定位 */
  offsetRatio?: number;
  updatedAt: number;
}


// ---------- 云端同步 ----------

/**
 * 用户整库快照：登录模式下本地数据与服务器之间以此结构双向同步。
 * documents 为书籍原文（Canonical Source Map），其余字段与 IndexedDB 各 store 对应；
 * readerPrefs 对应 localStorage 中 scrollbook-reader-prefs 的持久化部分。
 */
export interface CloudSnapshot {
  version: 1;
  books: Book[];
  documents: SourceDocument[];
  units: ReadingUnit[];
  progress: Record<string, ReadingProgress>;
  highlights: Highlight[];
  notes: Note[];
  marks: Marks;
  readerPrefs: {
    settings?: unknown;
    bookmarks?: unknown;
    positions?: unknown;
    highlightColor?: unknown;
  };
}

/** 服务器返回的会话用户信息 */
export interface CloudUser {
  id: number;
  email: string;
  createdAt: number;
}

/** 同步模式：local=纯本地（未登录，默认）；cloud=登录后云端同步 */
export type AppMode = 'local' | 'cloud';
