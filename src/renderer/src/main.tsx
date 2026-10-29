import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { applyTheme, readStoredTheme } from './lib/theme-mode'

// before the first paint, from the copy kept in localStorage; the store re-applies it once settings arrive
applyTheme(readStoredTheme())

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
