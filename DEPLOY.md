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

## ⚠️ 服务器共享与协作规则（2026-09-07 事故留档）

**这台服务器同时承载 FinReport Learner，且 `/scramble-books/` 的裸 IP 路由寄生在 finreport 的 nginx 配置文件里**（`/etc/nginx/sites-enabled/finreport.gracetools.club` 的「精确 IP 匹配块」，其优先级高于本项目的 default_server）。finreport 每次部署会用它自己的模板**整体重写**该文件，把我们的路由冲掉——2026-09-07 已因此发生过两次「同步失败 Network error」（API 404）。

**已在源头修复**：4 份 finreport 部署模板（`~/Documents/{finreport-track-a,finreport-track-b,finreport-render2,Learn Fin Report}/scripts/deploy-tencent.sh`）均已内建「主页 + `/scramble-books/` 代理」两个 location，之后 finreport 再部署也不会冲掉。**新增第 5 份 finreport 工作副本时，必须同步打这个补丁**（幂等判断：模板里已有 `location ^~ /scramble-books/` 即跳过）。

**排查特征**（再次出现「同步失败 Network error」时）：
1. `curl http://129.204.30.165/scramble-books/api/auth/me` 返回 HTML/404 而非 `{"error":"未登录"}` → 路由被冲；
2. 比对 `/etc/nginx/sites-enabled/finreport.gracetools.club` 是否含 `location ^~ /scramble-books/`；
3. 重打补丁（见本机 `/tmp/patch-finq.py` 或任一已修模板）+ `nginx -t` + reload。
