import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The Earth Replay API (backend/cloudefare) is reached through this dev
// server, so the browser sees one origin: no CORS setup, and the Auth0
// session cookie set by the API is sent with every /api request.
// Point VITE_API_TARGET somewhere else in Frontend/.env.local if needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_API_TARGET || 'http://localhost:8787'
  const proxy = { target, changeOrigin: true }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true, // the API's FRONTEND_URL points at this exact port
      proxy: {
        '/api': { ...proxy, ws: true }, // ws: replay rooms at /api/room/:code
        '/auth': proxy,
        '/tiles': proxy,
      },
    },
  }
})
