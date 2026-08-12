import { useSyncExternalStore } from 'react'
import { getMeta, setMeta } from './db'
import { DATA_EN, ZH } from './locales/zh'

/**
 * Chinese / English switch. **No i18n library.**
 *
 * Same reasoning as "no Kafka, no Redis" in DESIGN.md: every dependency has to
 * be forced on us by a constraint. What this needs is small -- one switch, one
 * catalogue, a fallback for missing entries. Thirty lines. Plural rules,
 * interpolation syntax, namespaces and lazy loading are all things this project
 * would never use but would still have to upgrade and debug.
 *
 * ⚠️ **The catalogue is keyed by the English source string** (gettext's msgid
 *    idea) rather than invented keys like 'check.pay'. Two reasons:
 *      1. What you read in the JSX is `tr('Collect')`, so the code tells you
 *         what the screen says without a trip to the catalogue
 *      2. **A missing translation falls back to the English** rather than
 *         rendering 'check.pay' or a blank. An English word on a Chinese screen
 *         is survivable; an empty button is something nobody dares press
 *
 * The cost: one English string that needs two different Chinese renderings
 * collides. When that happens, make the key longer ('Confirm void') rather than
 * inventing a key hierarchy.
 */

export type Lang = 'zh' | 'en'

const KEY = 'lang'

let current: Lang = 'zh'
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((f) => f())
}

/** Read the saved choice once at startup, before the first render. */
export async function initLang(): Promise<void> {
  const saved = await getMeta<Lang | null>(KEY, null)
  if (saved === 'zh' || saved === 'en') {
    current = saved
    emit()
  }
}

export function getLang(): Lang {
  return current
}

export function setLang(l: Lang): void {
  if (l === current) return
  current = l
  emit()
  // Persist it; failing to save only affects the next launch.
  void setMeta(KEY, l)
}

/** Subscribe to language changes -- useSyncExternalStore, not a Context
 *  provider wrapping the whole tree. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getLang,
    getLang,
  )
}

/**
 * Translate. In English mode the key is already the answer; in Chinese mode we
 * look it up and **fall back to the key** when it is missing.
 *
 * The one exception is data that is stored in Chinese -- the seeded display
 * names that show up as "who did this" on a check. Those get looked up the
 * other way round in English mode.
 *
 * Note tr() reads a module variable rather than a hook, so a component has to
 * call useLang() somewhere or it will not re-render on a language switch.
 */
export function tr(s: string): string {
  if (current === 'en') return DATA_EN[s] ?? s
  return ZH[s] ?? s
}

/** Locale for dates and times, so each language formats them its own way. */
export function locale(): string {
  return current === 'zh' ? 'zh-CN' : 'en-US'
}

/**
 * Dish and add-on names. The database already stores both languages, so these
 * follow the column rather than the catalogue.
 */
export function name(
  o: { name_zh: string; name_en?: string | null } | null | undefined,
): string {
  // Empty string rather than a throw -- one bad row should not blank the
  // whole ordering screen.
  if (!o) return ''
  if (current === 'zh') return o.name_zh
  return o.name_en?.trim() || o.name_zh
}

/**
 * A dish name on a check.
 *
 * Prefer the name_en captured when it was ordered, so renaming the menu does
 * not rewrite history. Checks opened before that column existed fall back to
 * looking the item up in the current menu, and to the stored name after that --
 * otherwise old checks stay Chinese on an English screen forever.
 */
export function lineName(
  l: { name: string; name_en?: string; menu_item_id?: number },
  menu?: { id: number; name_zh: string; name_en: string }[],
): string {
  if (current === 'zh') return l.name
  if (l.name_en?.trim()) return l.name_en
  const hit = menu?.find((m) => m.id === l.menu_item_id)
  return hit?.name_en?.trim() || l.name
}

/**
 * An add-on on a check line.
 *
 * Catalogue add-ons (they carry a modifier_id) follow the language: the name_en
 * stored at order time first, the catalogue by id second. Hand-typed requests
 * have no id and are shown exactly as entered -- translating them would be
 * rewriting what the server actually wrote down.
 */
export function modLabel(
  m: { label: string; label_en?: string; modifier_id?: number },
  catalog?: { id: number; name_zh: string; name_en: string }[],
): string {
  if (current === 'zh') return m.label
  if (m.label_en?.trim()) return m.label_en
  if (m.modifier_id !== undefined) {
    const hit = catalog?.find((x) => x.id === m.modifier_id)
    if (hit?.name_en?.trim()) return hit.name_en
  }
  return m.label
}

/** List separator follows the language too: 、 in Chinese, ", " in English. */
export function listSep(): string {
  return current === 'zh' ? '、' : ', '
}

/** Category label. Same idea as name(): the data carries both, no lookup. */
export function catLabel(c: { label: string; label_en?: string }): string {
  if (current === 'zh') return c.label
  return c.label_en?.trim() || c.label
}

/** Parentheses follow the language: full-width in Chinese, spaced in English.
 *  Mixing them gives you "Cash + card（Cash $21.12）", which reads as a bug. */
export function paren(inner: string): string {
  return current === 'zh' ? `（${inner}）` : ` (${inner})`
}
