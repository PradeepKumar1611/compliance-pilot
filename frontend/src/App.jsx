import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect, createContext, useContext } from 'react'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import KnowledgeBase from './pages/KnowledgeBase'
import ProcessQuestionnaire from './pages/ProcessQuestionnaire'
import AuditLog from './pages/AuditLog'
import Chat from './pages/Chat'
import UrlValidator from './pages/UrlValidator'
import Settings from './pages/Settings'
import Layout from './components/Layout'
import Toast from './components/Toast'
import api from './lib/api'

export const AuthContext = createContext(null)
export const ToastContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

export function useToast() {
  return useContext(ToastContext)
}

function ProtectedRoute({ children, adminOnly = false }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />
  return children
}

export default function App() {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })
  const [toast, setToast] = useState(null)

  // Auth is cookie-based now; we only persist the user profile for UI state.
  const login = (userData) => {
    localStorage.setItem('user', JSON.stringify(userData))
    setUser(userData)
  }

  const logout = () => {
    api.post('/auth/logout').catch(() => {})
    localStorage.removeItem('user')
    setUser(null)
  }

  const showToast = (message, type = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      <ToastContext.Provider value={showToast}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route
                path="knowledge-base"
                element={
                  <ProtectedRoute adminOnly>
                    <KnowledgeBase />
                  </ProtectedRoute>
                }
              />
              <Route path="process" element={<ProcessQuestionnaire />} />
              <Route path="chat" element={<Chat />} />
              <Route path="audit" element={<AuditLog />} />
              <Route path="url-validator" element={<UrlValidator />} />
              <Route
                path="settings"
                element={
                  <ProtectedRoute>
                    <Settings />
                  </ProtectedRoute>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </ToastContext.Provider>
    </AuthContext.Provider>
  )
}
