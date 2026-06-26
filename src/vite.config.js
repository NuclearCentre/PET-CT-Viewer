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
      // Existing Orthanc proxy -- unchanged. Routes all /orthanc/* to :8042.
      // Strips /orthanc prefix so: /orthanc/dicom-web/... -> :8042/dicom-web/...
      //                             /orthanc/wado?...      -> :8042/wado?...
      // SeriesPanel, ViewportGrid (default), and all existing code use this.
      '/orthanc': {
        target: 'http://localhost:8042',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/orthanc/, ''),
      },

      // Optional future-PACS routes. Not used by any code unless
      // window.__DICOMWEB_REST or window.__WADO_BASE are set in index.html.
      // Update the targets below when migrating to a different PACS.
      '/dicomweb': {
        target: 'http://localhost:8042',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dicomweb/, '/dicom-web'),
      },
      '/dicomwado': {
        target: 'http://localhost:8042',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dicomwado/, ''),
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
