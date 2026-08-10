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

/** 饮料只有成人/儿童两档；长者饮料按成人价（店里的实际做法） */
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
  /** 开放价：金额当场输入（Buffet To Go 按重量称） */
  open_price: boolean
}

export interface Category {
  key: string
  label: string
}

export interface Catalog {
  categories: Category[]
  tables: TableInfo[]
  menu: MenuItem[]
  prices: PriceRow[]
  current_period_kind: 'lunch' | 'dinner'
  fetched_at: string
}

const K = 'catalog'

/**
 * 目录缓存在本地。
 *
 * **离线冷启动时开桌页必须能渲染出 20 张桌和价格** —— 所以不能每次现拉。
 * 拉失败就用缓存，缓存也没有才算真的不可用。
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
    // 离线 —— 用缓存，不报错
    return loadCatalog()
  }
}

/**
 * 客户端估价，**只用于界面显示**。
 * 落库金额一律由服务端重算 —— 客户端可能拿着几天前的旧价，
 * 而且前端传什么金额就记什么金额等于谁都能给自己打折。
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
    // 饮料只有成人/儿童两档 —— 长者饮料按成人价
    drinks.adult * find('drink', 'adult') +
    drinks.child * find('drink', 'child')
  )
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}


/** 大桌门槛与费率 —— 必须和后端 checks.py 里的常量保持一致。 */
export const LARGE_PARTY_MIN = 5
export const SERVICE_CHARGE_RATE = 0.1

/**
 * 「几人」的口径：只喝饮料的人也占座位，所以取
 * max(buffet 人数, 饮料份数)。与后端 _party_size 一致。
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

/** 服务费估算，仅供显示；落库金额以服务端为准。 */
export function serviceCents(subtotal: number, size: number): number {
  return size >= LARGE_PARTY_MIN ? Math.round(subtotal * SERVICE_CHARGE_RATE) : 0
}
