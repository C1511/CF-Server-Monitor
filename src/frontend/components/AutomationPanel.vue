<template>
  <div v-if="hasAny" class="automation-panel">
    <div v-if="aliyun?.enabled" class="automation-card">
      <div class="automation-head">
        <span class="automation-title"><span class="prompt-sign">#</span> {{ trans.aliyunCdt }}</span>
        <span v-if="aliyun.ready && aliyun.ecs" class="automation-badge" :class="ecsBadgeClass">{{ ecsStatusText }}</span>
        <span v-if="aliyun.paused" class="automation-badge badge-muted">{{ trans.keepalivePaused }}</span>
      </div>

      <template v-if="aliyun.ready">
        <div class="automation-usage">
          <span class="automation-usage-main">{{ formatGB(aliyun.cdt.used_gb) }}</span>
          <span class="automation-usage-sub">/ {{ aliyun.cdt.threshold_gb }} GB</span>
          <span class="automation-usage-pct" :style="{ color: usageColor }">{{ aliyun.cdt.percent }}%</span>
        </div>
        <div class="automation-bar" role="progressbar" :aria-valuenow="aliyun.cdt.percent" aria-valuemin="0" aria-valuemax="100">
          <div class="automation-bar-fill" :style="{ width: Math.min(aliyun.cdt.percent, 100) + '%', background: usageColor }"></div>
        </div>
        <div class="automation-meta">
          <span>{{ trans.cdtMainland }} {{ formatGB(aliyun.cdt.mainland_gb) }}</span>
          <span v-if="aliyun.ecs?.cpu">{{ trans.ecsSpec }} {{ aliyun.ecs.cpu }}C/{{ formatMemory(aliyun.ecs.memory_mb) }}</span>
          <span>{{ trans.lastCheck }} {{ formatShortTime(aliyun.checked_at) }}</span>
          <span v-if="aliyun.last_action">{{ trans.lastAction }} {{ aliyun.last_action.type === 'start' ? trans.actionStart : trans.actionStop }} {{ formatShortTime(aliyun.last_action.at) }}</span>
        </div>
        <div v-if="aliyun.billing" class="automation-billing">
          <span>{{ trans.monthSpend }} <b>{{ formatMoney(aliyun.billing.month_pretax_amount, aliyun.billing.currency) }}</b></span>
          <span>{{ trans.accountBalance }} <b>{{ formatMoney(aliyun.billing.available_amount, aliyun.billing.currency) }}</b></span>
        </div>
        <div class="automation-hint">{{ trans.cdtResetHint }}</div>
      </template>
      <div v-else class="automation-hint">{{ trans.waitingFirstCheck }}</div>
    </div>

    <div v-if="signin?.enabled" class="automation-card">
      <div class="automation-head">
        <span class="automation-title"><span class="prompt-sign">#</span> {{ trans.nodeseekSignin }}</span>
        <span class="automation-badge" :class="signinBadgeClass">{{ signinStatusText }}</span>
      </div>

      <div class="automation-stats">
        <div>
          <div class="automation-stat-value">{{ signin.today.gain ?? '-' }}</div>
          <div class="automation-stat-label">{{ trans.signinToday }}{{ trans.signinGain }}</div>
        </div>
        <div>
          <div class="automation-stat-value">{{ signin.streak }}</div>
          <div class="automation-stat-label">{{ trans.signinStreak }}({{ trans.signinDays }})</div>
        </div>
        <div>
          <div class="automation-stat-value">{{ signin.month_gain }}</div>
          <div class="automation-stat-label">{{ trans.signinMonthGain }}</div>
        </div>
        <div v-if="signin.today.current != null">
          <div class="automation-stat-value">{{ signin.today.current }}</div>
          <div class="automation-stat-label">{{ trans.signinCurrent }}</div>
        </div>
      </div>

      <div class="automation-days" :aria-label="trans.signinLast14">
        <span
          v-for="day in signin.history"
          :key="day.date"
          class="automation-day"
          :class="'day-' + day.status"
          :title="day.date + (day.gain != null ? ' +' + day.gain : '')"
        ></span>
      </div>
      <div class="automation-meta">
        <span>{{ trans.signinLast14 }}</span>
        <span>{{ trans.signinSchedule }} {{ signin.schedule }}</span>
      </div>
      <div v-if="signin.failure_kind === 'cookie_invalid' || signin.login_invalid" class="automation-hint automation-warn">{{ trans.signinCookieInvalid }}</div>
      <div v-else-if="signin.failure_kind === 'blocked'" class="automation-hint automation-warn">{{ trans.signinBlocked }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useTranslation } from '../utils/i18n.js'
import { useAutomation } from '../composables/useAutomation.js'

const trans = useTranslation()
const { automation } = useAutomation()
const aliyun = computed(() => automation.value?.aliyun || null)
const signin = computed(() => automation.value?.signin || null)

const hasAny = computed(() => Boolean(aliyun.value?.enabled || signin.value?.enabled))

const usageColor = computed(() => {
  const pct = Number(aliyun.value?.cdt?.percent) || 0
  if (pct >= 90) return 'var(--accent-red)'
  if (pct >= 70) return 'var(--accent-yellow)'
  return 'var(--accent-green)'
})

const ecsStatus = computed(() => aliyun.value?.ecs?.status || 'Unknown')
const ecsStatusText = computed(() => trans.value['ecs' + ecsStatus.value] || ecsStatus.value)
const ecsBadgeClass = computed(() => ({
  Running: 'badge-ok',
  Stopped: 'badge-bad',
  Starting: 'badge-warn',
  Stopping: 'badge-warn',
  Pending: 'badge-warn'
}[ecsStatus.value] || 'badge-muted'))

const signinStatus = computed(() => signin.value?.today?.status || 'none')
const signinStatusText = computed(() => {
  const key = 'signin' + signinStatus.value.charAt(0).toUpperCase() + signinStatus.value.slice(1)
  return trans.value[key] || signinStatus.value
})
const signinBadgeClass = computed(() => ({
  success: 'badge-ok',
  already: 'badge-ok',
  failed: 'badge-bad'
}[signinStatus.value] || 'badge-muted'))

const formatGB = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `${n >= 100 ? n.toFixed(1) : n.toFixed(2)} GB`
}

const formatMemory = (mb) => {
  const n = Number(mb)
  if (!Number.isFinite(n) || n <= 0) return '-'
  return n >= 1024 ? `${Math.round((n / 1024) * 10) / 10}G` : `${n}M`
}

const formatMoney = (value, currency = 'CNY') => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  const symbol = currency === 'CNY' ? '¥' : `${currency} `
  return symbol + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const formatShortTime = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (v) => String(v).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

</script>

<style scoped>
.automation-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.automation-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 14px 16px;
  min-width: 0;
}

.automation-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.automation-title {
  color: var(--text-primary);
  font-weight: 600;
  margin-right: auto;
}

.automation-badge {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 3px;
  border: 1px solid currentColor;
}

.badge-ok { color: var(--accent-green); }
.badge-bad { color: var(--accent-red); }
.badge-warn { color: var(--accent-yellow); }
.badge-muted { color: var(--text-muted); }

.automation-usage {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}

.automation-usage-main {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.automation-usage-sub {
  color: var(--text-secondary);
}

.automation-usage-pct {
  margin-left: auto;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.automation-bar {
  height: 6px;
  background: var(--bg-secondary);
  border-radius: 3px;
  overflow: hidden;
}

.automation-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.automation-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.automation-billing {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color);
  font-size: 13px;
  color: var(--text-secondary);
}

.automation-billing b {
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.automation-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.automation-warn {
  color: var(--accent-red);
}

.automation-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
  text-align: center;
}

.automation-stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.automation-stat-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.automation-days {
  display: grid;
  grid-template-columns: repeat(14, 1fr);
  gap: 4px;
}

.automation-day {
  height: 14px;
  border-radius: 2px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}

.automation-day.day-success,
.automation-day.day-already {
  background: var(--accent-green);
  border-color: var(--accent-green);
}

.automation-day.day-failed {
  background: var(--accent-red);
  border-color: var(--accent-red);
}
</style>
