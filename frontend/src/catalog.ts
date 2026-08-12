import { authFetch } from './auth'
import { getMeta, setMeta } from './db'

export interface TableInfo {
  label: string
  seats: number
  zone: string | null
  sort_order: number
}

export interface PriceRow {
  period_kind: 'lunch' | 'dinner'
  charge_kind: 'admission' | 'drink'
  guest_type: 'adult' | 'child' | 'senior'
  price_cents: number
}

/** Drinks have adult and child tiers only; seniors pay the adult price (what the store does) */
export interface Drinks {
  adult: number
  child: number
}

export interface MenuItem {
  id: number
  name_en: string
  name_zh: string
  category: string
  price_cents: number | null
  is_buffet_dish: boolean
  station: string
  sort_order: number
  /** Open price: the amount is typed in at the counter (Buffet To Go, by weight) */
  open_price: boolean
}

export interface Category {
  key: string
  label: string
  /**
   * The category's English name, sent by the server.
   * Like dish and add-on names it **stays out of the catalogue** -- these are data and follow the field.
   * Missing from an older cache, so reads fall back to the Chinese.
   */
  label_en?: string
}

/** Catalogue of add-ons / special requests (extra spicy, add shrimp, add vegetables...). Priced **per portion**. */
export interface Modifier {
  id: number
  name_zh: string
  name_en: string
  price_cents: number
  sort_order: number
}

/**
 * What was actually added to one dish.
 * Catalogue ones carry a modifier_id (the server's price wins);
 * hand-typed ones have no id, and both the label and the amount were entered at the counter.
 */
export interface PickedModifier {
  modifier_id?: number
  label: string
  price_cents: number
}

export interface Catalog {
  categories: Category[]
  tables: TableInfo[]
  menu: MenuItem[]
  /** Missing from an older cache, so always read it as `?? []` */
  modifiers?: Modifier[]
  prices: PriceRow[]
  /**
   * The buffet layout, grouped by period (lunch / dinner), each slot with page and pos.
   * Missing from an older cache, so always read it with a default.
   */
  buffet_board?: Record<string, { id: number; page: number; pos: number; name_zh: string; name_en: string }[]>
  current_period_kind: 'lunch' | 'dinner'
  /** The current tax rate, 0.071 = 7.1% */
  tax_rate: number
  /**
   * Where the business day starts (store local time, on the hour). 0 = midnight.
   * Sent by the server and never hard-coded here -- see businessDay.ts.
   * Missing from an older cache, so it is always read through cutoffHourOf().
   */
  business_day_cutoff_hour?: number
  /** The business day the server currently thinks it is, 'YYYY-MM-DD', for checking device clock drift */
  business_date?: string
  /** The store's current UTC offset (minutes, east positive). Missing from an older cache, so optional. */
  store_utc_offset_minutes?: number
  fetched_at: string
}

const K = 'catalog'

/**
 * The catalogue is cached locally.
 *
 * **On an offline cold start the open-table screen still has to render 20 tables
 * and their prices**, so it cannot be fetched on demand. A failed fetch falls
 * back to the cache; only a missing cache is really unusable.
 */
export async function loadCatalog(): Promise<Catalog | null> {
  return getMeta<Catalog | null>(K, null)
}

export async function refreshCatalog(): Promise<Catalog | null> {
  try {
    const res = await authFetch('/api/catalog')
    if (!res.ok) return loadCatalog()
    const data = await res.json()
    const cat: Catalog = { ...data, fetched_at: new Date().toISOString() }
    await setMeta(K, cat)
    return cat
  } catch {
    // Offline -- use the cache and do not raise
    return loadCatalog()
  }
}

/**
 * The client's estimate, **for display only**.
 * The stored amount is always recomputed by the server -- the client may be
 * holding prices from days ago, and recording whatever the front end sends means anyone can discount themselves.
 */
export function estimateCents(
  prices: PriceRow[],
  period: 'lunch' | 'dinner',
  guests: { adult: number; child: number; senior: number },
  drinks: Drinks,
): number {
  const find = (kind: 'admission' | 'drink', gt: string) =>
    prices.find(
      (p) => p.period_kind === period && p.charge_kind === kind && p.guest_type === gt,
    )?.price_cents ?? 0

  return (
    guests.adult * find('admission', 'adult') +
    guests.child * find('admission', 'child') +
    guests.senior * find('admission', 'senior') +
    // Drinks have adult and child tiers only -- seniors pay the adult price
    drinks.adult * find('drink', 'adult') +
    drinks.child * find('drink', 'child')
  )
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}


/** Large-party threshold and rate -- has to match the constants in the server's checks.py. */
export const LARGE_PARTY_MIN = 5
export const SERVICE_CHARGE_RATE = 0.1

/**
 * What "how many people" means: someone who only drinks still takes a seat, so
 * it is max(buffet guests, drinks). Same as the server's _party_size.
 */
export function partySize(
  guests: { adult: number; child: number; senior: number },
  drinks: Drinks,
): number {
  return Math.max(
    guests.adult + guests.child + guests.senior,
    drinks.adult + drinks.child,
  )
}

/** Service charge estimate, for display only; the stored amount is the server's. */
export function serviceCents(subtotal: number, size: number): number {
  return size >= LARGE_PARTY_MIN ? Math.round(subtotal * SERVICE_CHARGE_RATE) : 0
}


/** Tax, charged on (subtotal + service charge). Matches the server's _recalc_service_charge. */
export function taxCents(subtotal: number, service: number, rate: number): number {
  return Math.round((subtotal + service) * rate)
}
