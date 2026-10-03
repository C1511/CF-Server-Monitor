#!/bin/sh
# CF-Server-Monitor sing-box 分流规则同步脚本
#
# 在面板后台「sing-box 分流」中编辑 route（分流规则），本脚本每隔几秒向面板轮询，
# 有新版本时替换本机 sing-box 配置中的 route 段，执行 sing-box check 后重启服务；
# 检查失败或重启后服务没有正常运行时自动回滚，并把结果回传面板。
# 只修改 route 段，入站/出站等其他配置保持不变；面板只能看到入站/出站的 tag 与类型，看不到密码和证书。
#
# 支持 systemd、OpenRC（Alpine）以及没有服务管理器、直接后台运行 sing-box 的系统。
#
# 安装（以 root 运行，用来改写 sing-box 配置并重启服务）：
#   curl -fsSL https://面板地址/singbox-agent.sh | CFSM_RELAY_SECRET='该服务器的上报密钥' sh -s -- install --url=https://面板地址 --id=服务器ID
# 可选参数：
#   --config=/etc/sing-box/config.json   含 route 段的配置文件（默认从服务定义或正在运行的 sing-box 进程参数中自动识别）
#   --service=sing-box                   sing-box 的服务名（systemd / OpenRC）
#   --restart-cmd='命令'                 自定义重启 sing-box 的命令（以上方式都不适用时使用）
#   --interval=10                        轮询间隔（秒，5-300）
# 其他命令：
#   cfsm-singbox status      查看配置与服务状态
#   cfsm-singbox sync        立即同步一次（回传当前配置并检查新版本）
#   cfsm-singbox update      从面板更新本脚本
#   cfsm-singbox uninstall   卸载（不会改动 sing-box 配置）
#   cfsm-singbox ensure      同步进程未运行时启动它（无服务管理器时由 crontab 每分钟调用）
#
# 连接分流记录（面板中可关闭）：通过本机 sing-box 的 Clash API 每秒采集一次连接快照，
# 连接结束时记下目标、命中规则、出站和流量，随轮询回传面板。配置中没有 clash_api 时会自动添加，
# 只监听 127.0.0.1 并使用随机密钥；持续时间不足 1 秒的连接可能采集不到。

set -u
umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

CONFIG_DIR="/etc/cfsm-singbox"
CONFIG_FILE="$CONFIG_DIR/config"
STATE_DIR="/var/lib/cfsm-singbox"
LOG_FILE="$STATE_DIR/agent.log"
LOCK_DIR="$STATE_DIR/sync.lock"
BIN_FILE="/usr/local/bin/cfsm-singbox"
UNIT_NAME="cfsm-singbox"
UNIT_FILE="/etc/systemd/system/$UNIT_NAME.service"
OPENRC_FILE="/etc/init.d/$UNIT_NAME"
DAEMON_PID="$STATE_DIR/daemon.pid"
SB_LOG="$STATE_DIR/sing-box.log"
CONN_PREV="$STATE_DIR/conn.prev.json"
CONN_CLOSED="$STATE_DIR/conn.closed.jsonl"
# 本地最多缓存的已结束连接条数（面板长时间连不上时丢弃最旧的）
CONN_BUFFER_MAX=3000
# 当前连接没有变化时，最长多久回传一次（秒）
CONN_ACTIVE_REFRESH=60
CLASH_DEFAULT_LISTEN="127.0.0.1:19095"
CRON_TAG="# cfsm-singbox"
# 即使配置没有变化，也定期回传一次（秒）
RESYNC_SECONDS=3600
# 重启后观察服务是否稳定运行（次数 x 2 秒）
HEALTH_CHECKS=5
ESC="$(printf '\033')"

log() {
    line="$(date '+%Y-%m-%d %H:%M:%S') $*"
    printf '%s\n' "$line"
    if [ -d "$STATE_DIR" ]; then
        printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
    fi
}

die() {
    log "[ERROR] $*"
    exit 1
}

trim_log() {
    if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 500 ]; then
        tail -n 300 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
}

# 从 key=value 配置文件中取值
conf() {
    sed -n "s/^$1=//p" "$CONFIG_FILE" | head -n 1
}

state_get() {
    cat "$STATE_DIR/$1" 2>/dev/null || true
}

state_set() {
    printf '%s' "$2" > "$STATE_DIR/$1"
}

load_config() {
    [ -f "$CONFIG_FILE" ] || die "未安装：找不到 $CONFIG_FILE"
    PANEL_URL="$(conf URL)"
    SERVER_ID="$(conf ID)"
    SECRET="$(conf SECRET)"
    SB_BIN="$(conf SINGBOX)"
    SB_CONFIG="$(conf SB_CONFIG)"
    CHECK_ARGS="$(conf CHECK_ARGS)"
    SERVICE="$(conf SERVICE)"
    INTERVAL="$(conf INTERVAL)"
    INIT="$(conf INIT)"
    START_CMD="$(conf START_CMD)"
    WORKDIR="$(conf WORKDIR)"
    RESTART_CMD="$(conf RESTART_CMD)"
    AGENT_MODE="$(conf AGENT_MODE)"
    [ -n "$PANEL_URL" ] && [ -n "$SERVER_ID" ] && [ -n "$SECRET" ] && [ -n "$SB_CONFIG" ] || die "配置不完整：$CONFIG_FILE"
    [ -n "$SB_BIN" ] || SB_BIN="$(command -v sing-box || echo sing-box)"
    [ -n "$CHECK_ARGS" ] || CHECK_ARGS="-c $SB_CONFIG"
    [ -n "$SERVICE" ] || SERVICE="sing-box"
    [ -n "$INIT" ] || INIT="systemd"
    [ -n "$WORKDIR" ] || WORKDIR="/"
    printf '%s' "$INTERVAL" | grep -Eq '^[0-9]+$' || INTERVAL=10
    mkdir -p "$STATE_DIR"
    # 配置参数中的相对路径以 sing-box 的工作目录为准
    cd "$WORKDIR" 2>/dev/null || cd /
}

# 向面板发请求；鉴权头通过 stdin 传给 curl，不出现在进程参数中
# 用法：panel_request <path> <输出文件> <请求体文件，可为空> [额外请求头...]；输出 HTTP 状态码
panel_request() {
    req_path="$1"
    req_out="$2"
    req_body="$3"
    shift 3
    {
        printf 'url = "%s%s"\n' "$PANEL_URL" "$req_path"
        printf 'header = "X-Relay-Id: %s"\n' "$SERVER_ID"
        printf 'header = "X-Relay-Secret: %s"\n' "$SECRET"
        for h in "$@"; do
            printf 'header = "%s"\n' "$h"
        done
        if [ -n "$req_body" ]; then
            printf 'header = "Content-Type: application/json"\n'
        else
            printf 'data = ""\n'
        fi
    } | if [ -n "$req_body" ]; then
        curl -sS -m 30 --connect-timeout 10 -o "$req_out" -D "$req_out.hdr" -w '%{http_code}' -K - --data-binary "@$req_body"
    else
        curl -sS -m 30 --connect-timeout 10 -o "$req_out" -D "$req_out.hdr" -w '%{http_code}' -K -
    fi
}

# 读取配置文件为纯 JSON（sing-box 允许注释，jq 不允许；含注释时用 sing-box format 转换）
read_config_json() {
    if jq -e 'type == "object"' "$SB_CONFIG" >/dev/null 2>&1; then
        cat "$SB_CONFIG"
    else
        "$SB_BIN" format -c "$SB_CONFIG" 2>/dev/null
    fi
}

singbox_version() {
    "$SB_BIN" version 2>/dev/null | head -n 1 | sed 's/^sing-box version //'
}

# 生成回传给面板的 JSON；入站/出站只取 tag 与类型（endpoints 也可作为出站）
# 其他配置文件（-C 目录）中的出站一并收集
# sing-box 用到的全部配置文件（含 route 的文件在最前），按绝对路径去重（启动参数里可能是相对路径）
config_files() {
    cf_list="$(readlink -f "$SB_CONFIG" 2>/dev/null || printf '%s' "$SB_CONFIG")"
    for f in $(printf '%s\n' "$CHECK_ARGS" | awk '{for (i = 1; i < NF; i++) if ($i == "-c" || $i == "--config") print $(i + 1)}'); do
        [ -f "$f" ] && cf_list="$cf_list $(readlink -f "$f" 2>/dev/null || printf '%s' "$f")"
    done
    for arg_dir in $(printf '%s\n' "$CHECK_ARGS" | awk '{for (i = 1; i < NF; i++) if ($i == "-C" || $i == "--config-directory") print $(i + 1)}'); do
        for f in "$arg_dir"/*.json; do
            [ -f "$f" ] && cf_list="$cf_list $(readlink -f "$f" 2>/dev/null || printf '%s' "$f")"
        done
    done
    printf '%s\n' $cf_list | awk '!seen[$0]++'
}

# 输出所有配置文件的 JSON（每个文件一个对象，含注释的先用 sing-box format 转换）
all_config_json() {
    for f in $(config_files); do
        if jq -e 'type == "object"' "$f" >/dev/null 2>&1; then cat "$f"; else "$SB_BIN" format -c "$f" 2>/dev/null; fi
    done
}

build_report() {
    rp_event="$1"; rp_rev="$2"; rp_ok="$3"; rp_msg="$4"; rp_out="$5"
    rp_tmp="$(mktemp "${TMPDIR:-/tmp}/cfsm-sb-report.XXXXXX")" || return 1
    all_config_json | jq -s '{
        inbounds: [.[] | .inbounds[]? | {tag: (.tag // ""), type: (.type // "")}],
        outbounds: [.[] | (.outbounds[]?, .endpoints[]?) | {tag: (.tag // ""), type: (.type // "")}],
        route: ([.[] | .route? | select(. != null)] | first)
    }' > "$rp_tmp" 2>/dev/null || printf '{}' > "$rp_tmp"
    jq -n \
        --arg event "$rp_event" \
        --arg rev "$rp_rev" \
        --argjson ok "$rp_ok" \
        --arg message "$rp_msg" \
        --arg version "$(singbox_version)" \
        --arg path "$SB_CONFIG" \
        --slurpfile summary "$rp_tmp" \
        '{event: $event, rev: $rev, ok: $ok, message: $message, singbox_version: $version, config_path: $path}
         + ($summary[0] // {} | {inbounds: (.inbounds // []), outbounds: (.outbounds // []), route: .route})' > "$rp_out"
    rp_status=$?
    rm -f "$rp_tmp"
    return $rp_status
}

send_report() {
    sr_body="$(mktemp "${TMPDIR:-/tmp}/cfsm-sb.XXXXXX")" || return 1
    if ! build_report "$1" "$2" "$3" "$4" "$sr_body"; then
        rm -f "$sr_body"
        log "[WARN] 生成回传数据失败"
        return 1
    fi
    sr_code="$(panel_request /relay/singbox/report "$sr_body.resp" "$sr_body")" || sr_code="000"
    rm -f "$sr_body" "$sr_body.resp" "$sr_body.resp.hdr"
    if [ "$sr_code" != "200" ]; then
        log "[WARN] 回传面板失败：HTTP $sr_code"
        return 1
    fi
    state_set reported_sum "$(config_sum)"
    state_set reported_at "$(date +%s)"
    return 0
}

config_sum() {
    cksum "$SB_CONFIG" 2>/dev/null | awk '{print $1 "-" $2}'
}

has_systemd() {
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

# OpenRC 是否真正在运行（容器里装了 openrc 但未由它启动时 rc-service 不可用）
has_openrc() {
    command -v rc-service >/dev/null 2>&1 && command -v openrc-run >/dev/null 2>&1 && [ -d /run/openrc ]
}

strip_color() {
    sed "s/${ESC}\[[0-9;]*m//g"
}

# 按进程名（/proc/PID/comm，最多 15 个字符）查找，返回最小的 PID。
# 不用 pgrep -x：busybox 的 pgrep -x 比较的是完整 argv[0]，匹配不到 /usr/bin/sing-box 这样启动的进程
find_pid() {
    fp_name="$(printf '%s' "$1" | cut -c1-15)"
    for fp_dir in /proc/[0-9]*; do
        [ "$(cat "$fp_dir/comm" 2>/dev/null)" = "$fp_name" ] && printf '%s\n' "${fp_dir#/proc/}"
    done | sort -n | head -n 1
}

# 正在运行的 sing-box 主进程 PID
singbox_pid() {
    sp="$(find_pid "$(basename "$SB_BIN")")"
    [ -n "$sp" ] || sp="$(find_pid sing-box)"
    printf '%s' "$sp"
}

# 进程的完整启动命令（/proc/PID/cmdline 以 NUL 分隔）
proc_cmdline() {
    tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null | sed 's/ *$//'
}

restart_singbox() {
    if [ -n "$RESTART_CMD" ]; then
        sh -c "$RESTART_CMD" 2>&1
        return $?
    fi
    case "$INIT" in
        systemd) systemctl restart "$SERVICE" 2>&1 ;;
        openrc) rc-service "$SERVICE" restart 2>&1 ;;
        *) restart_process ;;
    esac
}

# 没有服务管理器：结束旧进程，按原来的命令和工作目录重新后台启动
restart_process() {
    old="$(singbox_pid)"
    if [ -n "$old" ]; then
        kill "$old" 2>/dev/null
        i=0
        while kill -0 "$old" 2>/dev/null && [ "$i" -lt 25 ]; do
            sleep 0.2
            i=$((i + 1))
        done
        kill -9 "$old" 2>/dev/null
    fi
    # shellcheck disable=SC2086
    ( cd "$WORKDIR" 2>/dev/null || cd /; nohup $START_CMD >> "$SB_LOG" 2>&1 & )
    return 0
}

# 服务需在 HEALTH_CHECKS x 2 秒内保持运行且 PID 不变（排除反复崩溃重启）
singbox_healthy() {
    first_pid=""
    i=0
    while [ "$i" -lt "$HEALTH_CHECKS" ]; do
        sleep 2
        if [ "$INIT" = "systemd" ] && [ -z "$RESTART_CMD" ]; then
            [ "$(systemctl is-active "$SERVICE" 2>/dev/null)" = "active" ] || return 1
            pid="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)"
        else
            pid="$(singbox_pid)"
        fi
        [ -n "$pid" ] && [ "$pid" != "0" ] || return 1
        [ -n "$first_pid" ] || first_pid="$pid"
        [ "$pid" = "$first_pid" ] || return 1
        i=$((i + 1))
    done
    return 0
}

service_logs() {
    if [ "$INIT" = "systemd" ] && command -v journalctl >/dev/null 2>&1; then
        journalctl -u "$SERVICE" -n 8 --no-pager -o cat 2>/dev/null | strip_color | tail -c 1200
    elif [ -f "$SB_LOG" ]; then
        tail -n 8 "$SB_LOG" 2>/dev/null | strip_color | tail -c 1200
    fi
}

# 应用面板下发的 route：写入 -> check -> 重启 -> 观察，任一步失败都恢复备份
apply_route() {
    ar_rev="$1"
    ar_route="$2"
    ar_new="$(mktemp "${TMPDIR:-/tmp}/cfsm-sb-new.XXXXXX")" || return 1

    if ! jq -e 'type == "object"' "$ar_route" >/dev/null 2>&1; then
        AR_MESSAGE="面板下发的 route 不是 JSON 对象"
        rm -f "$ar_new"
        return 1
    fi
    if ! read_config_json | jq --slurpfile route "$ar_route" '.route = $route[0]' > "$ar_new" 2>/dev/null || [ ! -s "$ar_new" ]; then
        AR_MESSAGE="无法解析本机配置文件 $SB_CONFIG"
        rm -f "$ar_new"
        return 1
    fi
    install_config "$ar_new"
}

# 用新文件替换配置：备份 -> 写入 -> check -> 重启 -> 观察，任一步失败都恢复备份；结果写入 AR_MESSAGE
install_config() {
    ar_new="$1"
    ar_backup="$STATE_DIR/config.backup.json"
    cp -p "$SB_CONFIG" "$ar_backup" || { AR_MESSAGE="备份配置失败"; rm -f "$ar_new"; return 1; }
    # 原地写入以保留文件权限与属主；sing-box 只在启动时读取配置，check 失败会立即恢复
    cat "$ar_new" > "$SB_CONFIG"
    rm -f "$ar_new"

    # shellcheck disable=SC2086
    check_out="$(cd "$WORKDIR" 2>/dev/null; "$SB_BIN" check $CHECK_ARGS 2>&1)"
    if [ $? -ne 0 ]; then
        cat "$ar_backup" > "$SB_CONFIG"
        AR_MESSAGE="sing-box check 未通过，已恢复原配置：$(printf '%s' "$check_out" | strip_color | tail -c 1200)"
        return 1
    fi

    restart_out="$(restart_singbox)"
    if [ $? -eq 0 ] && singbox_healthy; then
        AR_MESSAGE="已应用并重启 sing-box"
        return 0
    fi

    logs="$(service_logs)"
    cat "$ar_backup" > "$SB_CONFIG"
    restart_singbox >/dev/null 2>&1
    if singbox_healthy; then
        AR_MESSAGE="新配置启动失败，已回滚并恢复运行。${restart_out:+ $restart_out}${logs:+ 日志：$logs}"
    else
        AR_MESSAGE="新配置启动失败，回滚后 sing-box 仍未正常运行，请登录服务器检查！${logs:+ 日志：$logs}"
    fi
    return 1
}

# ---------------- 连接分流记录 ----------------

# Clash API 连接 -> 回传面板的记录
CONN_REC_DEF='def rec($end): {
    start: .start, end: $end,
    in: (.metadata.type // ""), net: (.metadata.network // ""), src: (.metadata.sourceIP // ""),
    host: (.metadata.host // ""), ip: (.metadata.destinationIP // ""), port: (.metadata.destinationPort // ""),
    rule: (.rule // ""), chain: (.chains // []), up: (.upload // 0), down: (.download // 0)
};'

utc_now() {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
}

# 从配置中找出 Clash API 地址与密钥（监听全部地址时改用 127.0.0.1 访问）
detect_clash() {
    dc_tmp="$(all_config_json | jq -rs '[.[] | .experimental.clash_api? | select(. != null and (.external_controller // "") != "")] | first // empty | .external_controller, (.secret // "")' 2>/dev/null)"
    dc_listen="$(printf '%s\n' "$dc_tmp" | sed -n 1p)"
    if [ -z "$dc_listen" ]; then
        state_set clash_url ""
        state_set clash_secret ""
        return 1
    fi
    dc_port="${dc_listen##*:}"
    dc_host="${dc_listen%:*}"
    case "$dc_host" in
        ""|0.0.0.0|"[::]"|::|localhost) dc_host="127.0.0.1" ;;
    esac
    state_set clash_url "http://$dc_host:$dc_port"
    state_set clash_secret "$(printf '%s\n' "$dc_tmp" | sed -n 2p)"
    return 0
}

# 配置里没有 Clash API 时添加一个只监听本机、带随机密钥的（同样经过 check / 重启 / 回滚）
enable_clash_api() {
    ec_secret="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    ec_new="$(mktemp "${TMPDIR:-/tmp}/cfsm-sb-new.XXXXXX")" || return 1
    if ! read_config_json | jq --arg l "$CLASH_DEFAULT_LISTEN" --arg s "$ec_secret" \
        '.experimental.clash_api = ((.experimental.clash_api // {}) + {external_controller: $l, secret: $s})' > "$ec_new" 2>/dev/null || [ ! -s "$ec_new" ]; then
        rm -f "$ec_new"
        return 1
    fi
    log "为记录连接分流开启 Clash API（$CLASH_DEFAULT_LISTEN，仅本机）"
    AR_MESSAGE=""
    if install_config "$ec_new"; then
        detect_clash
        state_set clash_sum "$(config_sum)"
        log "Clash API 已开启"
        send_report sync "" true "已开启 Clash API（$CLASH_DEFAULT_LISTEN，仅本机）用于记录连接分流" || true
    else
        # 同一份配置不再重试，避免反复重启 sing-box
        state_set clash_failed "$(config_sum)"
        log "[ERROR] 开启 Clash API 失败：$AR_MESSAGE"
        send_report sync "" false "开启 Clash API 失败，无法记录连接分流：$AR_MESSAGE" || true
    fi
}

# 采集一次连接快照：上次有、这次没有的连接视为已结束，按上次的流量记录下来
collect_conns() {
    cc_url="$(state_get clash_url)"
    [ -n "$cc_url" ] || return 0
    cc_secret="$(state_get clash_secret)"
    cc_cur="$STATE_DIR/conn.cur.json"
    {
        printf 'url = "%s/connections"\n' "$cc_url"
        [ -n "$cc_secret" ] && printf 'header = "Authorization: Bearer %s"\n' "$cc_secret"
    } | curl -s -m 3 --noproxy '*' -K - -o "$cc_cur" 2>/dev/null || return 0
    jq -e '.connections | type == "array"' "$cc_cur" >/dev/null 2>&1 || { rm -f "$cc_cur"; return 0; }
    if [ -f "$CONN_PREV" ]; then
        jq -c --slurpfile cur "$cc_cur" --arg now "$(utc_now)" "$CONN_REC_DEF"'
            (($cur[0].connections // []) | map({(.id): true}) | add // {}) as $seen
            | (.connections // [])[] | select($seen[.id] | not) | rec($now)' "$CONN_PREV" >> "$CONN_CLOSED" 2>/dev/null
    fi
    mv "$cc_cur" "$CONN_PREV"
}

# 回传连接记录：有新结束的连接、当前连接有变化，或距上次超过 CONN_ACTIVE_REFRESH 秒时才发送
upload_conns() {
    [ -n "$(state_get clash_url)" ] && [ -f "$CONN_PREV" ] || return 0
    uc_sending="$CONN_CLOSED.sending"
    if [ -s "$CONN_CLOSED" ]; then
        cat "$CONN_CLOSED" >> "$uc_sending"
        rm -f "$CONN_CLOSED"
    fi
    if [ -f "$uc_sending" ] && [ "$(wc -l < "$uc_sending")" -gt "$CONN_BUFFER_MAX" ]; then
        tail -n "$CONN_BUFFER_MAX" "$uc_sending" > "$uc_sending.tmp" && mv "$uc_sending.tmp" "$uc_sending"
    fi
    uc_sig="$(jq -r '[.connections[]?.id] | sort | join(",")' "$CONN_PREV" 2>/dev/null | cksum | awk '{print $1}')"
    uc_now="$(date +%s)"
    uc_last="$(state_get conn_uploaded_at)"
    if [ ! -s "$uc_sending" ] && [ "$uc_sig" = "$(state_get conn_sig)" ] && [ $((uc_now - ${uc_last:-0})) -lt "$CONN_ACTIVE_REFRESH" ]; then
        return 0
    fi
    [ -f "$uc_sending" ] || : > "$uc_sending"
    uc_body="$(mktemp "${TMPDIR:-/tmp}/cfsm-sb-conn.XXXXXX")" || return 1
    if ! jq -n --slurpfile closed "$uc_sending" --slurpfile cur "$CONN_PREV" --arg now "$(utc_now)" "$CONN_REC_DEF"'
        {
            closed: $closed,
            active: ([($cur[0].connections // [])[] | rec($now)] | sort_by(.start) | reverse | .[:200]),
            totals: {up: ($cur[0].uploadTotal // 0), down: ($cur[0].downloadTotal // 0)}
        }' > "$uc_body" 2>/dev/null; then
        # 缓存损坏：丢弃，避免一直发送失败
        rm -f "$uc_body" "$uc_sending"
        return 1
    fi
    uc_code="$(panel_request /relay/singbox/conns "$uc_body.resp" "$uc_body")" || uc_code="000"
    rm -f "$uc_body" "$uc_body.resp" "$uc_body.resp.hdr"
    if [ "$uc_code" = "200" ]; then
        rm -f "$uc_sending"
        state_set conn_sig "$uc_sig"
        state_set conn_uploaded_at "$uc_now"
    else
        log "[WARN] 回传连接记录失败：HTTP $uc_code"
    fi
}

# 根据面板的开关准备采集：找到或开启 Clash API；关闭时清掉本地缓存
sync_conn_log() {
    if [ "$1" != "1" ]; then
        state_set conn_log 0
        rm -f "$CONN_PREV" "$CONN_CLOSED" "$CONN_CLOSED.sending"
        return 0
    fi
    state_set conn_log 1
    cs_sum="$(config_sum)"
    if [ "$cs_sum" != "$(state_get clash_sum)" ]; then
        detect_clash
        state_set clash_sum "$cs_sum"
    fi
    if [ -z "$(state_get clash_url)" ] && [ "$(state_get clash_failed)" != "$cs_sum" ]; then
        enable_clash_api
    fi
    upload_conns
}

cmd_sync() {
    load_config
    command -v jq >/dev/null 2>&1 || die "需要 jq"
    mkdir "$LOCK_DIR" 2>/dev/null || {
        # 上次运行异常退出留下的锁：超过 10 分钟视为失效
        if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
            rmdir "$LOCK_DIR" 2>/dev/null; mkdir "$LOCK_DIR" 2>/dev/null || return 0
        else
            return 0
        fi
    }
    tmp="$(mktemp "${TMPDIR:-/tmp}/cfsm-sb-poll.XXXXXX")" || { rmdir "$LOCK_DIR"; return 1; }

    # 配置文件被修改（例如在服务器上手动编辑）或距上次回传超过 1 小时：回传一次摘要
    now="$(date +%s)"
    last_at="$(state_get reported_at)"
    if [ "$(config_sum)" != "$(state_get reported_sum)" ] || [ $((now - ${last_at:-0})) -ge "$RESYNC_SECONDS" ]; then
        send_report sync "" true "" || true
    fi

    applied="$(state_get applied_rev)"
    code="$(panel_request /relay/singbox/poll "$tmp" "" "X-Applied-Rev: $applied")" || code="000"
    case "$code" in
        204) ;;
        200)
            rev="$(sed -n 's/^[Xx]-[Rr]oute-[Rr]ev:[[:space:]]*//p' "$tmp.hdr" | tr -d '\r' | head -n 1)"
            if ! printf '%s' "$rev" | grep -Eq '^v[0-9]{1,9}-[0-9a-f]{12}$'; then
                log "[WARN] 面板返回的版本号无效"
            elif [ "$rev" = "$(state_get failed_rev)" ]; then
                : # 该版本已应用失败过，等待面板保存新版本
            else
                log "收到新的分流规则 $rev，开始应用"
                AR_MESSAGE=""
                if apply_route "$rev" "$tmp"; then
                    state_set applied_rev "$rev"
                    state_set failed_rev ""
                    log "$rev $AR_MESSAGE"
                    send_report apply "$rev" true "$AR_MESSAGE" || true
                else
                    state_set failed_rev "$rev"
                    log "[ERROR] $rev $AR_MESSAGE"
                    send_report apply "$rev" false "$AR_MESSAGE" || true
                fi
            fi
            ;;
        401) log "[ERROR] 面板拒绝请求：密钥或服务器 ID 不正确" ;;
        403) log "[WARN] 面板未选择本机为 sing-box 服务器" ;;
        *) log "[WARN] 无法连接面板 $PANEL_URL（HTTP $code）" ;;
    esac
    case "$code" in
        200|204)
            # 面板通过 X-Conn-Log 告知是否记录连接分流（旧版面板没有该响应头，视为关闭）
            conn_flag="$(sed -n 's/^[Xx]-[Cc]onn-[Ll]og:[[:space:]]*//p' "$tmp.hdr" | tr -d '\r' | head -n 1)"
            sync_conn_log "$conn_flag"
            ;;
    esac
    rm -f "$tmp" "$tmp.hdr"
    rmdir "$LOCK_DIR" 2>/dev/null
    trim_log
}

cmd_daemon() {
    load_config
    printf '%s' "$$" > "$DAEMON_PID"
    log "已启动，每 ${INTERVAL} 秒轮询一次 $PANEL_URL"
    # 每秒一轮：开启连接分流记录时采集一次连接快照；每 INTERVAL 秒与面板同步一次
    last_sync=0
    while :; do
        if [ $(($(date +%s) - last_sync)) -ge "$INTERVAL" ]; then
            ( cmd_sync ) || true
            last_sync="$(date +%s)"
        fi
        if [ "$(state_get conn_log)" = "1" ]; then
            ( collect_conns ) || true
        fi
        sleep 1
    done
}

daemon_running() {
    pid="$(cat "$DAEMON_PID" 2>/dev/null)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q "cfsm-singbox" "/proc/$pid/cmdline" 2>/dev/null
}

# 无服务管理器时使用：同步进程不在运行就后台启动（crontab 每分钟调用，兼顾开机自启）
cmd_ensure() {
    load_config
    daemon_running && return 0
    nohup "$BIN_FILE" daemon >/dev/null 2>&1 &
}

stop_daemon() {
    pid="$(cat "$DAEMON_PID" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q "cfsm-singbox" "/proc/$pid/cmdline" 2>/dev/null; then
        kill "$pid" 2>/dev/null
    fi
    rm -f "$DAEMON_PID"
}

# 从启动命令中提取 sing-box 的配置参数（-c / -C / -D）；结果写入 DET_BIN、DET_ARGS
parse_exec() {
    DET_BIN=""
    DET_ARGS=""
    [ -n "$1" ] || return 0
    set -- $1
    DET_BIN="$1"
    shift
    while [ $# -gt 0 ]; do
        case "$1" in
            -c|--config|-C|--config-directory|-D|--directory)
                if [ $# -ge 2 ]; then
                    DET_ARGS="$DET_ARGS $1 $2"
                    shift 2
                else
                    shift
                fi
                ;;
            --config=*|--config-directory=*|--directory=*)
                DET_ARGS="$DET_ARGS ${1%%=*} ${1#*=}"
                shift
                ;;
            *) shift ;;
        esac
    done
    DET_ARGS="${DET_ARGS# }"
}

# 识别 sing-box 的运行方式：systemd 服务 > OpenRC 服务 > 正在运行的进程
# 结果写入 DET_INIT、DET_BIN、DET_ARGS、DET_START、DET_WORKDIR
detect_singbox() {
    DET_INIT=""; DET_START=""; DET_WORKDIR="/"; DET_BIN=""; DET_ARGS=""
    service="$1"
    if has_systemd && systemctl cat "$service" >/dev/null 2>&1; then
        DET_INIT="systemd"
        parse_exec "$(systemctl show -p ExecStart --value "$service" 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -n 1)"
        DET_WORKDIR="$(systemctl show -p WorkingDirectory --value "$service" 2>/dev/null)"
        case "$DET_WORKDIR" in /*) ;; *) DET_WORKDIR="/" ;; esac
        return 0
    fi

    pid="$(find_pid sing-box)"
    if [ -n "$pid" ]; then
        DET_START="$(proc_cmdline "$pid")"
        DET_WORKDIR="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
        [ -n "$DET_WORKDIR" ] || DET_WORKDIR="/"
        parse_exec "$DET_START"
        # 命令里是相对路径或只有程序名时，换成实际的程序文件
        case "$DET_BIN" in
            /*) ;;
            *)
                exe="$(readlink "/proc/$pid/exe" 2>/dev/null)"
                if [ -n "$exe" ]; then
                    # 重启命令里同样换成绝对路径，不依赖 PATH
                    DET_START="$exe${DET_START#"${DET_START%% *}"}"
                    DET_BIN="$exe"
                fi
                ;;
        esac
    fi

    if has_openrc && [ -x "/etc/init.d/$service" ]; then
        DET_INIT="openrc"
        if [ -z "$DET_ARGS" ]; then
            # 服务未运行：从 OpenRC 服务定义中读取 command / command_args
            oc_cmd="$(sed -n 's/^[[:space:]]*command=["'\'']\{0,1\}\([^"'\'' ]*\).*/\1/p' "/etc/init.d/$service" | head -n 1)"
            oc_args="$(cat "/etc/conf.d/$service" "/etc/init.d/$service" 2>/dev/null | sed -n 's/^[[:space:]]*command_args=["'\'']\{0,1\}\([^"'\'']*\).*/\1/p' | head -n 1)"
            [ -n "$oc_cmd" ] && parse_exec "$oc_cmd $oc_args"
        fi
        return 0
    fi

    [ -n "$DET_START" ] && DET_INIT="process"
    return 0
}

# 在启动参数涉及的配置文件中找到含 route 段的那一个
find_route_file() {
    candidates=""
    set -- $1
    while [ $# -ge 2 ]; do
        case "$1" in
            -c|--config) candidates="$candidates $2" ;;
            -C|--config-directory) for f in "$2"/*.json; do [ -f "$f" ] && candidates="$candidates $f"; done ;;
        esac
        shift 2
    done
    found=""
    count=0
    first=""
    for f in $candidates; do
        [ -n "$first" ] || first="$f"
        if { jq -e 'has("route")' "$f" || "$DET_BIN" format -c "$f" 2>/dev/null | jq -e 'has("route")'; } >/dev/null 2>&1; then
            found="$f"
            count=$((count + 1))
        fi
    done
    if [ "$count" -eq 1 ]; then
        printf '%s' "$found"
    elif [ "$count" -eq 0 ] && [ "$(printf '%s\n' $candidates | grep -c .)" -eq 1 ]; then
        printf '%s' "$first"
    fi
}

install_jq() {
    command -v jq >/dev/null 2>&1 && return 0
    log "安装 jq..."
    if command -v apk >/dev/null 2>&1; then
        apk add -q jq >/dev/null 2>&1
    elif command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq jq >/dev/null 2>&1
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q jq >/dev/null 2>&1
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q jq >/dev/null 2>&1
    fi
    command -v jq >/dev/null 2>&1 || die "需要 jq，请先手动安装（apk add jq / apt install jq / yum install jq）"
}

# 安装同步进程：systemd 服务 / OpenRC 服务 / crontab 每分钟检查并后台启动
install_agent_service() {
    if has_systemd; then
        cat > "$UNIT_FILE" <<EOF
[Unit]
Description=CF-Server-Monitor sing-box route sync
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$BIN_FILE daemon
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable "$UNIT_NAME" >/dev/null 2>&1
        systemctl restart "$UNIT_NAME" || die "启动 $UNIT_NAME 服务失败"
        AGENT_MODE="systemd"
        log "已安装 systemd 服务 $UNIT_NAME"
        return 0
    fi

    if has_openrc; then
        cat > "$OPENRC_FILE" <<EOF
#!/sbin/openrc-run
description="CF-Server-Monitor sing-box route sync"
command="$BIN_FILE"
command_args="daemon"
command_background=true
pidfile="/run/$UNIT_NAME.pid"

depend() {
    after net
}
EOF
        chmod 755 "$OPENRC_FILE"
        rc-update add "$UNIT_NAME" default >/dev/null 2>&1
        if rc-service "$UNIT_NAME" restart >/dev/null 2>&1; then
            AGENT_MODE="openrc"
            log "已安装 OpenRC 服务 $UNIT_NAME（开机自启）"
            return 0
        fi
        log "[WARN] OpenRC 服务启动失败，改用 crontab 方式"
        rc-update del "$UNIT_NAME" default >/dev/null 2>&1
        rm -f "$OPENRC_FILE"
    fi

    command -v crontab >/dev/null 2>&1 || die "没有 systemd / OpenRC 时需要 crontab"
    { crontab -l 2>/dev/null | grep -v "$CRON_TAG"; printf '* * * * * "%s" ensure >/dev/null 2>&1 %s\n' "$BIN_FILE" "$CRON_TAG"; } | crontab - || die "写入 crontab 失败"
    AGENT_MODE="cron"
    "$BIN_FILE" ensure
    log "已在后台启动同步进程，并添加每分钟检查一次的 crontab（重启后自动拉起）"
    pgrep crond >/dev/null 2>&1 || pgrep cron >/dev/null 2>&1 || log "[WARN] 未检测到 crond 在运行，重启服务器后同步进程不会自动启动；Alpine 可执行 crond 并把它加入开机启动"
}

cmd_install() {
    url=""; id=""; sb_config=""; service="sing-box"; interval="10"; restart_cmd=""
    for arg in "$@"; do
        case "$arg" in
            --url=*) url="${arg#*=}" ;;
            --id=*) id="${arg#*=}" ;;
            --config=*) sb_config="${arg#*=}" ;;
            --service=*) service="${arg#*=}" ;;
            --interval=*) interval="${arg#*=}" ;;
            --restart-cmd=*) restart_cmd="${arg#*=}" ;;
        esac
    done
    secret="${CFSM_RELAY_SECRET:-}"

    [ "$(id -u)" = "0" ] || die "需要 root 权限（要改写 sing-box 配置并重启服务）"
    url="${url%/}"
    printf '%s' "$url" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || die "--url 只能是 https:// 开头的面板根地址，例如 https://board.example.com"
    printf '%s' "$id" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || die "--id 无效"
    printf '%s' "$secret" | grep -Eq '^[0-9a-fA-F]{32,128}$' || die "请通过环境变量 CFSM_RELAY_SECRET 提供该服务器的上报密钥"
    printf '%s' "$service" | grep -Eq '^[A-Za-z0-9@._-]{1,64}$' || die "--service 无效"
    printf '%s' "$interval" | grep -Eq '^[0-9]{1,3}$' && [ "$interval" -ge 5 ] && [ "$interval" -le 300 ] || die "--interval 应为 5-300 秒"
    [ "$(printf '%s' "$restart_cmd" | tr -d '\r\n')" = "$restart_cmd" ] || die "--restart-cmd 不能包含换行"
    command -v curl >/dev/null 2>&1 || die "需要 curl"
    install_jq

    # 重装时先停掉旧的同步进程，并等待正在进行的应用结束（避免在 sing-box 重启途中识别）
    if [ -f "$CONFIG_FILE" ]; then
        has_systemd && systemctl stop "$UNIT_NAME" >/dev/null 2>&1
        [ -f "$OPENRC_FILE" ] && rc-service "$UNIT_NAME" stop >/dev/null 2>&1
        stop_daemon
        i=0
        while [ -d "$LOCK_DIR" ] && [ "$i" -lt 60 ]; do sleep 1; i=$((i + 1)); done
    fi

    detect_singbox "$service"
    sb_bin="${DET_BIN:-$(command -v sing-box || true)}"
    [ -n "$sb_bin" ] && [ -x "$sb_bin" ] || die "找不到 sing-box 程序。请确认 sing-box 正在运行，或用 --service= 指定服务名"
    check_args="$DET_ARGS"
    if [ -z "$sb_config" ]; then
        if [ -n "$check_args" ]; then
            sb_config="$(cd "$DET_WORKDIR" 2>/dev/null; find_route_file "$check_args")"
            [ -n "$sb_config" ] || die "无法确定哪个配置文件包含 route 段，请用 --config=文件路径 指定"
        else
            sb_config="/etc/sing-box/config.json"
        fi
    fi
    # 相对路径按 sing-box 的工作目录解析
    case "$sb_config" in /*) ;; *) sb_config="${DET_WORKDIR%/}/$sb_config" ;; esac
    [ -f "$sb_config" ] || die "找不到配置文件 $sb_config，请用 --config=文件路径 指定"
    [ -n "$check_args" ] || check_args="-c $sb_config"
    if [ -z "$DET_INIT" ] && [ -z "$restart_cmd" ]; then
        die "sing-box 没有在运行，也没有找到 systemd / OpenRC 服务，无法确定如何重启它。请先启动 sing-box，或用 --restart-cmd='重启命令' 指定"
    fi
    printf '%s' "$check_args $sb_config $sb_bin $DET_START $DET_WORKDIR" | grep -Eq '^[A-Za-z0-9 _./=@:+,-]+$' || die "sing-box 的启动参数或路径中含有不支持的字符，请用 --restart-cmd= 指定重启命令"

    mkdir -p "$CONFIG_DIR" "$STATE_DIR" || die "无法创建目录"
    chmod 700 "$CONFIG_DIR" "$STATE_DIR"

    curl -fsSL -m 60 "$url/singbox-agent.sh" -o "$BIN_FILE.tmp" || die "下载脚本失败：$url/singbox-agent.sh"
    head -n 1 "$BIN_FILE.tmp" | grep -q '^#!/bin/sh' || { rm -f "$BIN_FILE.tmp"; die "下载内容不是脚本"; }
    mkdir -p "$(dirname "$BIN_FILE")"
    mv "$BIN_FILE.tmp" "$BIN_FILE"
    chmod 700 "$BIN_FILE"

    rm -f "$STATE_DIR/reported_sum" "$STATE_DIR/reported_at"

    write_config() {
        {
            printf 'URL=%s\n' "$url"
            printf 'ID=%s\n' "$id"
            printf 'SECRET=%s\n' "$secret"
            printf 'SINGBOX=%s\n' "$sb_bin"
            printf 'SB_CONFIG=%s\n' "$sb_config"
            printf 'CHECK_ARGS=%s\n' "$check_args"
            printf 'SERVICE=%s\n' "$service"
            printf 'INIT=%s\n' "${DET_INIT:-custom}"
            printf 'START_CMD=%s\n' "$DET_START"
            printf 'WORKDIR=%s\n' "$DET_WORKDIR"
            printf 'RESTART_CMD=%s\n' "$restart_cmd"
            printf 'INTERVAL=%s\n' "$interval"
            printf 'AGENT_MODE=%s\n' "${AGENT_MODE:-}"
        } > "$CONFIG_FILE.tmp"
        # 原子替换：已在运行的同步进程不会读到写了一半的配置
        chmod 600 "$CONFIG_FILE.tmp"
        mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    }
    AGENT_MODE=""
    write_config

    log "sing-box：$sb_bin（$("$sb_bin" version 2>/dev/null | head -n 1 | sed 's/^sing-box version //')）"
    log "配置文件：$sb_config   检查参数：$check_args"
    case "${DET_INIT:-custom}" in
        systemd) log "重启方式：systemctl restart $service" ;;
        openrc) log "重启方式：rc-service $service restart" ;;
        process) log "重启方式：结束进程后按原命令重新启动（$DET_START）" ;;
    esac
    [ -n "$restart_cmd" ] && log "重启方式：$restart_cmd"

    install_agent_service
    write_config
    log "每 ${interval} 秒轮询一次面板；日志：$LOG_FILE"
}

cmd_status() {
    load_config
    printf '面板：%s\n服务器 ID：%s\nsing-box：%s（%s）\n配置文件：%s\n检查参数：%s\n重启方式：%s\n轮询间隔：%s 秒\n' \
        "$PANEL_URL" "$SERVER_ID" "$SB_BIN" "$(singbox_version)" "$SB_CONFIG" "$CHECK_ARGS" "${RESTART_CMD:-$INIT}" "$INTERVAL"
    printf '已应用版本：%s\n' "$(state_get applied_rev)"
    failed="$(state_get failed_rev)"
    [ -n "$failed" ] && printf '应用失败的版本：%s\n' "$failed"
    printf 'sing-box 进程：%s\n' "$(singbox_pid || true)"
    case "$AGENT_MODE" in
        systemd) printf '同步进程：%s\n' "$(systemctl is-active "$UNIT_NAME" 2>/dev/null)" ;;
        openrc) printf '同步进程：%s\n' "$(rc-service "$UNIT_NAME" status 2>/dev/null | tail -n 1)" ;;
        *) if daemon_running; then printf '同步进程：运行中（PID %s）\n' "$(cat "$DAEMON_PID")"; else printf '同步进程：未运行\n'; fi ;;
    esac
    [ -f "$LOG_FILE" ] && { printf '\n最近日志：\n'; tail -n 10 "$LOG_FILE"; }
}

restart_agent() {
    case "$AGENT_MODE" in
        systemd) systemctl restart "$UNIT_NAME" ;;
        openrc) rc-service "$UNIT_NAME" restart >/dev/null 2>&1 ;;
        *) stop_daemon; "$BIN_FILE" ensure ;;
    esac
}

cmd_update() {
    load_config
    curl -fsSL -m 60 "$PANEL_URL/singbox-agent.sh" -o "$BIN_FILE.tmp" || die "下载失败：$PANEL_URL/singbox-agent.sh"
    head -n 1 "$BIN_FILE.tmp" | grep -q '^#!/bin/sh' || { rm -f "$BIN_FILE.tmp"; die "下载内容不是脚本"; }
    mv "$BIN_FILE.tmp" "$BIN_FILE"
    chmod 700 "$BIN_FILE"
    log "已更新：$BIN_FILE"
    restart_agent
}

cmd_uninstall() {
    if has_systemd && [ -f "$UNIT_FILE" ]; then
        systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
        rm -f "$UNIT_FILE"
        systemctl daemon-reload
    fi
    if [ -f "$OPENRC_FILE" ]; then
        rc-service "$UNIT_NAME" stop >/dev/null 2>&1 || true
        rc-update del "$UNIT_NAME" default >/dev/null 2>&1 || true
        rm -f "$OPENRC_FILE"
    fi
    if command -v crontab >/dev/null 2>&1; then
        crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab - 2>/dev/null || true
    fi
    stop_daemon
    rm -f "$BIN_FILE"
    rm -rf "$CONFIG_DIR" "$STATE_DIR"
    printf '已卸载 cfsm-singbox（sing-box 配置未改动）\n'
}

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    daemon) cmd_daemon ;;
    ensure) cmd_ensure ;;
    sync) cmd_sync ;;
    status) cmd_status ;;
    update) cmd_update ;;
    uninstall) cmd_uninstall ;;
    *)
        printf '用法：%s install|sync|status|update|uninstall\n' "$0"
        exit 1
        ;;
esac
