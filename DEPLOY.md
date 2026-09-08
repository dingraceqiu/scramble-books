# 部署说明

> 当前双入口：生产服务器（主）+ GitHub Pages（备用/纯前端演示）。

## 生产服务器（129.204.30.165）

- **入口**：`http://129.204.30.165/scramble-books/`（ICP 备案过渡期走裸 IP + 二级路径；备案通过后 `https://books.gracetools.club` 的根路径与 `/scramble-books/` 均已预埋可用）
- **架构**：systemd 服务 `scramble-books.service` 跑 Express（`/home/ubuntu/apps/scramble-books`，`dist-server/server.js`），nginx 前置代理。**后端完整**：GLM AI（标题/分类/知识点）+ 云端账号/同步（SQLite，`/home/ubuntu/apps/data/cloud.db`）
- **nginx 要点**：`/scramble-books/` 代理时**剥前缀**（`proxy_pass http://127.0.0.1:5000/;` 尾斜杠）——应用内静态资源与 API 均以根路径提供服务，前缀只存在于浏览器地址栏。该 location 必须保留 `client_max_body_size 70m;`。配置文件：`/etc/nginx/sites-enabled/{scramble-books,finreport.gracetools.club}`，改动前的原始版本有 `.bak` 备份
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

## ⚠️ 2026-09-08 云同步 413 事故

- **现象**：裸 IP 入口 `http://129.204.30.165/scramble-books/` 登录后云同步显示「请求失败（413）」；当次旧诊断按 `JSON.stringify(...).length` 记录约 **3.98MB**（实为字符数口径）。2026-09-08 对生产库最新 V1 快照复核：4,035,822 JSON 字符、**7,699,662 UTF-8 bytes（7.34MiB）**；以后请求体与 60MiB 上限一律按 UTF-8 bytes 统计。
- **根因**：客户端当时上传 V1 整库 JSON，`documents` 已含完整 Canonical Source，而 `units[].sourceText` 又重复一份原文；真正匹配裸 IP 的 nginx 精确 `server_name 129.204.30.165` 块没有足够的请求体上限，命中 nginx 默认约 1MB 限制，请求尚未到达 Express 的 70MB parser 和应用的 60MiB 快照校验。
- **即时修复**：生产 `/etc/nginx/sites-enabled/finreport.gracetools.club` 的精确 IP 块中，`location ^~ /scramble-books/` 已设 `client_max_body_size 70m;`；`/etc/nginx/sites-enabled/scramble-books` 的域名及二级路径入口也设为 70m。2026-09-08 用 `nginx -T` 已确认三处生效。
- **架构修复**：新客户端写 Cloud Snapshot V2，只在逐字重建验证通过时省略 `sourceText / preview / headingText`；仍兼容 V1 拉取并在完整恢复本地后安全覆盖升级为 V2。应用层上限按 UTF-8 bytes 校验，不再用 JS 字符数近似。

### 413 防复发验证

每次 nginx/finreport 部署前后都执行：

```bash
sudo nginx -T 2>/dev/null | grep -n -E 'server_name 129.204.30.165|location \^~ /scramble-books/|client_max_body_size'
sudo nginx -t
curl -i http://129.204.30.165/scramble-books/api/auth/me   # 期望 JSON 401，不是 HTML 404/413
```

nginx 70m 是反向代理通行上限；Express parser 为 70mb，业务快照硬上限为 60MiB。不要把 nginx 值降到 60m：HTTP envelope 和单位差异需要余量。

## ⚠️ 服务器共享与协作规则（2026-09-07 事故留档）

**这台服务器同时承载 FinReport Learner，且 `/scramble-books/` 的裸 IP 路由寄生在 finreport 的 nginx 配置文件里**（`/etc/nginx/sites-enabled/finreport.gracetools.club` 的「精确 IP 匹配块」，其优先级高于本项目的 default_server）。finreport 每次部署会用它自己的模板**整体重写**该文件，把我们的路由冲掉——2026-09-07 已因此发生过两次「同步失败 Network error」（API 404）。

**nginx 生成模板的事实源不在本仓库**，而在 finreport 各工作副本的 `scripts/deploy-tencent.sh`。2026-09-08 当前核对结果：

- 已含 `/scramble-books/` location + `client_max_body_size 70m`：`~/Documents/{finreport-track-a,finreport-track-b,finreport-render2,Learn Fin Report}/scripts/deploy-tencent.sh`；
- `~/Documents/finreport-wave1/scripts/deploy-tencent.sh` 当前仍缺该 location，**修复前禁止用这份脚本部署生产 nginx**；该副本属于 `dingraceqiu/finreport-learner` 的独立 `feat/wave1-render` 工作树，不在 scramble-books 仓库内，不能由本仓库提交代替修复。

以后新增或刷新任何 finreport 工作副本，部署前必须检查模板同时包含 `location ^~ /scramble-books/` 和同一 location 内的 `client_max_body_size 70m;`。只有 location 而没有 70m 仍会复发 413；只有 70m 而没有 location 会复发 404。

**排查特征**（再次出现「同步失败 Network error」时）：
1. `curl http://129.204.30.165/scramble-books/api/auth/me` 返回 HTML/404 而非 `{"error":"未登录"}` → 路由被冲；
2. 比对 `/etc/nginx/sites-enabled/finreport.gracetools.club` 是否含 `location ^~ /scramble-books/`；
3. 重打补丁（见本机 `/tmp/patch-finq.py` 或任一已修模板）+ `nginx -t` + reload。
