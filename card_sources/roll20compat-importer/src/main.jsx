import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const root = createRoot(document.getElementById('root'))

if (import.meta.env.DEV) {
  const { ApiMock } = await import('../ApiMock.js')
  root.render(
    <StrictMode>
      <App Api={ApiMock} />
    </StrictMode>
  )
} else {
  window.addEventListener('cardapi:ready', () => {
    root.render(
      <StrictMode>
        <App Api={window.CardAPI} />
      </StrictMode>
    )
  }, { once: true })
}
