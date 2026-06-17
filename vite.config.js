import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

export default defineConfig({
  plugins: [
    react(),
    viteCommonjs(), // required for dicom-parser (CommonJS)
  ],
  server: {
    proxy: {
      '/orthanc': {
        target: 'http://localhost:8042',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/orthanc/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  worker: {
    format: 'es',
    rolldownOptions: {
      external: ['@icr/polyseg-wasm'],
    },
  },
  build: {
    rolldownOptions: {
      external: ['@icr/polyseg-wasm'],
    },
  },
})
