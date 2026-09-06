# 部署说明

> 当前双入口：生产服务器（主）+ GitHub Pages（备用/纯前端演示）。

## 生产服务器（129.204.30.165）

- **入口**：`http://129.204.30.165/scramble-books/`（ICP 备案过渡期走裸 IP + 二级路径；备案通过后 `https://books.gracetools.club` 的根路径与 `/scramble-books/` 均已预埋可用）
- **架构**：systemd 服务 `scramble-books.service` 跑 Express（`/home/ubuntu/apps/scramble-books`，`dist-server/server.js`），nginx 前置代理。**后端完整**：GLM AI（标题/分类/知识点）+ 云端账号/同步（SQLite，`/home/ubuntu/apps/data/cloud.db`）
- **nginx 要点**：`/scramble-books/` 代理时**剥前缀**（`proxy_pass http://127.0.0.1:5000/;` 尾斜杠）——应用内静态资源与 API 均以根路径提供服务，前缀只存在于浏览器地址栏。配置文件：`/etc/nginx/sites-enabled/{scramble-books,finreport.gracetools.club}`，改动前的原始版本有 `.bak` 备份
- **IP 根路径**是导航主页（`/var/www/index.html`，链接 Scramble Books 与 FinReport Learner）

### 更新部署（SSH 已在 Mac 配好，直接 `ssh 129.204.30.165`）

```bash
cd /home/ubuntu/apps/scramble-books
git pull origin main
pnpm install --frozen-lockfile
pnpm vite build --base=/scramble-books/   # ⚠️ 必须带 --base，裸 vite build 会丢子路径前缀
pnpm tsup --config tsup.config.ts
sudo systemctl restart scramble-books.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5000/   # 期望 200
```

## GitHub Pages（备用）

- **入口**：https://dingraceqiu.github.io/scramble-books/
- **自动化**：push 到 main 即触发 `.github/workflows/deploy-pages.yml`（按仓库名动态注入 `--base`），无需手动操作
- **限制**：纯前端静态托管——无后端，GLM 自动降级为本地 mock 标题、云端登录/同步不可用；核心阅读功能完整（浏览器内解析 + IndexedDB）
- 仓库当前为 public（免费计划的 Pages 仅支持公开仓库；转回 private 会停用 Pages）

## 版本核对

| 环境 | 位置 | 版本 |
|------|------|------|
| 代码事实源 | github.com/dingraceqiu/scramble-books (main) | 最新 |
| 生产服务器 | /home/ubuntu/apps/scramble-books | 部署时以 `git log --oneline -1` 核对 |
| GitHub Pages | Actions 自动 | 跟随 main |
