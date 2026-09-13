// ABOUTME: Express server with Vite integration
// ABOUTME: Handles API routes and serves frontend in dev/prod modes

import { createServer, type Server } from 'http';
import { createApp, globalErrorHandler } from './app';
import { initCloud } from './routes/index';
import { setupVite } from './vite';

const isDev = process.env.COZE_PROJECT_ENV !== 'PROD';
const port = parseInt(process.env.PORT || '5000', 10);
const hostname = process.env.HOSTNAME || 'localhost';

async function startServer(): Promise<Server> {
  const app = createApp();

  // 使用 http.createServer 包装 Express app，以便支持 WebSocket 等协议升级
  const server = createServer(app);

  // 初始化云端 SQLite（邀请码/用户/会话/用户数据）
  initCloud();

  // 集成 Vite（开发模式）或静态文件服务（生产模式）；API 路由已在 createApp 内注册
  await setupVite(app);

  // 全局错误处理
  app.use(globalErrorHandler);

  server.once('error', err => {
    console.error('Server error:', err);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`\n✨ Server running at http://${hostname}:${port}`);
    console.log(`📝 Environment: ${isDev ? 'development' : 'production'}\n`);
  });

  return server;
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
