#!/usr/bin/env bash
# Scramble Books GLM 密钥轮换 + systemd 加固（v2，2026-09-13）
#
# 用法（root）：
#   scramble-books-key-rotation apply     # 交互式输入新密钥并执行轮换（旧密钥必须仍有效）
#   scramble-books-key-rotation verify    # 仅验证当前配置与接口状态（不需要密钥）
#   scramble-books-key-rotation cleanup   # 旧密钥已在 GLM 控制台撤销后：删除含旧密钥的回滚副本
#
# 退出码：0 成功；2 前置检查/输入失败；3 启动失败（已回滚）；4 验证失败（服务在线，
#         此时禁止撤销旧密钥）；5 启动失败且回滚也失败（需人工介入）。
#
# 密钥卫生：新密钥只经 stdin（read -rs）进入，写入 root-only EnvironmentFile；
#           绝不出现在任何子进程的命令行参数中（journal 扫描通过环境变量传给 awk）。
# 回滚副本：轮换前的 unit（含旧密钥）存入 root-only 0700 目录、文件 0600；
#           旧密钥撤销后用 cleanup 子命令删除。
#
# 测试注入口（仅 test-key-rotation.sh 使用，生产环境勿设置）：
#   SB_UNIT SB_ENVFILE SB_DB SB_BACKUP_DIR SB_SERVICE SB_SYSTEMCTL SB_CURL
#   SB_JOURNALCTL SB_SLEEP SB_PROC SB_HEALTH_URL SB_APP_URL SB_GLM_URL
set -u

MODE="${1:-apply}"

SERVICE_NAME="${SB_SERVICE:-scramble-books.service}"
UNIT="${SB_UNIT:-/etc/systemd/system/${SERVICE_NAME}}"
ENVFILE="${SB_ENVFILE:-/etc/default/${SERVICE_NAME%.service}}"
DB="${SB_DB:-/home/ubuntu/apps/data/cloud.db}"
BACKUP_DIR="${SB_BACKUP_DIR:-/root/scramble-books-rotation}"
BACKUP_FILE="${BACKUP_DIR}/${SERVICE_NAME}.pre-rotation"
SYSTEMCTL="${SB_SYSTEMCTL:-systemctl}"
CURL="${SB_CURL:-curl}"
JOURNALCTL="${SB_JOURNALCTL:-journalctl}"
SLEEP="${SB_SLEEP:-sleep}"
PROCFS="${SB_PROC:-/proc}"
HEALTH_URL="${SB_HEALTH_URL:-http://127.0.0.1:5000/api/health}"
APP_URL="${SB_APP_URL:-http://127.0.0.1/scramble-books/}"
GLM_URL="${SB_GLM_URL:-http://127.0.0.1:5000/api/ai-titles}"

RC_OK=0
RC_PRECHECK=2
RC_START_FAILED=3
RC_VERIFY_FAILED=4
RC_ROLLBACK_FAILED=5

log() { printf '%s\n' "$*"; }
fail() { printf '!! %s\n' "$*" >&2; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "请用 sudo 运行本命令"
    exit "$RC_PRECHECK"
  fi
}

# ---------------------------------------------------------------------------
# 回滚：从 root-only 副本恢复轮换前 unit 并重启（旧密钥仍有效）。
# 注意：本函数定义先于任何修改动作；run_mutation 中每一步都显式检查失败。
# ---------------------------------------------------------------------------
rollback() {
  local rb=0
  fail "启动失败——回滚到轮换前 unit（旧密钥仍有效，服务恢复原状）"
  if ! cp -a "$BACKUP_FILE" "$UNIT"; then
    fail "回滚：无法从 $BACKUP_FILE 恢复 unit"
    rb=1
  fi
  chmod 644 "$UNIT" 2>/dev/null || true
  if ! "$SYSTEMCTL" daemon-reload; then
    fail "回滚：daemon-reload 失败"
    rb=1
  fi
  if ! "$SYSTEMCTL" restart "$SERVICE_NAME"; then
    fail "回滚：restart 失败"
    rb=1
  fi
  $SLEEP 2
  if ! "$SYSTEMCTL" is-active --quiet "$SERVICE_NAME"; then
    fail "回滚后服务仍未运行，立即排查：journalctl -u $SERVICE_NAME -n 50"
    rb=1
  fi
  if [ "$rb" -eq 0 ]; then
    log "✅ 已回滚，服务恢复为轮换前配置（EnvironmentFile 已写入但未被引用，可直接重试 apply）"
  fi
  return "$rb"
}

wait_startup_healthy() {
  local code
  code=000
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    code=$($CURL -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" 2>/dev/null) || code=000
    if [ "$code" = "200" ]; then break; fi
    $SLEEP 1
  done
  if [ "$code" != "200" ]; then
    fail "  /api/health 未恢复（最后状态 $code）"
    return 1
  fi
  # 稳定窗口：等待 6s 后再次确认进程存活与 health，捕获「启动即通过、随后延迟退出」
  $SLEEP 6
  if ! "$SYSTEMCTL" is-active --quiet "$SERVICE_NAME"; then
    fail "  服务在启动验证通过后退出（延迟失败）"
    return 1
  fi
  code=$($CURL -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" 2>/dev/null) || code=000
  if [ "$code" != "200" ]; then
    fail "  稳定窗口内 health 再次失败（$code）"
    return 1
  fi
  return 0
}

# 变更窗口：任何一步失败都返回非零，由调用方统一触发回滚
run_mutation() {
  # [2] root-only EnvironmentFile（密钥经 printf 内建写入文件，不进入任何进程 argv）
  umask 077
  if ! printf 'GLM_API_KEY=%s\n' "$NEWKEY" > "$ENVFILE"; then
    fail "无法写入 $ENVFILE"
    return 1
  fi
  chown root:root "$ENVFILE" || return 1
  chmod 600 "$ENVFILE" || return 1

  # [3] 新 unit：EnvironmentFile= + UMask=0077，移除内联密钥
  if ! cat > "$UNIT" <<'UNIT_EOF'
[Unit]
Description=Scramble Books (刷书) Node server
After=network.target

[Service]
Type=simple
User=ubuntu
UMask=0077
WorkingDirectory=/home/ubuntu/apps/scramble-books
Environment=COZE_PROJECT_ENV=PROD
Environment=PORT=5000
Environment=HOSTNAME=0.0.0.0
Environment=CLOUD_DB_PATH=/home/ubuntu/apps/data/cloud.db
Environment=GLM_MODEL=glm-4-flash-250414
EnvironmentFile=/etc/default/scramble-books
ExecStart=/usr/bin/node dist-server/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT_EOF
  then
    fail "无法写入 $UNIT"
    return 1
  fi
  chmod 644 "$UNIT" || return 1

  # [4] 数据库文件 0600（幂等；WAL/SHM 若在重启窗口被重建也一并收紧）
  chmod 600 "$DB" "$DB-wal" "$DB-shm" 2>/dev/null || true
  find "$(dirname "$DB")" -maxdepth 1 -name 'cloud.db.bak-*' -exec chmod 600 {} + 2>/dev/null || true

  # [5] daemon-reload + 受控重启
  "$SYSTEMCTL" daemon-reload || { fail "daemon-reload 失败"; return 1; }
  "$SYSTEMCTL" restart "$SERVICE_NAME" || { fail "restart 失败"; return 1; }

  # [6] 启动验证（含延迟退出稳定窗口）
  wait_startup_healthy
}

# 共享验证（apply 与 verify 共用）。参数 $1 = NEWKEY（verify 模式传空，
# 跳过按密钥值的 journal 增量扫描）。任一项失败返回 1。
run_verification() {
  local newkey="${1:-}"
  local ok=1 code resp body glm_code glm_ok pid n jtmp

  code=$($CURL -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null) || code=000
  log "  /api/health                    → $code (期望 200)"
  [ "$code" = "200" ] || ok=0

  code=$($CURL -s -o /dev/null -w '%{http_code}' --max-time 5 "${APP_URL}api/auth/me" 2>/dev/null) || code=000
  log "  ${APP_URL}api/auth/me          → $code (期望 401，路由正常)"
  [ "$code" = "401" ] || ok=0

  code=$($CURL -s -o /dev/null -w '%{http_code}' --max-time 5 "$APP_URL" 2>/dev/null) || code=000
  log "  ${APP_URL} 页面                 → $code (期望 200)"
  [ "$code" = "200" ] || ok=0

  # GLM 真实探针：只输出 HTTP 状态与布尔结果，不打印响应体
  resp=$($CURL -s -w '\n%{http_code}' --max-time 70 -X POST -H 'Content-Type: application/json' \
    --data-binary @- "$GLM_URL" <<'JSON'
{"items":[{"id":"probe","text":"读书是把别人的思考变成自己血肉的过程。读得多不如读得深，深度决定复利的利率。"}]}
JSON
  ) || resp=$'\n000'
  glm_code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if printf '%s' "$body" | grep -q '"ok":true'; then glm_ok=true; else glm_ok=false; fi
  log "  GLM 探针 (/api/ai-titles)      → HTTP $glm_code, ok=$glm_ok"
  [ "$glm_ok" = "true" ] || ok=0

  # 密钥卫生：只输出计数与权限，绝不输出密钥内容
  pid=$("$SYSTEMCTL" show -p MainPID --value "$SERVICE_NAME")
  if [ -n "$pid" ] && [ -r "$PROCFS/$pid/environ" ]; then
    n=$(tr '\0' '\n' < "$PROCFS/$pid/environ" | grep -c '^GLM_API_KEY=') || n=0
    log "  新进程环境 GLM_API_KEY 变量数  → $n (期望 1)"
    [ "$n" -eq 1 ] || ok=0
  else
    fail "  无法读取主进程环境 (/proc/$pid/environ)"
    ok=0
  fi

  n=$(grep -c 'Environment=GLM_API_KEY' "$UNIT") || n=0
  log "  unit 内联密钥行数              → $n (期望 0)"
  [ "$n" -eq 0 ] || ok=0

  n=$(stat -Lc '%a' "$ENVFILE" 2>/dev/null) || n=unknown
  log "  $ENVFILE 权限                  → $n $(stat -Lc '%U:%G' "$ENVFILE" 2>/dev/null) (期望 600 root:root)"
  [ "$n" = "600" ] || ok=0

  n=$(stat -Lc '%a' "$DB" 2>/dev/null) || n=unknown
  log "  数据库 $DB 权限               → $n (期望 600)"
  [ "$n" = "600" ] || ok=0

  if [ -n "$newkey" ]; then
    # 新密钥重启后不得新增任何 journal 命中。
    # 注意：前缀赋值只作用于管道第一段命令，awk 取不到 ENVIRON——必须在子 shell 内
    # export（密钥经环境变量传递，不进入任何进程 argv）。
    jtmp=$(mktemp)
    (
      export GLMKEY="$newkey"
      $JOURNALCTL --since '-5 min' 2>/dev/null |
        awk 'index($0, ENVIRON["GLMKEY"]) { n++ } END { print n + 0 }'
    ) > "$jtmp"
    n=$(cat "$jtmp")
    rm -f "$jtmp"
    log "  重启后 journal 新增密钥命中    → $n (期望 0)"
    [ "$n" -eq 0 ] || ok=0
  fi

  # WAL/SHM 在 UMask=0077 下应已为 600；幂等再收紧一次
  chmod 600 "$DB-wal" "$DB-shm" 2>/dev/null || true

  [ "$ok" -eq 1 ]
}

cmd_apply() {
  require_root
  if [ ! -f "$UNIT" ]; then
    fail "unit 不存在：$UNIT"
    exit "$RC_PRECHECK"
  fi
  if ! "$SYSTEMCTL" is-active --quiet "$SERVICE_NAME"; then
    fail "服务当前未运行（systemctl status $SERVICE_NAME），先恢复运行再做轮换"
    exit "$RC_PRECHECK"
  fi

  printf '粘贴新 GLM API Key（输入不回显）: ' >&2
  IFS= read -rsr NEWKEY
  printf '\n' >&2
  if [ -z "${NEWKEY:-}" ] || [ "${#NEWKEY}" -lt 20 ] || ! printf '%s' "$NEWKEY" | grep -qE '^[A-Za-z0-9._-]+$'; then
    fail "密钥为空、短于 20 字符或含非法字符，未做任何修改，已中止"
    exit "$RC_PRECHECK"
  fi

  # [1] 轮换前 unit（含旧密钥）→ root-only 目录、0600；旧密钥撤销后用 cleanup 删除
  install -d -m 700 "$BACKUP_DIR" || { fail "无法创建 $BACKUP_DIR"; exit "$RC_PRECHECK"; }
  chown root:root "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  cp -a "$UNIT" "$BACKUP_FILE"
  chown root:root "$BACKUP_FILE"
  chmod 600 "$BACKUP_FILE"
  log "[1/6] 已备份轮换前 unit → $BACKUP_FILE ($(stat -Lc '%a %U:%G' "$BACKUP_FILE"))"

  if run_mutation; then
    log "[2/6] EnvironmentFile 已写入（root:root 0600）"
    log "[3/6] unit 已更新（EnvironmentFile= + UMask=0077，移除内联密钥）"
    log "[4/6] 数据库文件权限 0600 已收紧"
    log "[5/6] daemon-reload + 受控重启完成"
  else
    if rollback; then
      exit "$RC_START_FAILED"
    else
      exit "$RC_ROLLBACK_FAILED"
    fi
  fi

  log "[6/6] 验证"
  if run_verification "$NEWKEY"; then
    log ""
    log "✅ 全部验证通过。请立即到 GLM 控制台撤销旧密钥，"
    log "   撤销成功后执行：sudo $(basename "$0") cleanup   （删除含旧密钥的回滚副本）"
    exit "$RC_OK"
  else
    log ""
    fail "存在未通过的验证项。服务仍以新密钥运行；在查明原因前不要撤销旧密钥。"
    exit "$RC_VERIFY_FAILED"
  fi
}

cmd_verify() {
  require_root
  log "验证当前配置与接口状态"
  if run_verification ""; then
    log "✅ 验证通过"
    exit "$RC_OK"
  else
    fail "存在未通过的验证项"
    exit "$RC_VERIFY_FAILED"
  fi
}

cmd_cleanup() {
  require_root
  if [ ! -d "$BACKUP_DIR" ]; then
    log "回滚副本目录不存在（$BACKUP_DIR），无需清理"
    exit "$RC_OK"
  fi
  rm -rf -- "$BACKUP_DIR"
  log "✅ 已删除含旧密钥的回滚副本：$BACKUP_DIR"
  n=$(grep -c 'Environment=GLM_API_KEY' "$UNIT") || n=0
  if [ "$n" -ne 0 ]; then
    fail "警告：unit 中仍存在内联密钥行（$n），请检查"
    exit "$RC_VERIFY_FAILED"
  fi
  log "确认：unit 无内联密钥，密钥唯一来源为 $ENVFILE（root:root 0600）"
  exit "$RC_OK"
}

case "$MODE" in
  apply) cmd_apply ;;
  verify) cmd_verify ;;
  cleanup) cmd_cleanup ;;
  *)
    fail "用法: $(basename "$0") apply|verify|cleanup"
    exit "$RC_PRECHECK"
    ;;
esac
