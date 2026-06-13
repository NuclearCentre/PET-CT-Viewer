# PET-CT Viewer

A zero-footprint, browser-based PET-CT DICOM viewer built with React 18, Cornerstone3D v2.1.16, and Orthanc v1.12.10.

## Stack
| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 8 |
| Rendering | Cornerstone3D v2.1.16 (WebGL) |
| DICOM server | Orthanc v1.12.10 (local PACS) |
| DICOM protocol | WADO-RS (DICOMweb via Vite proxy) |

## Development phases

| Phase | Feature | Status |
|---|---|---|
| 1 | CT rendering — Pan, Zoom, Scroll, W/L | ✅ Done |
| 2 | PET display + 13 colormaps (Hot Iron default) | ✅ Done |
| 3 | Volume MPR · CT/PET fusion · Crosshairs · MIP | ✅ Done |
| 4 | SUV (QIBA/EANM SUVbw) · ROI measurements · Annotation filters | 🔄 In progress |
| 5 | Text-box clamping · CircleROI handles · Missing stats fix · CT/PET size parity | 🔜 Next |
| 6 | Series thumbnails · Overlays · Export/Print/Send to filming | ⏳ Pending |

## Quick start

```powershell
# 1. Start Orthanc (Windows service)
Start-Service Orthanc
# Verify: http://localhost:8042

# 2. Start the viewer
cd "D:\PET-CT Viewer\petct-viewer"
npm run dev
# Open: http://localhost:5173
```

## Critical configuration notes

- **Cornerstone3D must stay at v2.1.16** — v3 and v5 have silent worker failures under Vite
- `@cornerstonejs/dicom-image-loader` must be in `optimizeDeps.exclude` (not include)
- `dicomLoaderInit({ maxWebWorkers: 1 })` — higher counts hang in Vite dev
- React **StrictMode must be OFF** — CS3D singleton breaks under double-invocation
- `main.jsx` calls `initCornerstone()` BEFORE `createRoot().render()`

## Project structure

```
src/
  components/
    ViewportGrid.jsx    # 3×2 MPR grid + MIP; volume loading; crosshair sync
    ViewerBox.jsx       # Single viewport: tools, annotations, SUV panel, ROI stats
  utils/
    volumeManager.js    # Volume creation, fusion viewport setup, MIP
    suvUtils.js         # SUVbw calculation (QIBA/EANM), decay correction
    dicomMetadata.js    # DICOM tag extraction for SUV parameters
  cornerstone-init.js   # CS3D init, tool registration, annotation patches
  App.jsx               # Study selector, W/L controls, tool switching
  main.jsx              # Entry point — CS3D init before React render
```

## Session 4 open issues (→ Session 5)

1. **P1** Annotation text spills outside viewport — needs `getTextBoxCoordsCanvas` module-level wrap before tool instantiation
2. **P2** CircleROI missing multi-handle dots — use `configuration.getHandles()` override on tool instance
3. **P3** Intermittent missing measurement text — listen to `ANNOTATION_MODIFIED`, retry stats, show spinner
4. **P4** CT/PET size parity — verify camera sync `useEffect` in browser against live Orthanc
