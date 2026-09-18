import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const el = document.getElementById('root')
if (el === null) throw new Error('Web 应用缺少 #root 挂载点')
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
