import { useSyncExternalStore } from 'react'
import { getMeta, setMeta } from './db'

/**
 * 中英切换。**没有引入任何 i18n 库。**
 *
 * 理由和 DESIGN.md 里「不用 Kafka/Redis」是同一条：引入的每个组件都得被
 * 约束逼出来。这里要的东西很小 —— 一个语言开关、一份词表、缺词时的兜底，
 * 三十行就够。i18n 库带来的复数规则、插值语法、命名空间、懒加载，
 * 这个项目一样都用不上，却要多一个升级和排障的面。
 *
 * ⚠️ **词表用中文原文当 key**（gettext 的 msgid 思路），不发明 'check.pay'
 *    这种键名。两个原因：
 *      1. JSX 里读到的仍然是 `t('结账')`，看代码就知道界面上写什么，
 *         不用来回翻词表
 *      2. **缺翻译时自动回退成中文** —— 界面上会出现一句中文，
 *         而不是一个 'check.pay' 或者空白。少一句英文不影响开工，
 *         一个空按钮会让人不敢点
 *
 * 代价：同一句中文在不同语境下需要不同英文时会撞车（比如「确认」）。
 * 真遇到了就把 key 写长一点（'确认作废'），别硬拆成键名体系。
 */

export type Lang = 'zh' | 'en'

const KEY = 'lang'

let current: Lang = 'zh'
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((f) => f())
}

/** 启动时读一次。放在渲染之前调用，避免先闪一下中文再跳成英文。 */
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
  // 存本地，下次打开还是这个语言。存不上也不影响这次使用。
  void setMeta(KEY, l)
}

/** 订阅语言变化。用 useSyncExternalStore 而不是 Context —— 不用把整棵树包起来。 */
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
 * 翻译。中文模式直接返回原文，英文模式查表，查不到**回退中文**。
 *
 * 注意 tr() 读的是模块变量，不是 hook —— 所以组件里必须先调一次
 * useLang() 订阅，否则切换语言时那个组件不会重渲染。
 */
export function tr(zh: string): string {
  if (current === 'zh') return zh
  return EN[zh] ?? zh
}

/** 日期时间的 locale。中文界面显示 8月11日，英文界面显示 Aug 11。 */
export function locale(): string {
  return current === 'zh' ? 'zh-CN' : 'en-US'
}

/**
 * 菜名 / 加料名。数据库里本来就存了中英两份 ——
 * 这些不进词表，跟着语言取字段即可。
 */
export function name(
  o: { name_zh: string; name_en?: string | null } | null | undefined,
): string {
  // 取不到就给空串，不要抛 —— 一条脏数据不该让整个点菜页白屏
  if (!o) return ''
  if (current === 'zh') return o.name_zh
  return o.name_en?.trim() || o.name_zh
}

/**
 * 括号跟着语言走：中文全角、英文半角。
 * 混着用最难看的是「Cash + card（Cash $21.12）」这种半英半中的排版。
 */
/**
 * 账单行上的菜名。
 *
 * 优先用下单当时存下的 name_en（菜单改名不影响历史账单）。
 * 这一版之前开的单没存过英文名 —— 回退到按 menu_item_id 查当前菜单，
 * 查不到才显示中文。不这么做的话，老单子在英文界面里永远是中文。
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
 * 加料名。
 *
 * 目录里的（带 modifier_id）跟着语言走 —— 优先用下单当时存的英文名，
 * 没有就按 id 回查目录。手写的要求没有 id，原样显示：那是前台
 * 当场打进去的字，翻译它等于篡改记录。
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

/** 顿号也跟着语言走：中文「、」，英文「, 」。 */
export function listSep(): string {
  return current === 'zh' ? '、' : ', '
}

/** 分类名。跟 name() 一个道理：数据自带两份，不查词表。 */
export function catLabel(c: { label: string; label_en?: string }): string {
  if (current === 'zh') return c.label
  return c.label_en?.trim() || c.label
}

export function paren(inner: string): string {
  return current === 'zh' ? `（${inner}）` : ` (${inner})`
}

// ---------------------------------------------------------------------------
// 词表。左边是代码里写的中文原文，右边是英文。
// 少一条只会让那一处显示中文，不会崩 —— 所以可以慢慢补。
// ---------------------------------------------------------------------------

const EN: Record<string, string> = {
  // —— 顶栏 / 通用 ——
  在线: 'Online',
  离线: 'Offline',
  登出: 'Log out',
  未上传: 'Pending',
  失败: 'Failed',
  取消: 'Cancel',
  确认: 'Confirm',
  关闭: 'Close',
  保存: 'Save',
  未改动: 'No changes',
  '保存中…': 'Saving…',
  '载入中…': 'Loading…',
  删除: 'Delete',
  知道了: 'Got it',
  立即同步: 'Sync now',
  立即重试: 'Retry now',
  撤销改动: 'Discard changes',
  数据都已上传: 'Everything uploaded',
  '离线，数据已排队，联网后自动补发': 'Offline. Queued, will send when back online.',
  '会话已失效，请重新登录（数据仍在排队）':
    'Session expired, please log in again (your data is still queued)',
  需要联网才能读取: 'Needs a connection',
  '保存失败，检查网络后重试': 'Save failed, check the connection and retry',

  // —— 角色 ——
  前台员工: 'Server',
  前台主管: 'Front manager',
  后厨: 'Kitchen',
  老板: 'Owner',

  // —— 导航 ——
  楼面: 'Floor',
  自提: 'To go',
  账单清单: 'Checks',
  月报: 'Reports',
  修改: 'Prices',

  // —— 楼面 / 开桌 ——
  午市: 'Lunch',
  晚市: 'Dinner',
  主厅: 'Main',
  大桌: 'Large',
  座: 'seats',
  人: '',
  在座: 'Seated',
  开台: 'Open',
  成人: 'Adult',
  儿童: 'Child',
  长者: 'Senior',
  饮料: 'Drinks',
  '全员饮料': 'Drinks for all',
  直接点餐: 'Order à la carte',
  开桌: 'Seat table',

  // —— 账单 ——
  未结: 'Open',
  已结: 'Closed',
  已作废: 'Voided',
  已并入: 'Merged',
  未收清: 'Unpaid',
  全部: 'All',
  结账: 'Take payment',
  改支付方式: 'Change payment',
  补收差额: 'Collect balance',
  补收: 'Collect',
  加菜: 'Add dishes',
  改单: 'Edit',
  作废: 'Void',
  恢复: 'Restore',
  查看历史: 'History',
  '换桌 / 并桌': 'Move / merge',
  待收: 'Owing',
  多收: 'Overpaid',
  '多收（应退）': 'Overpaid (refund due)',
  已收: 'Collected',
  账单应收: 'Check total',
  之前已收: 'Already collected',
  本次待收: 'Collect now',
  支付方式: 'Payment',
  未记录: 'Not recorded',
  未记支付: 'No payment recorded',
  现金: 'Cash',
  刷卡: 'Card',
  其它: 'Other',
  '现金+刷卡': 'Cash + card',
  开台时间: 'Opened',
  操作人: 'By',
  客人: 'Customer',
  作废原因: 'Void reason',
  原因: 'Reason',
  确认作废: 'Void this check',
  营业额: 'Revenue',
  'Buffet 人数': 'Buffet guests',
  饮料份数: 'Drinks',
  '未结 / 已结': 'Open / closed',
  '现金 / 刷卡 / 其它': 'Cash / card / other',
  大桌服务费: 'Large-party fee',
  '大桌服务费 10%': 'Large-party fee 10%',
  税: 'Tax',
  含服务费: 'incl. fee',
  单: 'checks',
  没有符合条件的账单: 'No checks match.',
  '你的账号无改单、作废权限。': 'Your account cannot edit or void checks.',

  // —— 点菜 ——
  点菜: 'Order',
  '搜菜名（中文或英文）': 'Search dishes',
  没有匹配的菜: 'No matching dishes.',
  定制: 'Options',
  常用要求: 'Common requests',
  手写要求: 'Custom requests',
  自定义要求: 'Custom request',
  '　金额在下方输': ' price below',
  '例如：不放花生 / 分两盘装': 'e.g. no peanuts / split into two',
  加进: 'Add',
  份数: 'Qty',
  免费: 'Free',
  清空: 'Clear',
  自助餐打包: 'Buffet to go',
  '秤上算出多少就录多少。': 'Enter the amount from the scale.',
  建单: 'Create',
  客人信息: 'Customer',
  姓名: 'Name',
  '手机号（只取后四位）': 'Phone (last 4 digits)',
  '都可以留空。手机号只记后四位。': 'Both optional. Only the last 4 digits are kept.',
  返回改菜: 'Back to dishes',
  电话点菜: 'Phone order',
  '从菜单点，客人到店自提': 'Order from the menu for pickup',
  'Buffet To Go · 按重量，直接录金额': 'Buffet To Go — by weight, enter the amount',
  未取: 'Waiting',
  '首次使用需要联网加载一次菜单…': 'First run needs a connection to load the menu…',
  '还没有加载到加料目录，联网后再试。': 'Add-ons not loaded yet. Try again online.',

  // —— 跨天未结 ——
  跨天未结账单: 'Checks carried over',
  张跨天未结账单: ' checks carried over',
  '楼面已翻到新的一天，这些还没结 —— 点开处理':
    'The floor has moved to a new day. These are still unpaid — tap to handle.',
  时间异常: 'Bad timestamp',
  这台设备的时区和店里不一致: "This device's time zone differs from the store's",

  // —— 月报 ——
  本月营业额: 'Revenue this month',
  营业天数: 'Days open',
  客流: 'Guests',
  单数: 'Checks',
  日均: 'Daily average',
  客单价: 'Per guest',
  未记支付方式: 'No payment method',
  支付与账单不符: 'Payment does not match',
  当日小费总额: "Today's tips",
  保存小费: 'Save tips',
  '一天录一个总数 —— 卡机小费和桌上现金加一起。':
    'One total per day — card tips plus cash on the tables.',
  '这个月还没有营业数据。': 'No business recorded this month.',
  '离线·上次数据': 'Offline · last data',
  需要联网: 'Needs a connection',
  作废的账单: 'Voided checks',
  '这一天没有这类账单。': 'No checks of this kind on this day.',
  需要联网才能查看明细: 'Needs a connection to show the detail',
  堂食: 'Dine in',
  电话单: 'Phone order',
  打包: 'To go',

  // —— 设置 / 改价 ——
  设置: 'Settings',
  销售税率: 'Sales tax',
  '税率（%）': 'Tax rate (%)',
  生效日期: 'Effective from',
  '备注（可选）': 'Note (optional)',
  营业日与时区: 'Business day & time zone',
  时区: 'Time zone',
  营业日从几点开始: 'Business day starts at',
  店内此刻: 'Store time now',
  当前营业日: 'Business day',
  '自助餐 / 饮料': 'Buffet & drinks',
  菜单价: 'Menu prices',
  自助餐: 'Buffet',
  在售: 'On sale',
  已下架: 'Off menu',
  现场输金额: 'Amount entered on the spot',
  保存人头价: 'Save buffet prices',
  保存菜价: 'Save menu prices',
  保存常用要求: 'Save requests',
  '＋ 加一条': '+ Add one',
  '中文名，例如 加虾': 'Name, e.g. Add shrimp',
  只有老板账号能改价: 'Only the owner account can change prices',
  原: 'was',
  改: 'edited',

  // —— 补齐：被 <b> 拆开的句段和零散文案 ——
  '+服务费': '+fee',
  '—— 下单时存的是当时的价格快照。 下架的菜不会再出现在点菜页，但历史账单照常显示。': '— each check stores the price it was ordered at. Removing a dish hides it from ordering; past checks are unchanged.',
  '—— 历史账单上加过这一项的记录必须留着。 停用后它不再出现在点菜页，已经开出去的单照常显示。': '— past checks that used it must keep the record. It disappears from ordering; existing checks still show it.',
  '⚠️ 同一张桌今天开不了新单 —— 一张桌同时只能有一张未结账单。先把这里处理完。': '⚠️ You cannot open that table today — one open check per table. Settle these first.',
  '。设错了会按错误的时段收价 —— 午市 $14.05、晚市 $15.88。': '. Get it wrong and the wrong period price is charged — lunch $14.05, dinner $15.88.',
  '一半': 'Half',
  '全额': 'Full',
  '位': 'guests',
  '饮': 'drinks',
  '一张桌同时只能有一张未结账单，所以现在开不了新单。 先把它结掉或作废，这张桌就空出来了。': 'One open check per table, so a new one cannot be started. Settle or void it and the table frees up.',
  '上下箭头调顺序': 'Use the arrows to reorder',
  '上次同步': 'Last sync',
  '技术细节': 'Details',
  '现在网络': 'Network',
  '不会。已经存在这台 iPad 上了。': 'No. It is already stored on this iPad.',
  '不影响已经开出去的单': 'does not affect checks already open',
  '不用。联网后会自动补发。': 'Nothing. It sends automatically once online.',
  '例如 7.1': 'e.g. 7.1',
  '例如：gift card / 代金券': 'e.g. gift card / voucher',
  '例如：县里调率': 'e.g. county rate change',
  '例如：客人取消 / 录错桌号': 'e.g. guest cancelled / wrong table',
  '停用，不是删除': 'deactivated, not deleted',
  '成人饮料': 'Adult drink',
  '儿童饮料': 'Child drink',
  '全部清除': 'Clear all',
  '其它设备': 'Other device',
  '加辣、加料、特殊要求': 'Spice, add-ons, special requests',
  '午市/晚市怎么切': 'where lunch turns into dinner',
  '历史来自服务端的操作日志，**每一条都记录了是谁、什么时候做的**， 不能删改。': 'History comes from the server operation log — who did what and when. It cannot be edited.',
  '去处理这张单': 'Go settle it',
  '另一边自动等于余额': 'the other side is always the remainder',
  '只存在这台 iPad 上': 'only on this iPad',
  '同步出错': 'Sync error',
  '未知': 'unknown',
  '店里': 'Store',
  '本机': 'This device',
  '后厨界面在 Step 5（订单队列 + 补菜记录）。': 'The kitchen screen comes in Step 5.',
  '回到本月': 'This month',
  '选择月份': 'Pick a month',
  '多久补发一次': 'How often it retries',
  '如果一直不归零，说明服务器连不上（检查店内 WiFi 和后台机器）。 红色的「失败 N」才是需要人处理的 —— 那是服务端明确拒绝的操作。': 'If it never reaches zero the server is unreachable — check the WiFi and the back-office machine. The red Failed badge is the one that needs a person: those were rejected outright.',
  '小计 + 大桌服务费': 'subtotal + large-party fee',
  '尚未结账': 'not settled yet',
  '开在': 'Opened',
  '已上传': 'Uploaded',
  '已作废。恢复需要主管权限。': 'Voided. Restoring needs manager rights.',
  '已并入其它单': 'Merged into another check',
  '并桌': 'Merge',
  '换桌': 'Move table',
  '归集（分界时间见 ⚙︎ 设置）。': 'grouped by business day (cutoff in Settings).',
  '恢复这一单': 'Restore this check',
  '换一个生效日就是新增一版，旧价原样留着': 'a new effective date adds a version and keeps the old prices',
  '数据会丢吗': 'Can data be lost',
  '新增一条生效记录': 'adds a new effective-dated record',
  '月报里靠近日界的账单可能会换一天。': 'Checks near the cutoff may move to a different day in the reports.',
  '有积压时每 4 秒重试一次': 'Every 4 seconds while anything is queued',
  '本机数据已重置，正在重新拉取': 'Local data reset, fetching again',
  '条操作还没传到店里的服务器。': 'operations have not reached the store server yet.',
  '没有其它未结账单。': 'No other open checks.',
  '没有匹配的菜。': 'No matching dishes.',
  '没有失败记录。': 'No failures.',
  '没有生效日，是全局改的': 'has no effective date; it changes everything',
  '没有符合条件的账单。': 'No checks match.',
  '生效日填今天 = 从今天起按新价；填以前的日期会把那天之后的账重新算。 同一个生效日重复保存 = 改回来，不算调价。': "Today's date applies the new price from today. An earlier date re-prices everything after it. Saving twice on the same date is a correction, not a price change.",
  '的单。明细会搬到这张单上， 原来的单标记为「已并入」，不再单独计入营业额。': '. Their lines move onto this check; the originals are marked merged and no longer counted on their own.',
  '秤上算出多少就录多少 —— 系统只负责记进总账，不做称重也不算单品。': 'Enter the amount from the scale.',
  '营业日': 'business day',
  '要我做什么吗': 'Anything to do',
  '解释规则': 'a rule for interpreting time',
  '记录一次（骨架探针）': 'Record one (probe)',
  '请把多收的退给客人': 'Refund the difference to the guest',
  '账单可能被算到错误的营业日。请到 iPad 的系统设置里把时区改成店里的。': "Checks may land on the wrong business day. Set this iPad's time zone to the store's in iOS Settings.",
  '账单算哪一天': 'which day a check belongs to',
  '还有一张没结的单': 'still has an open check',
  '还有未上传的操作，等它同步完再重置': 'Some operations are still queued; let them sync before resetting',
  '还没有同步到服务器，暂无历史。': 'Not synced yet, no history.',
  '还没有自提单。': 'No to-go orders yet.',
  '还没有设过税率，当前按 0% 计。': 'No tax rate set yet; 0% is being used.',
  '这些单开在今天之前还没结账。每一张都是开了桌但没收到的钱 —— 结掉或作废后才会从这里消失。': 'These were opened before today and never settled. Each one is money that was never collected — settle or void them to clear this list.',
  '这些操作服务端明确拒绝了，不会自动重试。看清原因后手动重新录入即可， 确认无误后再清除。': 'The server rejected these outright and will not retry. Read the reason, re-enter them by hand, then clear.',
  '这张单已并入其它单，明细已转移，不再计入营业额。': 'This check was merged into another; its lines moved and it is no longer counted.',
  '选一张空桌，整张单挪过去。已占用的桌不能选。': 'Pick an empty table to move the whole check to. Occupied tables cannot be chosen.',
  '重置本机数据': 'Reset local data',
  '需要联网才能读取营业日设置。': 'Needs a connection to read the business-day settings.',
  '餐馆运营系统': 'Restaurant Operations',
  '首次使用需要联网加载一次桌位和菜单…': 'First run needs a connection to load tables and menu…',
  '（另有价格）': '(priced separately)',
  '（输入中）': '(entering)',
  '（长者同价 · 按人无限续）': '(seniors same as adults, free refills)',
  '，不会动已经开过的账单 —— 历史账单永远按当时的税率算，否则以前的票和账就对不上了。': '. Existing checks keep the rate they were rung up at, otherwise old receipts stop matching the books.',
  '，再用「改支付方式」把金额改成实收。': ', then use Change payment to record what was actually kept.',
  '，没传到服务器。 联网后会自动补发，不用做任何操作。': ' and has not reached the server. It sends automatically once online.',
  '，顺序就是点菜页的显示顺序。 免费的填 0。': '. This order is what the ordering screen shows. Use 0 for free.',
  '：清空这台设备缓存的账单，重新从服务器拉一遍。 服务端的数据被清理过、而本机还留着旧单时才需要 —— 服务端删数据不会通知客户端。': ': clears the checks cached on this device and pulls them again. Only needed when the server data was cleaned up and this device still holds old checks.',

  '换一个生效日 = 新增一版，旧价原样留着（月报和对账要回查当时卖多少钱）。同一个生效日重复保存 = 改回来，不算调价。': 'A new effective date adds a version and keeps the old prices — reports and reconciliation need to know what a seat cost on a given day. Saving twice on the same date is a correction, not a price change.',
  '当前这版生效于': 'This version applies from',
  '今天的营业日': "today's business day is",
  '电话': 'Phone',
  '尾号': 'last 4',
  '自助打包': 'Buffet to go',
  '本月小费': 'Tips this month',

  '小费': 'Tips',
  '甜酸肉': 'Sweet and Sour Pork',

  '全部都要饮料': 'Drinks for everyone',
  '含大桌服务费': 'incl. large-party fee',
  '开桌（仅饮料）': 'Open (drinks only)',
  '最近': 'last',
  '满 5 人 10%': '10% on parties of 5+',
  '金额在下方输': 'price below',

  '份': 'ea',
  '比账单多': 'over the check by',
  '多半是结账后退了菜或改小了人数。请把多收的退给客人，再用「改支付方式」把金额改成实收。': 'Usually a dish was voided or the head count lowered after settling. Refund the difference, then use Change payment to record what was actually kept.',

  '账号': 'Account',
  '密码': 'Password',
  '说明（必填）': 'Note (required)',
  '跳到某一天': 'Jump to a day',

  '由': 'by',
  '设定': '',
  '时区与营业日': 'time zone and business day',
  '0 点整 —— 过午夜就是新的一天': 'Midnight — a new day starts at 00:00',
  '凌晨 1 点': '1 AM',
  '凌晨 2 点 —— 收市后补的单仍算前一天': '2 AM — late entries still count as the previous day',
  '凌晨 3 点': '3 AM',
  '凌晨 4 点': '4 AM',
  '凌晨 5 点': '5 AM',
  '税率不合法': 'Tax rate is not valid',
  '请选择税率的生效日期': 'Pick an effective date for the tax rate',
  '需要联网才能读取设置': 'Needs a connection to read settings',
  '已保存': 'Saved',

  '时区决定午市/晚市怎么切（15:00 分界）和账单算哪一天。设错了会按错误的时段收价。': 'The time zone decides where lunch becomes dinner (15:00) and which day a check belongs to. Get it wrong and the wrong period price is charged.',
  '⚠️ 改时区是全局生效的，没有生效日 —— 月报里靠近日界的账单可能会换一天。': '⚠️ A time zone change applies to everything, with no effective date — checks near the cutoff may move to a different day in the reports.',
  '税收在小计 + 大桌服务费上。改税率是新增一条生效记录，已经开过的账单不受影响。': 'Tax applies to the subtotal plus the large-party fee. Changing it adds a new effective-dated record; existing checks are unaffected.',
  '自': 'from',

  '账户': 'Accounts',
  '每个人一个账号，账单上「谁操作的」就是这里的名字。': 'One account per person. The name here is what shows up as "who did this" on a check.',
  '密码在库里是不可逆的哈希，看不到原文 —— 只能重设一个新的。重设会把这个账号在所有设备上的登录踢掉（最多 15 分钟内生效）。': 'Passwords are stored as a one-way hash, so they cannot be shown — only replaced. Resetting one signs that account out on every device (within 15 minutes).',
  '显示名': 'Display name',
  '登录名': 'Username',
  '新密码': 'New password',
  '至少 4 位': 'At least 4 characters',
  '重设密码': 'Reset password',
  '当前登录': 'You',
  '处登录': 'signed in',
  '没有设备登录': 'No device signed in',
  '名字已保存': 'Name saved',
  '新密码已生效，原有登录已全部失效': 'new password is live, every existing sign-in was revoked',
  '你自己也要用新密码重新登录': 'you will have to sign in again with it',
  '改菜价不影响已经开出去的单 —— 下单时存的是当时的价格快照。下架的菜不再出现在点菜页，历史账单照常显示。': 'Changing a dish price does not touch checks already open — the price is snapshotted when the dish is ordered. A dish taken off keeps showing on past checks.',
  '点菜「定制」里的常用要求。上下箭头调顺序，顺序就是点菜页的显示顺序。免费的填 0。': 'The add-ons offered under "Customise" when ordering. The arrows set the order they appear in. Put 0 for free ones.',
  '删掉一条是停用，不是删除 —— 历史账单上加过这一项的记录必须留着。停用后它不再出现在点菜页，已经开出去的单照常显示。': 'Removing one deactivates it rather than deleting it — past checks that used it have to keep their record. It stops appearing when ordering; existing checks still show it.',
  '人头价': 'Per-head prices',
  '菜价': 'Dish prices',
  '已保存。前台会用新价，已经开出去的单不受影响。': 'saved. The floor will use the new prices; checks already open are unaffected.',

  '这个登录名已经有人用了': 'That username is already taken',

  '登录中…': 'Signing in…',
  '登录': 'Sign in',
  '连不上服务器（检查店内 WiFi）': 'Cannot reach the server (check the store WiFi)',
  '登录失败': 'Sign-in failed',
  '用户名或密码错误': 'Wrong username or password',
  '账号已停用': 'This account is disabled',

  '补菜': 'Refills',
  '订单': 'Orders',
  '补菜台': 'Buffet board',
  '补满': 'Full',
  '空了': 'Empty',
  '记到': 'Log at',
  '现在': 'now',
  '分钟前': 'min ago',
  '还没记过': 'no record yet',
  '已记': 'Logged',
  '这块板还没设置。老板账号在「修改 → 补菜台」里填。': 'This board is empty. The owner sets it up under Prices → Buffet board.',
  '做好了': 'Done',
  '没有等待中的单品。': 'Nothing waiting.',
  '自助餐台上摆的菜。3 页 × 10 格，午市晚市各一块板，台前照这个顺序显示。': 'The dishes out on the buffet. Three pages of ten, one board for lunch and one for dinner, shown in this order.',
  '改名字 = 同一道菜换个写法，消耗记录接得上。换成另一道菜请清空这一格再填新的 —— 直接改名会让新菜继承旧菜的历史。': 'Renaming keeps the same dish and its history. To put a different dish in a slot, clear it first and type the new one — renaming in place would hand the old dish’s history to the new one.',
  '第 N 页': 'Page N',
  '空格': 'empty',
  '保存这块板': 'Save this board',
  '台面已保存，补菜页立刻就是新的。': 'Board saved. The refill page has it already.',

  '什么时候的事？': 'When did it happen?',
  '刚刚': 'just now',
  '忙完才想起来记的话，选一下实际是多久以前。选完记一条就自动回到「刚刚」。': 'If you are logging it after the fact, pick how long ago it actually was. It goes back to "just now" after one entry.',
  '已完成': 'Done',
  '撤销': 'Undo',
  '现在没有单。': 'No orders right now.',
}
