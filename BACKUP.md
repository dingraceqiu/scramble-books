# 云端数据库备份与恢复演练

> 适用对象：生产服务器（129.204.30.165）上的云端 SQLite 库 `/home/ubuntu/apps/data/cloud.db`
> （`scramble-books.service` 的 `CLOUD_DB_PATH`，WAL 模式）。
> 备份机制由本仓库独立维护，不依赖、不影响任何其他项目，也不触碰共享 Nginx。

## 备份方案（为什么不是 `cp cloud.db`）

生产库运行在 **WAL journal mode** 下：最新写入可能还躺在 `cloud.db-wal` 里，
**直接复制主 `.db` 文件会得到一个缺数据的旧快照，是明确禁止的方案**。

本工具使用 SQLite 官方一致读语义生成快照：以**只读连接**打开源库，执行
`VACUUM INTO`（在线备份，SQLite 3.27+）。它对在线 WAL 库安全——快照内容
= 主库 + WAL 的同一时点一致视图；顺带产出无碎片文件，通常比主库更小。
服务器上已实测验证（Node v24.20.0 `node:sqlite`；其 `backup()` API 在该
版本不可用，故采用 `VACUUM INTO`）。

每次备份的完整流程（`scripts/cloud-backup/cloud-backup.mjs backup`）：

1. 只读打开源库，记录 journal mode、page 统计与 `quick_check` 结果（只记录，不阻断）；
2. `VACUUM INTO` 写入**临时文件**（与备份目录同文件系统）；
3. 对临时文件跑 `PRAGMA integrity_check`，非 `ok` 立即删除并失败退出；
4. 计算 SHA-256，**原子 rename** 为最终文件名
   `scramble-books-cloud-YYYYMMDDTHHMMSSZ.db`（UTC 时间戳，秒级冲突会等待下一秒，绝不覆盖）；
5. 写 manifest（`.json`：创建时间、大小、SHA-256、完整性结果、来源库信息、各表行数）；
6. 按保留策略清理（见下）。

**日志与 manifest 只含路径、大小、SHA、时间戳、表名与行数统计**，
不输出正文、笔记、账号、token、密码或任何数据库内容。

## 备份位置与保留策略

- 备份目录：`/home/ubuntu/apps/data/scramble-books-backups/`（独立于应用目录，部署不会触碰）
- 每天自动一次（systemd timer，04:30 服务器本地时间 + 随机延迟）
- 保留：**最近 7 个「天」各留最新一份 + 更旧备份里最近 4 个 ISO 周各留最新一份**
  （每天最多 1 份 + 4 份 ≈ 11 份）
- 清理三重防线：文件名必须匹配 `scramble-books-cloud-*.db(.json)` 严格正则；
  删除集合由保留策略决定（最新一份永远保留）；删除前逐个做 realpath 级
  路径校验（父目录必须就是备份根目录）。
  **旧手动备份 `cloud.db.bak-20260908-pre-v2`、其他项目文件、任何不匹配
  命名的文件在数学上就不可能被本工具删除。**

## systemd 单元

| 单元 | 说明 |
|---|---|
| `scramble-books-backup.service` | oneshot，跑 `scripts/cloud-backup/cloud-backup.mjs backup`；`ProtectSystem=strict` 全盘只读、仅备份目录可写，源库物理上不可写 |
| `scramble-books-backup.timer` | 每天 04:30（`Persistent=true`，错过的时点开机补跑） |

单元模板在仓库 `ops/systemd/`，安装方式见其文件头注释。
与在线服务 `scramble-books.service` 完全独立：备份失败只让 oneshot 单元
失败（journald 可查），**不会停止、重启或影响在线服务**。

## 常用操作

```bash
# 查看 timer 状态与下次触发时间
systemctl list-timers scramble-books-backup.timer --no-pager

# 手动触发一次备份
sudo systemctl start scramble-books-backup.service
journalctl -u scramble-books-backup.service -n 50 --no-pager

# 列出备份（时间 / 大小 / SHA-256 / 完整性结果）
node scripts/cloud-backup/cloud-backup.mjs list

# 恢复演练（默认最新一份；复制到临时目录验证，绝不触碰生产库）
node scripts/cloud-backup/cloud-backup.mjs drill
node scripts/cloud-backup/cloud-backup.mjs drill --file scramble-books-cloud-20260913T043000Z.db
```

手动跑 `list` / `drill` 需要 `CLOUD_BACKUP_DIR` 环境变量或 `--out` 参数
（见脚本头注释）；`drill` 会复核 SHA-256 与 manifest 一致、
`integrity_check=ok`、四张业务表结构与列齐全、行数与 manifest 一致。

## 失败排查

1. `journalctl -u scramble-books-backup.service -n 100 --no-pager`
   （错误行以 `[cloud-backup] ERROR` 开头，含具体失败阶段）；
2. `VACUUM INTO 失败`：检查磁盘空间（`df -h /home/ubuntu/apps/data`）与
   `scramble-books.service` 是否在运行（只读打开 WAL 库需要 -shm 可读）；
3. `integrity_check 未通过`：**不要覆盖该备份**，立即再做一次手动备份并
   对源库跑只读 `PRAGMA quick_check`；持续失败按「真正恢复」流程评估；
4. timer 未触发：`systemctl status scramble-books-backup.timer`、
   `systemctl list-timers --all`，确认 `Persistent=true` 且无 `Failed` 计数；
5. 备份为 0 字节或远小于历史：先 `drill` 验证，不要急着清理历史备份。

## 恢复演练（安全，可随时做）

`drill` 子命令只读备份文件、在 `/tmp` 临时目录验证后即清理，**永不写生产库**。
建议每次手动备份后、以及每月例行跑一次。

## 真正的灾难恢复（人工步骤，本仓库不自动执行）

> 以下步骤仅在没有可用生产库（文件损坏 / 丢失）时由人工执行。
> 工具本身没有也不应有「自动恢复生产库」路径。

1. `sudo systemctl stop scramble-books.service`（停在线服务，防写入）；
2. 选定备份：`node scripts/cloud-backup/cloud-backup.mjs list`，优先选最新
   `integrity=ok` 且 SHA 可复核（`sha256sum` 与 manifest 比对）的一份；
3. 决定落点：原路径 `CLOUD_DB_PATH`（同盘、足够空间）；
4. 恢复（假设原库已不可用，直接改名替换；若只是要覆盖旧库，先把旧库
   移走留档，不要删除）：
   ```bash
   sudo mv /home/ubuntu/apps/data/cloud.db /home/ubuntu/apps/data/cloud.db.corrupt-$(date +%Y%m%d)
   sudo install -m 644 /home/ubuntu/apps/data/scramble-books-backups/<选定备份>.db /home/ubuntu/apps/data/cloud.db
   sudo chown ubuntu:ubuntu /home/ubuntu/apps/data/cloud.db
   rm -f /home/ubuntu/apps/data/cloud.db-wal /home/ubuntu/apps/data/cloud.db-shm   # 旧 WAL/SHM 与新库不匹配，必须清掉
   ```
5. 验证：
   ```bash
   sudo systemctl start scramble-books.service
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5000/   # 期望 200
   node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.CLOUD_DB_PATH||'/home/ubuntu/apps/data/cloud.db',{readOnly:true});console.log(d.prepare('PRAGMA quick_check').get(),d.prepare('SELECT COUNT(*) c FROM user_data').get())"
   ```
   （对恢复后的生产库做**只读** quick_check 与行数确认；再登录一次网页端确认云同步可读）
6. 立即手动触发一次备份，重建备份链。

## 权限要求

- 备份以 `ubuntu` 用户跑（`CLOUD_DB_PATH` 同属 `ubuntu`）；
- **备份目录 0700、备份文件与 manifest 0600**：systemd 单元设 `UMask=0077`，
  CLI 也会显式 `chmod`（手动运行同样收紧，预置宽松权限的目录会被强制改回 0700）；
- 安装/启停 unit 需要 `sudo`；请勿手工 chmod 放宽备份目录或文件权限；
- 旧手动备份 `cloud.db.bak-20260908-pre-v2` 属 `root:root`，**只增不删**。

## 测试

`pnpm verify:cloud-backup`（已并入 `pnpm verify`）覆盖：命名正则拒绝旧手动
备份/临时/越权文件、realpath 路径校验拒绝遍历与 symlink 逃逸、保留策略
（7 日 + 4 周）、以及真实 CLI 端到端（WAL 在线库 → backup/list/drill →
manifest SHA 复核 → 源库字节级不变 → 清理不触碰保护文件）。
