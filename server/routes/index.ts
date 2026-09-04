import { Router } from 'express';
import { classifyBook } from '../lib/classify';
import { glmAvailable, glmChat, glmModelName, extractJson } from '../lib/glm';
import { authRouter, adminRouter, getAdminKey } from './auth';
import { syncRouter } from './sync';
import * as cloudDb from '../lib/cloudDb';

const router = Router();

// 账号 / 邀请码 / 云端同步
router.use('/api/auth', authRouter);
router.use('/api/admin', adminRouter);
router.use('/api', syncRouter);

/**
 * 服务器启动时初始化云端 SQLite 库；
 * 若无任何邀请码则自动生成 5 个并打印到日志（管理员用此邀请码开放注册）。
 */
export function initCloud(): void {
  try {
    cloudDb.getDb();
    if (cloudDb.countUnusedInviteCodes() === 0) {
      const codes = cloudDb.createInviteCodes(5);
      console.log('\n🔑 已生成初始邀请码（邀请制注册用，也可通过管理员接口生成）:');
      codes.forEach((c) => console.log(`   - ${c}`));
      console.log(`   管理员密钥（生成更多邀请码）: ${getAdminKey()}\n`);
    } else {
      console.log(`☁️  云端存储就绪，剩余可用邀请码：${cloudDb.countUnusedInviteCodes()} 个`);
      console.log(`   管理员密钥（生成更多邀请码）: ${getAdminKey()}`);
    }
  } catch (e) {
    console.error('[cloud] SQLite 初始化失败（云端功能不可用，本地模式不受影响）:', e);
  }
}

// API 路由示例
router.get('/api/hello', (_req, res) => {
  res.json({
    message: 'Hello from Express + Vite!',
    timestamp: new Date().toISOString(),
  });
});

router.post('/api/data', (req, res) => {
  res.json({
    success: true,
    data: req.body,
    receivedAt: new Date().toISOString(),
  });
});

// 健康检查接口
router.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: process.env.COZE_PROJECT_ENV,
    timestamp: new Date().toISOString(),
  });
});

/**
 * 书籍类型在线分类。
 * body: { title, author?, subjects?（EPUB dc:subject/dc:type）, language? }
 * 返回 { bookType: BookType|null, source, evidence, coverUrl?, description? }
 * bookType 为 null 表示无法确认，前端落为「其他」。
 */
router.post('/api/classify-book', async (req, res) => {
  const body = (req.body ?? {}) as {
    title?: unknown;
    author?: unknown;
    subjects?: unknown;
    language?: unknown;
  };
  const title = typeof body.title === 'string' ? body.title : '';
  const author = typeof body.author === 'string' ? body.author : '';
  const subjects = Array.isArray(body.subjects)
    ? body.subjects.filter((s): s is string => typeof s === 'string')
    : [];
  const language = typeof body.language === 'string' ? body.language : undefined;

  try {
    const result = await classifyBook(
      { title, author, subjects, language },
      req.headers as Record<string, string>,
    );
    res.json(result);
  } catch (e) {
    res.status(200).json({
      bookType: null,
      source: 'none',
      evidence: [`分类服务异常：${(e as Error).message?.slice(0, 120)}`],
    });
  }
});

/**
 * 标题忠实度宽松校验：标题的实词必须能在原文里找到，防止 GLM「文不对题」。
 * 中文按 CJK 2-gram 命中率、英文按单词命中率，阈值 0.5；不过关的结果直接丢弃（保留 mock 标题）。
 */
function titleGrounded(title: string, text: string): boolean {
  const cjkRuns = title.match(/[一-鿿]{2,}/g) ?? [];
  if (cjkRuns.length > 0) {
    let hit = 0;
    let total = 0;
    for (const run of cjkRuns) {
      for (let i = 0; i < run.length - 1; i++) {
        total++;
        if (text.includes(run.slice(i, i + 2))) hit++;
      }
    }
    return total === 0 || hit / total >= 0.5;
  }
  const words = title.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  if (words.length === 0) return true;
  const lower = text.toLowerCase();
  const hit = words.filter((w) => lower.includes(w)).length;
  return hit / words.length >= 0.5;
}

/**
 * AI 标题生成（GLM）。
 * body: { items: [{ id, text, coreSentence?, bookType? }] }
 * - text 是单元原文（作者原文，AI 只读不改）；标题铁律：claim 必须被原文支撑，绝不编造。
 * - 每次最多 8 条（批量一次请求），文本各截断至 1500 字控制 token。
 * 返回 { results: [{ id, title }], generator }；GLM 未配置或失败时返回 ok:false，前端保留 mock 标题。
 */
router.post('/api/ai-titles', async (req, res) => {
  if (!glmAvailable()) {
    res.json({ ok: false, error: 'GLM_API_KEY 未配置', results: [] });
    return;
  }
  const body = (req.body ?? {}) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  const cleaned = items
    .slice(0, 8)
    .map((it, idx) => {
      const o = (it ?? {}) as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text.slice(0, 1500) : '';
      const core = typeof o.coreSentence === 'string' ? o.coreSentence.slice(0, 200) : '';
      const bookType = typeof o.bookType === 'string' ? o.bookType : '';
      return text.trim() ? { id: String(o.id ?? idx), text, core, bookType } : null;
    })
    .filter((x): x is { id: string; text: string; core: string; bookType: string } => x !== null);

  if (cleaned.length === 0) {
    res.json({ ok: false, error: '没有有效文本', results: [] });
    return;
  }

  const listing = cleaned
    .map(
      (it, i) =>
        `[${i}] id=${it.id} 类型=${it.bookType || '未知'}\n原文：${it.text}` +
        (it.core ? `\n核心句（标题 claim 必须被它支撑）：${it.core}` : ''),
    )
    .join('\n\n');

  try {
    const raw = await glmChat(
      [
        {
          role: 'system',
          content:
            '你是「刷书」App 的编辑，为用户导入的书摘单元写 Feed 卡片标题。铁律：\n' +
            '1. 标题的核心 claim 必须能在原文中找到直接支撑，绝不引入原文没有的事实、名词或数字；\n' +
            '2. 用原文的主要语言写标题（中文正文出中文标题，英文正文出英文标题）；\n' +
            '3. 中文标题 8~18 字，英文标题不超过 10 个单词；像杂志笔记标题，吸引点击但不标题党；\n' +
            '4. 不要用书名号、句号结尾，不要出现「本文」「这篇文章」这类词。\n' +
            '只输出 JSON 数组：[{"id":"...","title":"..."}]',
        },
        { role: 'user', content: `请为以下 ${cleaned.length} 个单元各写一个标题：\n\n${listing}` },
      ],
      { temperature: 0.6, timeoutMs: 60000, maxTokens: 800 },
    );
    const parsed = extractJson<Array<{ id?: string; title?: string }>>(raw);
    if (!Array.isArray(parsed)) {
      res.json({ ok: false, error: 'GLM 返回无法解析', results: [] });
      return;
    }
    const textById = new Map(cleaned.map((it) => [it.id, it.text]));
    const results = parsed
      .filter((r) => typeof r?.id === 'string' && typeof r?.title === 'string' && r.title.trim())
      .map((r) => ({ id: r.id as string, title: (r.title as string).trim().slice(0, 60) }))
      // 忠实度后校验：标题实词必须能在原文命中，文不对题的一律丢弃
      .filter((r) => {
        const text = textById.get(r.id);
        return text ? titleGrounded(r.title, text) : false;
      });
    res.json({ ok: results.length > 0, results, generator: glmModelName() });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message?.slice(0, 120), results: [] });
  }
});

/**
 * 知识点抽取（GLM）。
 * body: { items: [{ id, text }] } — text 是【已读】原文（只考已读内容的硬规则由前端保证）。
 * 铁律：quote 必须是原文逐字摘录；concept/explanation 不得引入原文没有的 claim。
 * 返回 { results: [{ id, concept, explanation, quote }], generator }；失败时 ok:false（前端走本地兜底）。
 */
router.post('/api/knowledge-points', async (req, res) => {
  if (!glmAvailable()) {
    res.json({ ok: false, error: 'GLM_API_KEY 未配置', results: [] });
    return;
  }
  const body = (req.body ?? {}) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  const cleaned = items
    .slice(0, 6)
    .map((it, idx) => {
      const o = (it ?? {}) as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text.slice(0, 2500) : '';
      return text.trim() ? { id: String(o.id ?? idx), text } : null;
    })
    .filter((x): x is { id: string; text: string } => x !== null);

  if (cleaned.length === 0) {
    res.json({ ok: false, error: '没有有效文本', results: [] });
    return;
  }

  const listing = cleaned
    .map((it, i) => `[${i}] id=${it.id}\n原文：${it.text}`)
    .join('\n\n');

  try {
    const raw = await glmChat(
      [
        {
          role: 'system',
          content:
            '你是「刷书」App 的学习编辑，从用户已读的书籍原文中抽取「知识点」。铁律：\n' +
            '1. 每段原文抽取 1 个最值得记住的知识点（一个概念、机制、论证或结论）；\n' +
            '2. concept：不超过 20 字的概念短语，用原文的主要语言；\n' +
            '3. explanation：1~2 句解释，忠实于原文，绝不引入原文没有的观点或事实；\n' +
            '4. quote：支撑该知识点的原文核心句，必须逐字摘自原文，不得改写；\n' +
            '只输出 JSON 数组：[{"id":"...","concept":"...","explanation":"...","quote":"..."}]',
        },
        { role: 'user', content: `请为以下 ${cleaned.length} 段原文各抽取一个知识点：\n\n${listing}` },
      ],
      { temperature: 0.3, timeoutMs: 60000, maxTokens: 1200 },
    );
    const parsed = extractJson<Array<{ id?: string; concept?: string; explanation?: string; quote?: string }>>(raw);
    if (!Array.isArray(parsed)) {
      res.json({ ok: false, error: 'GLM 返回无法解析', results: [] });
      return;
    }
    const results = parsed
      .filter(
        (r): r is { id: string; concept: string; explanation: string; quote?: string } =>
          typeof r?.id === 'string' &&
          typeof r?.concept === 'string' &&
          !!r.concept.trim() &&
          typeof r?.explanation === 'string' &&
          !!r.explanation.trim(),
      )
      .map((r) => ({
        id: r.id,
        concept: r.concept.trim().slice(0, 40),
        explanation: r.explanation.trim().slice(0, 300),
        quote: typeof r.quote === 'string' && r.quote.trim() ? r.quote.trim().slice(0, 200) : undefined,
      }));
    res.json({ ok: results.length > 0, results, generator: glmModelName() });
  } catch (e) {
    res.json({ ok: false, error: (e as Error).message?.slice(0, 120), results: [] });
  }
});

export default router;
