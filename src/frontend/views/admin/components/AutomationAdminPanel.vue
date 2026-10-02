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
        <div class="automation-actions">
          <button class="btn" :disabled="signinBusy" @click="signinAction('signin_check')">🔍 {{ trans.signinCheck }}</button>
          <button class="btn btn-primary" :disabled="signinBusy" @click="signinAction('signin_run')">✔ {{ trans.signinRunNow }}</button>
        </div>

        <div v-if="signin.login_invalid" class="danger-box mb-2">{{ trans.signinCookieInvalid }}</div>
        <div v-else-if="signin.error" class="danger-box mb-2">{{ trans.errorLabel }}：{{ signin.error }}</div>

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
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { adminApi } from '../../../utils/api'
import { formatDateTime } from '../../../utils/time.js'

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
  error: 'text-red',
  failed: 'text-red'
}[type] || '')

const call = async (data) => {
  const result = await adminApi(data, props.selectedApiIndex)
  if (result.error) {
    emit('alert-message', result.error)
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

const signinAction = async (action) => {
  signinBusy.value = true
  try {
    const data = await call({ action })
    if (data) signin.value = data
  } finally {
    signinBusy.value = false
    signinLoaded.value = true
  }
}

watch(() => props.activeTab, (tab) => {
  if (tab === 'automation') {
    aliyunAction('aliyun_status')
    signinAction('signin_status')
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

.nowrap { white-space: nowrap; }
.text-green { color: var(--accent-green); }
.text-yellow { color: var(--accent-yellow); }
.text-red { color: var(--accent-red); }
</style>
