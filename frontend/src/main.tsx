import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { login, logout } from './auth'
import { refreshCatalog } from './catalog'
import { allChecks, closeTable, modifyTable, openChecksByTable, openTable, totalsOf, voidTable } from './checks'
import db from './db'
import './styles.css'
import { sync } from './sync'

/**
 * 调试钩子。
 *
 * iPad 上没有开发者工具，真机排障只能靠这个 —— 用 Safari 的
 * "网页检查器"连上后直接在控制台调 `__rs.openTable('A7', ...)`。
 * 前面丢 op 那次如果早有它，定位能快很多。
 *
 * 只读不到任何敏感信息：这些函数本来就是 UI 在调的，
 * 能打开控制台的人已经能操作 UI 了。
 */
declare global {
  interface Window {
    __rs: Record<string, unknown>
  }
}
window.__rs = {
  db,
  sync,
  login,
  logout,
  openTable,
  closeTable,
  modifyTable,
  voidTable,
  allChecks,
  totalsOf,
  openChecksByTable,
  refreshCatalog,
  build: __BUILD__,
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
