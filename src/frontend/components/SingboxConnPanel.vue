<template>
  <div v-if="view?.enabled" class="sbc-card">
    <div class="sbc-head">
      <button class="sbc-title" :aria-expanded="!collapsed" @click="toggleCollapsed">
        <span class="sbc-caret">{{ collapsed ? '▸' : '▾' }}</span>
        <span class="prompt-sign">#</span> {{ trans.sbcTitle }}
        <span class="sbc-server">· {{ view.server?.name }}</span>
      </button>
      <span class="sbc-badge" :class="view.recording ? 'badge-ok' : 'badge-muted'">{{ view.recording ? trans.sbcRecording : trans.sbcPaused }}</span>
      <span class="sbc-updated">{{ updatedText }}</span>
    </div>

    <template v-if="!collapsed">
      <div class="sbc-summary">
        <div class="sbc-stat">
          <div class="sbc-stat-value">{{ stats?.count ?? 0 }}</div>
          <div class="sbc-stat-label">{{ trans.sbcTodayConns }}</div>
        </div>
        <div class="sbc-stat">
          <div class="sbc-stat-value">{{ view.active?.length || 0 }}</div>
          <div class="sbc-stat-label">{{ trans.sbcActiveConns }}</div>
        </div>
        <div class="sbc-stat">
          <div class="sbc-stat-value sbc-traffic">↑{{ formatBytes(stats?.up) }} ↓{{ formatBytes(stats?.down) }}</div>
          <div class="sbc-stat-label">{{ trans.sbcTodayTraffic }}</div>
        </div>
      </div>

      <div v-if="stats?.outbounds?.length" class="sbc-outbounds">
        <button
          v-for="item in stats.outbounds"
          :key="item.tag"
          class="sbc-out-chip"
          :class="{ active: outFilter === item.tag }"
          :style="{ '--chip-color': outColor(item.tag) }"
          :title="trans.sbcFilterByOutbound"
          @click="outFilter = outFilter === item.tag ? '' : item.tag"
        >
          <span class="sbc-dot"></span>{{ item.tag }}
          <b>{{ item.count }}</b>
          <span class="sbc-share">{{ share(item.count) }}%</span>
        </button>
      </div>

      <div class="sbc-toolbar">
        <div class="sbc-tabs" role="tablist">
          <button role="tab" :aria-selected="tab === 'records'" :class="{ active: tab === 'records' }" @click="tab = 'records'">{{ trans.sbcTabRecords }} ({{ view.records?.length || 0 }})</button>
          <button role="tab" :aria-selected="tab === 'active'" :class="{ active: tab === 'active' }" @click="tab = 'active'">{{ trans.sbcTabActive }} ({{ view.active?.length || 0 }})</button>
          <button role="tab" :aria-selected="tab === 'hosts'" :class="{ active: tab === 'hosts' }" @click="tab = 'hosts'">{{ trans.sbcTabHosts }}</button>
        </div>
        <input v-model.trim="search" class="sbc-search" type="search" :placeholder="trans.sbcSearch" :aria-label="trans.sbcSearch" />
      </div>

      <template v-if="tab !== 'hosts'">
        <div v-if="filteredConns.length" class="sbc-table-wrap">
          <table class="sbc-table">
            <thead>
              <tr>
                <th>{{ trans.sbcTime }}</th>
                <th>{{ trans.sbcTarget }}</th>
                <th>{{ trans.sbcRule }}</th>
                <th>{{ trans.sbcOutbound }}</th>
                <th class="num">{{ trans.sbcTraffic }}</th>
                <th class="num">{{ trans.sbcDuration }}</th>
                <th>{{ trans.sbcSource }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in visibleConns" :key="i">
                <td class="nowrap" :title="fullTime(c)">{{ shortTime(tab === 'active' ? c.start : c.end) }}</td>
                <td class="sbc-target" :title="c.ip && c.ip !== c.host ? c.ip : ''">
                  {{ c.host || c.ip }}<span class="sbc-port">:{{ c.port }}</span>
                  <span v-if="c.net === 'udp'" class="sbc-net">UDP</span>
                </td>
                <td class="sbc-rule" :title="c.rule">{{ ruleText(c.rule) }}</td>
                <td class="nowrap">
                  <span class="sbc-out" :style="{ '--chip-color': outColor(c.out) }" :title="chainText(c)"><span class="sbc-dot"></span>{{ c.out || '-' }}</span>
                </td>
                <td class="num nowrap">↑{{ formatBytes(c.up) }} ↓{{ formatBytes(c.down) }}</td>
                <td class="num nowrap">{{ durationText(c) }}</td>
                <td class="sbc-src nowrap" :title="c.in">{{ inboundText(c.in) }} {{ c.src }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sbc-empty">{{ emptyText }}</p>
        <button v-if="filteredConns.length > limit" class="sbc-more" @click="limit += PAGE">{{ trans.sbcShowMore }} ({{ filteredConns.length - limit }})</button>
      </template>

      <template v-else>
        <div v-if="filteredHosts.length" class="sbc-table-wrap">
          <table class="sbc-table">
            <thead>
              <tr>
                <th>{{ trans.sbcTarget }}</th>
                <th class="num">{{ trans.sbcConns }}</th>
                <th>{{ trans.sbcOutbound }}</th>
                <th class="num">{{ trans.sbcTraffic }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in filteredHosts" :key="h.host">
                <td class="sbc-target">{{ h.host }}</td>
                <td class="num">{{ h.count }}</td>
                <td class="nowrap"><span class="sbc-out" :style="{ '--chip-color': outColor(h.out) }"><span class="sbc-dot"></span>{{ h.out || '-' }}</span></td>
                <td class="num nowrap">↑{{ formatBytes(h.up) }} ↓{{ formatBytes(h.down) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="sbc-empty">{{ emptyText }}</p>
      </template>

      <p class="sbc-hint">{{ trans.sbcHint }}</p>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTranslation } from '../utils/i18n.js'
import { fetchSingboxConnections, formatBytes } from '../utils/api.js'

const trans = useTranslation()

const PAGE = 50
const OPEN_POLL_MS = 5000
const CLOSED_POLL_MS = 60000
const COLLAPSE_KEY = 'cfsm_sbc_collapsed'
const PALETTE = ['#39d2c0', '#4da6ff', '#b392f0', '#ffb870', '#f778ba', '#00d4aa', '#f85149', '#e3b341']

const view = ref(null)
const tab = ref('records')
const search = ref('')
const outFilter = ref('')
const limit = ref(PAGE)
const now = ref(Date.now())
const collapsed = ref(false)
try {
  collapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1'
} catch (_) {
  // 无法访问本地存储时默认展开
}

const stats = computed(() => view.value?.stats || null)

const toggleCollapsed = () => {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0')
  } catch (_) {
    // 忽略
  }
  schedule(0)
}

// 出站颜色：direct 固定为绿色，其余按 tag 稳定取色
const outColor = (tag) => {
  if (!tag || tag === '-') return 'var(--text-muted)'
  if (tag === 'direct') return 'var(--accent-green)'
  let hash = 0
  for (const ch of tag) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

const share = (count) => {
  const total = stats.value?.count || 0
  return total ? Math.round((count / total) * 100) : 0
}

const pad = (n) => String(n).padStart(2, '0')
const shortTime = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const fullTime = (c) => `${new Date(c.start).toLocaleString()} → ${tab.value === 'active' ? trans.value.sbcStillOpen : new Date(c.end).toLocaleString()}`

const durationText = (c) => {
  const end = tab.value === 'active' ? now.value : c.end
  const sec = Math.max(0, Math.round((end - c.start) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${pad(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h${pad(Math.floor((sec % 3600) / 60))}m`
}

// "domain_suffix=netflix.com => route(warp)" 只显示匹配条件；"final" 表示没有命中任何规则
const ruleText = (rule) => {
  if (!rule || rule === 'final') return trans.value.sbcRuleFinal
  return rule.replace(/\s*=>.*$/, '')
}

// Clash API 的入站类型形如 "anytls/anytls-in"，只显示 tag
const inboundText = (value) => String(value || '').split('/').pop()
const chainText = (c) => (c.chain?.length > 1 ? [...c.chain].reverse().join(' → ') : c.out)

const matches = (c) => {
  if (outFilter.value && c.out !== outFilter.value) return false
  if (!search.value) return true
  const q = search.value.toLowerCase()
  return [c.host, c.ip, c.rule, c.out, c.src, c.in, c.port].some(v => String(v || '').toLowerCase().includes(q))
}

const filteredConns = computed(() => {
  const list = tab.value === 'active' ? view.value?.active : view.value?.records
  return (list || []).filter(matches)
})
const visibleConns = computed(() => filteredConns.value.slice(0, limit.value))

const filteredHosts = computed(() => (stats.value?.hosts || []).filter(h => {
  if (outFilter.value && h.out !== outFilter.value) return false
  return !search.value || h.host.toLowerCase().includes(search.value.toLowerCase())
}))

const emptyText = computed(() => {
  if (!view.value?.recording) return trans.value.sbcNotRecording
  if (search.value || outFilter.value) return trans.value.sbcNoMatch
  return view.value?.updated_at ? trans.value.sbcNoData : trans.value.sbcWaiting
})

const updatedText = computed(() => {
  const at = view.value?.updated_at
  if (!at) return ''
  const sec = Math.max(0, Math.round((now.value - at) / 1000))
  if (sec < 60) return `${trans.value.sbcUpdated} ${sec}s`
  if (sec < 3600) return `${trans.value.sbcUpdated} ${Math.floor(sec / 60)}m`
  return `${trans.value.sbcUpdated} ${shortTime(at)}`
})

watch([tab, search, outFilter], () => {
  limit.value = PAGE
})

// ---- 刷新：展开且页面可见时 5 秒一次；未登录（401）时停止 ----
let timer = null
let stopped = false
let clock = null

const load = async () => {
  const data = await fetchSingboxConnections()
  if (data === null) {
    // 未登录或接口不可用：不显示，也不再请求
    view.value = null
    stopped = true
    return
  }
  view.value = data
  if (!data.enabled) stopped = true
}

const schedule = (delay) => {
  clearTimeout(timer)
  if (stopped) return
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await load()
    schedule(collapsed.value ? CLOSED_POLL_MS : OPEN_POLL_MS)
  }, delay)
}

const onVisible = () => {
  if (document.visibilityState === 'visible') schedule(0)
}

onMounted(async () => {
  await load()
  schedule(collapsed.value ? CLOSED_POLL_MS : OPEN_POLL_MS)
  clock = setInterval(() => { now.value = Date.now() }, 1000)
  document.addEventListener('visibilitychange', onVisible)
})

onUnmounted(() => {
  clearTimeout(timer)
  clearInterval(clock)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<style scoped>
.sbc-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 14px 16px;
  margin-bottom: 20px;
  min-width: 0;
}

.sbc-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.sbc-title {
  margin-right: auto;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.sbc-caret {
  display: inline-block;
  width: 1em;
  color: var(--text-secondary);
}

.sbc-server {
  color: var(--text-secondary);
  font-weight: 400;
}

.sbc-badge {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 3px;
  border: 1px solid currentColor;
}

.badge-ok { color: var(--accent-green); }
.badge-muted { color: var(--text-muted); }

.sbc-updated {
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.sbc-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.sbc-stat {
  min-width: 0;
}

.sbc-stat-value {
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.sbc-stat-value.sbc-traffic {
  font-size: 15px;
  line-height: 1.8;
}

.sbc-stat-label {
  color: var(--text-secondary);
  font-size: 12px;
}

.sbc-outbounds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.sbc-out-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sbc-out-chip.active {
  border-color: var(--chip-color);
  box-shadow: inset 0 0 0 1px var(--chip-color);
}

.sbc-out-chip b {
  font-variant-numeric: tabular-nums;
}

.sbc-share {
  color: var(--text-secondary);
}

.sbc-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--chip-color);
  flex-shrink: 0;
}

.sbc-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 14px;
}

.sbc-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.sbc-tabs button {
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sbc-tabs button.active {
  border-color: var(--accent-cyan);
  color: var(--accent-cyan);
}

.sbc-search {
  flex: 0 1 240px;
  min-width: 0;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
}

.sbc-table-wrap {
  max-height: 460px;
  margin-top: 8px;
  overflow: auto;
}

.sbc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.sbc-table th,
.sbc-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-color);
  text-align: left;
  vertical-align: top;
}

.sbc-table th {
  position: sticky;
  top: 0;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-weight: 500;
  white-space: nowrap;
}

.sbc-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.sbc-target {
  color: var(--text-primary);
  overflow-wrap: anywhere;
  min-width: 140px;
}

.sbc-port {
  color: var(--text-secondary);
}

.sbc-net {
  margin-left: 4px;
  padding: 0 4px;
  border: 1px solid var(--border-color);
  border-radius: 2px;
  color: var(--text-secondary);
  font-size: 10px;
}

.sbc-rule {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
  max-width: 280px;
}

.sbc-out {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-primary);
}

.sbc-src {
  color: var(--text-secondary);
}

.nowrap {
  white-space: nowrap;
}

.sbc-empty,
.sbc-hint {
  margin: 10px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.sbc-more {
  margin-top: 8px;
  padding: 4px 12px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: none;
  color: var(--accent-cyan);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

/* 手机：每条连接显示为两行卡片，不出现横向滚动 */
@media (max-width: 640px) {
  .sbc-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .sbc-search {
    flex-basis: 100%;
  }

  .sbc-table thead {
    display: none;
  }

  .sbc-table,
  .sbc-table tbody {
    display: block;
  }

  .sbc-table tr {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border-color);
  }

  .sbc-table td {
    padding: 0;
    border: none;
  }

  .sbc-table td.sbc-target {
    flex-basis: 100%;
    order: -1;
  }

  .sbc-rule {
    max-width: none;
  }
}
</style>
