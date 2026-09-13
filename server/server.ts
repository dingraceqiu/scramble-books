// ABOUTME: Express server with Vite integration
// ABOUTME: Handles API routes and serves frontend in dev/prod modes

import { createServer, type Server } from 'http';
import { createApp, globalErrorHandler } from './app';
import { initCloud } from './routes/index';
import { setupVite } from './vite';

const isDev = process.env.COZE_PROJECT_ENV !== 'PROD';
const port = parseInt(process.env.PORT || '5000', 10);
// 监听面收紧（5000-hardening）：默认只绑回环——生产公网流量必须经本机 Nginx 反代
// （proxy_pass http://127.0.0.1:5000/），不再依赖云安全组拦截直连 5000。
// 需要对外暴露监听时显式设置 LISTEN_HOST（如局域网调试 LISTEN_HOST=0.0.0.0）。
const listenHost = process.env.LISTEN_HOST || '127.0.0.1';

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

  server.listen(port, listenHost, () => {
    console.log(`\n✨ Server running at http://${listenHost}:${port}`);
    console.log(`📝 Environment: ${isDev ? 'development' : 'production'}\n`);
  });

  return server;
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
