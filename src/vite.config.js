// vite.config.js — EXACT WORKING CONFIG from dev log (June 11 2026)
// ⚠️  DO NOT CHANGE optimizeDeps without testing Cornerstone3D rendering
// Critical rules:
//   @cornerstonejs/dicom-image-loader MUST be in EXCLUDE (not include)
//   Pre-bundling it breaks the internal web worker silently
//   Worker hangs → loadAndCacheImage never resolves → setStack hangs forever

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

export default defineConfig({
  plugins: [
    react(),
    viteCommonjs(),   // required for CommonJS codec packages
  ],

  server: {
    proxy: {
      '/orthanc': {
        target: 'http://localhost:8042',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/orthanc/, ''),
        // Note: Orthanc v1.12.10 ignores HttpCorsEnabled in orthanc.json
        // CORS is handled entirely by this proxy in dev
        // In production: use nginx reverse proxy with CORS headers
      },
    },
  },

  optimizeDeps: {
    // CRITICAL: dicom-image-loader MUST be excluded
    // Including it breaks the internal web worker silently
    exclude: ['@cornerstonejs/dicom-image-loader'],

    // dicom-parser must be included (CommonJS module)
    include: ['dicom-parser'],
  },

  worker: {
    format: 'es',  // ES module workers required for Cornerstone3D v2
  },
})
