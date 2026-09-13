// ABOUTME: Express app 工厂（TD-06 抽取自 server.ts，便于测试在临时端口启动同一套中间件链）
// ABOUTME: 请求体解析 / trust proxy / API 路由 / 全局错误处理；Vite 集成与监听仍在 server.ts

import express from 'express';
import router from './routes/index';

/** GLM 代理接口的独立小请求体上限：远超合法客户端载荷（≤8×1500 汉字 ≈ 30KB），
 *  又能在超大恶意请求进入业务逻辑前以 413 拒绝（全局 70mb 解析器只服务云同步快照）。 */
export const GLM_BODY_LIMITS: Record<'/api/ai-titles' | '/api/knowledge-points' | '/api/classify-book', string> = {
  '/api/ai-titles': '128kb',
  '/api/knowledge-points': '128kb',
  '/api/classify-book': '64kb',
};

/**
 * 请求体解析错误（413 超限 / 400 非法 JSON）→ 稳定 JSON。
 * 只处理 body-parser 的 expose 错误，其余原样交给下一个错误处理器。
 */
export function jsonBodyErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const e = err as { status?: number; expose?: boolean; type?: string };
  if (res.headersSent) {
    next(err);
    return;
  }
  if (e?.expose && e.status === 413) {
    res.status(413).json({ ok: false, error: '请求体过大', code: 'payload_too_large' });
    return;
  }
  if (e?.expose && e.status === 400 && e.type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: '请求体不是有效 JSON', code: 'bad_request' });
    return;
  }
  next(err);
}

export function createApp(): express.Express {
  const app = express();

  // Nginx 反代还原真实客户端 IP：只信任回环代理（本机 nginx）。
  // - 经 nginx 的请求：XFF 末项由 nginx 追加的真实公网 IP（不可被客户端伪造）→ 各用户独立桶；
  // - 公网直连 5000：socket 对端非可信代理 → req.ip = 真实来源（伪造 XFF 无效）；
  // - 绝不让全部公网用户共享 127.0.0.1 一个桶。
  app.set('trust proxy', 'loopback');

  // 请求日志（仅开发环境）
  const isDev = process.env.COZE_PROJECT_ENV !== 'PROD';
  if (isDev) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(`${req.method} ${req.url} - ${ms}ms`);
      });
      next();
    });
  }

  // GLM 代理接口先过小限额解析器（express.json 幂等：全局解析器随后自动跳过），
  // 超限请求在这里就被 413 拒绝，绝不进入业务逻辑，更不会触达 GLM。
  for (const [path, limit] of Object.entries(GLM_BODY_LIMITS)) {
    app.use(path, express.json({ limit }));
  }
  app.use('/api/ai-titles', jsonBodyErrorHandler);
  app.use('/api/knowledge-points', jsonBodyErrorHandler);
  app.use('/api/classify-book', jsonBodyErrorHandler);

  // 添加请求体解析（云端整库快照可能含封面 dataURL，上限放宽到 70MB）
  app.use(express.json({ limit: '70mb' }));
  app.use(express.urlencoded({ extended: true, limit: '70mb' }));

  // 注册 API 路由
  app.use(router);

  return app;
}

/** 全局错误处理（server.ts 与测试共用） */
export function globalErrorHandler(
  err: Error,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  void next;
  console.error('Server error:', err);
  const status = 'status' in err ? (err as { status?: number }).status ?? 500 : 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
  });
}
