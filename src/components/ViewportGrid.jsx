/**
 * ViewportGrid.jsx -- Session 14 final
 *
 * Changes vs Session 13:
 *
 * 1. PACS-agnostic DICOMweb URLs:
 *    - Two configurable base constants replace the hardcoded /orthanc strings.
 *    - DICOMWEB_REST_BASE: for metadata fetches (studies, series, instances lists).
 *    - WADO_BASE: for WADO-URI image IDs (the per-instance pixel data).
 *    - Defaults keep the EXISTING /orthanc proxy working with zero config change.
 *    - To switch PACS: set window.__DICOMWEB_REST and window.__WADO_BASE before
 *      the app loads. No code or proxy changes needed.
 *
 *    Orthanc URL structure (why two bases are needed):
 *      REST metadata : GET /orthanc/dicom-web/studies/{uid}/series   (proxy strips /orthanc)
 *      WADO-URI image: wadouri:/orthanc/wado?requestType=WADO&...    (proxy strips /orthanc)
 *    Orthanc's WADO endpoint is /wado, NOT /dicom-web/wado. A single base with one
 *    rewrite rule cannot serve both paths, so two separate bases are required.
 *
 * 2. Loading message updated (no longer says "Orthanc").
 *
 * 3. Everything else unchanged from Session 12/13:
 *    - Series selection logic, metadata registry, metaData.addProvider guard.
 *    - All layout definitions, BoxPicker, toolGroupId assignments.
 *    - MIP zoom sync, onMetaLoaded callback.
 *    - renderMode='volume' for all 7 viewports (CT, PET-CT, MIP).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { getRenderingEngine, metaData, Enums as CoreEnums } from '@cornerstonejs/core';
import ViewerBox from './ViewerBox.jsx';
import { RENDERING_ENGINE_ID, setCrosshairsActive, ToolGroupManager } from '../cornerstone-init.js';
import { ensureVolumes, purgeVolumes } from '../utils/volumeManager.js';
import { resetFusionTransform } from '../utils/fusionManager.js';
import { initSUVMeta } from '../utils/suvUtils.js';

// ---------------------------------------------------------------------------
// PACS base URL configuration
//
// DICOMWEB_REST_BASE : DICOMweb REST endpoint prefix (studies/series/instances).
// WADO_BASE          : Prefix for WADO-URI image ID URLs (per-instance pixel data).
//
// Defaults use the existing /orthanc Vite proxy -- no vite.config.js change needed.
// To use a different PACS: set these on window before the app loads:
//   window.__DICOMWEB_REST = 'https://your-pacs.example.com/wado/rs'
//   window.__WADO_BASE     = 'https://your-pacs.example.com'
// ---------------------------------------------------------------------------
export function getDicomWebRestBase() {
  return (typeof window !== 'undefined' && window.__DICOMWEB_REST)
    ? window.__DICOMWEB_REST
    : '/orthanc/dicom-web';
}

export function getWadoBase() {
  return (typeof window !== 'undefined' && window.__WADO_BASE)
    ? window.__WADO_BASE
    : '/orthanc';
}

// ---------------------------------------------------------------------------
// Viewport definitions (unchanged from Session 12)
// ---------------------------------------------------------------------------
const CT_VIEWPORTS = [
  { id: 'ct-axial',    label: 'CT \u00b7 Axial',    modality: 'CT',  orientation: 'axial',    accentColor: '#88c4ff' },
  { id: 'ct-coronal',  label: 'CT \u00b7 Coronal',  modality: 'CT',  orientation: 'coronal',  accentColor: '#88c4ff' },
  { id: 'ct-sagittal', label: 'CT \u00b7 Sagittal', modality: 'CT',  orientation: 'sagittal', accentColor: '#88c4ff' },
];
const PET_VIEWPORTS = [
  { id: 'pct-axial',    label: 'PET-CT \u00b7 Axial',    modality: 'PET', orientation: 'axial',    accentColor: '#88dd88' },
  { id: 'pct-coronal',  label: 'PET-CT \u00b7 Coronal',  modality: 'PET', orientation: 'coronal',  accentColor: '#88dd88' },
  { id: 'pct-sagittal', label: 'PET-CT \u00b7 Sagittal', modality: 'PET', orientation: 'sagittal', accentColor: '#88dd88' },
];
const MIP_VIEWPORT = {
  id: 'mip', label: 'MIP \u00b7 WB', modality: 'MIP', orientation: 'coronal', accentColor: '#333333',
};

export const ALL_VP_DEFS = {
  'ct-axial':     CT_VIEWPORTS[0],
  'ct-coronal':   CT_VIEWPORTS[1],
  'ct-sagittal':  CT_VIEWPORTS[2],
  'pct-axial':    PET_VIEWPORTS[0],
  'pct-coronal':  PET_VIEWPORTS[1],
  'pct-sagittal': PET_VIEWPORTS[2],
  'mip':          MIP_VIEWPORT,
  'empty':        { id: 'empty', label: 'Empty', modality: null, accentColor: '#444' },
};

// The 7 real viewport ids (excludes the 'empty' placeholder) -- constant
// across every layout, only their grid position changes.
const ALL_VIEWPORT_IDS = Object.keys(ALL_VP_DEFS).filter(id => id !== 'empty');

// ---------------------------------------------------------------------------
// Layout definitions (unchanged from Session 12)
// ---------------------------------------------------------------------------
export const LAYOUT_DEFS = {
  '2x3mip': {
    gridTemplateColumns: '1fr 1fr 1fr 1fr',
    gridTemplateRows: '1fr 1fr',
    slots: [
      { vpKey: 'ct-axial'     },
      { vpKey: 'ct-coronal'   },
      { vpKey: 'ct-sagittal'  },
      { vpKey: 'mip', gridColumn: '4', gridRow: '1 / 3' },
      { vpKey: 'pct-axial'    },
      { vpKey: 'pct-coronal'  },
      { vpKey: 'pct-sagittal' },
    ],
  },
  '2x2': {
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr 1fr',
    slots: [
      { vpKey: 'ct-axial'   },
      { vpKey: 'ct-coronal' },
      { vpKey: 'pct-axial'  },
      { vpKey: 'mip'        },
    ],
  },
  '1x1': {
    gridTemplateColumns: '1fr',
    gridTemplateRows: '1fr',
    slots: [{ vpKey: 'ct-axial' }],
  },
  '3x3': {
    gridTemplateColumns: '1fr 1fr 1fr',
    gridTemplateRows: '1fr 1fr 1fr',
    slots: [
      { vpKey: 'ct-axial'    }, { vpKey: 'ct-coronal'   }, { vpKey: 'ct-sagittal'  },
      { vpKey: 'pct-axial'   }, { vpKey: 'pct-coronal'  }, { vpKey: 'pct-sagittal' },
      { vpKey: 'mip'         }, { vpKey: 'empty'         }, { vpKey: 'empty'        },
    ],
  },
  '1x3mpr': {
    gridTemplateColumns: '1fr 1fr 1fr',
    gridTemplateRows: '1fr',
    slots: [
      { vpKey: 'ct-axial'    },
      { vpKey: 'ct-coronal'  },
      { vpKey: 'ct-sagittal' },
    ],
  },
  '1x2': {
    gridTemplateColumns: '1fr 1fr',
    gridTemplateRows: '1fr',
    slots: [
      { vpKey: 'ct-axial'  },
      { vpKey: 'pct-axial' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Metadata registry + provider (unchanged from Session 12)
// ---------------------------------------------------------------------------
const metadataRegistry = new Map();

function fallbackMetadataProvider(type, imageId) {
  if (!metadataRegistry.has(imageId)) return undefined;
  const d = metadataRegistry.get(imageId);
  const generalSeriesModule = {
    modality: d.modality,
    seriesInstanceUID: d.seriesInstanceUID,
    seriesNumber: d.seriesNumber,
  };
  const imagePlaneModule = {
    imageOrientationPatient: d.imageOrientationPatient,
    imagePositionPatient: d.imagePositionPatient,
    pixelSpacing: d.pixelSpacing,
    rowPixelSpacing: d.pixelSpacing[1],
    columnPixelSpacing: d.pixelSpacing[0],
    rows: d.rows,
    columns: d.columns,
  };
  const imagePixelModule = {
    samplesPerPixel: 1,
    photometricInterpretation: 'MONOCHROME2',
    rows: d.rows,
    columns: d.columns,
    bitsAllocated: 16,
    bitsStored: 16,
    highBit: 15,
    pixelRepresentation: d.pixelRepresentation,
  };
  return {
    modality: d.modality,
    pixelRepresentation: d.pixelRepresentation,
    rows: d.rows,
    columns: d.columns,
    rescaleSlope: d.rescaleSlope,
    rescaleIntercept: d.rescaleIntercept,
    imagePositionPatient: d.imagePositionPatient,
    imageOrientationPatient: d.imageOrientationPatient,
    pixelSpacing: d.pixelSpacing,
    seriesInstanceUID: d.seriesInstanceUID,
    seriesNumber: d.seriesNumber,
    generalSeriesModule,
    imagePlaneModule,
    imagePixelModule,
    imagingParameters: {
      pixelRepresentation: d.pixelRepresentation,
      rows: d.rows,
      columns: d.columns,
      rescaleSlope: d.rescaleSlope,
      rescaleIntercept: d.rescaleIntercept,
      imagePositionPatient: d.imagePositionPatient,
      imageOrientationPatient: d.imageOrientationPatient,
      pixelSpacing: d.pixelSpacing,
    },
  };
}

let _providerRegistered = false;

// ---------------------------------------------------------------------------
// Image ID builder
// REST calls use getDicomWebRestBase(). Image IDs use getWadoBase().
// ---------------------------------------------------------------------------
async function _buildImageIds(studyUID, seriesUID) {
  const restBase = getDicomWebRestBase();
  const wadoBase = getWadoBase();

  const res = await fetch(`${restBase}/studies/${studyUID}/series/${seriesUID}/instances`);
  if (!res.ok) throw new Error(`Instances fetch failed: ${res.status} (REST base: ${restBase})`);
  const instances = await res.json();

  instances.sort((a, b) =>
    parseInt(a['00200013']?.Value?.[0] || '0', 10) -
    parseInt(b['00200013']?.Value?.[0] || '0', 10)
  );

  return instances.map(inst => {
    const sop = inst['00080018']?.Value?.[0];
    // WADO-URI: uses wadoBase (e.g. /orthanc) so Orthanc's /wado endpoint is hit.
    // Proxy strips /orthanc prefix -> :8042/wado?requestType=WADO&... (correct).
    const id = `wadouri:${wadoBase}/wado?requestType=WADO`
      + `&studyUID=${studyUID}`
      + `&seriesUID=${seriesUID}`
      + `&objectUID=${sop}`
      + `&contentType=application/dicom`;

    metadataRegistry.set(id, {
      modality:                inst['00080060']?.Value?.[0] || '',
      seriesInstanceUID:       seriesUID,
      seriesNumber:            inst['00200011']?.Value?.[0] ?? 1,
      pixelRepresentation:     inst['00280103']?.Value?.[0] ?? 0,
      rows:                    inst['00280010']?.Value?.[0] ?? 512,
      columns:                 inst['00280011']?.Value?.[0] ?? 512,
      rescaleSlope:            inst['00281053']?.Value?.[0] ?? 1,
      rescaleIntercept:        inst['00281052']?.Value?.[0] ?? 0,
      imagePositionPatient:    inst['00200032']?.Value ?? [0, 0, 0],
      imageOrientationPatient: inst['00200037']?.Value ?? [1, 0, 0, 0, 1, 0],
      pixelSpacing:            inst['00280030']?.Value ?? [1, 1],
    });

    return id;
  });
}

function _parseName(nameObj) {
  const raw = typeof nameObj === 'string' ? nameObj : nameObj?.Alphabetic || '';
  return raw.replace(/\^/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// MIP zoom parity (unchanged from Session 12)
// ---------------------------------------------------------------------------
function _syncMIPZoom(engine) {
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    try {
      const mipVP   = engine.getViewport('mip');
      const ctCorVp = engine.getViewport('ct-coronal');
      const mipCam  = mipVP?.getCamera();
      const ctCam   = ctCorVp?.getCamera();
      if (mipCam?.parallelScale > 100 && ctCam?.parallelScale > 100) {
        const targetScale = ctCam.parallelScale;
        mipVP.setCamera({ ...mipCam, parallelScale: targetScale });
        // No render() -- avoids Rule 32 shrink
        window.__mipScale = targetScale;
        console.log('[MIPZoom] parallelScale matched to ct-coronal:', targetScale);
        clearInterval(poll);

        // Lock MIP zoom via CAMERA_MODIFIED (CoreEnums.Events.CAMERA_MODIFIED).
        // No render() call here -- setCamera alone is enough; the MIP
        // rotation rAF picks it up on the next frame.
        const mipEl = mipVP.element;
        if (mipEl) {
          mipEl.addEventListener(CoreEnums.Events.CAMERA_MODIFIED, () => {
            try {
              const cam = mipVP.getCamera();
              if (window.__mipScale && Math.abs(cam.parallelScale - window.__mipScale) > 10) {
                mipVP.setCamera({ ...cam, parallelScale: window.__mipScale });
              }
            } catch(e) {}
          });
        }
      }
    } catch(e) {}
    if (attempts >= 20) clearInterval(poll);
  }, 500);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ViewportGrid({
  studyUID,
  ctWL,
  petWL,
  mipWL,
  onCTWL,
  onPETWL,
  onMIPWL,
  stackMode = false,
  petOpacity,
  onOpacity,
  onMetaLoaded,
  fusionMode = 'auto',
  fusionOffset = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
  layout = '2x3mip',
  boxAssignments = null,
  onBoxAssign,
  petPaletteId = 'inv_hot_iron',
  onPetPaletteChange,
  expandedId = null,
  onExpand,
}) {
  const [ctImageIds,   setCTImageIds]   = useState([]);
  const [petImageIds,  setPETImageIds]  = useState([]);
  const [mipImageIds,  setMIPImageIds]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [volumesReady, setVolumesReady] = useState(false);
  // volumeKey increments on each series swap to re-trigger ViewerBox setup
  // WITHOUT going through the loading screen (viewports stay mounted).
  const [volumeKey, setVolumeKey] = useState(0);

  // Manual series override (drag-and-drop from SeriesPanel onto CT-Axial /
  // PET-CT-Axial -- see handleSeriesDrop below). null = auto-pick via
  // _bestSeries as before. Reset whenever the study itself changes, since an
  // override from the previous study would be meaningless (and likely
  // missing) in a new one.
  const [ctOverrideSeriesUID,  setCtOverrideSeriesUID]  = useState(null);
  const [petOverrideSeriesUID, setPetOverrideSeriesUID] = useState(null);
  useEffect(() => {
    setCtOverrideSeriesUID(null);
    setPetOverrideSeriesUID(null);
  }, [studyUID]);

  const handleSeriesDrop = useCallback((modality, seriesUID) => {
    if (modality === 'CT') setCtOverrideSeriesUID(seriesUID);
    else if (modality === 'PT' || modality === 'PET') setPetOverrideSeriesUID(seriesUID);
  }, []);

  const ctImageIdsRef  = useRef([]);
  const petImageIdsRef = useRef([]);

  // Resize engine when a box expands/collapses so CS3D redraws at new size
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const eng = getRenderingEngine(RENDERING_ENGINE_ID);
        if (!eng) return;
        eng.resize(true, true);
        // After resize, let MIP find its natural scale then lock it
        // Clear __mipScale so the lock listener accepts the new post-resize scale
        window.__mipScale = null;
        setTimeout(() => {
          try {
            const mipVp = eng.getViewport('mip');
            if (mipVp) {
              const cam = mipVp.getCamera();
              if (cam?.parallelScale) {
                window.__mipScale = cam.parallelScale;
              }
            }
          } catch(e) {}
        }, 100);
      } catch(e) {}
    }, 50);
    return () => clearTimeout(timer);
  }, [expandedId]);

  const prevStudyUIDRef = useRef(null);

  useEffect(() => {
    if (!studyUID) return;
    let cancelled = false;

    if (!_providerRegistered) {
      metaData.addProvider(fallbackMetadataProvider, 100);
      _providerRegistered = true;
    }

    // Distinguish full study switch from same-study series override (drag-drop).
    // disableElement on a live viewport while CS3D is actively rendering causes
    // CONTEXT_LOST_WEBGL on Intel UHD -- only do it for true study changes.
    const isStudyChange = studyUID !== prevStudyUIDRef.current;
    prevStudyUIDRef.current = studyUID;

    (async () => {
      setLoading(true);
      setError(null);
      setVolumesReady(false);

      if (isStudyChange && !stackMode) {
        // Only tear down GPU resources for study changes in volume mode.
        // In stack mode there are no VTK volume allocations to clean up.
        try {
          const engine = getRenderingEngine(RENDERING_ENGINE_ID);
          if (engine) {
            ALL_VIEWPORT_IDS.forEach(id => {
              try { engine.disableElement(id); } catch(e) {}
            });
          }
        } catch(e) {}

        await new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
        });
      }

      try {
        // LOCAL STUDY DETECTION: Worklist.jsx stores imageIds for locally-loaded
        // DICOM files in window.__localStudyImageIds[studyUID]. If this key
        // exists, skip the Orthanc DICOMweb fetch entirely -- the files are
        // already registered as wadouri Object URLs in window.__localDicomFiles
        // and ready to stream directly into CS3D's volume cache.
        // For local studies we treat all imageIds as CT (no PET separation yet --
        // local file sets are typically a single modality series).
        const localEntry = window.__localStudyImageIds?.[studyUID];
        let ctIds, petIds;

        // localEntry is either the old flat array (legacy) or the new
        // { all, ct, pet } object written by the updated Worklist.jsx.
        const localIds = localEntry?.all || (Array.isArray(localEntry) ? localEntry : null);

        if (localIds?.length) {
          console.log('[ViewportGrid] local study -- CT:', (localEntry?.ct||localIds).length,
            'PET:', (localEntry?.pet||localIds).length);
          ctIds  = localEntry?.ct?.length  ? localEntry.ct  : localIds;
          petIds = localEntry?.pet?.length ? localEntry.pet : localIds;
        } else {
          const restBase = getDicomWebRestBase();
          const res = await fetch(`${restBase}/studies/${studyUID}/series`);
          if (!res.ok) throw new Error(
            `Series load failed: ${res.status} -- REST base: ${restBase}\n` +
            `Set window.__DICOMWEB_REST to override.`
          );
          const sList = await res.json();

          function _bestSeries(list, targetMod) {
            const mods = targetMod === 'PET' ? ['PT', 'PET'] : ['CT'];
            return list
              .filter(s => {
                const mod  = s['00080060']?.Value?.[0] || '';
                const desc = (s['0008103E']?.Value?.[0] || '').toLowerCase();
                if (!mods.includes(mod)) return false;
                if (desc.includes('nac') || desc.includes('non-corrected') ||
                    desc.includes('non corrected') || desc.includes('scout') ||
                    desc.includes('topogram') || desc.includes('surview') ||
                    desc.includes('localizer')) return false;
                return true;
              })
              .sort((a, b) => {
                const ai = parseInt(a['00201209']?.Value?.[0] || '0', 10);
                const bi = parseInt(b['00201209']?.Value?.[0] || '0', 10);
                return ai - bi;
              })[0] || null;
          }

          const ctSeries  = _bestSeries(sList, 'CT');
          const petSeries = _bestSeries(sList, 'PET');
          const ct  = ctSeries?.['0020000E']?.Value?.[0];
          const pet = petSeries?.['0020000E']?.Value?.[0];

          console.log('[ViewportGrid] REST base:', restBase, '| WADO base:', getWadoBase());
          console.log('[ViewportGrid] CT series:', ctSeries?.['0008103E']?.Value?.[0],
            '-- instances:', ctSeries?.['00201209']?.Value?.[0]);
          console.log('[ViewportGrid] PET series:', petSeries?.['0008103E']?.Value?.[0],
            '-- instances:', petSeries?.['00201209']?.Value?.[0]);

          if (!ct || !pet) throw new Error(
            `No matching CT + PET series found.\nStudy: ${studyUID}\nREST base: ${restBase}`
          );

          const ids = await Promise.all([
            _buildImageIds(studyUID, ct),
            _buildImageIds(studyUID, pet),
          ]);
          ctIds  = ids[0];
          petIds = ids[1];
        }

        if (cancelled) return;

        ctImageIdsRef.current  = ctIds;
        petImageIdsRef.current = petIds;

        if (!stackMode) {
          // Volume mode: allocate GPU volumes. Skip in stack mode to avoid
          // VTK shader compilation and CONTEXT_LOST_WEBGL on Intel UHD.
          purgeVolumes();
          resetFusionTransform();
          await ensureVolumes(ctIds, petIds);
          if (cancelled) return;
        }

        // SUV calibration metadata -- was never wired up, which is why every
        // ROI on the PET-CT row showed "No PET metadata loaded" instead of an
        // SUV value. Pulled from the PET series' DICOMweb tags already fetched
        // above (petSeries), falling back to today's date if SeriesDate/Time
        // are absent (suvUtils.initSUVMeta handles that fallback internally).
        try {
          const seriesDate = petSeries?.['00080021']?.Value?.[0];
          const seriesTime = petSeries?.['00080031']?.Value?.[0];
          initSUVMeta(petIds[0], seriesDate, seriesTime);
        } catch(e) {
          console.warn('[ViewportGrid] initSUVMeta failed:', e?.message);
        }

        // Auto-activate Crosshairs once all 6 MPR viewports are registered.
        // CS3D requires >= 2 viewports before Crosshairs can safely activate.
        // Each ViewerBox registers asynchronously, so poll until tg-mpr has
        // >= 6 viewports (20 x 300ms = 6 second window).
        ;(function _waitAndActivateCrosshairs() {
          let _attempts = 0;
          const _poll = setInterval(() => {
            _attempts++;
            try {
              const _tg = ToolGroupManager.getToolGroup('tg-mpr');
              if (!_tg) { if (_attempts >= 20) clearInterval(_poll); return; }
              const _vpIds = _tg.getViewportIds ? _tg.getViewportIds()
                : (_tg.viewportsInfo?.map(v => v.viewportId) || []);
              if (_vpIds.length >= 6) {
                clearInterval(_poll);
                try { setCrosshairsActive(true); } catch(e) {}
              }
            } catch(e) {}
            if (_attempts >= 20) clearInterval(_poll);
          }, 300);
        })();

        setCTImageIds(ctIds);
        setPETImageIds(petIds);
        setMIPImageIds(petIds);
        setVolumesReady(true);
        setLoading(false);

        if (!stackMode) {
          const engine = getRenderingEngine(RENDERING_ENGINE_ID);
          if (engine) _syncMIPZoom(engine);
        }

        // CT/PET size parity: copy parallelScale from each CT viewport to
        // its matching PET-CT viewport after 500ms (cameras stable by then).
        setTimeout(() => {
          try {
            const eng = getRenderingEngine(RENDERING_ENGINE_ID);
            if (!eng) return;
            const pairs = [
              ['ct-axial',    'pct-axial'],
              ['ct-coronal',  'pct-coronal'],
              ['ct-sagittal', 'pct-sagittal'],
            ];
            for (const [ctId, petId] of pairs) {
              const ctVp  = eng.getViewport(ctId);
              const petVp = eng.getViewport(petId);
              if (!ctVp || !petVp) continue;
              const ctCam  = ctVp.getCamera();
              if (!ctCam?.parallelScale) continue;
              const petCam = petVp.getCamera();
              petVp.setCamera({ ...petCam, parallelScale: ctCam.parallelScale });
              // No render() -- avoids Rule 32 camera reset shrink
            }
            // MIP zoom: MIP column spans 2 rows so parallelScale x2 matches CT size.
            const ctCorVp = eng.getViewport('ct-coronal');
            const mipVp   = eng.getViewport('mip');
            if (ctCorVp && mipVp) {
              const ctCorCam = ctCorVp.getCamera();
              const mipCam   = mipVp.getCamera();
              if (ctCorCam?.parallelScale && mipCam) {
                const targetScale = ctCorCam.parallelScale * 2;
                mipVp.setCamera({ ...mipCam, parallelScale: targetScale });
                try { mipVp.resize(); } catch(e) {}
                // No render() here -- avoids Rule 32 parallelScale reset shrink
                window.__mipScale = targetScale;
                console.log('[MIPZoom] matched to ct-coronal x2:', targetScale);
              }
            }
          } catch(e) {}
        }, 500);

        if (onMetaLoaded) {
          onMetaLoaded({
            patientName: _parseName(sList[0]?.['00100010']?.Value?.[0]),
            patientId:   sList[0]?.['00100020']?.Value?.[0] || '',
            studyDate:   sList[0]?.['00080020']?.Value?.[0] || '',
          });
        }

      } catch (err) {
        console.error('[ViewportGrid]', err);
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [studyUID, stackMode]); // series overrides handled by separate lightweight effect below

  // Lightweight series-override effect -- runs ONLY on drag-drop, NOT on
  // initial study load. Keeps viewports mounted (no setVolumesReady(false))
  // to avoid the CONTEXT_LOST_WEBGL crash caused by ViewerBox unmounting
  // while VTK's shader compiler is still running. Instead, just swap the
  // volume cache and update imageId props -- ViewerBox handles the rest.
  const prevCtOverrideRef  = useRef(null);
  const prevPetOverrideRef = useRef(null);

  useEffect(() => {
    // Skip on first render (both are null -- that's the initial state, handled
    // by the main effect above). Only act when a user explicitly drops a series.
    if (ctOverrideSeriesUID === prevCtOverrideRef.current &&
        petOverrideSeriesUID === prevPetOverrideRef.current) return;
    prevCtOverrideRef.current  = ctOverrideSeriesUID;
    prevPetOverrideRef.current = petOverrideSeriesUID;
    if (!studyUID || (!ctOverrideSeriesUID && !petOverrideSeriesUID)) return;

    // Local studies have no DICOM series UIDs to swap -- their imageIds
    // are a flat list from the filesystem. Skip the series swap entirely.
    if (window.__localStudyImageIds?.[studyUID]) {
      console.log('[ViewportGrid] local study -- series swap skipped');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const restBase = getDicomWebRestBase();
        const res = await fetch(`${restBase}/studies/${studyUID}/series`);
        if (!res.ok) return;
        const sList = await res.json();

        function _best(list, targetMod) {
          const mods = targetMod === 'PET' ? ['PT','PET'] : ['CT'];
          return list.filter(s => {
            const mod = s['00080060']?.Value?.[0] || '';
            const desc = (s['0008103E']?.Value?.[0] || '').toLowerCase();
            if (!mods.includes(mod)) return false;
            if (desc.includes('nac') || desc.includes('scout') ||
                desc.includes('topogram') || desc.includes('localizer')) return false;
            return true;
          }).sort((a,b) => {
            const ai = parseInt(a['00201209']?.Value?.[0]||'0',10);
            const bi = parseInt(b['00201209']?.Value?.[0]||'0',10);
            return ai - bi;
          })[0] || null;
        }

        const ctSer  = ctOverrideSeriesUID
          ? (sList.find(s => s['0020000E']?.Value?.[0] === ctOverrideSeriesUID) || _best(sList,'CT'))
          : null;
        const petSer = petOverrideSeriesUID
          ? (sList.find(s => s['0020000E']?.Value?.[0] === petOverrideSeriesUID) || _best(sList,'PET'))
          : null;

        const newCtIds  = ctSer  ? await _buildImageIds(studyUID, ctSer['0020000E']?.Value?.[0])
                                 : ctImageIdsRef.current;
        const newPetIds = petSer ? await _buildImageIds(studyUID, petSer['0020000E']?.Value?.[0])
                                 : petImageIdsRef.current;

        if (cancelled) return;

        // Swap the volume cache without tearing down viewports.
        // No disableElement -- viewports remain live. purgeVolumes frees the
        // old GPU buffers; ensureVolumes creates new ones for the swapped series.
        // ViewerBox.jsx detects the new imageIds via the prop change and calls
        // setVolumes() on the already-enabled viewport, which is safe.
        if (!stackMode) {
          purgeVolumes();
          resetFusionTransform();
          await ensureVolumes(newCtIds, newPetIds);
          if (cancelled) return;
        }

        ctImageIdsRef.current  = newCtIds;
        petImageIdsRef.current = newPetIds;

        // Bump volumeKey to re-trigger ViewerBox setup (re-wires VTK actors
        // to the new volumes). volumesReady stays true -- no loading screen,
        // no viewport unmount, no CONTEXT_LOST_WEBGL.
        setCTImageIds(newCtIds);
        setPETImageIds(newPetIds);
        setMIPImageIds(newPetIds);
        setVolumeKey(k => k + 1);
        console.log('[ViewportGrid] series swap complete -- CT:', newCtIds.length, 'PET:', newPetIds.length);
      } catch(e) {
        console.warn('[ViewportGrid] series swap failed:', e?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [ctOverrideSeriesUID, petOverrideSeriesUID]);

  // Slot resolution (unchanged)
  const layoutDef   = LAYOUT_DEFS[layout] || LAYOUT_DEFS['2x3mip'];
  const activeSlots = layoutDef.slots.map((slot, idx) => {
    const vpKey = (boxAssignments?.[idx]) ? boxAssignments[idx] : slot.vpKey;
    const vpDef = ALL_VP_DEFS[vpKey] || ALL_VP_DEFS['empty'];
    return { slotIdx: idx, vpDef, gridColumn: slot.gridColumn, gridRow: slot.gridRow };
  });

  const imageIdsFor = (modality) => {
    if (modality === 'CT')  return ctImageIds;
    if (modality === 'PET') return petImageIds;
    if (modality === 'MIP') return mipImageIds;
    return [];
  };

  if (loading) return (
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', background: '#111', color: '#aaa', fontSize: 13 }}>
      Streaming DICOM volumes from PACS...
    </div>
  );

  if (error) return (
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', background: '#111', color: '#ff6b6b', fontSize: 13, padding: 20, flexDirection: 'column', gap: 8 }}>
      <div>Load error</div>
      <div style={{ color: '#888', fontSize: 10, whiteSpace: 'pre-wrap', maxWidth: 500 }}>{error}</div>
    </div>
  );

  return (
    <div style={{
      display: 'grid', flex: 1,
      gridTemplateColumns: expandedId ? '1fr' : layoutDef.gridTemplateColumns,
      gridTemplateRows:    expandedId ? '1fr' : layoutDef.gridTemplateRows,
      gap: 2, padding: 2, background: '#ffffff',
      minHeight: 0, height: '100%',
    }}>
      {activeSlots.map(({ slotIdx, vpDef, gridColumn, gridRow }) => {
        // When a box is expanded, hide all others
        if (expandedId && vpDef.id !== expandedId) return null;

        if (!vpDef.modality) {
          return (
            <div key={`empty-${slotIdx}`} style={{
              background: '#050505', border: '1px dashed #222', borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#333', fontSize: 11, position: 'relative',
              gridColumn: expandedId ? undefined : (gridColumn || undefined),
              gridRow:    expandedId ? undefined : (gridRow    || undefined),
            }}>
              <BoxPicker slotIdx={slotIdx} onBoxAssign={onBoxAssign} alwaysVisible />
              <span>Empty</span>
            </div>
          );
        }

        return (
          <div key={vpDef.id} style={{
            display: 'flex', flexDirection: 'column', position: 'relative',
            gridColumn: expandedId ? undefined : (gridColumn || undefined),
            gridRow:    expandedId ? undefined : (gridRow    || undefined),
            minHeight: 0, height: '100%',
            background: vpDef.modality === 'MIP' ? '#ffffff' : undefined,
          }}>
            <ViewerBox
              viewportId={vpDef.id}
              modality={vpDef.modality}
              label={vpDef.label}
              accentColor={vpDef.accentColor}
              orientation={vpDef.orientation}
              renderMode={stackMode ? 'stack' : 'volume'}
              imageIds={imageIdsFor(vpDef.modality)}
              volumesReady={volumesReady}
              volumeKey={volumeKey}
              wl={vpDef.modality === 'CT' ? ctWL : vpDef.modality === 'MIP' ? (mipWL || petWL) : petWL}
              onWL={vpDef.modality === 'CT' ? onCTWL : vpDef.modality === 'MIP' ? (onMIPWL || onPETWL) : onPETWL}
              ctWLFusion={ctWL}
              petWLFusion={petWL}
              petOpacity={petOpacity}
              onOpacity={onOpacity}
              fusionMode={fusionMode}
              fusionOffset={fusionOffset}
              // Palette sync: pct- boxes share petPaletteId; MIP is independent
              paletteOverride={vpDef.modality === 'PET' ? petPaletteId : null}
              onPaletteChange={vpDef.modality === 'PET' ? onPetPaletteChange : null}
              isExpanded={expandedId === vpDef.id}
              onDoubleClick={() => onExpand?.(expandedId === vpDef.id ? null : vpDef.id)}
              toolGroupId={
                vpDef.modality === 'CT'  ? 'tg-ct'  :
                vpDef.modality === 'PET' ? 'tg-pet' :
                vpDef.modality === 'MIP' ? 'tg-mpr' : undefined
              }
              // Drag-and-drop series loading (from SeriesPanel): only the
              // axial box of each row accepts drops -- coronal/sagittal are
              // always MPR-reconstructed from that same volume, never
              // separately loadable. studyUID passed so ViewerBox can
              // validate the dropped series actually belongs to this study.
              onSeriesDrop={vpDef.id === 'ct-axial' || vpDef.id === 'pct-axial' || vpDef.id === 'mip' ? handleSeriesDrop : undefined}
              dropStudyUID={studyUID}
            />
            <BoxPicker slotIdx={slotIdx} onBoxAssign={onBoxAssign} />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BoxPicker (unchanged from Session 12)
// ---------------------------------------------------------------------------
const VP_OPTIONS = [
  { vpKey: 'ct-axial',     label: 'CT \u00b7 Axial'        },
  { vpKey: 'ct-coronal',   label: 'CT \u00b7 Coronal'      },
  { vpKey: 'ct-sagittal',  label: 'CT \u00b7 Sagittal'     },
  { vpKey: 'pct-axial',    label: 'PET-CT \u00b7 Axial'    },
  { vpKey: 'pct-coronal',  label: 'PET-CT \u00b7 Coronal'  },
  { vpKey: 'pct-sagittal', label: 'PET-CT \u00b7 Sagittal' },
  { vpKey: 'mip',          label: 'MIP \u00b7 WB'          },
  { vpKey: 'empty',        label: 'Empty'                   },
];

function BoxPicker({ slotIdx, onBoxAssign, alwaysVisible = false }) {
  const [open,    setOpen]    = useState(false);
  const [hovered, setHovered] = useState(false);
  if (!onBoxAssign) return null;
  const show = alwaysVisible || hovered || open;

  return (
    <div
      style={{ position: 'absolute', top: 4, right: 4, zIndex: 100 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setOpen(false); }}
    >
      {show && (
        <div style={{
          width: 18, height: 18, background: 'rgba(30,30,30,0.85)',
          border: '1px solid #444', borderRadius: 3,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', fontSize: 11, color: '#aaa',
        }} onClick={() => setOpen(v => !v)} title="Reassign viewport">&#9881;</div>
      )}
      {open && (
        <div style={{
          position: 'absolute', top: 22, right: 0,
          background: 'rgba(18,18,18,0.97)', border: '1px solid #333',
          borderRadius: 4, padding: '3px 0', minWidth: 140,
          boxShadow: '0 4px 12px rgba(0,0,0,0.7)', zIndex: 200,
        }}>
          <div style={{ padding: '3px 8px', fontSize: 8, color: '#555', borderBottom: '1px solid #222', marginBottom: 2 }}>
            ASSIGN VIEWPORT
          </div>
          {VP_OPTIONS.map(opt => (
            <div key={opt.vpKey}
              style={{ padding: '5px 10px', fontSize: 10, color: '#ccc', cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = '#252525'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              onClick={() => { onBoxAssign(slotIdx, opt.vpKey); setOpen(false); }}
            >{opt.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
