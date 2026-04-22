import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DiagnosticoForm } from './components/DiagnosticoForm'
import './styles.css'

const API_BASE = (import.meta.env.VITE_SMG_API_URL || 'http://localhost:3344/api').replace(/\/$/, '')
const PUBLIC_WORKFLOW = String(import.meta.env.VITE_SMG_DEFAULT_WORKFLOW || 'smg').trim().toLowerCase()
const currentPath = window.location.pathname.toLowerCase()
const isDiagnosticoPage = currentPath === '/diagnostico' || currentPath.startsWith('/diagnostico/')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isDiagnosticoPage ? <DiagnosticoForm apiBase={API_BASE} workflow={PUBLIC_WORKFLOW} /> : <App />}
  </React.StrictMode>
)
