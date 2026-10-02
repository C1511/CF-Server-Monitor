#!/bin/sh
# CF-Server-Monitor NodeSeek 签到代发脚本
#
# NodeSeek 已关闭 IPv6 访问，而 Cloudflare Workers 只能以 IPv6 发出请求，
# 因此由一台有 IPv4 的服务器在签到时间向面板领取任务、发起签到，并把原始响应回传给面板。
# Cookie 保存在面板后台（加密），本脚本每次运行时临时领取，不落盘。
#
# 安装（以普通用户运行即可，无需 root）：
#   curl -fsSL https://面板地址/ns-relay.sh | CFSM_RELAY_SECRET='该服务器的上报密钥' sh -s -- install --url=https://面板地址 --id=服务器ID --time=08:37
# 其他命令：
#   cfsm-ns-relay run [--force]   立即执行（--force 忽略签到时间，但不会重复签到）
#   cfsm-ns-relay check           只检查与面板的连接和今日任务，不签到
#   cfsm-ns-relay update          从面板更新本脚本
#   cfsm-ns-relay stats           只查询鸡腿余额与签到收益，不签到
#   cfsm-ns-relay uninstall       卸载

set -u
umask 077
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cfsm-ns-relay"
CONFIG_FILE="$CONFIG_DIR/config"
LOG_FILE="$CONFIG_DIR/relay.log"
LOCK_DIR="$CONFIG_DIR/run.lock"
BIN_DIR="$HOME/.local/bin"
BIN_FILE="$BIN_DIR/cfsm-ns-relay"
CRON_TAG="# cfsm-ns-relay"
NS_ORIGIN="${CFSM_NS_ORIGIN:-https://www.nodeseek.com}"
USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
MAX_ATTEMPTS=3
RETRY_SLEEP_SECONDS="${CFSM_RETRY_SLEEP:-600}"

log() {
    line="$(date '+%Y-%m-%d %H:%M:%S') $*"
    printf '%s\n' "$line"
    if [ -d "$CONFIG_DIR" ]; then
        printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
    fi
}

die() {
    log "[ERROR] $*"
    exit 1
}

trim_log() {
    if [ -f "$LOG_FILE" ]; then
        tail -n 200 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
}

# curl 配置文件格式的双引号字符串转义
curl_quote() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# 从 key=value 文本中取值
field() {
    printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -n 1
}

load_config() {
    [ -f "$CONFIG_FILE" ] || die "未安装：找不到 $CONFIG_FILE"
    RELAY_URL="$(sed -n 's/^URL=//p' "$CONFIG_FILE")"
    RELAY_ID="$(sed -n 's/^ID=//p' "$CONFIG_FILE")"
    RELAY_SECRET="$(sed -n 's/^SECRET=//p' "$CONFIG_FILE")"
    [ -n "$RELAY_URL" ] && [ -n "$RELAY_ID" ] && [ -n "$RELAY_SECRET" ] || die "配置不完整：$CONFIG_FILE"
}

# 向面板发请求；鉴权头通过 stdin 传给 curl，不出现在进程参数中
# 用法：panel_request <path> [body_file]
panel_request() {
    path="$1"
    body_file="${2:-}"
    {
        printf 'url = "%s%s"\n' "$RELAY_URL" "$path"
        printf 'header = "X-Relay-Id: %s"\n' "$RELAY_ID"
        printf 'header = "X-Relay-Secret: %s"\n' "$RELAY_SECRET"
        if [ -n "${RELAY_STATUS:-}" ]; then
            printf 'header = "X-Relay-Status: %s"\n' "$RELAY_STATUS"
        fi
        if [ -n "${RELAY_LOCATION:-}" ]; then
            printf 'header = "X-Relay-Location: %s"\n' "$RELAY_LOCATION"
        fi
        # 签到过程中 NodeSeek 刷新了凭证：把合并后的 Cookie 交回面板加密保存
        if [ -n "${RELAY_COOKIE:-}" ]; then
            printf 'header = "X-Relay-Cookie: %s"\n' "$(curl_quote "$RELAY_COOKIE")"
        fi
        printf 'header = "Content-Type: text/plain; charset=utf-8"\n'
        if [ -z "$body_file" ]; then
            printf 'data = ""\n'
        fi
    } | if [ -n "$body_file" ]; then
        # 请求体文件路径不含敏感信息，作为普通参数传入
        curl -sS -m 30 --connect-timeout 10 -K - --data-binary "@$body_file"
    else
        curl -sS -m 30 --connect-timeout 10 -K -
    fi
}

fetch_task() {
    query=""
    [ "${1:-}" = "force" ] && query="?force=1"
    [ "${1:-}" = "stats" ] && query="?stats=1"
    RELAY_STATUS="" panel_request "/relay/nodeseek/task$query"
}

# 查询鸡腿明细第一页并原样回传面板解析（余额、每日签到收益）
fetch_credit() {
    credit_cookie="$1"
    credit_file="$2"
    credit_code="$({
        printf 'url = "%s/api/account/credit/page-1"\n' "$NS_ORIGIN"
        printf 'header = "Cookie: %s"\n' "$(curl_quote "$credit_cookie")"
        printf 'header = "User-Agent: %s"\n' "$USER_AGENT"
        printf 'header = "Accept: application/json, text/plain, */*"\n'
        printf 'header = "Accept-Language: zh-CN,zh;q=0.9"\n'
        printf 'header = "Referer: %s/credit"\n' "$NS_ORIGIN"
    } | curl -4 -sS -m 30 --connect-timeout 10 -o "$credit_file" -w '%{http_code}' -K - 2>/dev/null)" || credit_code="000"
    credit_cookie=""
    head -c 262144 "$credit_file" > "$credit_file.report" 2>/dev/null
    credit_result="$(RELAY_STATUS="$credit_code" panel_request "/relay/nodeseek/credit" "$credit_file.report")" || {
        log "[WARN] 回传鸡腿明细失败"
        return 0
    }
    if [ "$(field ok "$credit_result")" = "1" ]; then
        log "鸡腿余额：$(field balance "$credit_result")  今日签到获得：$(field today_gain "$credit_result")"
    else
        log "[WARN] 鸡腿明细：$(field message "$credit_result")"
    fi
    rm -f "$credit_file.report"
}

signin_request() {
    cookie="$1"
    random="$2"
    body_file="$3"
    {
        printf 'url = "%s/api/attendance?random=%s"\n' "$NS_ORIGIN" "$random"
        printf 'header = "Cookie: %s"\n' "$(curl_quote "$cookie")"
        printf 'header = "User-Agent: %s"\n' "$USER_AGENT"
        printf 'header = "Accept: application/json, text/plain, */*"\n'
        printf 'header = "Accept-Language: zh-CN,zh;q=0.9"\n'
        printf 'header = "Origin: %s"\n' "$NS_ORIGIN"
        printf 'header = "Referer: %s/board"\n' "$NS_ORIGIN"
        # 与浏览器 fetch 一致：空请求体，不带表单 Content-Type
        printf 'header = "Content-Type:"\n'
        printf 'data = ""\n'
    } | curl -4 -sS -m 30 --connect-timeout 10 -D "$body_file.hdr" -o "$body_file" -w '%{http_code}' -K - 2>"$body_file.err"
}

# 响应头中的 Set-Cookie，输出 name=value（每行一个，跳过空值）
set_cookie_pairs() {
    sed -n 's/^[Ss][Ee][Tt]-[Cc][Oo][Oo][Kk][Ii][Ee]:[[:space:]]*//p' "$1" 2>/dev/null \
        | tr -d '\r' | cut -d';' -f1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -E '^[^=]+=.+' || true
}

# 用新 Cookie 覆盖同名旧值：merge_cookies "a=1; b=2" "b=3\nc=4" -> "a=1; b=3; c=4"
merge_cookies() {
    printf '%s\n' "$2" | awk -v old="$1" '
        BEGIN { n = split(old, parts, /;[[:space:]]*/); for (i = 1; i <= n; i++) { if (parts[i] == "") continue; k = parts[i]; sub(/=.*/, "", k); if (!(k in val)) order[++cnt] = k; val[k] = parts[i] } }
        NF { k = $0; sub(/=.*/, "", k); if (!(k in val)) order[++cnt] = k; val[k] = $0 }
        END { out = ""; for (i = 1; i <= cnt; i++) out = out (out == "" ? "" : "; ") val[order[i]]; print out }'
}

# 发起签到；NodeSeek 刷新登录凭证时会返回 303 + Set-Cookie 并跳回签到地址，
# 浏览器会带上新 Cookie 重新提交，这里同样处理（最多 2 次）。
# 结果写入 SIGNIN_CODE；凭证有更新时 SIGNIN_COOKIE 为合并后的 Cookie，否则为空
do_signin() {
    SIGNIN_COOKIE=""
    current="$1"
    hops=0
    while :; do
        SIGNIN_CODE="$(signin_request "$current" "$2" "$3")" || SIGNIN_CODE="000"
        case "$SIGNIN_CODE" in
            301|302|303|307|308) ;;
            *) break ;;
        esac
        case "$(redirect_location "$3.hdr")" in
            */api/attendance*|/api/attendance*) ;;
            *) break ;;
        esac
        fresh="$(set_cookie_pairs "$3.hdr")"
        [ -n "$fresh" ] || break
        hops=$((hops + 1))
        [ "$hops" -le 2 ] || break
        log "NodeSeek 刷新了登录凭证（$(printf '%s\n' "$fresh" | cut -d= -f1 | tr '\n' ' ')），带新 Cookie 重新提交"
        current="$(merge_cookies "$current" "$fresh")"
        SIGNIN_COOKIE="$current"
    done
    current=""
}

# 从响应头中取出跳转地址（去掉回车、引号，最长 300 字符）
redirect_location() {
    sed -n 's/^[Ll]ocation:[[:space:]]*//p' "$1" 2>/dev/null | tail -n 1 | tr -d '\r"\\' | cut -c1-300
}

cmd_run() {
    load_config
    mkdir "$LOCK_DIR" 2>/dev/null || die "已有任务在运行（如确认没有，可删除 $LOCK_DIR）"
    tmp_body="$(mktemp "${TMPDIR:-/tmp}/cfsm-ns.XXXXXX")" || { rmdir "$LOCK_DIR"; die "无法创建临时文件"; }
    trap 'rm -f "$tmp_body" "$tmp_body.err" "$tmp_body.report" "$tmp_body.hdr"; rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM

    mode="${1:-}"
    attempt=1
    while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
        task="$(fetch_task "$mode")" || die "无法连接面板 $RELAY_URL"
        if [ -n "$(field error "$task")" ]; then
            die "面板拒绝请求：$(field error "$task")（检查服务器 ID 与密钥，或后台是否已选择本机为代发服务器）"
        fi
        if [ "$(field due "$task")" != "true" ]; then
            log "无需签到：$(field reason "$task")"
            trim_log
            return 0
        fi

        cookie="$(field cookie "$task")"
        random="$(field random "$task")"
        [ "$random" = "false" ] || random="true"
        log "第 ${attempt} 次签到（IPv4）..."
        do_signin "$cookie" "$random" "$tmp_body"
        code="$SIGNIN_CODE"
        stats_cookie="${SIGNIN_COOKIE:-$cookie}"
        cookie=""
        RELAY_COOKIE="$SIGNIN_COOKIE"
        SIGNIN_COOKIE=""

        if [ "$code" = "000" ]; then
            head -c 300 "$tmp_body.err" > "$tmp_body.report" 2>/dev/null
            RELAY_STATUS="0"
        else
            head -c 65536 "$tmp_body" > "$tmp_body.report" 2>/dev/null
            RELAY_STATUS="$code"
            RELAY_LOCATION="$(redirect_location "$tmp_body.hdr")"
        fi
        result="$(panel_request "/relay/nodeseek/report" "$tmp_body.report")" || die "签到已发出，但回传结果到面板失败"
        RELAY_STATUS=""
        RELAY_LOCATION=""
        RELAY_COOKIE=""
        log "结果：$(field kind "$result") $(field message "$result")"

        if [ "$(field done "$result")" = "1" ]; then
            fetch_credit "$stats_cookie" "$tmp_body"
            stats_cookie=""
            trim_log
            return 0
        fi
        stats_cookie=""
        if [ "$(field retry "$result")" != "1" ]; then
            trim_log
            return 1
        fi
        attempt=$((attempt + 1))
        if [ "$attempt" -le "$MAX_ATTEMPTS" ]; then
            log "${RETRY_SLEEP_SECONDS} 秒后重试"
            sleep "$RETRY_SLEEP_SECONDS"
            mode=""
        fi
    done
    trim_log
    return 1
}

cmd_check() {
    load_config
    task="$(fetch_task)" || die "无法连接面板 $RELAY_URL"
    if [ -n "$(field error "$task")" ]; then
        die "面板拒绝请求：$(field error "$task")"
    fi
    log "面板连接正常。今日任务：due=$(field due "$task") $(field reason "$task")"
    ns_code="$(curl -4 -sS -o /dev/null -m 15 -A "$USER_AGENT" -w '%{http_code}' "$NS_ORIGIN/" 2>/dev/null || echo 000)"
    log "本机 IPv4 访问 NodeSeek 首页：HTTP $ns_code"

    # 不带 Cookie 调用签到接口：正常应返回 USER NOT FOUND（说明本机 IP 未被拦截）
    probe="$(mktemp "${TMPDIR:-/tmp}/cfsm-ns-probe.XXXXXX")" || return 0
    probe_code="$(curl -4 -sS -m 15 -X POST -A "$USER_AGENT" -H "Origin: $NS_ORIGIN" -H "Referer: $NS_ORIGIN/board" \
        -D "$probe.hdr" -o "$probe" -w '%{http_code}' "$NS_ORIGIN/api/attendance?random=true" 2>/dev/null || echo 000)"
    probe_location="$(redirect_location "$probe.hdr")"
    probe_body="$(head -c 160 "$probe" 2>/dev/null | tr '\r\n' '  ')"
    rm -f "$probe" "$probe.hdr"
    log "无 Cookie 探测签到接口：HTTP $probe_code${probe_location:+ 跳转到 $probe_location} $probe_body"
    case "$probe_body" in
        *"USER NOT FOUND"*) log "判断：本机 IP 可以访问签到接口，问题在 Cookie 或请求本身" ;;
        *) log "判断：本机 IP 可能被 NodeSeek 风控拦截" ;;
    esac
}

# 北京时间 HH:MM 转为本机时区的 crontab 分、时
local_cron_time() {
    bj_hour="${1%%:*}"
    bj_min="${1##*:}"
    offset="$(date +%z)"
    sign="$(printf '%s' "$offset" | cut -c1)"
    off_h="$(printf '%s' "$offset" | cut -c2-3 | sed 's/^0//')"
    off_m="$(printf '%s' "$offset" | cut -c4-5 | sed 's/^0//')"
    off_total=$(( ${off_h:-0} * 60 + ${off_m:-0} ))
    [ "$sign" = "-" ] && off_total=$(( -off_total ))
    bj_total=$(( $(printf '%s' "$bj_hour" | sed 's/^0//' | sed 's/^$/0/') * 60 + $(printf '%s' "$bj_min" | sed 's/^0//' | sed 's/^$/0/') ))
    total=$(( (bj_total - 480 + off_total + 1440 * 2) % 1440 ))
    printf '%s %s' "$((total % 60))" "$((total / 60))"
}

cmd_install() {
    url=""
    id=""
    time="08:37"
    for arg in "$@"; do
        case "$arg" in
            --url=*) url="${arg#*=}" ;;
            --id=*) id="${arg#*=}" ;;
            --time=*) time="${arg#*=}" ;;
        esac
    done
    secret="${CFSM_RELAY_SECRET:-}"

    url="${url%/}"
    case "$url" in
        https://*) ;;
        *) die "--url 必须是 https:// 开头的面板地址" ;;
    esac
    printf '%s' "$url" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || die "--url 只能是面板根地址，例如 https://board.example.com"
    printf '%s' "$id" | grep -Eq '^[A-Za-z0-9_-]{1,64}$' || die "--id 无效"
    printf '%s' "$secret" | grep -Eq '^[0-9a-fA-F]{32,128}$' || die "请通过环境变量 CFSM_RELAY_SECRET 提供该服务器的上报密钥"
    printf '%s' "$time" | grep -Eq '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' || die "--time 格式应为 HH:MM（北京时间）"
    command -v curl >/dev/null 2>&1 || die "需要 curl"
    command -v crontab >/dev/null 2>&1 || die "需要 crontab（cron 服务）"

    mkdir -p "$CONFIG_DIR" "$BIN_DIR" || die "无法创建目录"
    chmod 700 "$CONFIG_DIR"
    {
        printf 'URL=%s\n' "$url"
        printf 'ID=%s\n' "$id"
        printf 'SECRET=%s\n' "$secret"
    } > "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"

    curl -fsSL -m 60 "$url/ns-relay.sh" -o "$BIN_FILE.tmp" || die "下载脚本失败：$url/ns-relay.sh"
    mv "$BIN_FILE.tmp" "$BIN_FILE"
    chmod 700 "$BIN_FILE"

    set -- $(local_cron_time "$time")
    cron_line="$1 $2 * * * \"$BIN_FILE\" run >/dev/null 2>&1 $CRON_TAG"
    { crontab -l 2>/dev/null | grep -v "$CRON_TAG"; printf '%s\n' "$cron_line"; } | crontab - || die "写入 crontab 失败"

    log "已安装：每天北京时间 $time 执行（本机时间 $(printf '%02d:%02d' "$2" "$1")）"
    log "脚本：$BIN_FILE   配置：$CONFIG_FILE   日志：$LOG_FILE"
    RELAY_URL="$url" RELAY_ID="$id" RELAY_SECRET="$secret" cmd_check_inline
}

# 安装后立即检查一次（复用已解析的参数）
cmd_check_inline() {
    task="$(RELAY_STATUS="" panel_request "/relay/nodeseek/task")" || { log "[WARN] 暂时无法连接面板"; return 0; }
    if [ -n "$(field error "$task")" ]; then
        log "[WARN] 面板拒绝请求：$(field error "$task")（请确认后台已选择本机为代发服务器）"
    else
        log "面板连接正常。今日任务：due=$(field due "$task") $(field reason "$task")"
    fi
}

cmd_stats() {
    load_config
    task="$(fetch_task stats)" || die "无法连接面板 $RELAY_URL"
    if [ -n "$(field error "$task")" ]; then
        die "面板拒绝请求：$(field error "$task")"
    fi
    [ "$(field stats "$task")" = "true" ] || die "面板未下发查询任务：$(field reason "$task")"
    tmp_credit="$(mktemp "${TMPDIR:-/tmp}/cfsm-ns.XXXXXX")" || die "无法创建临时文件"
    trap 'rm -f "$tmp_credit" "$tmp_credit.report"' EXIT INT TERM
    fetch_credit "$(field cookie "$task")" "$tmp_credit"
    task=""
}

# 从面板下载最新版脚本覆盖本机副本（配置与 crontab 保持不变）
cmd_update() {
    load_config
    curl -fsSL -m 60 "$RELAY_URL/ns-relay.sh" -o "$BIN_FILE.tmp" || die "下载失败：$RELAY_URL/ns-relay.sh"
    head -n 1 "$BIN_FILE.tmp" | grep -q '^#!/bin/sh' || { rm -f "$BIN_FILE.tmp"; die "下载内容不是脚本"; }
    mv "$BIN_FILE.tmp" "$BIN_FILE"
    chmod 700 "$BIN_FILE"
    log "已更新：$BIN_FILE"
}

cmd_uninstall() {
    if command -v crontab >/dev/null 2>&1; then
        crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab - 2>/dev/null || true
    fi
    rm -f "$BIN_FILE"
    rm -rf "$CONFIG_DIR"
    printf '已卸载 cfsm-ns-relay\n'
}

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    run)
        shift
        if [ "${1:-}" = "--force" ]; then cmd_run force; else cmd_run; fi
        ;;
    check) cmd_check ;;
    update) cmd_update ;;
    stats) cmd_stats ;;
    uninstall) cmd_uninstall ;;
    *)
        printf '用法：%s install|run [--force]|check|stats|update|uninstall\n' "$0"
        exit 1
        ;;
esac
