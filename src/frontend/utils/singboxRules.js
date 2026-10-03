// sing-box route 规则与可视化编辑行之间的转换
// 可视化行只覆盖"一个匹配条件 + 一个动作"的常见规则，其余规则保留为 JSON 行原样编辑

export const GEOSITE_URL = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-'
export const GEOIP_URL = 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-'

// 列表型匹配条件（值按行或逗号分隔）
export const LIST_MATCH_TYPES = [
  'domain_suffix',
  'domain',
  'domain_keyword',
  'domain_regex',
  'geosite',
  'ip_cidr',
  'geoip',
  'source_ip_cidr',
  'port',
  'port_range',
  'inbound',
  'protocol',
  'network',
  'rule_set'
]
export const MATCH_TYPES = [...LIST_MATCH_TYPES, 'ip_is_private', 'any', 'json']
export const SPECIAL_ACTIONS = ['reject', 'hijack-dns', 'sniff']

const RULE_SET_NAME = /^[A-Za-z0-9!@._-]{1,64}$/
let rowSeq = 0

function nextId() {
  rowSeq += 1
  return `r${rowSeq}`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function jsonRow(rule) {
  return { id: nextId(), type: 'json', values: '', action: '', json: JSON.stringify(rule, null, 2) }
}

export function emptyRow(defaultOutbound = '') {
  return { id: nextId(), type: 'domain_suffix', values: '', action: defaultOutbound ? `out:${defaultOutbound}` : 'act:reject', json: '' }
}

// 单条规则 -> 编辑行；不能用可视化表示的规则返回 JSON 行
export function ruleToRow(rule) {
  if (!isPlainObject(rule)) return jsonRow(rule)
  let action
  if (rule.action === undefined || rule.action === 'route') {
    if (typeof rule.outbound !== 'string' || !rule.outbound) return jsonRow(rule)
    action = `out:${rule.outbound}`
  } else if (SPECIAL_ACTIONS.includes(rule.action) && rule.outbound === undefined) {
    action = `act:${rule.action}`
  } else {
    return jsonRow(rule)
  }

  const matchKeys = Object.keys(rule).filter(key => key !== 'action' && key !== 'outbound')
  if (matchKeys.length === 0) return withOriginal({ id: nextId(), type: 'any', values: '', action, json: '' }, rule)
  if (matchKeys.length !== 1) return jsonRow(rule)

  const key = matchKeys[0]
  const value = rule[key]
  if (key === 'ip_is_private') {
    return value === true ? withOriginal({ id: nextId(), type: key, values: '', action, json: '' }, rule) : jsonRow(rule)
  }
  if (!LIST_MATCH_TYPES.includes(key) || key === 'geosite' || key === 'geoip') return jsonRow(rule)
  const list = Array.isArray(value) ? value : [value]
  if (!list.length || !list.every(item => typeof item === 'string' || (key === 'port' && Number.isInteger(item)))) {
    return jsonRow(rule)
  }

  let type = key
  let items = list.map(String)
  if (key === 'rule_set') {
    for (const prefix of ['geosite', 'geoip']) {
      if (items.every(tag => tag.startsWith(`${prefix}-`) && tag.length > prefix.length + 1)) {
        type = prefix
        items = items.map(tag => tag.slice(prefix.length + 1))
        break
      }
    }
  }
  return withOriginal({ id: nextId(), type, values: items.join('\n'), action, json: '' }, rule)
}

const rowSignature = (row) => `${row.type}\u0000${row.values}\u0000${row.action}`

// 记住原始规则：未改动的行原样输出，不会因为写法不同（例如旧版省略 action）被视为修改
// 按行 id 存放，不挂在行对象上（行对象会被 Vue 包装成响应式代理）
const originals = new Map()

function withOriginal(row, rule) {
  originals.set(row.id, { rule: JSON.stringify(rule), signature: rowSignature(row) })
  return row
}

export function splitValues(text) {
  return String(text || '').split(/[\n,，]+/).map(item => item.trim()).filter(Boolean)
}

class RowError extends Error {
  constructor(index, code, detail = '') {
    super(code)
    this.index = index
    this.code = code
    this.detail = detail
  }
}

// 编辑行 -> 规则；出错时抛出 RowError（index 为行号，从 0 开始）
export function rowToRule(row, index = 0) {
  if (row.type === 'json') {
    let rule
    try {
      rule = JSON.parse(row.json)
    } catch (e) {
      throw new RowError(index, 'singboxRowInvalidJson', e.message)
    }
    if (!isPlainObject(rule)) throw new RowError(index, 'singboxRowInvalidJson')
    return rule
  }

  const original = originals.get(row.id)
  if (original && original.signature === rowSignature(row)) {
    return JSON.parse(original.rule)
  }

  const rule = {}
  if (row.type === 'ip_is_private') {
    rule.ip_is_private = true
  } else if (row.type !== 'any') {
    const values = splitValues(row.values)
    if (!values.length) throw new RowError(index, 'singboxRowEmpty')
    if (row.type === 'port') {
      const ports = values.map(Number)
      if (!ports.every(p => Number.isInteger(p) && p >= 1 && p <= 65535)) throw new RowError(index, 'singboxRowInvalidPort')
      rule.port = ports
    } else if (row.type === 'geosite' || row.type === 'geoip') {
      if (!values.every(v => RULE_SET_NAME.test(v))) throw new RowError(index, 'singboxRowInvalidName')
      rule.rule_set = values.map(v => `${row.type}-${v}`)
    } else {
      rule[row.type] = values
    }
  }

  const action = String(row.action || '')
  if (action.startsWith('out:') && action.length > 4) {
    rule.action = 'route'
    rule.outbound = action.slice(4)
  } else if (action.startsWith('act:') && SPECIAL_ACTIONS.includes(action.slice(4))) {
    rule.action = action.slice(4)
  } else {
    throw new RowError(index, 'singboxRowNoAction')
  }
  return rule
}

// 规则中用到的 geosite-* / geoip-* 若未在 rule_set 中定义，自动补上官方远程规则集
export function ensureRuleSets(route) {
  const defined = new Set((route.rule_set || []).map(set => set?.tag))
  const added = []
  const visit = (rule) => {
    if (!isPlainObject(rule)) return
    if (Array.isArray(rule.rules)) rule.rules.forEach(visit)
    const tags = Array.isArray(rule.rule_set) ? rule.rule_set : (typeof rule.rule_set === 'string' ? [rule.rule_set] : [])
    for (const tag of tags) {
      if (defined.has(tag)) continue
      let url = ''
      if (/^geosite-/.test(tag)) url = `${GEOSITE_URL}${tag.slice(8)}.srs`
      else if (/^geoip-/.test(tag)) url = `${GEOIP_URL}${tag.slice(6)}.srs`
      if (!url) continue
      defined.add(tag)
      added.push({ tag, type: 'remote', format: 'binary', url })
    }
  }
  ;(route.rules || []).forEach(visit)
  if (added.length) route.rule_set = [...(route.rule_set || []), ...added]
  return route
}

export function routeToEditor(route) {
  const source = isPlainObject(route) ? route : {}
  return {
    rows: (Array.isArray(source.rules) ? source.rules : []).map(ruleToRow),
    final: typeof source.final === 'string' ? source.final : ''
  }
}

// base 为原 route（保留 rules、final 以外的字段，例如 rule_set、default_domain_resolver）
export function editorToRoute(base, rows, final) {
  const route = { ...(isPlainObject(base) ? base : {}) }
  route.rules = rows.map((row, index) => rowToRule(row, index))
  if (final) route.final = final
  else delete route.final
  return ensureRuleSets(route)
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

// 与服务端一致：规则的 outbound、final、rule_set 的 download_detour
export function referencedOutbounds(route) {
  const tags = new Set()
  if (typeof route?.final === 'string' && route.final) tags.add(route.final)
  for (const rule of Array.isArray(route?.rules) ? route.rules : []) {
    if (isPlainObject(rule) && typeof rule.outbound === 'string' && rule.outbound) tags.add(rule.outbound)
  }
  for (const set of Array.isArray(route?.rule_set) ? route.rule_set : []) {
    if (isPlainObject(set) && typeof set.download_detour === 'string' && set.download_detour) tags.add(set.download_detour)
  }
  return [...tags]
}
