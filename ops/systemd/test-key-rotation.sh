#!/usr/bin/env bash
# scramble-books-key-rotation.sh 的故障注入测试（2026-09-13）
#
# 在隔离 tmp 环境中用假 systemctl/curl/journalctl 驱动轮换脚本，覆盖：
#   A. 基线成功：全链路通过，密钥不出现在任何子进程 argv 日志中
#   B. restart 立即失败 → 必须回滚（退出码 3，unit 恢复为轮换前内容）
#   C. 服务延迟退出（health 通过后进程死掉）→ 必须回滚（退出码 3）
#   D. GLM 探针失败 → 不回滚（服务在线），退出码 4
#   E. 回滚成功路径本身可恢复服务（B/C 中断言）
#   F. cleanup 删除含旧密钥的回滚副本
#
# 用法（root 或配好 sudo 的环境直接跑）：
#   sudo bash test-key-rotation.sh ../path/to/scramble-books-key-rotation.sh
# 所有 SB_* 覆盖只指向 tmp 目录，绝不触碰真实 systemd/数据库。
set -u

SCRIPT_UNDER_TEST="${1:?用法: test-key-rotation.sh <scramble-books-key-rotation.sh>}"
SCRIPT_UNDER_TEST="$(cd "$(dirname "$SCRIPT_UNDER_TEST")" && pwd)/$(basename "$SCRIPT_UNDER_TEST")"

PASS=0
FAILED=0
CURRENT_CASE="?"

assert_eq() { # got want what
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL [%s] %s: got <%s> want <%s>\n' "$CURRENT_CASE" "$3" "$1" "$2"
  fi
}

assert_contains() { # haystack needle what
  if printf '%s' "$1" | grep -qF -- "$2"; then
    PASS=$((PASS + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL [%s] %s: 未找到 <%s>\n' "$CURRENT_CASE" "$3" "$2"
  fi
}

assert_key_absent_from_logs() { # dir key
  if grep -rqF -- "$2" "$1" 2>/dev/null; then
    FAILED=$((FAILED + 1))
    printf 'FAIL [%s] 密钥泄漏: 出现在 %s 的进程 argv 日志中\n' "$CURRENT_CASE" "$1"
  else
    PASS=$((PASS + 1))
  fi
}

OLD_MARKER='Environment=GLM_API_KEY=OLDKEY-must-never-leak'
NEW_MARKER='EnvironmentFile='

new_env() {
  T="$(mktemp -d /tmp/sb-rot-test.XXXXXX)"
  STATE="$T/state"
  BIN="$T/bin"
  mkdir -p "$BIN" "$STATE" "$T/proc/42" "$T/data"
  TESTKEY="TESTKEY$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')probe"

  # 假 sleep：立即返回（真实测试窗口由假 curl/systemctl 的确定性状态机模拟）
  printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN/sleep"

  # 假 systemctl：restart/is-active/daemon-reload/show 的确定性状态机
  cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
S="$SB_STATE"
cmd="$1"
shift || true
echo "$cmd $*" >> "$S/cmd.log"
  case "$cmd" in
    daemon-reload)
      if [ -n "${SBF_DAEMON_RELOAD_FAIL:-}" ]; then exit 1; fi
      exit 0
      ;;
  restart)
    if [ -n "${SBF_RESTART_FAIL:-}" ] && [ ! -f "$S/restart_failed_once" ]; then
      touch "$S/restart_failed_once"
      exit 1
    fi
    echo up > "$S/state"
    exit 0
    ;;
  is-active)
    if [ -f "$S/delay_pending" ]; then
      rm -f "$S/delay_pending"
      echo down > "$S/state"
      exit 1
    fi
    [ "$(cat "$S/state" 2>/dev/null)" = "up" ]
    ;;
  show)
    # systemctl show -p MainPID --value <unit>
    cat "$S/pid"
    ;;
  *)
    echo "fake-systemctl: unknown command $cmd" >&2
    exit 1
    ;;
esac
EOF

  # 假 curl：health 随状态机返回 200/000；GLM 探针可注入失败；记录全部 argv 供密钥泄漏断言
  cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$SB_STATE/curl.log"
url="${*: -1}"
case "$url" in
  */api/health)
    if [ -n "${SBF_DELAYED_EXIT:-}" ] && [ ! -f "$SB_STATE/flipped" ]; then
      touch "$SB_STATE/flipped" "$SB_STATE/delay_pending"
      printf '200'
      exit 0
    fi
    if [ "$(cat "$SB_STATE/state" 2>/dev/null)" = "up" ]; then printf '200'; else printf '000'; fi
    ;;
  */api/auth/me)
    printf '401'
    ;;
  */api/ai-titles)
    if [ -n "${SBF_GLM_FAIL:-}" ]; then
      printf '{"ok":false,"error":"GLM HTTP 503"}\n200'
    else
      printf '{"ok":true,"results":[{"id":"probe","title":"x"}],"generator":"glm-4-flash"}\n200'
    fi
    ;;
  *)
    printf '200'
    ;;
esac
exit 0
EOF

  # 假 journalctl：固定审计行（泄漏注入场景输出测试密钥，密钥经 GLMKEY 环境变量取得）
  cat > "$BIN/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "journalctl $*" >> "$SB_STATE/cmd.log"
if [ -n "${SBF_JOURNAL_LEAK:-}" ]; then
  printf 'Sep 13 sudo[9]: root : COMMAND=/usr/bin/tee %s' "$GLMKEY"
else
  printf 'Sep 13 sudo[1]: ubuntu : PWD=/home ; USER=root ; COMMAND=/usr/bin/systemctl'
fi
exit 0
EOF

  chmod +x "$BIN/sleep" "$BIN/systemctl" "$BIN/curl" "$BIN/journalctl"

  # 假 /proc/<pid>/environ
  printf 'GLM_API_KEY=dummy-runtime-value\0HOME=/root\0' > "$T/proc/42/environ"

  # 假数据库三件套 + 一个旧 .bak（权限收紧目标）
  : > "$T/data/cloud.db"
  : > "$T/data/cloud.db-wal"
  : > "$T/data/cloud.db-shm"
  : > "$T/data/cloud.db.bak-20260908-pre-v2"

  # 轮换前 unit（含旧密钥占位）
  cat > "$T/unit" <<EOF
[Unit]
Description=old unit with inline key

[Service]
Environment=GLM_MODEL=glm-4-flash-250414
$OLD_MARKER
ExecStart=/usr/bin/node dist-server/server.js
EOF

  echo 42 > "$STATE/pid"
  echo up > "$STATE/state"
  export SB_STATE="$STATE"
}

# run_script <mode>：以隔离 SB_* 环境执行被测脚本，回显输出并返回其退出码
run_script() {
  local mode="$1"
  local out
  set +e
  out=$(
    SB_UNIT="$T/unit" \
      SB_ENVFILE="$T/envfile" \
      SB_DB="$T/data/cloud.db" \
      SB_BACKUP_DIR="$T/rootbackup" \
      SB_SYSTEMCTL="$BIN/systemctl" \
      SB_CURL="$BIN/curl" \
      SB_JOURNALCTL="$BIN/journalctl" \
      SB_SLEEP="$BIN/sleep" \
      SB_PROC="$T/proc" \
      SB_HEALTH_URL="http://fake:5000/api/health" \
      SB_APP_URL="http://fake/scramble-books/" \
      SB_GLM_URL="http://fake/api/ai-titles" \
      bash "$SCRIPT_UNDER_TEST" "$mode" 2>&1 <<< "$TESTKEY"
  )
  local rc=$?
  set -e
  printf '%s\n' "$out" > "$T/out.log"
  printf '%s' "$rc"
}

begin_case() { CURRENT_CASE="$1"; }
set -e

# ---- Case A：基线成功 -------------------------------------------------------
begin_case "A-基线成功"
new_env
rc=$(run_script apply)
assert_eq "$rc" "0" "退出码"
unit_now=$(cat "$T/unit")
assert_contains "$unit_now" "$NEW_MARKER" "unit 含 EnvironmentFile="
if printf '%s' "$unit_now" | grep -qF "$OLD_MARKER"; then
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] unit 仍含内联旧密钥\n' "$CURRENT_CASE"
else
  PASS=$((PASS + 1))
fi
backup_file="$T/rootbackup/scramble-books.service.pre-rotation"
assert_contains "$(cat "$backup_file")" "$OLD_MARKER" "回滚副本含轮换前 unit"
assert_eq "$(stat -Lc '%a' "$backup_file")" "600" "回滚副本权限 0600"
assert_eq "$(stat -Lc '%a' "$T/rootbackup")" "700" "回滚目录权限 0700"
assert_contains "$(cat "$T/envfile")" "$TESTKEY" "envfile 含新密钥"
assert_eq "$(stat -Lc '%a' "$T/envfile")" "600" "envfile 权限 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db")" "600" "cloud.db 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db-wal")" "600" "wal 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db.bak-20260908-pre-v2")" "600" "旧 bak 0600"
assert_key_absent_from_logs "$STATE" "$TESTKEY"
assert_contains "$(cat "$T/out.log")" "撤销旧密钥" "提示撤销旧密钥"
# Case F 前置：cleanup 删除回滚副本
rc=$(run_script cleanup)
assert_eq "$rc" "0" "cleanup 退出码"
if [ -d "$T/rootbackup" ]; then
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] cleanup 后回滚目录仍存在\n' "$CURRENT_CASE"
else
  PASS=$((PASS + 1))
fi
# verify 模式（无密钥）对成功配置应通过
rc=$(run_script verify)
assert_eq "$rc" "0" "verify 退出码"

# ---- Case B：restart 立即失败 → 回滚 ----------------------------------------
begin_case "B-restart立即失败"
new_env
export SBF_RESTART_FAIL=1
rc=$(run_script apply)
unset SBF_RESTART_FAIL
assert_eq "$rc" "3" "退出码（启动失败）"
assert_eq "$(cat "$STATE/state")" "up" "回滚后服务恢复运行"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] unit 未恢复为轮换前内容\n' "$CURRENT_CASE"
fi
assert_contains "$(cat "$T/out.log")" "已回滚" "输出回滚成功信息"
assert_key_absent_from_logs "$STATE" "$TESTKEY"

# ---- Case C：服务延迟退出 → 回滚 --------------------------------------------
begin_case "C-服务延迟退出"
new_env
export SBF_DELAYED_EXIT=1
rc=$(run_script apply)
unset SBF_DELAYED_EXIT
assert_eq "$rc" "3" "退出码（启动失败）"
assert_eq "$(cat "$STATE/state")" "up" "回滚后服务恢复运行"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] unit 未恢复为轮换前内容\n' "$CURRENT_CASE"
fi
assert_contains "$(cat "$T/out.log")" "已回滚" "输出回滚成功信息"

# ---- Case D：GLM 探针失败 → 不回滚，退出码 4 ---------------------------------
begin_case "D-GLM失败"
new_env
export SBF_GLM_FAIL=1
rc=$(run_script apply)
unset SBF_GLM_FAIL
assert_eq "$rc" "4" "退出码（验证失败）"
assert_contains "$(cat "$T/unit")" "$NEW_MARKER" "unit 保持新配置（未回滚）"
assert_contains "$(cat "$T/unit")" "UMask=0077" "unit 含 UMask=0077"
assert_contains "$(cat "$T/out.log")" "不要撤销旧密钥" "提示暂缓撤销"
assert_contains "$(cat "$T/out.log")" "ok=false" "GLM 探针只输出布尔"
if printf '%s' "$(cat "$T/out.log")" | grep -q 'GLM HTTP 503'; then
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] 输出泄漏了 GLM 响应体\n' "$CURRENT_CASE"
else
  PASS=$((PASS + 1))
fi
assert_key_absent_from_logs "$STATE" "$TESTKEY"

# ---- Case E：journal 出现新密钥 → 验证失败，退出码 4 --------------------------
begin_case "E-journal泄漏"
new_env
export SBF_JOURNAL_LEAK=1
rc=$(run_script apply)
unset SBF_JOURNAL_LEAK
assert_eq "$rc" "4" "退出码（验证失败）"
assert_contains "$(cat "$T/out.log")" "journal 新增密钥命中    → 1" "journal 扫描命中计数"

printf '\n测试结果: PASS=%d FAIL=%d\n' "$PASS" "$FAILED"
[ "$FAILED" -eq 0 ]
