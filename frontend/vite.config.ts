import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Собранный фронтенд кладём прямо внутрь бэкенда: FastAPI отдаёт его как
// статику, поэтому конечному пользователю не нужен ни Node, ни npm.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8756',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../backend/app/static',
    emptyOutDir: true,
    sourcemap: false,
  },
})
