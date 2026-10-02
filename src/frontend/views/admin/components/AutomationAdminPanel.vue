<template>
  <div id="tab-automation" class="tab-content" :class="{ active: activeTab === 'automation' }">
    <!-- 阿里云保活 -->
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.aliyunKeepalive }}</div>

      <div v-if="aliyunLoaded && !aliyun?.enabled" class="warning-box">{{ trans.notConfiguredAliyun }}</div>

      <template v-if="aliyun?.enabled">
        <div class="automation-actions">
          <button class="btn" :disabled="aliyunBusy" @click="aliyunAction('aliyun_refresh')">🔄 {{ trans.refreshData }}</button>
          <button class="btn btn-primary" :disabled="aliyunBusy" @click="runKeepalive">▶ {{ trans.keepaliveRunNow }}</button>
          <button class="btn" :disabled="aliyunBusy" @click="aliyunAction('aliyun_pause', { paused: !aliyunState?.paused })">
            {{ aliyunState?.paused ? '⏵ ' + trans.keepaliveResume : '⏸ ' + trans.keepalivePause }}
          </button>
        </div>

        <div v-if="aliyunState?.error" class="danger-box mb-2">{{ trans.errorLabel }}：{{ aliyunState.error }}</div>

        <div class="automation-kv">
          <div><span>{{ trans.keepaliveRule }}</span><b>{{ trans.keepaliveRuleDesc }}</b></div>
          <div><span>{{ trans.aliyunKeepalive }}</span><b :class="aliyunState?.paused ? 'text-yellow' : 'text-green'">{{ aliyunState?.paused ? trans.keepalivePaused : trans.keepaliveActive }}</b></div>
          <div><span>{{ trans.ecsInstance }}</span><b>{{ aliyun.config.instance_id }} ({{ aliyun.config.region_id }})</b></div>
          <div><span>{{ trans.cdtThreshold }}</span><b>{{ aliyun.config.threshold_gb }} GB</b></div>
          <div><span>{{ trans.checkInterval }}</span><b>{{ aliyun.config.interval_minutes }} min</b></div>
          <div><span>AccessKey ID</span><b>{{ aliyun.config.access_key_id }}</b></div>
          <div><span>{{ trans.lastCheck }}</span><b>{{ formatDateTime(aliyunState?.checked_at) }}</b></div>
          <div><span>{{ trans.lastDecision }}</span><b>{{ aliyunState?.last_decision?.reason || '-' }}</b></div>
        </div>

        <div class="automation-subtitle">{{ trans.thresholdSetting }}</div>
        <div class="threshold-editor">
          <input
            v-model="thresholdInput"
            type="number"
            min="1"
            max="100000"
            step="1"
            class="form-input threshold-input"
            :aria-label="trans.thresholdSetting"
            @keyup.enter="saveThreshold"
          />
          <span class="text-muted">GB</span>
          <button class="btn btn-primary" :disabled="aliyunBusy || !thresholdChanged" @click="saveThreshold">{{ trans.thresholdSave }}</button>
          <button class="btn" :disabled="aliyunBusy || aliyun.config.threshold_source !== 'custom'" @click="resetThreshold">{{ trans.thresholdReset }}</button>
          <span class="text-muted text-sm">{{ thresholdSourceText }}</span>
        </div>
        <p class="text-muted text-sm threshold-hint">{{ trans.thresholdApplyHint }}</p>
        <p v-if="Number(thresholdInput) > 180" class="text-sm threshold-hint text-yellow">⚠ {{ trans.thresholdQuotaHint }}</p>

        <template v-if="aliyunState?.cdt">
          <div class="automation-subtitle">CDT</div>
          <div class="automation-kv">
            <div><span>{{ trans.cdtNonMainland }}</span><b>{{ aliyunState.cdt.non_mainland_gb }} GB ({{ aliyunState.cdt.percent }}%)</b></div>
            <div><span>{{ trans.cdtMainland }}</span><b>{{ aliyunState.cdt.mainland_gb }} GB</b></div>
          </div>
          <table v-if="aliyunState.cdt.regions?.length" class="automation-table">
            <thead><tr><th>{{ trans.cdtByRegion }}</th><th>GB</th><th></th></tr></thead>
            <tbody>
              <tr v-for="r in aliyunState.cdt.regions" :key="r.region">
                <td>{{ r.region || '-' }}</td>
                <td>{{ r.gb }}</td>
                <td class="text-muted">{{ r.non_mainland ? trans.cdtNonMainland : trans.cdtMainland }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-if="aliyunState?.ecs">
          <div class="automation-subtitle">ECS</div>
          <div class="automation-kv">
            <div><span>{{ trans.ecsStatus }}</span><b>{{ trans['ecs' + aliyunState.ecs.status] || aliyunState.ecs.status }}</b></div>
            <div><span>{{ trans.ecsInstance }}</span><b>{{ aliyunState.ecs.name || '-' }}</b></div>
            <div><span>{{ trans.ecsSpec }}</span><b>{{ aliyunState.ecs.instance_type }} · {{ aliyunState.ecs.cpu }}C / {{ aliyunState.ecs.memory_mb }}MB</b></div>
            <div><span>Zone</span><b>{{ aliyunState.ecs.zone || '-' }}</b></div>
            <div><span>{{ trans.ecsPublicIp }}</span><b>{{ aliyunState.ecs.public_ip || '-' }}</b></div>
            <div><span>{{ trans.ecsChargeType }}</span><b>{{ aliyunState.ecs.instance_charge_type }} / {{ aliyunState.ecs.internet_charge_type }} · {{ aliyunState.ecs.bandwidth_out_mbps }} Mbps</b></div>
            <div><span>OS</span><b>{{ aliyunState.ecs.os || '-' }}</b></div>
            <div v-if="aliyunState.ecs.expired_time"><span>Expire</span><b>{{ aliyunState.ecs.expired_time }}</b></div>
          </div>
        </template>

        <div class="automation-subtitle">{{ trans.aliyunBilling }}</div>
        <div v-if="aliyunState?.billing_error" class="danger-box mb-2">{{ trans.errorLabel }}：{{ aliyunState.billing_error }}</div>
        <template v-if="billing">
          <div class="billing-tiles">
            <div class="billing-tile">
              <div class="billing-value">{{ money(billing.available_amount) }}</div>
              <div class="billing-label">{{ trans.accountBalance }}</div>
            </div>
            <div class="billing-tile">
              <div class="billing-value">{{ money(billing.month_pretax_amount) }}</div>
              <div class="billing-label">{{ trans.monthSpend }} · {{ billing.billing_cycle }}</div>
            </div>
            <div class="billing-tile">
              <div class="billing-value">{{ money(billing.available_cash_amount) }}</div>
              <div class="billing-label">{{ trans.cashBalance }}</div>
            </div>
            <div v-if="billing.month_outstanding_amount" class="billing-tile">
              <div class="billing-value text-red">{{ money(billing.month_outstanding_amount) }}</div>
              <div class="billing-label">{{ trans.outstandingAmount }}</div>
            </div>
          </div>
          <table v-if="billing.products?.length" class="automation-table">
            <thead>
              <tr>
                <th>{{ trans.billByProduct }}</th>
                <th class="num">{{ trans.monthSpend }}</th>
                <th class="num">{{ trans.monthGross }}</th>
                <th class="num">{{ trans.couponDeduction }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in billing.products" :key="p.name">
                <td>{{ p.name }}</td>
                <td class="num">{{ money(p.pretax_amount) }}</td>
                <td class="num text-muted">{{ money(p.gross_amount) }}</td>
                <td class="num text-muted">{{ p.coupon_amount ? money(p.coupon_amount) : '-' }}</td>
              </tr>
            </tbody>
          </table>
          <p class="text-muted text-sm">{{ trans.billingUpdated }} {{ formatDateTime(billing.checked_at) }} · {{ trans.billingHint }}</p>
        </template>
        <p v-else-if="!aliyunState?.billing_error" class="text-muted text-sm">{{ trans.billingHint }}</p>

        <div class="automation-subtitle">{{ trans.eventLog }}</div>
        <table v-if="aliyunState?.events?.length" class="automation-table">
          <tbody>
            <tr v-for="(e, i) in aliyunState.events" :key="i">
              <td class="nowrap">{{ formatDateTime(e.at) }}</td>
              <td class="nowrap" :class="eventClass(e.type)">{{ e.type }}</td>
              <td class="nowrap text-muted">{{ e.trigger }}</td>
              <td>{{ e.message }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="text-muted">{{ trans.noEvents }}</p>
      </template>
    </div>

    <!-- NodeSeek 签到 -->
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.nodeseekSignin }}</div>

      <div v-if="signinLoaded && !signin?.enabled" class="warning-box">{{ trans.notConfiguredSignin }}</div>

      <template v-if="signin?.enabled">
        <div v-if="!relayActive" class="automation-actions">
          <button class="btn" :disabled="signinBusy" @click="signinAction('signin_check')">🔍 {{ trans.signinCheck }}</button>
          <button class="btn btn-primary" :disabled="signinBusy" @click="signinAction('signin_run')">✔ {{ trans.signinRunNow }}</button>
        </div>
        <p v-else class="text-sm relay-manual"><code>{{ trans.signinRelayManual }}</code></p>

        <div v-if="signin.error" class="danger-box mb-2">
          <div v-if="signin.failure_kind === 'cookie_invalid'"><b>{{ trans.signinCookieInvalid }}</b></div>
          <div v-else-if="signin.failure_kind === 'blocked'"><b>{{ trans.signinBlocked }}</b></div>
          <div class="text-sm">{{ trans.errorLabel }}：{{ signin.error }}</div>
        </div>

        <div class="automation-kv">
          <div><span>{{ trans.signinToday }}</span><b>{{ signinStatusText(signin.today.status) }}{{ signin.detail?.message ? ' · ' + signin.detail.message : '' }}</b></div>
          <div><span>{{ trans.signinGain }}</span><b>{{ signin.today.gain ?? '-' }}</b></div>
          <div><span>{{ trans.signinCurrent }}</span><b>{{ signin.today.current ?? '-' }}</b></div>
          <div><span>{{ trans.signinStreak }}</span><b>{{ signin.streak }} {{ trans.signinDays }}</b></div>
          <div><span>{{ trans.signinMonthGain }}</span><b>{{ signin.month_gain }}</b></div>
          <div><span>{{ trans.signinSchedule }}</span><b>{{ signin.config.schedule }}</b></div>
          <div><span>{{ trans.signinRandom }}</span><b>{{ signin.config.random ? trans.yes : trans.no }}</b></div>
          <div><span>{{ trans.signinAttempts }}</span><b>{{ signin.attempts?.count ?? 0 }}</b></div>
          <div><span>{{ trans.lastCheck }}</span><b>{{ formatDateTime(signin.last_checked_at) }}</b></div>
        </div>

        <table v-if="signin.history_30?.length" class="automation-table">
          <tbody>
            <tr v-for="h in signin.history_30" :key="h.date">
              <td class="nowrap">{{ h.date }}</td>
              <td :class="eventClass(h.status)">{{ signinStatusText(h.status) }}</td>
              <td>{{ h.gain != null ? '+' + h.gain : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="signinLoaded && signin?.config">
        <div class="automation-subtitle">{{ trans.signinRelayTitle }}</div>
        <p class="text-muted text-sm relay-desc">{{ trans.signinRelayDesc }}</p>
        <div class="threshold-editor">
          <select v-model="relaySelect" class="form-input relay-select" :aria-label="trans.signinRelayTitle">
            <option value="">{{ trans.signinRelayNone }}</option>
            <option v-for="s in relayServers" :key="s.id" :value="s.id">{{ s.name || s.id }}</option>
          </select>
          <button class="btn btn-primary" :disabled="signinBusy || relaySelect === (signin.config.relay_server_id || '')" @click="saveRelay">{{ trans.signinRelaySave }}</button>
        </div>
        <template v-if="relayActive">
          <div class="automation-kv relay-status">
            <div><span>{{ trans.signinRelaySeen }}</span><b>{{ signin.relay_seen_at ? formatDateTime(signin.relay_seen_at) : trans.signinRelayNever }}</b></div>
            <div><span>{{ trans.signinRelayReported }}</span><b>{{ signin.relay_reported_at ? formatDateTime(signin.relay_reported_at) : trans.signinRelayNever }}</b></div>
          </div>
          <p class="text-sm relay-install-label">{{ trans.signinRelayInstall }}</p>
          <div class="relay-command">
            <code>{{ relayCommand || '…' }}</code>
            <button class="btn" :disabled="!relayCommand" @click="copyRelayCommand">{{ relayCopied ? trans.copied : trans.copyCommand }}</button>
          </div>
          <p class="text-muted text-sm">{{ trans.signinRelayInstallHint }}</p>
        </template>

        <div class="automation-subtitle">{{ trans.signinCookieTitle }}</div>
        <div v-if="signin.config.stored_cookie_unreadable" class="warning-box mb-2">{{ trans.signinCookieUnreadable }}</div>
        <div class="automation-kv mb-2">
          <div>
            <span>{{ trans.signinCookieSource }}</span>
            <b>{{ cookieSourceText }}<template v-if="signin.config.cookie_source === 'admin' && signin.config.cookie_updated_at"> · {{ formatDateTime(signin.config.cookie_updated_at) }}</template></b>
          </div>
        </div>
        <textarea
          v-model="cookieInput"
          class="form-input cookie-input"
          rows="3"
          autocomplete="off"
          spellcheck="false"
          data-lpignore="true"
          data-1p-ignore="true"
          :placeholder="trans.signinCookiePlaceholder"
          :aria-label="trans.signinCookieTitle"
        ></textarea>
        <div class="automation-actions cookie-actions">
          <button class="btn btn-primary" :disabled="signinBusy || !cookieInput.trim()" @click="saveCookie">{{ trans.signinCookieSave }}</button>
          <button class="btn" :disabled="signinBusy || signin.config.cookie_source !== 'admin'" @click="clearCookie">{{ trans.signinCookieClear }}</button>
          <span v-if="cookieSaved" class="text-green text-sm">✓ {{ trans.signinCookieSaved }}</span>
        </div>
        <p class="text-muted text-sm">{{ trans.signinCookieHint }}</p>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { adminApi } from '../../../utils/api'
import { formatDateTime } from '../../../utils/time.js'
import { copyTextToClipboard } from '../../../utils/clipboard.js'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: 'automation' },
  selectedApiIndex: { type: Number, default: 0 }
})

const emit = defineEmits(['alert-message'])

const aliyun = ref(null)
const aliyunLoaded = ref(false)
const aliyunBusy = ref(false)
const signin = ref(null)
const signinLoaded = ref(false)
const signinBusy = ref(false)

const aliyunState = computed(() => aliyun.value?.state || null)
const billing = computed(() => aliyunState.value?.billing || null)

const thresholdInput = ref('')
const thresholdChanged = computed(() => {
  const n = Number(thresholdInput.value)
  return thresholdInput.value !== '' && Number.isFinite(n) && n !== Number(aliyun.value?.config?.threshold_gb)
})
const thresholdSourceText = computed(() => {
  const source = aliyun.value?.config?.threshold_source
  if (source === 'custom') return props.trans.thresholdSourceCustom
  if (source === 'env') return props.trans.thresholdSourceEnv
  return props.trans.thresholdSourceDefault
})

// 服务端数据更新后同步输入框
watch(() => aliyun.value?.config?.threshold_gb, (value) => {
  if (value != null) thresholdInput.value = String(value)
})

const money = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  const symbol = (billing.value?.currency || 'CNY') === 'CNY' ? '¥' : (billing.value?.currency + ' ')
  return symbol + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const signinStatusText = (status) => {
  const key = 'signin' + String(status || 'none').charAt(0).toUpperCase() + String(status || 'none').slice(1)
  return props.trans[key] || status
}

const eventClass = (type) => ({
  start: 'text-green',
  success: 'text-green',
  already: 'text-green',
  resume: 'text-green',
  stop: 'text-yellow',
  warn: 'text-yellow',
  pause: 'text-yellow',
  config: 'text-cyan',
  error: 'text-red',
  failed: 'text-red'
}[type] || '')

const call = async (data) => {
  const result = await adminApi(data, props.selectedApiIndex)
  if (result.error) {
    emit('alert-message', props.trans[result.error] || result.error)
    return null
  }
  return result.data
}

const aliyunAction = async (action, extra = {}) => {
  aliyunBusy.value = true
  try {
    const data = await call({ action, ...extra })
    if (data) aliyun.value = data
  } finally {
    aliyunBusy.value = false
    aliyunLoaded.value = true
  }
}

const runKeepalive = () => {
  if (window.confirm(props.trans.keepaliveRunConfirm)) {
    aliyunAction('aliyun_run')
  }
}

// ---- 签到代发服务器 ----
const relayServers = ref([])
const relaySelect = ref('')
const relayCopied = ref(false)
const relayActive = computed(() => Boolean(signin.value?.config?.relay_server_id))

watch(() => signin.value?.config?.relay_server_id, (value) => {
  relaySelect.value = value || ''
})

// 安装命令：密钥通过环境变量传给 sh，不出现在 install 的参数中
const relayCommand = computed(() => {
  const id = signin.value?.config?.relay_server_id
  const server = relayServers.value.find(s => s.id === id)
  if (!server?.agent_secret) return ''
  const origin = window.location.origin
  const time = signin.value?.schedule || '08:37'
  return `curl -fsSL ${origin}/ns-relay.sh | CFSM_RELAY_SECRET='${server.agent_secret}' sh -s -- install --url=${origin} --id=${id} --time=${time}`
})

const loadRelayServers = async () => {
  const data = await call({ action: 'list' })
  if (data?.servers) relayServers.value = data.servers
}

const saveRelay = () => {
  signinAction('signin_set_relay', { server_id: relaySelect.value || null })
}

const copyRelayCommand = async () => {
  if (await copyTextToClipboard(relayCommand.value)) {
    relayCopied.value = true
    setTimeout(() => { relayCopied.value = false }, 2000)
  }
}

const cookieInput = ref('')
const cookieSaved = ref(false)

const cookieSourceText = computed(() => {
  const source = signin.value?.config?.cookie_source
  if (source === 'admin') return props.trans.cookieSourceAdmin
  if (source === 'env') return props.trans.cookieSourceEnv
  return props.trans.cookieSourceNone
})

const saveCookie = async () => {
  // 允许直接粘贴带 "Cookie:" 前缀的整行
  const value = cookieInput.value.trim().replace(/^cookie:\s*/i, '')
  if (!value) return
  cookieSaved.value = false
  if (await signinAction('signin_set_cookie', { cookie: value })) {
    cookieInput.value = ''
    cookieSaved.value = true
  }
}

const clearCookie = () => {
  cookieSaved.value = false
  signinAction('signin_set_cookie', { cookie: '' })
}

const saveThreshold = () => {
  if (!thresholdChanged.value) return
  aliyunAction('aliyun_set_threshold', { threshold_gb: Number(thresholdInput.value) })
}

const resetThreshold = () => {
  aliyunAction('aliyun_set_threshold', { threshold_gb: null })
}

const signinAction = async (action, extra = {}) => {
  signinBusy.value = true
  try {
    const data = await call({ action, ...extra })
    if (data) signin.value = data
    return Boolean(data)
  } finally {
    signinBusy.value = false
    signinLoaded.value = true
  }
}

watch(() => props.activeTab, (tab) => {
  if (tab === 'automation') {
    aliyunAction('aliyun_status')
    signinAction('signin_status')
    loadRelayServers()
  }
}, { immediate: true })
</script>

<style scoped>
.automation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
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
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 13px;
}

.automation-table th,
.automation-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-color);
}

.automation-table th {
  color: var(--text-secondary);
  font-weight: 500;
}

.relay-desc {
  margin: 0 0 8px;
}

.relay-select {
  min-width: 220px;
  max-width: 100%;
}

.relay-status {
  margin-top: 10px;
}

.relay-install-label {
  margin: 10px 0 4px;
  color: var(--text-secondary);
}

.relay-command {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.relay-command code,
.relay-manual code {
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

.relay-manual {
  margin: 0 0 12px;
}

.relay-manual code {
  display: inline-block;
}

.cookie-input {
  width: 100%;
  min-height: 72px;
  font-family: inherit;
  font-size: 12px;
  resize: vertical;
}

.cookie-actions {
  margin-top: 8px;
  align-items: center;
}

.threshold-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.threshold-input {
  width: 120px;
}

.threshold-hint {
  margin: 6px 0 0;
}

.billing-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  margin-bottom: 4px;
}

.billing-tile {
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 10px 12px;
}

.billing-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.billing-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.automation-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.nowrap { white-space: nowrap; }
.text-cyan { color: var(--accent-cyan); }
.text-green { color: var(--accent-green); }
.text-yellow { color: var(--accent-yellow); }
.text-red { color: var(--accent-red); }
</style>
