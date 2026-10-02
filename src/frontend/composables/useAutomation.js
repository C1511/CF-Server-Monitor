import { onMounted, onUnmounted, ref } from 'vue'
import { fetchAutomation } from '../utils/api.js'

// 自动任务摘要（阿里云保活 / NodeSeek 签到）在多个组件间共享，只保留一个定时刷新
const REFRESH_MS = 60_000

const automation = ref(null)
let timer = null
let subscribers = 0

const load = async () => {
  try {
    automation.value = await fetchAutomation()
  } catch (_) {
    // 附加信息，加载失败时保持上一次的数据
  }
}

export function useAutomation() {
  onMounted(() => {
    subscribers += 1
    if (subscribers === 1) {
      load()
      timer = setInterval(load, REFRESH_MS)
    }
  })

  onUnmounted(() => {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })

  return { automation, reload: load }
}
