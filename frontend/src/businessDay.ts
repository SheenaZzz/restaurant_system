/**
 * 营业日口径（客户端侧）。
 *
 * ⚠️ 这里**不定义**营业日，只是照着服务端的规则算。
 *    唯一定义在 backend/app/services/period.py，分界值由 /api/catalog
 *    下发（business_day_cutoff_hour）。前端写死第二份常量的话，
 *    哪天把分界从 0 点调回 2 点，清单页和月报就各按各的口径切 ——
 *    而这两个数字能对上，正是这套系统唯一的交叉验证手段。
 *
 * 为什么用**设备本地时钟**而不是服务端时间：
 * 断网时没有服务端可问，而员工核对时看的是墙上的钟。
 * 前提是 iPad 的时区跟店里一致；在线时可以拿 catalog 下发的
 * business_date 核对有没有偏（见 businessDateDrift）。
 */

import type { Catalog } from './catalog'

/**
 * 缓存的 catalog 可能是加这个字段**之前**存的，那时没有这一项。
 * 用 ?? 显式兜底成 0，而不是让 undefined 一路传下去 ——
 * `d.getHours() < undefined` 恒为 false，会静默按 0 点处理；
 * 万一将来默认值不是 0，这个静默就变成错账。
 */
export function cutoffHourOf(cat: Catalog | null | undefined): number {
  const h = cat?.business_day_cutoff_hour
  return typeof h === 'number' && Number.isFinite(h) ? h : 0
}

/** 本地日期 → 'YYYY-MM-DD'。用本地字段拼，不能用 toISOString（那是 UTC）。 */
function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 某个时刻属于哪个营业日，返回 'YYYY-MM-DD'。
 *
 * 时间戳无效时返回空串而不是抛异常 —— 一条坏数据不该让整个
 * 账单列表白屏。空串永远不等于任何真实营业日，所以它会被归到
 * 「跨天未结」里被人看见，而不是消失。
 */
export function businessDateOf(iso: string, cutoffHour: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // 分界之前算前一天。setDate 会自动处理跨月/跨年。
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1)
  return ymd(d)
}

/** 此刻所属的营业日。 */
export function currentBusinessDate(cutoffHour: number): string {
  return businessDateOf(new Date().toISOString(), cutoffHour)
}

/**
 * 这台设备的时区和店里不一致时返回两边的偏移，一致（或无从比较）返回 null。
 *
 * 为什么不是"只在营业日算错时才报"：两个时区在一天里大部分时间会
 * 算出**相同**的营业日，只有靠近日界的那几个小时才分叉。等分叉了才提示，
 * 意味着每天都有几小时在静默归错日 —— 而那几小时恰好是晚市高峰。
 *
 * 不自动纠正：设备时钟是离线时唯一的时间来源，静默改掉它会让离线
 * 补发的单落到错误的时段。只报给人看，让人去 iPad 设置里改。
 *
 * ⚠️ JS 的 getTimezoneOffset() 符号是反的（UTC-7 返回 +420），
 *    所以这里取负号换成标准写法，和后端下发的对齐。
 */
export function clockDrift(
  cat: Catalog | null,
): { storeMinutes: number; deviceMinutes: number } | null {
  const store = cat?.store_utc_offset_minutes
  if (typeof store !== 'number' || !Number.isFinite(store)) return null
  const device = -new Date().getTimezoneOffset()
  return store === device ? null : { storeMinutes: store, deviceMinutes: device }
}

/** 偏移分钟数 → 'UTC-7' / 'UTC+5:30' */
export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}

/** 营业日加减天数，'YYYY-MM-DD' 进出。用于「保留最近 N 天」这类判断。 */
export function shiftBusinessDate(bdate: string, days: number): string {
  const [y, m, d] = bdate.split('-').map(Number)
  if (!y || !m || !d) return bdate
  const dt = new Date(y, m - 1, d + days)
  return ymd(dt)
}

/** 给人看的日期，例如「8月10日 周一」。 */
export function businessDateLabel(bdate: string): string {
  const [y, m, d] = bdate.split('-').map(Number)
  if (!y || !m || !d) return bdate
  // 用本地构造，不走 Date('YYYY-MM-DD')——那个按 UTC 解析，
  // 在 UTC-7 会显示成前一天。
  return new Date(y, m - 1, d).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}
