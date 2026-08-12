/**
 * The business day, client side.
 *
 * ⚠️ This does **not define** the business day, it only follows the server's
 *    rule. The definition lives in backend/app/services/period.py and the
 *    boundary is published by /api/catalog (business_day_cutoff_hour). A
 *    second constant hard-coded here means that the day someone moves the
 *    boundary back to 02:00, the check list and the month report split it
 *    differently -- and those two numbers agreeing is this system's only cross-check.
 *
 * Why the **device clock** rather than the server's time: offline there is no
 * server to ask, and what staff compare against is the clock on the wall.
 * That assumes the iPad is on store time; online, the business_date from the
 * catalog is used to check whether it has drifted (see businessDateDrift).
 */

import type { Catalog } from './catalog'
import { locale } from './i18n'

/**
 * A cached catalog may predate this field, in which case it is missing.
 * Fall back to 0 explicitly rather than letting undefined travel on --
 * `d.getHours() < undefined` is always false, so it would silently behave as
 * midnight; and if the default is ever something else, that silence becomes wrong money.
 */
export function cutoffHourOf(cat: Catalog | null | undefined): number {
  const h = cat?.business_day_cutoff_hour
  return typeof h === 'number' && Number.isFinite(h) ? h : 0
}

/** Local date -> 'YYYY-MM-DD'. Built from local fields; toISOString would be UTC. */
function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * Which business day an instant belongs to, as 'YYYY-MM-DD'.
 *
 * An invalid timestamp returns an empty string rather than throwing -- one bad
 * row should not blank the whole check list. An empty string never equals a real
 * business day, so the check lands in "carried over" where someone sees it, instead of disappearing.
 */
export function businessDateOf(iso: string, cutoffHour: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Before the boundary belongs to the previous day. setDate handles month and year ends.
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1)
  return ymd(d)
}

/** The business day right now. */
export function currentBusinessDate(cutoffHour: number): string {
  return businessDateOf(new Date().toISOString(), cutoffHour)
}

/**
 * The offsets on both sides when this device is not on store time; null when they agree (or cannot be compared).
 *
 * Why not "warn only once the business day is actually wrong": two time zones
 * agree on the day for most of it and only diverge for the few hours near the
 * boundary. Waiting for divergence means a few hours a day are silently filed
 * wrong -- and those hours are the dinner peak.
 *
 * It does not correct anything: the device clock is the only source of time
 * offline, and quietly changing it would file queued checks in the wrong period.
 * It reports, and a person fixes it in the iPad's settings.
 *
 * ⚠️ JS getTimezoneOffset() has the opposite sign (UTC-7 returns +420), so it
 *    is negated here into the conventional form the server uses.
 */
export function clockDrift(
  cat: Catalog | null,
): { storeMinutes: number; deviceMinutes: number } | null {
  const store = cat?.store_utc_offset_minutes
  if (typeof store !== 'number' || !Number.isFinite(store)) return null
  const device = -new Date().getTimezoneOffset()
  return store === device ? null : { storeMinutes: store, deviceMinutes: device }
}

/** Offset in minutes -> 'UTC-7' / 'UTC+5:30' */
export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`
}

/** Add or subtract days from a business day, 'YYYY-MM-DD' in and out. For "keep the last N days" style checks. */
export function shiftBusinessDate(bdate: string, days: number): string {
  const [y, m, d] = bdate.split('-').map(Number)
  if (!y || !m || !d) return bdate
  const dt = new Date(y, m - 1, d + days)
  return ymd(dt)
}

/** A date for people to read, "Aug 10, Mon" for instance. */
export function businessDateLabel(bdate: string): string {
  const [y, m, d] = bdate.split('-').map(Number)
  if (!y || !m || !d) return bdate
  // Built from local parts rather than Date('YYYY-MM-DD') -- that parses as UTC
  // and shows the previous day at UTC-7.
  return new Date(y, m - 1, d).toLocaleDateString(locale(), {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}
