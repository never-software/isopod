import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

const certFile = '/certs/_wildcard.orb.local+2.pem'
const keyFile = '/certs/_wildcard.orb.local+2-key.pem'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4000,
    host: '0.0.0.0',
    allowedHosts: ['.orb.local'],
    https: fs.existsSync(certFile)
      ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
      : undefined,
  },
})
