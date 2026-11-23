import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  // Use relative asset paths so loadFile() works inside the .asar bundle.
  // Without this, Vite outputs src="/assets/..." which resolves to filesystem
  // root when loaded via file:// protocol in the packaged Electron app.
  base: './',
})

