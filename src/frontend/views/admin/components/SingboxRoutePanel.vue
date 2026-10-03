<template>
  <div id="tab-singbox" class="tab-content" :class="{ active: activeTab === 'singbox' }">
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.singboxServerTitle }}</div>
      <p class="text-muted text-sm sb-desc">{{ trans.singboxDesc }}</p>
      <div class="sb-inline">
        <select v-model="serverSelect" class="form-input sb-select" :aria-label="trans.singboxServerTitle">
          <option value="">{{ trans.singboxServerNone }}</option>
          <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name || s.id }}</option>
        </select>
        <button class="btn btn-primary" :disabled="busy || serverSelect === (view?.config?.server_id || '')" @click="saveServer">{{ trans.singboxServerSave }}</button>
      </div>

      <template v-if="serverId">
        <div class="automation-kv sb-status">
          <div><span>{{ trans.singboxAgent }}</span><b :class="online ? 'text-green' : 'text-yellow'">{{ online ? trans.singboxOnline : trans.singboxOffline }}<template v-if="state.seen_at"> · {{ formatDateTime(state.seen_at) }}</template></b></div>
          <div><span>sing-box</span><b>{{ state.singbox_version || '-' }}</b></div>
          <div><span>{{ trans.singboxConfigPath }}</span><b>{{ state.config_path || '-' }}</b></div>
          <div><span>{{ trans.singboxInbounds }}</span><b>{{ tagList(state.inbounds) }}</b></div>
          <div><span>{{ trans.singboxOutbounds }}</span><b>{{ tagList(state.outbounds) }}</b></div>
          <div><span>{{ trans.singboxSyncState }}</span><b :class="syncClass">{{ syncText }}</b></div>
        </div>
        <div v-if="view?.sync === 'failed' && state.error" class="danger-box sb-gap">
          <b>{{ trans.singboxApplyFailed }}</b>
          <div class="text-sm sb-pre">{{ state.error }}</div>
        </div>
        <div v-if="view?.sync === 'drift'" class="warning-box sb-gap text-sm">{{ trans.singboxDriftHint }}</div>

        <details class="sb-install" :open="!state.seen_at">
          <summary>{{ trans.singboxInstall }}</summary>
          <div class="relay-command">
            <code>{{ installCommand || '…' }}</code>
            <button class="btn" :disabled="!installCommand" @click="copyInstall">{{ copied ? trans.copied : trans.copyCommand }}</button>
          </div>
          <p class="text-muted text-sm">{{ trans.singboxInstallHint }}</p>
        </details>
      </template>
    </div>

    <div v-if="serverId" class="settings-section sb-section">
      <div class="section-title"><span>▸</span> {{ trans.singboxRulesTitle }}</div>

      <div v-if="!editorReady" class="text-muted">{{ trans.singboxWaitingAgent }}</div>
      <template v-else>
        <div class="sb-toolbar">
          <div class="sb-modes">
            <button class="btn btn-sm" :class="{ 'btn-primary': mode === 'visual' }" @click="switchMode('visual')">{{ trans.singboxVisual }}</button>
            <button class="btn btn-sm" :class="{ 'btn-primary': mode === 'json' }" @click="switchMode('json')">JSON</button>
          </div>
          <div class="sb-modes">
            <button class="btn btn-sm" :disabled="!state.current_route" @click="loadFromServer">{{ trans.singboxLoadServer }}</button>
            <button class="btn btn-sm" :disabled="!dirty" @click="resetEditor">{{ trans.singboxDiscard }}</button>
          </div>
        </div>

        <template v-if="mode === 'visual'">
          <p class="text-muted text-sm sb-hint">{{ trans.singboxOrderHint }}</p>
          <div
            v-for="(row, index) in rows"
            :key="row.id"
            class="sb-rule"
            :class="{ 'sb-rule-error': rowError?.index === index }"
          >
            <span class="sb-index">{{ index + 1 }}</span>
            <select v-model="row.type" class="form-input sb-type" :aria-label="trans.singboxMatchType">
              <option v-for="type in MATCH_TYPES" :key="type" :value="type">{{ matchLabel(type) }}</option>
            </select>
            <textarea
              v-if="row.type === 'json'"
              v-model="row.json"
              class="form-input sb-values sb-json-row"
              rows="3"
              spellcheck="false"
            ></textarea>
            <textarea
              v-else-if="!['any', 'ip_is_private'].includes(row.type)"
              v-model="row.values"
              class="form-input sb-values"
              :rows="Math.min(6, Math.max(1, row.values.split('\n').length))"
              spellcheck="false"
              :placeholder="placeholderFor(row.type)"
            ></textarea>
            <span v-else class="sb-values text-muted text-sm">{{ matchHint(row.type) }}</span>
            <template v-if="row.type !== 'json'">
              <span class="sb-arrow">→</span>
              <select v-model="row.action" class="form-input sb-action" :aria-label="trans.singboxAction">
                <option v-for="tag in outboundOptions" :key="'out:' + tag" :value="'out:' + tag">{{ tag }}</option>
                <option value="act:reject">{{ trans.singboxActionReject }}</option>
                <option value="act:hijack-dns">{{ trans.singboxActionHijackDns }}</option>
                <option value="act:sniff">{{ trans.singboxActionSniff }}</option>
              </select>
            </template>
            <span class="sb-row-btns">
              <button class="btn btn-sm" :disabled="index === 0" :title="trans.singboxMoveUp" @click="moveRow(index, -1)">↑</button>
              <button class="btn btn-sm" :disabled="index === rows.length - 1" :title="trans.singboxMoveDown" @click="moveRow(index, 1)">↓</button>
              <button class="btn btn-sm btn-red" :title="trans.singboxRemove" @click="rows.splice(index, 1)">✕</button>
            </span>
          </div>
          <p v-if="!rows.length" class="text-muted text-sm">{{ trans.singboxNoRules }}</p>
          <button class="btn btn-sm sb-add" @click="rows.push(emptyRow(outboundOptions[0]))">＋ {{ trans.singboxAddRule }}</button>

          <div class="sb-inline sb-final">
            <span>{{ trans.singboxFinal }}</span>
            <select v-model="final" class="form-input sb-select">
              <option value="">{{ trans.singboxFinalDefault }}</option>
              <option v-for="tag in outboundOptions" :key="tag" :value="tag">{{ tag }}</option>
            </select>
          </div>
          <p class="text-muted text-sm">{{ trans.singboxOtherFieldsHint }}</p>
        </template>

        <template v-else>
          <p class="text-muted text-sm sb-hint">{{ trans.singboxJsonHint }}</p>
          <textarea v-model="jsonText" class="form-input sb-json" rows="22" spellcheck="false"></textarea>
        </template>

        <div v-if="editorError" class="danger-box sb-gap text-sm">{{ editorError }}</div>
        <div v-if="unknownOutbounds.length" class="warning-box sb-gap text-sm">{{ trans.singboxUnknownOutbound }}：{{ unknownOutbounds.join(', ') }}</div>

        <div class="automation-actions sb-save">
          <button class="btn btn-primary" :disabled="busy || !dirty" @click="saveRoute">{{ trans.singboxSave }}</button>
          <span v-if="view?.desired" class="text-muted text-sm">{{ trans.singboxPanelVersion }} {{ view.desired.rev }} · {{ formatDateTime(view.desired.updated_at) }}</span>
        </div>
      </template>

      <template v-if="state.events?.length">
        <div class="automation-subtitle">{{ trans.eventLog }}</div>
        <table class="automation-table sb-events">
          <tbody>
            <tr v-for="(e, i) in state.events" :key="i">
              <td class="nowrap">{{ formatDateTime(e.at) }}</td>
              <td class="nowrap" :class="eventClass(e.type)">{{ e.type }}</td>
              <td class="nowrap text-muted">{{ e.rev }}</td>
              <td class="sb-pre">{{ e.message === 'saved' ? trans.singboxEventSaved : e.message }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../utils/api'
import { formatDateTime } from '../../../utils/time.js'
import { copyTextToClipboard } from '../../../utils/clipboard.js'
import {
  MATCH_TYPES,
  canonicalJson,
  editorToRoute,
  emptyRow,
  referencedOutbounds,
  routeToEditor
} from '../../../utils/singboxRules.js'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: 'servers' },
  selectedApiIndex: { type: Number, default: 0 }
})

const emit = defineEmits(['alert-message'])

// 服务器"最后在线时间"最多每分钟更新一次
const ONLINE_WINDOW_MS = 3 * 60 * 1000
const PENDING_POLL_MS = 2000
const IDLE_POLL_MS = 20000
const PENDING_TIMEOUT_MS = 90 * 1000

const view = ref(null)
const busy = ref(false)
const servers = ref([])
const serverSelect = ref('')
const copied = ref(false)

const serverId = computed(() => view.value?.config?.server_id || '')
const state = computed(() => view.value?.state || {})
const online = computed(() => Boolean(state.value.seen_at) && Date.now() - state.value.seen_at < ONLINE_WINDOW_MS)

watch(serverId, (value) => {
  serverSelect.value = value
})

const tagList = (list) => (list?.length ? list.map(item => item.tag).join(', ') : '-')

const syncText = computed(() => {
  const key = {
    none: 'singboxSyncNone',
    pending: 'singboxSyncPending',
    applied: 'singboxSyncApplied',
    failed: 'singboxSyncFailed',
    drift: 'singboxSyncDrift'
  }[view.value?.sync || 'none']
  const rev = view.value?.sync === 'applied' ? ` · ${state.value.applied_rev}` : ''
  return props.trans[key] + rev
})

const syncClass = computed(() => ({
  applied: 'text-green',
  pending: 'text-cyan',
  failed: 'text-red',
  drift: 'text-yellow'
}[view.value?.sync] || 'text-muted'))

const eventClass = (type) => ({ success: 'text-green', error: 'text-red', config: 'text-cyan', sync: 'text-muted' }[type] || '')

const matchLabel = (type) => props.trans[`singboxMatch_${type}`] || type
const matchHint = (type) => props.trans[`singboxMatchHint_${type}`] || ''
const placeholderFor = (type) => {
  if (type === 'inbound' && state.value.inbounds?.length) return state.value.inbounds.map(i => i.tag).join('\n')
  return props.trans[`singboxPlaceholder_${type}`] || ''
}

// 安装命令：密钥通过环境变量传给 sh，不出现在 install 的参数中
const installCommand = computed(() => {
  const server = servers.value.find(s => s.id === serverId.value)
  if (!server?.agent_secret) return ''
  const origin = window.location.origin
  return `curl -fsSL ${origin}/singbox-agent.sh | CFSM_RELAY_SECRET='${server.agent_secret}' sh -s -- install --url=${origin} --id=${serverId.value}`
})

const copyInstall = async () => {
  if (await copyTextToClipboard(installCommand.value)) {
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
}

// ---- 编辑器 ----
const mode = ref('visual')
const rows = ref([])
const final = ref('')
const baseRoute = ref(null)
const jsonText = ref('')
const editorReady = ref(false)
const editorError = ref('')
const rowError = ref(null)

// 编辑器的参照：面板已保存的版本，没有时为服务器当前配置
const referenceRoute = computed(() => view.value?.desired?.route || state.value.current_route || null)

const outboundOptions = computed(() => {
  const tags = (state.value.outbounds || []).map(o => o.tag)
  // 规则里引用了但服务器未上报的 tag 也保留在下拉框里，避免切换时丢失
  const extra = []
  for (const row of rows.value) {
    if (row.action?.startsWith('out:')) extra.push(row.action.slice(4))
  }
  if (final.value) extra.push(final.value)
  return [...new Set([...tags, ...extra])]
})

const loadEditor = (route) => {
  const source = route && typeof route === 'object' ? route : {}
  baseRoute.value = JSON.parse(JSON.stringify(source))
  const editor = routeToEditor(source)
  rows.value = editor.rows
  final.value = editor.final
  jsonText.value = JSON.stringify(source, null, 2)
  editorError.value = ''
  rowError.value = null
  editorReady.value = true
}

// 生成当前编辑结果；出错时抛出带说明的错误
const buildRoute = () => {
  if (mode.value === 'json') {
    let route
    try {
      route = JSON.parse(jsonText.value)
    } catch (e) {
      throw Object.assign(new Error(`${props.trans.singboxInvalidJson}: ${e.message}`), { index: null })
    }
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw Object.assign(new Error(props.trans.singboxInvalidJson), { index: null })
    }
    return route
  }
  try {
    return editorToRoute(baseRoute.value, rows.value, final.value)
  } catch (e) {
    const message = `${props.trans.singboxRuleLabel} ${Number(e.index) + 1}：${props.trans[e.code] || e.code}${e.detail ? ` (${e.detail})` : ''}`
    throw Object.assign(new Error(message), { index: e.index })
  }
}

const preview = computed(() => {
  try {
    return { route: buildRoute(), error: null }
  } catch (e) {
    return { route: null, error: e }
  }
})

const dirty = computed(() => {
  if (!editorReady.value) return false
  if (!preview.value.route) return true
  return canonicalJson(preview.value.route) !== canonicalJson(referenceRoute.value || {})
})

const unknownOutbounds = computed(() => {
  const known = new Set((state.value.outbounds || []).map(o => o.tag))
  if (!known.size || !preview.value.route) return []
  return referencedOutbounds(preview.value.route).filter(tag => !known.has(tag))
})

watch(() => preview.value.error, () => {
  editorError.value = ''
  rowError.value = null
})

const switchMode = (next) => {
  if (next === mode.value) return
  if (next === 'json') {
    try {
      jsonText.value = JSON.stringify(buildRoute(), null, 2)
    } catch (e) {
      editorError.value = e.message
      rowError.value = e
      return
    }
    mode.value = 'json'
  } else {
    let route
    try {
      route = buildRoute()
    } catch (e) {
      editorError.value = e.message
      return
    }
    mode.value = 'visual'
    loadEditor(route)
  }
}

const resetEditor = () => {
  loadEditor(referenceRoute.value)
}

const loadFromServer = () => {
  if (dirty.value && !window.confirm(props.trans.singboxLoadServerConfirm)) return
  loadEditor(state.value.current_route)
}

const moveRow = (index, delta) => {
  const target = index + delta
  if (target < 0 || target >= rows.value.length) return
  const list = rows.value.slice()
  ;[list[index], list[target]] = [list[target], list[index]]
  rows.value = list
}

// ---- 请求 ----
const call = async (data) => {
  const result = await adminApi(data, props.selectedApiIndex)
  if (result.error) {
    const [code, ...rest] = String(result.error).split(': ')
    const text = props.trans[code] ? `${props.trans[code]}${rest.length ? `：${rest.join(': ')}` : ''}` : result.error
    emit('alert-message', text)
    return null
  }
  return result.data
}

const applyView = (data, { reloadEditor = false } = {}) => {
  const previousServer = serverId.value
  view.value = data
  if (!serverId.value) {
    editorReady.value = false
    return
  }
  // 编辑器只在首次拿到数据、切换服务器或保存成功后重新载入，避免覆盖正在编辑的内容
  // 服务器回传过（即使配置里还没有 route 段）或面板已有保存的版本时才能编辑
  const canEdit = Boolean(referenceRoute.value || state.value.reported_at)
  if (reloadEditor || previousServer !== serverId.value || (!editorReady.value && canEdit)) {
    if (canEdit) {
      mode.value = 'visual'
      loadEditor(referenceRoute.value)
    } else {
      editorReady.value = false
    }
  }
}

const refresh = async (options) => {
  const data = await call({ action: 'singbox_status' })
  if (data) applyView(data, options)
}

const loadServers = async () => {
  const data = await call({ action: 'list' })
  if (data?.servers) servers.value = data.servers
}

const saveServer = async () => {
  if (serverId.value && !window.confirm(props.trans.singboxServerChangeConfirm)) return
  busy.value = true
  try {
    const data = await call({ action: 'singbox_set_server', server_id: serverSelect.value || null })
    if (data) applyView(data, { reloadEditor: true })
  } finally {
    busy.value = false
  }
}

const saveRoute = async () => {
  let route
  try {
    route = buildRoute()
  } catch (e) {
    editorError.value = e.message
    rowError.value = e
    return
  }
  if (unknownOutbounds.value.length) {
    editorError.value = `${props.trans.singboxUnknownOutbound}：${unknownOutbounds.value.join(', ')}`
    return
  }
  busy.value = true
  try {
    const data = await call({ action: 'singbox_save_route', route })
    if (data) {
      applyView(data, { reloadEditor: true })
      pendingSince = Date.now()
      schedulePoll()
    }
  } finally {
    busy.value = false
  }
}

// ---- 自动刷新：等待服务器应用时 2 秒一次，其余时间 20 秒一次 ----
let pollTimer = null
let pendingSince = 0

const schedulePoll = () => {
  clearTimeout(pollTimer)
  if (props.activeTab !== 'singbox') return
  const waiting = view.value?.sync === 'pending' && Date.now() - pendingSince < PENDING_TIMEOUT_MS
  pollTimer = setTimeout(async () => {
    await refresh()
    schedulePoll()
  }, waiting ? PENDING_POLL_MS : IDLE_POLL_MS)
}

watch(() => props.activeTab, async (tab) => {
  if (tab === 'singbox') {
    await Promise.all([refresh(), loadServers()])
    schedulePoll()
  } else {
    clearTimeout(pollTimer)
  }
}, { immediate: true })

onUnmounted(() => clearTimeout(pollTimer))
</script>

<style scoped>
.sb-section {
  margin-top: 16px;
}

.sb-desc,
.sb-hint {
  margin: 0 0 10px;
}

.sb-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sb-select {
  width: auto;
  flex: 0 1 320px;
  min-width: 200px;
  max-width: 100%;
}

.sb-status {
  margin-top: 12px;
}

.sb-gap {
  margin-top: 10px;
}

.sb-pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.sb-install {
  margin-top: 12px;
}

.sb-install summary {
  cursor: pointer;
  color: var(--accent-cyan);
  user-select: none;
  margin-bottom: 6px;
}

.relay-command {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.relay-command code {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.sb-toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.sb-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.sb-rule {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
}

.sb-rule-error {
  border-color: var(--accent-red);
}

.sb-index {
  min-width: 22px;
  padding-top: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: right;
}

.sb-type {
  width: 150px;
}

.sb-values {
  flex: 1 1 220px;
  min-width: 0;
  font-family: monospace;
  font-size: 12px;
  resize: vertical;
}

span.sb-values {
  padding-top: 7px;
  font-family: inherit;
}

.sb-json-row {
  flex-basis: 100%;
  order: 10;
}

.sb-arrow {
  padding-top: 6px;
  color: var(--text-secondary);
}

.sb-action {
  width: 170px;
}

.sb-row-btns {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.sb-add {
  margin-top: 4px;
}

.sb-final {
  margin: 14px 0 6px;
}

.sb-json {
  width: 100%;
  font-family: monospace;
  font-size: 12px;
  resize: vertical;
}

.sb-save {
  margin-top: 14px;
  align-items: center;
}

.automation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.automation-subtitle {
  margin: 16px 0 8px;
  color: var(--accent-cyan);
  font-weight: 600;
}

.automation-kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 6px 16px;
}

.automation-kv > div {
  display: flex;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}

.automation-kv span {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.automation-kv b {
  color: var(--text-primary);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.automation-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.automation-table td {
  text-align: left;
  vertical-align: top;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-color);
}

.nowrap { white-space: nowrap; }
.text-cyan,
.automation-kv b.text-cyan { color: var(--accent-cyan); }
.text-green,
.automation-kv b.text-green { color: var(--accent-green); }
.text-yellow,
.automation-kv b.text-yellow { color: var(--accent-yellow); }
.text-red,
.automation-kv b.text-red { color: var(--accent-red); }

@media (max-width: 640px) {
  .sb-type,
  .sb-action {
    flex: 1 1 140px;
    width: auto;
  }

  .sb-arrow {
    display: none;
  }

  /* 事件记录：时间、类型、版本一行，消息单独一行 */
  .sb-events tr {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    padding: 5px 0;
    border-bottom: 1px solid var(--border-color);
  }

  .sb-events td {
    padding: 0;
    border: none;
  }

  .sb-events td:last-child {
    flex-basis: 100%;
  }
}
</style>
