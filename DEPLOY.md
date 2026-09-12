# 部署说明

> 当前双入口：生产服务器（主）+ GitHub Pages（备用/纯前端演示）。

## 生产服务器（129.204.30.165）

- **入口**：`http://129.204.30.165/scramble-books/`（ICP 备案过渡期走裸 IP + 二级路径；备案通过后 `https://books.gracetools.club` 的根路径与 `/scramble-books/` 均已预埋可用）
- **架构**：systemd 服务 `scramble-books.service` 跑 Express（`/home/ubuntu/apps/scramble-books`，`dist-server/server.js`），nginx 前置代理。**后端完整**：GLM AI（标题/分类/知识点）+ 云端账号/同步（SQLite，`/home/ubuntu/apps/data/cloud.db`）
- **nginx 要点**：`/scramble-books/` 代理时**剥前缀**（`proxy_pass http://127.0.0.1:5000/;` 尾斜杠）——应用内静态资源与 API 均以根路径提供服务。该项目的 IP 路由事实源是仓库内 `ops/nginx/ip-location.conf`，生产安装到 `/etc/nginx/project-locations/scramble-books.conf`；稳定网关 `/etc/nginx/sites-enabled/00-ip-gateway` 只负责 include，不由任何项目部署脚本重写。
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

只有 `ops/nginx/ip-location.conf` 变化时才更新本项目的 nginx fragment：

```bash
sudo install -d -m 755 /etc/nginx/project-locations
sudo install -m 644 ops/nginx/ip-location.conf /etc/nginx/project-locations/scramble-books.conf
sudo nginx -t && sudo systemctl reload nginx
```

## 云端数据库备份（自动，每日）

生产库 `/home/ubuntu/apps/data/cloud.db`（WAL 模式）由本仓库独立维护的
systemd timer 每日 04:30 自动备份到 `/home/ubuntu/apps/data/scramble-books-backups/`。
**WAL 模式下禁止用 `cp cloud.db` 备份**（会丢未 checkpoint 的 WAL 数据）；
备份用只读连接 + SQLite `VACUUM INTO` 一致快照，含 integrity_check、SHA-256
manifest 与原子改名，保留最近 7 个每日 + 4 个每周备份。

常用命令与失败排查见 **[BACKUP.md](./BACKUP.md)**（含恢复演练与人工灾难恢复步骤）：

```bash
systemctl list-timers scramble-books-backup.timer --no-pager   # timer 状态
sudo systemctl start scramble-books-backup.service             # 手动触发一次
node scripts/cloud-backup/cloud-backup.mjs list                # 列出备份
node scripts/cloud-backup/cloud-backup.mjs drill               # 恢复演练（不碰生产库）
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

## ⚠️ 2026-09-08 云同步 413 事故

- **现象**：裸 IP 入口 `http://129.204.30.165/scramble-books/` 登录后云同步显示「请求失败（413）」；当次旧诊断按 `JSON.stringify(...).length` 记录约 **3.98MB**（实为字符数口径）。2026-09-08 对生产库最新 V1 快照复核：4,035,822 JSON 字符、**7,699,662 UTF-8 bytes（7.34MiB）**；以后请求体与 60MiB 上限一律按 UTF-8 bytes 统计。
- **根因**：客户端当时上传 V1 整库 JSON，`documents` 已含完整 Canonical Source，而 `units[].sourceText` 又重复一份原文；真正匹配裸 IP 的 nginx 精确 `server_name 129.204.30.165` 块没有足够的请求体上限，命中 nginx 默认约 1MB 限制，请求尚未到达 Express 的 70MB parser 和应用的 60MiB 快照校验。
- **即时修复**：生产入口已设 `client_max_body_size 70m;`；随后迁移为独立的 `/etc/nginx/project-locations/scramble-books.conf`，不再寄生在 FinReport 配置中。域名配置仍由 `/etc/nginx/sites-enabled/scramble-books` 独立维护。
- **架构修复**：新客户端写 Cloud Snapshot V2，只在逐字重建验证通过时省略 `sourceText / preview / headingText`；仍兼容 V1 拉取并在完整恢复本地后安全覆盖升级为 V2。应用层上限按 UTF-8 bytes 校验，不再用 JS 字符数近似。

### 413 防复发验证

每次 nginx/finreport 部署前后都执行：

```bash
sudo nginx -T 2>/dev/null | grep -n -E 'server_name 129.204.30.165|location \^~ /scramble-books/|client_max_body_size'
sudo nginx -t
curl -i http://129.204.30.165/scramble-books/api/auth/me   # 期望 JSON 401，不是 HTML 404/413
```

nginx 70m 是反向代理通行上限；Express parser 为 70mb，业务快照硬上限为 60MiB。不要把 nginx 值降到 60m：HTTP envelope 和单位差异需要余量。

## 服务器共享与协作规则（2026-09-07 事故留档，2026-09-08 已完成架构隔离）

**历史根因**：`/scramble-books/` 曾寄生在 FinReport 的精确 IP `server` 块里，FinReport 部署整体重写该文件，2026-09-07 因此发生过两次 API 404，2026-09-08 又暴露过 413 上限漂移。

**当前隔离模型**：

- host-owned：`/etc/nginx/sites-enabled/00-ip-gateway`，只定义精确 IP server 和 include；文件名以 `00-` 开头，确保即使旧 FinReport 脚本重新引入重复 IP server，旧块也因冲突被 nginx 忽略；
- Scramble Books：仓库 `ops/nginx/ip-location.conf` → 服务器 `/etc/nginx/project-locations/scramble-books.conf`；
- FinReport：其仓库 `scripts/nginx/ip-location.conf` → 服务器 `/etc/nginx/project-locations/finreport.conf`；
- Insight：个人成长项目 `personal-growth-ip-location.nginx` → 服务器 `/etc/nginx/project-locations/insight.conf`；
- IP 首页：host-owned `/etc/nginx/project-locations/00-home.conf`。

任何项目部署只能安装自己的 fragment/domain 文件；禁止整体生成或复制别人的 location。现存旧 FinReport worktree 在同步 GitHub `main` 前仍含旧部署脚本，不应继续用于生产发布。

**排查特征**（再次出现「同步失败 Network error」时）：
1. `curl http://129.204.30.165/scramble-books/api/auth/me` 返回 HTML/404 而非 `{"error":"未登录"}` → 路由被冲；
2. 比对 `/etc/nginx/project-locations/scramble-books.conf` 与仓库 `ops/nginx/ip-location.conf`；
3. 只重新安装 Scramble Books fragment，执行 `nginx -t` 后 reload。
