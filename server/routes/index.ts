import { Router } from 'express';
import { classifyBook } from '../lib/classify';
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

export default router;
