import { useCallback, useEffect, useMemo, useState } from 'react'
import { name, tr } from './i18n'
import { loadCatalog } from './catalog'
import { type LocalTray } from './db'
import {
  agoText,
  lastByDish,
  recordTray,
  type BoardDish,
  type TrayKind,
} from './trays'

/**
 * 补菜台。**前台和后厨共用这一页。**
 *
 * 厨师补菜时顺手点最自然，但发现菜盘空了的往往是服务员 ——
 * 只给后厨的话，最该被记下的"空了"事件会大量丢失，
 * 而那正是区间截尾的右端点，模型最需要的那一头。
 *
 * 界面上的每个取舍都为一件事让路：**高峰期三秒之内点得完**。
 *   · 三个按钮，没有下拉、没有确认、没有填充度滑块
 *   · 一页十格，翻页而不是长列表 —— 站在台前不该滚动找菜
 *   · 午市/晚市**手动切**，不跟着时钟走：换台面是人做的动作，
 *     系统猜错了反而会把记录记到另一块板上
 */

const KINDS: { kind: TrayKind; zh: string; cls: string }[] = [
  { kind: 'refill', zh: '补满', cls: 'k-refill' },
  { kind: 'half', zh: '一半', cls: 'k-half' },
  { kind: 'empty', zh: '空了', cls: 'k-empty' },
]

/** 回拨选项。厨师往往是**事后**才想起来点 —— 见 JOURNAL 的说明。 */
const BACK = [0, 5, 10, 15]

const PAGES = [1, 2, 3]
const SLOTS = 10

export default function RefillView() {
  const [board, setBoard] = useState<Record<string, BoardDish[]> | null>(null)
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('lunch')
  const [page, setPage] = useState(1)
  const [last, setLast] = useState<Map<number, LocalTray>>(new Map())
  const [back, setBack] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  // 每分钟重算一次"多久以前"。不重算的话数字会停在打开页面那一刻。
  const [, tick] = useState(0)

  useEffect(() => {
    void (async () => {
      const cat = await loadCatalog()
      setBoard((cat?.buffet_board ?? { lunch: [], dinner: [] }) as Record<string, BoardDish[]>)
      // 默认落在服务端认定的时段上，但**允许手动改** ——
      // 15:00 那一刻台面不会自己换，人换台面才换。
      setPeriod(cat?.current_period_kind === 'dinner' ? 'dinner' : 'lunch')
    })()
  }, [])

  const refresh = useCallback(async () => setLast(await lastByDish()), [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => {
      tick((n) => n + 1)
      void refresh()
    }, 30_000)
    return () => window.clearInterval(t)
  }, [refresh])

  const slots = useMemo(() => {
    const dishes = (board?.[period] ?? []).filter((d) => d.page === page)
    const byPos = new Map(dishes.map((d) => [d.pos, d]))
    return Array.from({ length: SLOTS }, (_, i) => byPos.get(i + 1) ?? null)
  }, [board, period, page])

  async function hit(d: BoardDish, kind: TrayKind) {
    await recordTray(d.id, kind, back)
    await refresh()
    const label = tr(KINDS.find((k) => k.kind === kind)!.zh)
    setToast(
      `${name(d)} · ${label}${back ? ` · ${back} ${tr('分钟前')}` : ''}`,
    )
    // 回拨是**一次性**的，用完立刻归零。留着的话下一条会被静默记到过去，
    // 而没人会记得自己刚才拨过。
    setBack(0)
    window.setTimeout(() => setToast(null), 2500)
  }

  if (!board) return <p className="hint">{tr('载入中…')}</p>

  const filled = (board[period] ?? []).length

  return (
    <>
      <div className="refill-top">
        <div className="seg">
          {(['lunch', 'dinner'] as const).map((p) => (
            <button
              key={p}
              className={period === p ? 'on' : ''}
              onClick={() => setPeriod(p)}
            >
              {tr(p === 'lunch' ? '午市' : '晚市')}
            </button>
          ))}
        </div>
        <div className="seg pages">
          {PAGES.map((p) => (
            <button key={p} className={page === p ? 'on' : ''} onClick={() => setPage(p)}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="refill-back">
        <span className="rb-label">{tr('记到')}</span>
        {BACK.map((m) => (
          <button key={m} className={back === m ? 'on' : ''} onClick={() => setBack(m)}>
            {m === 0 ? tr('现在') : `−${m}′`}
          </button>
        ))}
      </div>

      {filled === 0 && (
        <p className="hint">{tr('这块板还没设置。老板账号在「修改 → 补菜台」里填。')}</p>
      )}

      <div className="tray-grid">
        {slots.map((d, i) =>
          d === null ? (
            <div key={`e${i}`} className="tray empty">
              <span className="t-name">{i + 1}</span>
            </div>
          ) : (
            <div key={d.id} className="tray">
              <div className="t-head">
                <span className="t-name">{name(d)}</span>
                <span className="t-ago">
                  {last.get(d.id)
                    ? `${agoText(last.get(d.id)!.at).text}′ ${tr(
                        KINDS.find((k) => k.kind === last.get(d.id)!.kind)?.zh ?? '',
                      )}`
                    : tr('还没记过')}
                </span>
              </div>
              <div className="t-btns">
                {KINDS.map((k) => (
                  <button key={k.kind} className={k.cls} onClick={() => void hit(d, k.kind)}>
                    {tr(k.zh)}
                  </button>
                ))}
              </div>
            </div>
          ),
        )}
      </div>

      {toast && <div className="tray-toast">{tr('已记')} · {toast}</div>}
    </>
  )
}
