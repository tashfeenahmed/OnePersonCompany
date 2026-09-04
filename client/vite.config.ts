import { fileURLToPath } from "node:url"
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API holds the credentials; the browser never does. Proxying in dev
    // means the app calls same-origin /api and no CORS is involved.
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } },
  },
  resolve: {
    alias: { "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./src") },
  },
})
