import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api.js'

// status: 'loading' | 'signed-in' | 'signed-out' | 'unavailable'
// 'unavailable' means the API could not be reached or has no Auth0 settings.
const AuthContext = createContext({ status: 'loading', user: null, message: '' })

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ status: 'loading', user: null, message: '' })

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setAuth({ status: 'signed-in', user, message: '' })
      })
      .catch((error) => {
        if (cancelled) return
        if (error.status === 401) {
          setAuth({ status: 'signed-out', user: null, message: '' })
        } else {
          setAuth({ status: 'unavailable', user: null, message: error.message })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react/only-export-components
export function useAuth() {
  return useContext(AuthContext)
}
