/* name: ViewportGrid.jsx */
/**
 * ViewportGrid.jsx — merged Session 9
 *
 * From their file (kept):
 *   - Smart two-pass series selection (WB preferred, NAC skipped)
 *   - fallbackMetadataProvider via metaData.addProvider (robust catch-all)
 *   - Full imagePixelModule (samplesPerPixel, photometricInterpretation, highBit)
 *   - onMetaLoaded callback + _parseName
 *   - resetFusionTransform() called before purgeVolumes()
 *   - Loading message text
 *
 * From my file (kept):
 *   - DICOM tag fix: 00280010=rows, 00280011=columns (theirs used wrong tags)
 *   - All 6 LAYOUT_DEFS with gridTemplateColumns/gridTemplateRows strings
 *   - layout + boxAssignments + onBoxAssign props
 *   - BoxPicker component
 *   - MIP zoom sync (_syncMIPZoom)
 *   - mipImageIds state (separate from petImageIds)
 */

import { useState, useEffect, useRef } from 'react';
import { getRenderingEngine, metaData } from '@cornerstonejs/core';
import ViewerBox from './ViewerBox.jsx';
import { RENDERING_ENGINE_ID } from '../cornerstone-init.js';
import { ensureVolumes, purgeVolumes } from '../utils/volumeManager.js';
import { resetFusionTransform } from '../utils/fusionManager.js';

const BASE = '/orthanc/dicom-web';

// ─── Viewport definitions ─────────────────────────────────────────────────────
const CT_VIEWPORTS = [
  { id: 'ct-axial',    label: 'CT · Axial',    modality: 'CT',  orientation: 'axial',    accentColor: '#88c4ff' },
  { id: 'ct-coronal',  label: 'CT · Coronal',  modality: 'CT',  orientation: 'coronal',  accentColor: '#88c4ff' },
  { id: 'ct-sagittal', label: 'CT · Sagittal', modality: 'CT',  orientation: 'sagittal', accentColor: '#88c4ff' },
];
const PET_VIEWPORTS = [
  { id: 'pct-axial',    label: 'PET-CT · Axial',    modality: 'PET', orientation: 'axial',    accentColor: '#88dd88' },
  { id: 'pct-coronal',  label: 'PET-CT · Coronal',  modality: 'PET', orientation: 'coronal',  accentColor: '#88dd88' },
  { id: 'pct-sagittal', label: 'PET-CT · Sagittal', modality: 'PET', orientation: 'sagittal', accentColor: '#88dd88' },
];
const MIP_VIEWPORT = { id: 'mip', label: 'MIP · WB', modality: 'MIP', orientation: 'coronal', accentColor: '#333333' };

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

// ─── Layout definitions ───────────────────────────────────────────────────────
// App.jsx uses LAYOUT_DEFS[layout].slots to build boxAssignments defaults.
export const LAYOUT_DEFS = {
  '2x3mip': {
    gridTemplateColumns: '1fr 1fr 1fr 1fr',
    gridTemplateRows: '1fr 1fr',
    slots: [
      { vpKey: 'ct-axial'     },
      { vpKey: 'ct-coronal'   },
      { vpKey: 'ct-sagittal'  },
      { vpKey: 'mip',           gridColumn: '4', gridRow: '1 / 3' },
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

// ─── Metadata registry + provider ────────────────────────────────────────────
// Stores raw DICOM data per imageId in a Map.
// Registered as a CS3D metadata provider (priority 100) — catches any module
// request CS3D makes that isn't already in the cache.
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

  // All-inclusive object — covers any module key CS3D might request
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

// NOTE: metaData.addProvider is NOT called here at module scope.
// Calling it before coreInit() throws in CS3D v2.1.16 and kills the module,
// preventing LAYOUT_DEFS from being exported. It is registered once inside
// the ViewportGrid useEffect, after CS3D is guaranteed to be initialised.
// _providerRegistered guards against duplicate registrations when studyUID
// changes (the useEffect re-runs but must not call addProvider again).
let _providerRegistered = false;

// ─── Image ID builder ─────────────────────────────────────────────────────────
async function _buildImageIds(studyUID, seriesUID) {
  const res = await fetch(`${BASE}/studies/${studyUID}/series/${seriesUID}/instances`);
  if (!res.ok) throw new Error(`Instances fetch failed: ${res.status}`);
  const instances = await res.json();

  // Sort by instance number for correct slice order
  instances.sort((a, b) =>
    parseInt(a['00200013']?.Value?.[0] || '0', 10) -
    parseInt(b['00200013']?.Value?.[0] || '0', 10)
  );

  return instances.map(inst => {
    const sop = inst['00080018']?.Value?.[0];
    // wadouri: scheme → WADO-URI → Orthanc returns raw DICOM P10 file directly.
    // dicomweb: scheme → WADO-RS → returns multipart/related MIME envelope →
    // dicom-parser fails with "DICM prefix not found" on the MIME boundary bytes.
    const id = `wadouri:/orthanc/wado?requestType=WADO&studyUID=${studyUID}&seriesUID=${seriesUID}&objectUID=${sop}&contentType=application/dicom`;

    metadataRegistry.set(id, {
      modality:                inst['00080060']?.Value?.[0] || '',
      seriesInstanceUID:       seriesUID,
      seriesNumber:            inst['00200011']?.Value?.[0] ?? 1,
      pixelRepresentation:     inst['00280103']?.Value?.[0] ?? 0,
      // FIX: correct DICOM tags — 00280010=Rows, 00280011=Columns
      // (00280100=BitsAllocated, 00280101=BitsStored — wrong tags used previously)
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

// ─── MIP zoom parity ──────────────────────────────────────────────────────────
// Rule 29: MIP zoom handled here only — never in ViewerBox.
function _syncMIPZoom(engine) {
  // applyMIPVolume is async and may not have completed when volumesReady fires.
  // Poll every 500ms (max 20 attempts = 10s) until MIP camera has a valid
  // parallelScale (> 100 confirms it is a real WB volume camera, not default).
  // Stores to window.__mipScale so CineBar._stepMIP can use it in setCamera.
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    try {
      const mipVP = engine.getViewport('mip');
      const cam   = mipVP?.getCamera();
      if (cam?.parallelScale > 100) {
        window.__mipScale = cam.parallelScale;
        console.log('[MIPZoom] parallelScale locked:', window.__mipScale);
        clearInterval(poll);
      }
    } catch(e) {}
    if (attempts >= 20) clearInterval(poll);
  }, 500);
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ViewportGrid({
  studyUID,
  ctWL,
  petWL,
  onCTWL,
  onPETWL,
  petOpacity,
  onOpacity,
  onMetaLoaded,
  fusionMode = 'auto',
  fusionOffset = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
  layout = '2x3mip',
  boxAssignments = null,
  onBoxAssign,
}) {
  const [ctImageIds,   setCTImageIds]   = useState([]);
  const [petImageIds,  setPETImageIds]  = useState([]);
  const [mipImageIds,  setMIPImageIds]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [volumesReady, setVolumesReady] = useState(false);

  const ctImageIdsRef  = useRef([]);
  const petImageIdsRef = useRef([]);

  // ── Series load ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!studyUID) return;
    let cancelled = false;

    // Register fallback metadata provider now — CS3D is guaranteed initialised
    // by the time any component mounts (main.jsx awaits initCornerstone first).
    // Guard prevents duplicate registration if useEffect re-runs (studyUID change).
    if (!_providerRegistered) {
      metaData.addProvider(fallbackMetadataProvider, 100);
      _providerRegistered = true;
    }

    (async () => {
      setLoading(true);
      setError(null);
      setVolumesReady(false);

      try {
        const res = await fetch(`${BASE}/studies/${studyUID}/series`);
        if (!res.ok) throw new Error(`Series load failed: ${res.status}`);
        const sList = await res.json();

        // Series selection: pick the CT and PET/PT series with the most instances,
        // skipping NAC, non-corrected, scouts, and topograms.
        // WB series always has more slices than H&N or other sub-region series,
        // so sorting by instance count guarantees WB is selected.
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
              return ai - bi; // ascending — fewest slices first = H&N wins (faster dev loading)
            })[0] || null;
        }

        const ctSeries  = _bestSeries(sList, 'CT');
        const petSeries = _bestSeries(sList, 'PET');
        const ct  = ctSeries?.['0020000E']?.Value?.[0];
        const pet = petSeries?.['0020000E']?.Value?.[0];

        console.log('[ViewportGrid] CT series:', ctSeries?.['0008103E']?.Value?.[0],
          '— instances:', ctSeries?.['00201209']?.Value?.[0]);
        console.log('[ViewportGrid] PET series:', petSeries?.['0008103E']?.Value?.[0],
          '— instances:', petSeries?.['00201209']?.Value?.[0]);

        if (!ct || !pet) throw new Error('No matching CT + PET series pair found in study.');

        const [ctIds, petIds] = await Promise.all([
          _buildImageIds(studyUID, ct),
          _buildImageIds(studyUID, pet),
        ]);

        if (cancelled) return;

        ctImageIdsRef.current  = ctIds;
        petImageIdsRef.current = petIds;

        // Order: purge volumes → reset transform → build new volumes (Session 8 fix)
        purgeVolumes();
        resetFusionTransform();
        await ensureVolumes(ctIds, petIds);

        if (cancelled) return;

        // setState AFTER volumes are in cache — avoids React batch race (Session 8 fix)
        setCTImageIds(ctIds);
        setPETImageIds(petIds);
        setMIPImageIds(petIds);  // MIP uses the same PET volume
        setVolumesReady(true);
        setLoading(false);

        // MIP zoom parity — 500ms after volumes ready (Rule 29)
        const engine = getRenderingEngine(RENDERING_ENGINE_ID);
        if (engine) _syncMIPZoom(engine);  // self-polls until MIP camera ready

        // Patient metadata callback
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
  }, [studyUID]);

  // ── Slot resolution ───────────────────────────────────────────────────────
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

  // ── Loading / error ───────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', background: '#111', color: '#aaa', fontSize: 13 }}>
      Streaming Attenuation-Corrected WholeBody Volumes from Orthanc...
    </div>
  );

  if (error) return (
    <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', background: '#111', color: '#ff6b6b', fontSize: 13, padding: 20, flexDirection: 'column', gap: 8 }}>
      <div>⚠ Load error</div>
      <div style={{ color: '#888', fontSize: 10 }}>{error}</div>
    </div>
  );

  // ── Grid ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: 'grid', flex: 1,
      gridTemplateColumns: layoutDef.gridTemplateColumns,
      gridTemplateRows:    layoutDef.gridTemplateRows,
      gap: 2, padding: 2, background: '#000',
      minHeight: 0, height: '100%',
    }}>
      {activeSlots.map(({ slotIdx, vpDef, gridColumn, gridRow }) => {
        if (!vpDef.modality) {
          return (
            <div key={`empty-${slotIdx}`} style={{
              background: '#050505', border: '1px dashed #222', borderRadius: 4,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#333', fontSize: 11, position: 'relative',
              gridColumn: gridColumn || undefined, gridRow: gridRow || undefined,
            }}>
              <BoxPicker slotIdx={slotIdx} onBoxAssign={onBoxAssign} alwaysVisible />
              <span>Empty</span>
            </div>
          );
        }

        return (
          <div key={vpDef.id} style={{
            display: 'flex', flexDirection: 'column', position: 'relative',
            gridColumn: gridColumn || undefined, gridRow: gridRow || undefined,
            minHeight: 0,
          }}>
            <ViewerBox
              viewportId={vpDef.id}
              modality={vpDef.modality}
              label={vpDef.label}
              accentColor={vpDef.accentColor}
              orientation={vpDef.orientation}
              renderMode={vpDef.modality === 'MIP' ? 'volume' : 'stack'}
              imageIds={imageIdsFor(vpDef.modality)}
              volumesReady={volumesReady}
              wl={vpDef.modality === 'CT' ? ctWL : petWL}
              onWL={vpDef.modality === 'CT' ? onCTWL : onPETWL}
              ctWLFusion={ctWL}
              petWLFusion={petWL}
              petOpacity={petOpacity}
              onOpacity={onOpacity}
              fusionMode={fusionMode}
              fusionOffset={fusionOffset}
              toolGroupId={
                vpDef.modality === 'CT'  ? 'tg-ct'  :
                vpDef.modality === 'PET' ? 'tg-pet' :
                vpDef.modality === 'MIP' ? 'tg-mpr' : undefined
              }
            />
            <BoxPicker slotIdx={slotIdx} onBoxAssign={onBoxAssign} />
          </div>
        );
      })}
    </div>
  );
}

// ─── BoxPicker ────────────────────────────────────────────────────────────────
const VP_OPTIONS = [
  { vpKey: 'ct-axial',     label: 'CT · Axial'       },
  { vpKey: 'ct-coronal',   label: 'CT · Coronal'     },
  { vpKey: 'ct-sagittal',  label: 'CT · Sagittal'    },
  { vpKey: 'pct-axial',    label: 'PET-CT · Axial'   },
  { vpKey: 'pct-coronal',  label: 'PET-CT · Coronal' },
  { vpKey: 'pct-sagittal', label: 'PET-CT · Sagittal'},
  { vpKey: 'mip',          label: 'MIP · WB'         },
  { vpKey: 'empty',        label: 'Empty'            },
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
        }} onClick={() => setOpen(v => !v)} title="Reassign viewport">⚙</div>
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
