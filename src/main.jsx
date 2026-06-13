// main.jsx
// ⚠️  CRITICAL: StrictMode is PERMANENTLY DISABLED
// Cornerstone3D singleton breaks under double-invocation of effects.

import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './App.css'
import { initCornerstone } from './cornerstone-init.js'
// Prevent Chrome from consuming middle mouse button
window.addEventListener('mousedown', e => {
  if (e.button === 1) e.preventDefault()
}, { capture: true, passive: false })

document.addEventListener('auxclick', e => {
  e.preventDefault()
}, { capture: true, passive: false })
initCornerstone()
  .then(() => {
    createRoot(document.getElementById('root')).render(<App />)
  })
  .catch(err => {
    console.error('[main] CS3D init failed:', err)
    createRoot(document.getElementById('root')).render(<App />)
  })
