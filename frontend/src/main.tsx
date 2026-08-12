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
 * Debug hooks.
 *
 * There are no developer tools on an iPad, so on-device troubleshooting has
 * to go through these -- attach Safari's Web Inspector and call
 * `__rs.openTable('A7', ...)` in the console. The time ops went missing, this
 * would have found it much faster.
 *
 * Nothing sensitive is exposed: these are the same functions the UI calls,
 * and anyone who can open the console can already work the UI.
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
