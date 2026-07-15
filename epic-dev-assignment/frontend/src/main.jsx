import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App.jsx'
import AuthBridge from './lib/AuthBridge.jsx'
import './index.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

// Fail fast with a clear screen instead of a blank page when the key is missing.
function ConfigError() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 480, padding: 32, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111827', marginBottom: 8 }}>Configuration required</h1>
        <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>
          <code>VITE_CLERK_PUBLISHABLE_KEY</code> is not set. Add it to{' '}
          <code>frontend/.env.local</code> (dev) or the build environment (prod), then restart.
          Get the key from dashboard.clerk.com → Configure → API keys.
        </p>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {PUBLISHABLE_KEY ? (
      <ClerkProvider
        publishableKey={PUBLISHABLE_KEY}
        signInUrl="/login"
        signUpUrl="/signup"
        afterSignOutUrl="/login"
      >
        <AuthBridge />
        <App />
      </ClerkProvider>
    ) : (
      <ConfigError />
    )}
  </React.StrictMode>,
)
