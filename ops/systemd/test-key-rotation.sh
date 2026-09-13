#!/usr/bin/env bash
# scramble-books-key-rotation.sh 的故障注入测试（v3，2026-09-13）
#
# 在隔离 tmp 环境中用假 systemctl/curl/journalctl 驱动轮换脚本，覆盖：
#   A. 基线成功：全链路通过；密钥不出现在任何子进程 argv 日志；verify 通过；
#      cleanup（YES 确认）删除单个回滚文件与空目录；重复 cleanup 幂等
#   B. restart 立即失败 → 必须回滚（退出码 3，unit 恢复为轮换前内容）
#   C. 服务延迟退出（health 通过后进程死掉）→ 必须回滚（退出码 3）
#   D. GLM 探针失败（最终验证失败）→ 必须回滚（退出码 4，unit 恢复旧配置）
#   E. journal 出现新密钥 → 必须回滚（退出码 4）
#   F. 回滚副本创建失败 → 修改 unit/envfile 之前终止（退出码 2，零修改）
#   G. cleanup 拒绝路径：服务未运行 / 确认词不符 → 零删除
#   H. 危险路径注入全部拒绝：SB_TEST_ROOT=/ 、逃逸到 /etc、相对路径逃逸、
#      符号链接逃逸（canary 零删除）、生产模式 SB_* 注入、空变量、空 SB_TEST_ROOT
#   I. 重复 apply：与当前 unit 一致的副本复用（inode 不变），重试成功
#   J. 重复 apply：内容不同的副本拒绝覆盖（副本/unit/envfile 均不变）
#   K. journalctl 本身执行失败 → 按验证失败回滚（绝不误判零命中）
#   L. GLM HTTP 500 + ok=true 对抗用例 → 仍判失败并回滚
#   O. GLM 瞬态失败（前 2 次 429，第 3 次成功）→ 重试通过
#   P. GLM 调用成功但 id 回显不匹配（ok:false 无 error、generator 存在）
#      → 探针以 generator 哨兵判定通过，不误回滚
#   M. 轮换窗口内权限漂移（envfile 644）→ 验证失败并回滚
#   N. cleanup 发现 unit 缺 UMask/EnvironmentFile 配置 → 拒绝（零删除）
#
# 用法（root，或 GitHub runner 的 sudo）：
#   sudo bash test-key-rotation.sh <scramble-books-key-rotation.sh>
# 全程 SB_TEST_MODE=1 + SB_TEST_ROOT 限定在隔离 tmp 目录，绝不触碰真实 systemd/数据库。
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

assert_path_exists() { # path what
  if [ -e "$1" ]; then
    PASS=$((PASS + 1))
  else
    FAILED=$((FAILED + 1))
    printf 'FAIL [%s] %s: 路径不存在 <%s>\n' "$CURRENT_CASE" "$3" "$1"
  fi
}

assert_path_absent() { # path what
  if [ -e "$1" ]; then
    FAILED=$((FAILED + 1))
    printf 'FAIL [%s] %s: 路径不应存在 <%s>\n' "$CURRENT_CASE" "$3" "$1"
  else
    PASS=$((PASS + 1))
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

  # 假 sleep：立即返回（时序由假 curl/systemctl 的确定性状态机模拟）
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
    # 权限漂移注入：重启同时把 envfile 改成 644，模拟轮换窗口内的权限异常
    if [ -n "${SBF_PERMS_DRIFT:-}" ] && [ -n "${SB_ENVFILE:-}" ]; then
      chmod 644 "$SB_ENVFILE"
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
    calls_file="$SB_STATE/glm_calls"
    calls=$(cat "$calls_file" 2>/dev/null || echo 0)
    calls=$((calls + 1))
    echo "$calls" > "$calls_file"
    if [ -n "${SBF_GLM_FAIL:-}" ]; then
      printf '{"ok":false,"error":"GLM HTTP 503"}\n200'
    elif [ -n "${SBF_GLM_HTTP500:-}" ]; then
      # 对抗用例：非 200 但 body 声称成功——必须仍判失败
      printf '{"ok":false,"error":"GLM HTTP 500"}\n500'
    elif [ -n "${SBF_GLM_FAIL_FIRST:-}" ] && [ "$calls" -le "${SBF_GLM_FAIL_FIRST}" ]; then
      # 瞬态用例：前 N 次失败，之后成功——验证重试逻辑
      printf '{"ok":false,"error":"GLM HTTP 429"}\n429'
    elif [ -n "${SBF_GLM_IDECHO:-}" ]; then
      # id 回显用例：GLM 调用成功但结果被应用按 id 过滤丢弃（ok:false 无 error 字段，
      # generator 存在）——探针必须以 generator 为哨兵判定通过
      printf '{"ok":false,"results":[],"generator":"glm-4-flash"}\n200'
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
if [ -n "${SBF_JOURNAL_FAIL:-}" ]; then
  # 模拟 journalctl 本身执行失败（无输出、非零退出）
  exit 1
fi
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

# run_script <mode> <stdin>：以隔离 SB_* 环境执行被测脚本，输出写 $T/out.log，返回退出码
run_script() {
  local mode="$1" stdin="${2-}"
  local rc
  set +e
  (
    export SB_TEST_MODE=1
    export SB_TEST_ROOT="$T"
    export SB_UNIT="$T/unit"
    export SB_ENVFILE="$T/envfile"
    export SB_DB="$T/data/cloud.db"
    export SB_BACKUP_DIR="$T/rootbackup"
    export SB_SYSTEMCTL="$BIN/systemctl"
    export SB_CURL="$BIN/curl"
    export SB_JOURNALCTL="$BIN/journalctl"
    export SB_SLEEP="$BIN/sleep"
    export SB_PROC="$T/proc"
    export SB_HEALTH_URL="http://fake:5000/api/health"
    export SB_APP_URL="http://fake/scramble-books/"
    export SB_GLM_URL="http://fake/api/ai-titles"
    cd "$T" || exit 2
    bash "$SCRIPT_UNDER_TEST" "$mode" 2>&1 <<< "$stdin"
  ) > "$T/out.log"
  rc=$?
  set -e
  printf '%s' "$rc"
}

# run_danger <mode> <stdin> [cwd]：危险注入场景专用（期望被守卫拒绝）
run_danger() {
  local mode="$1" stdin="$2" cwd="${3:-$T}"
  local rc
  set +e
  (
    # shellcheck disable=SC2086
    cd "$cwd" && env \
      SB_TEST_MODE="${D_TEST_MODE-}" \
      SB_TEST_ROOT="${D_TEST_ROOT-}" \
      SB_UNIT="${D_UNIT-}" \
      SB_ENVFILE="${D_ENVFILE-}" \
      SB_DB="${D_DB-}" \
      SB_BACKUP_DIR="${D_BACKUP-}" \
      SB_SYSTEMCTL="${D_SYSTEMCTL-}" \
      SB_CURL="${D_CURL-}" \
      SB_JOURNALCTL="${D_JOURNALCTL-}" \
      SB_SLEEP="${D_SLEEP-}" \
      SB_PROC="${D_PROC-}" \
      SB_HEALTH_URL="${D_HEALTH-}" \
      SB_APP_URL="${D_APP-}" \
      SB_GLM_URL="${D_GLM-}" \
      bash "$SCRIPT_UNDER_TEST" "$mode" 2>&1 <<< "$stdin"
  ) > "$T/out.log"
  rc=$?
  set -e
  printf '%s' "$rc"
}

# 危险场景的「合法」基准值（除被注入的那个变量外全部合规）
set_danger_defaults() {
  D_TEST_MODE=1
  D_TEST_ROOT="$T"
  D_UNIT="$T/unit"
  D_ENVFILE="$T/envfile"
  D_DB="$T/data/cloud.db"
  D_BACKUP="$T/rootbackup"
  D_SYSTEMCTL="$BIN/systemctl"
  D_CURL="$BIN/curl"
  D_JOURNALCTL="$BIN/journalctl"
  D_SLEEP="$BIN/sleep"
  D_PROC="$T/proc"
  D_HEALTH="http://fake:5000/api/health"
  D_APP="http://fake/scramble-books/"
  D_GLM="http://fake/api/ai-titles"
}

begin_case() { CURRENT_CASE="$1"; }
set -e

# ---- Case A：基线成功 + verify + cleanup（YES）+ 重复 cleanup -----------------
begin_case "A-基线成功"
new_env
rc=$(run_script apply "$TESTKEY")
assert_eq "$rc" "0" "apply 退出码"
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
assert_eq "$(stat -Lc '%a %U %G' "$T/rootbackup")" "700 root root" "回滚目录 0700 root:root"
assert_contains "$(cat "$T/envfile")" "$TESTKEY" "envfile 含新密钥"
assert_eq "$(stat -Lc '%a' "$T/envfile")" "600" "envfile 权限 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db")" "600" "cloud.db 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db-wal")" "600" "wal 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db-shm")" "600" "shm 0600"
assert_eq "$(stat -Lc '%a' "$T/data/cloud.db.bak-20260908-pre-v2")" "600" "旧 bak 0600"
assert_key_absent_from_logs "$STATE" "$TESTKEY"
assert_contains "$(cat "$T/out.log")" "撤销旧密钥" "提示撤销旧密钥"
rc=$(run_script verify "")
assert_eq "$rc" "0" "verify 退出码"
rc=$(run_script cleanup "YES")
assert_eq "$rc" "0" "cleanup 退出码"
assert_path_absent "$backup_file" "回滚文件已删"
assert_path_absent "$T/rootbackup" "空目录已 rmdir"
rc=$(run_script cleanup "YES")
assert_eq "$rc" "0" "重复 cleanup 幂等退出码"
assert_contains "$(cat "$T/out.log")" "无需清理" "重复 cleanup 提示无需清理"

# ---- Case B：restart 立即失败 → 回滚 ----------------------------------------
begin_case "B-restart立即失败"
new_env
export SBF_RESTART_FAIL=1
rc=$(run_script apply "$TESTKEY")
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
rc=$(run_script apply "$TESTKEY")
unset SBF_DELAYED_EXIT
assert_eq "$rc" "3" "退出码（启动失败）"
assert_eq "$(cat "$STATE/state")" "up" "回滚后服务恢复运行"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] unit 未恢复为轮换前内容\n' "$CURRENT_CASE"
fi
assert_contains "$(cat "$T/out.log")" "已回滚" "输出回滚成功信息"

# ---- Case D：GLM 探针失败（最终验证失败）→ 回滚 ------------------------------
begin_case "D-GLM验证失败回滚"
new_env
export SBF_GLM_FAIL=1
rc=$(run_script apply "$TESTKEY")
unset SBF_GLM_FAIL
assert_eq "$rc" "4" "退出码（最终验证失败）"
assert_eq "$(cat "$STATE/state")" "up" "回滚后服务恢复运行"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] 验证失败后 unit 未恢复为轮换前内容\n' "$CURRENT_CASE"
fi
assert_contains "$(cat "$T/out.log")" "已回滚" "输出回滚成功信息"
assert_contains "$(cat "$T/out.log")" "不要撤销旧密钥" "提示暂缓撤销"
assert_contains "$(cat "$T/out.log")" "generator 缺失" "探针按 generator 哨兵判失败"
assert_contains "$(cat "$T/out.log")" "GLM 探针失败类别" "输出脱敏错误类别"
if printf '%s' "$(cat "$T/out.log")" | grep -q '{"ok":false'; then
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] 输出泄漏了 GLM 响应正文\n' "$CURRENT_CASE"
else
  PASS=$((PASS + 1))
fi
assert_key_absent_from_logs "$STATE" "$TESTKEY"

# ---- Case E：journal 出现新密钥 → 回滚 ---------------------------------------
begin_case "E-journal泄漏回滚"
new_env
export SBF_JOURNAL_LEAK=1
rc=$(run_script apply "$TESTKEY")
unset SBF_JOURNAL_LEAK
assert_eq "$rc" "4" "退出码（最终验证失败）"
assert_contains "$(cat "$T/out.log")" "journal 新增密钥命中    → 1" "journal 扫描命中计数"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] journal 泄漏后 unit 未恢复为轮换前内容\n' "$CURRENT_CASE"
fi

# ---- Case F：回滚副本创建失败 → 修改 unit/envfile 之前终止 -------------------
begin_case "F-副本创建失败"
new_env
: > "$T/fileparent" # 普通文件，使其下无法建目录
set +e
(
  export SB_TEST_MODE=1 SB_TEST_ROOT="$T"
  export SB_UNIT="$T/unit" SB_ENVFILE="$T/envfile" SB_DB="$T/data/cloud.db"
  export SB_BACKUP_DIR="$T/fileparent/sub"
  export SB_SYSTEMCTL="$BIN/systemctl" SB_CURL="$BIN/curl" SB_JOURNALCTL="$BIN/journalctl"
  export SB_SLEEP="$BIN/sleep" SB_PROC="$T/proc"
  export SB_HEALTH_URL="http://fake:5000/api/health" SB_APP_URL="http://fake/scramble-books/" SB_GLM_URL="http://fake/api/ai-titles"
  cd "$T" || exit 2
  bash "$SCRIPT_UNDER_TEST" apply 2>&1 <<< "$TESTKEY"
) > "$T/out.log"
rc=$?
set -e
assert_eq "$rc" "2" "退出码（前置失败）"
assert_contains "$(cat "$T/unit")" "$OLD_MARKER" "unit 保持原样（零修改）"
assert_path_absent "$T/envfile" "envfile 未创建"
assert_eq "$(cat "$STATE/state")" "up" "服务状态未受影响"

# ---- Case G：cleanup 拒绝路径（零删除）---------------------------------------
begin_case "G-cleanup拒绝"
new_env
rc=$(run_script apply "$TESTKEY")
assert_eq "$rc" "0" "apply 成功（准备 cleanup 场景）"
backup_file="$T/rootbackup/scramble-books.service.pre-rotation"
# G1: 服务未运行
echo down > "$STATE/state"
rc=$(run_script cleanup "YES")
assert_eq "$rc" "2" "服务未运行 → 拒绝"
assert_path_exists "$backup_file" "拒绝后回滚文件仍在"
# G2: 确认词不符
echo up > "$STATE/state"
rc=$(run_script cleanup "yes")
assert_eq "$rc" "2" "确认词不符 → 拒绝"
assert_path_exists "$backup_file" "拒绝后回滚文件仍在"
rc=$(run_script cleanup "")
assert_eq "$rc" "2" "空确认 → 拒绝"
assert_path_exists "$backup_file" "拒绝后回滚文件仍在"

# ---- Case H：危险路径注入全部拒绝（零删除）-----------------------------------
begin_case "H-危险路径"
# H1: SB_TEST_ROOT=/
set_danger_defaults
D_TEST_ROOT="/"
D_BACKUP="$T/rootbackup"
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "SB_TEST_ROOT=/ → 拒绝"
assert_path_exists "/etc/passwd" "系统目录未受影响"
# H2: 逃逸到 /etc
set_danger_defaults
D_BACKUP="/etc/scramble-evil"
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "SB_BACKUP_DIR=/etc/... → 拒绝"
assert_path_absent "/etc/scramble-evil" "/etc 未被创建/删除"
# H3: 相对路径逃逸（cwd=/tmp，../etc/rot → /etc/rot）
set_danger_defaults
D_BACKUP="../etc/rot"
rc=$(run_danger cleanup "YES" "/tmp")
assert_eq "$rc" "2" "相对路径逃逸 → 拒绝"
assert_path_absent "/etc/rot" "/etc 未被创建/删除"
# H4: 符号链接逃逸（canary 必须零删除）
set_danger_defaults
EVIL="$(mktemp -d /tmp/sb-rot-evil.XXXXXX)"
EVIL_CANARY="$EVIL/canary"
: > "$EVIL_CANARY"
ln -s "$EVIL" "$T/linkdir"
D_BACKUP="$T/linkdir"
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "符号链接逃逸 → 拒绝"
assert_path_exists "$EVIL_CANARY" "链接目标 canary 零删除"
# H5: 生产模式 SB_* 注入（未显式 SB_TEST_MODE=1）
set_danger_defaults
D_TEST_MODE=""
D_TEST_ROOT=""
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "生产模式 SB_* 注入 → 拒绝"
# H6: 测试模式空变量（禁止回退生产默认）
set_danger_defaults
D_UNIT=""
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "测试模式空 SB_UNIT → 拒绝"
# H7: 空 SB_TEST_ROOT
set_danger_defaults
D_TEST_ROOT=""
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "空 SB_TEST_ROOT → 拒绝"
# H8: SB_TEST_MODE 值非法
set_danger_defaults
D_TEST_MODE="true"
rc=$(run_danger cleanup "YES")
assert_eq "$rc" "2" "SB_TEST_MODE=true（非 1）→ 拒绝"

# ---- Case I：重复 apply——相同回滚副本复用（不重写）--------------------------
begin_case "I-重复apply复用副本"
new_env
export SBF_GLM_FAIL=1 # 第一次 apply 在验证阶段失败并回滚 → unit 与副本一致
rc=$(run_script apply "$TESTKEY")
unset SBF_GLM_FAIL
assert_eq "$rc" "4" "首次 apply 验证失败已回滚"
backup_file="$T/rootbackup/scramble-books.service.pre-rotation"
inode1=$(stat -Lc '%i' "$backup_file")
TESTKEY2="TESTKEYsecond$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
rc=$(run_script apply "$TESTKEY2")
assert_eq "$rc" "0" "重试 apply 成功"
inode2=$(stat -Lc '%i' "$backup_file")
assert_eq "$inode1" "$inode2" "回滚副本被复用（inode 未变）"
assert_contains "$(cat "$backup_file")" "$OLD_MARKER" "副本仍是轮换前内容"
assert_contains "$(cat "$T/envfile")" "$TESTKEY2" "新密钥已生效"
assert_contains "$(cat "$T/unit")" "$NEW_MARKER" "unit 为新配置"

# ---- Case J：重复 apply——内容不同的副本拒绝覆盖 ------------------------------
begin_case "J-重复apply拒绝覆盖"
new_env
rc=$(run_script apply "$TESTKEY")
assert_eq "$rc" "0" "首次 apply 成功"
backup_file="$T/rootbackup/scramble-books.service.pre-rotation"
inode1=$(stat -Lc '%i' "$backup_file")
TESTKEY2="${TESTKEY}different-second-key"
rc=$(run_script apply "$TESTKEY2")
assert_eq "$rc" "2" "不同副本 → 拒绝（退出码 2）"
assert_contains "$(cat "$T/out.log")" "拒绝覆盖" "输出拒绝覆盖信息"
assert_eq "$(stat -Lc '%i' "$backup_file")" "$inode1" "回滚副本未被重写（inode 未变）"
assert_contains "$(cat "$backup_file")" "$OLD_MARKER" "副本仍含旧密钥内容"
assert_contains "$(cat "$T/unit")" "$NEW_MARKER" "unit 未被改动"
assert_contains "$(cat "$T/envfile")" "$TESTKEY" "envfile 仍是首次密钥"

# ---- Case K：journalctl 执行失败 → 验证失败并回滚（绝不误判零命中）-----------
begin_case "K-journalctl失败"
new_env
export SBF_JOURNAL_FAIL=1
rc=$(run_script apply "$TESTKEY")
unset SBF_JOURNAL_FAIL
assert_eq "$rc" "4" "退出码（最终验证失败）"
assert_contains "$(cat "$T/out.log")" "journalctl 执行失败" "按失败处理而非零命中"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] journalctl 失败后 unit 未恢复\n' "$CURRENT_CASE"
fi
assert_eq "$(cat "$STATE/state")" "up" "回滚后服务恢复运行"

# ---- Case L：GLM HTTP 500（持续）→ 重试 3 次仍失败 → 回滚 --------------------
begin_case "L-GLM-HTTP500对抗"
new_env
export SBF_GLM_HTTP500=1
rc=$(run_script apply "$TESTKEY")
unset SBF_GLM_HTTP500
assert_eq "$rc" "4" "退出码（最终验证失败）"
assert_contains "$(cat "$T/out.log")" "HTTP 500, generator 缺失" "探针输出如实报告"
assert_eq "$(grep -c 'generator 缺失' "$T/out.log")" "3" "重试了 3 次"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] HTTP 500 后 unit 未恢复\n' "$CURRENT_CASE"
fi

# ---- Case O：GLM 瞬态失败（前 2 次 429，第 3 次成功）→ 重试通过 --------------
begin_case "O-GLM瞬态重试"
new_env
export SBF_GLM_FAIL_FIRST=2
rc=$(run_script apply "$TESTKEY")
unset SBF_GLM_FAIL_FIRST
assert_eq "$rc" "0" "重试后 apply 成功"
assert_contains "$(cat "$T/out.log")" "(第 3/3 次)     → HTTP 200, generator=glm-4-flash ✅" "第 3 次成功"
assert_contains "$(cat "$T/unit")" "$NEW_MARKER" "unit 为新配置（未回滚）"
assert_contains "$(cat "$T/envfile")" "$TESTKEY" "新密钥生效"

# ---- Case P：GLM 调用成功但 id 回显不匹配（ok:false 无 error，generator 存在）
#              → 探针以 generator 为哨兵判定通过，不误回滚 ---------------------
begin_case "P-id回显丢弃不误判"
new_env
export SBF_GLM_IDECHO=1
rc=$(run_script apply "$TESTKEY")
unset SBF_GLM_IDECHO
assert_eq "$rc" "0" "generator 哨兵判定通过（退出码 0）"
assert_contains "$(cat "$T/out.log")" "generator=glm-4-flash ✅" "输出 generator 哨兵"
assert_contains "$(cat "$T/unit")" "$NEW_MARKER" "unit 为新配置"
assert_contains "$(cat "$T/out.log")" "撤销旧密钥" "正常走完 apply 流程"

# ---- Case M：轮换窗口内权限漂移（envfile 644）→ 验证失败并回滚 ---------------
begin_case "M-权限漂移"
new_env
export SBF_PERMS_DRIFT=1
rc=$(run_script apply "$TESTKEY")
unset SBF_PERMS_DRIFT
assert_eq "$rc" "4" "退出码（最终验证失败）"
assert_contains "$(cat "$T/out.log")" "644 root root" "验证报告了漂移后的权限"
if cmp -s "$T/unit" "$T/rootbackup/scramble-books.service.pre-rotation"; then
  PASS=$((PASS + 1))
else
  FAILED=$((FAILED + 1)); printf 'FAIL [%s] 权限漂移后 unit 未恢复\n' "$CURRENT_CASE"
fi

# ---- Case N：cleanup 发现 unit 配置异常 → 拒绝（零删除）----------------------
begin_case "N-cleanup配置校验"
new_env
rc=$(run_script apply "$TESTKEY")
assert_eq "$rc" "0" "apply 成功"
backup_file="$T/rootbackup/scramble-books.service.pre-rotation"
sed -i '/UMask=0077/d' "$T/unit" # 破坏 unit 的 UMask 配置
rc=$(run_script cleanup "YES")
assert_eq "$rc" "2" "unit 缺 UMask=0077 → 拒绝清理"
assert_path_exists "$backup_file" "拒绝后回滚文件仍在"
# 恢复 UMask、破坏 EnvironmentFile 行
printf 'UMask=0077\n' >> "$T/unit"
sed -i '/EnvironmentFile=\/etc\/default\/scramble-books/d' "$T/unit"
rc=$(run_script cleanup "YES")
assert_eq "$rc" "2" "unit 缺 EnvironmentFile → 拒绝清理"
assert_path_exists "$backup_file" "拒绝后回滚文件仍在"

printf '\n测试结果: PASS=%d FAIL=%d\n' "$PASS" "$FAILED"
[ "$FAILED" -eq 0 ]
