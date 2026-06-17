/**
 * ViewportGrid.jsx — Phase 3 (MPR · Fusion · Crosshairs)
 * 2×3 viewport grid + right MIP column.
 * Row 1: CT Axial, CT Coronal, CT Sagittal      → ORTHOGRAPHIC CT volume (true MPR)
 * Row 2: PET-CT Axial, Coronal, Sagittal        → FUSION (CT base + PET overlay)
 * Right col (spans both rows): MIP              → PET maximum-intensity projection
 *
 * Phase 3 changes vs Phase 1/2:
 *   - CT + PET volumes are built ONCE (volumeManager.ensureVolumes) and shared
 *     across all viewports, so coronal/sagittal are real reconstructions instead
 *     of the axial stack.
 *   - The six MPR viewports join TOOL_GROUP_MPR, which carries the CrosshairsTool;
 *     because the fusion viewports use CT as volume[0], all six share the CT
 *     Frame Of Reference and the crosshairs link them together.
 *   - Set RENDER_MODE = 'stack' to fall straight back to the Phase 1/2 behaviour.
 *
 * W/L separation rule (unchanged):
 *   CT W/L  (blue)  → CT row + CT base of fusion
 *   PET W/L (green) → PET overlay of fusion + MIP
 *   SUV threshold   → all 3 PET-CT viewports
 */

import { useState, useEffect } from 'react';
import { getRenderingEngine } from '@cornerstonejs/core';
import ViewerBox from './ViewerBox.jsx';
import { TOOL_GROUP_CT, TOOL_GROUP_PET, TOOL_GROUP_MPR, RENDERING_ENGINE_ID } from '../cornerstone-init.js';
import { ensureVolumes, purgeVolumes } from '../utils/volumeManager.js';
import { resetFusionTransform } from '../utils/fusionManager.js';

// 'volume' → Phase 3 MPR/fusion/crosshairs · 'stack' → Phase 1/2 fallback
const RENDER_MODE = 'volume';

// Orthanc QIDO-RS base via Vite proxy
const BASE = '/orthanc/dicom-web';

// ── Viewport definitions ───────────────────────────────────────────────────────
const CT_VIEWPORTS = [
  { id: 'ct-axial',    label: 'CT · Axial',    modality: 'CT', orientation: 'axial',    accentColor: '#88c4ff' },
  { id: 'ct-coronal',  label: 'CT · Coronal',  modality: 'CT', orientation: 'coronal',  accentColor: '#88c4ff' },
  { id: 'ct-sagittal', label: 'CT · Sagittal', modality: 'CT', orientation: 'sagittal', accentColor: '#88c4ff' },
];
const PET_VIEWPORTS = [
  { id: 'pct-axial',    label: 'PET-CT · Axial',    modality: 'PET', orientation: 'axial',    accentColor: '#88dd88' },
  { id: 'pct-coronal',  label: 'PET-CT · Coronal',  modality: 'PET', orientation: 'coronal',  accentColor: '#88dd88' },
  { id: 'pct-sagittal', label: 'PET-CT · Sagittal', modality: 'PET', orientation: 'sagittal', accentColor: '#88dd88' },
];
const MIP_VIEWPORT = { id: 'mip', label: 'MIP · WB', modality: 'MIP', orientation: 'coronal', accentColor: '#333333' };

export default function ViewportGrid({
  studyUID,
  ctWL, petWL, onCTWL, onPETWL,
  suvThreshold, onSUV,
  petOpacity, onOpacity,
  activeToolCT, activeToolPET,
  expandedId, onExpand,
  syncScroll = true,
  syncZoom   = false,
  syncPan    = false,
  onMetaLoaded,   // Phase 5: callback(meta) fired once when patient/study info is ready
  // -- Phase 4 -- fusion controls
  fusionMode   = 'auto',
  fusionOffset = { tx:0, ty:0, tz:0, rx:0, ry:0, rz:0 },
  fusionFixed  = false,
}) {
  const [ctImageIds,  setCTImageIds]  = useState([]);
  const [petImageIds, setPETImageIds] = useState([]);
  const [mipImageIds, setMIPImageIds] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error,   setError]           = useState(null);
  const [seriesInfo, setSeriesInfo]   = useState({ ct: null, pet: null });
  const [volumesReady, setVolumesReady] = useState(false);

  // ── Fetch series from Orthanc ─────────────────────────────────────────────
  useEffect(() => {
    if (!studyUID) return;
    setLoading(true);
    setError(null);
    setVolumesReady(false);
    if (RENDER_MODE === 'volume') { purgeVolumes(); resetFusionTransform(); }

    async function loadSeries() {
      try {
        const res  = await fetch(`${BASE}/studies/${studyUID}/series`);
        if (!res.ok) throw new Error(`QIDO-RS ${res.status}`);
        const series = await res.json();

        const ctSeries  = series.find(s => _modality(s) === 'CT');
        const petSeries = series.find(s => _modality(s) === 'PT');

        if (!ctSeries)  throw new Error('No CT series found in study');
        if (!petSeries) throw new Error('No PET (PT) series found in study');

        const ctUID  = _seriesUID(ctSeries);
        const petUID = _seriesUID(petSeries);

        setSeriesInfo({
          ct:  { uid: ctUID,  desc: _desc(ctSeries)  },
          pet: { uid: petUID, desc: _desc(petSeries) },
        });

        const [ctIds, petIds] = await Promise.all([
          _buildImageIds(studyUID, ctUID),
          _buildImageIds(studyUID, petUID),
        ]);

        setCTImageIds(ctIds);
        setPETImageIds(petIds);
        setMIPImageIds(petIds);

        console.log(`[ViewportGrid] CT: ${ctIds.length} images, PET: ${petIds.length} images`);

        // ── Phase 5: fire complete patient/study/thumbnail meta once ─────────
        // QIDO-RS carries patient/study tags on every series object.
        // All data (instance UIDs for thumbnails) is available here after
        // _buildImageIds, so we call onMetaLoaded exactly once with everything.
        if (onMetaLoaded) {
          try {
            const s = ctSeries
            const extractSOP = id => (id.match(/objectUID=([^&]+)/) || [])[1] || ''
            onMetaLoaded({
              name:        _parseName(s['00100010']?.Value?.[0]),
              dob:         s['00100030']?.Value?.[0] || '',
              sex:         s['00100040']?.Value?.[0] || '',
              studyDate:   s['00080020']?.Value?.[0] || '',
              studyDesc:   s['00081030']?.Value?.[0] || _desc(ctSeries) || '',
              institution: s['00080080']?.Value?.[0]
                        || petSeries['00080080']?.Value?.[0] || '',
              ctCount:     ctIds.length,
              petCount:    petIds.length,
              ctSeriesUID: ctUID,
              petSeriesUID: petUID,
              studyUID,
              // Middle slice is more representative than slice 0
              ctThumbSOP:  extractSOP(ctIds[Math.floor(ctIds.length  / 2)]),
              petThumbSOP: extractSOP(petIds[Math.floor(petIds.length / 2)]),
            })
          } catch(e) {
            console.warn('[ViewportGrid] onMetaLoaded failed:', e)
          }
        }

        // Phase 3 — build (and start streaming) both volumes once, up front.
        if (RENDER_MODE === 'volume') {
          await ensureVolumes(ctIds, petIds);
          setVolumesReady(true);
          console.log('[ViewportGrid] volumes created — MPR/fusion ready');
        }
      } catch(e) {
        setError(e.message);
        console.error('[ViewportGrid] loadSeries error:', e);
      } finally {
        setLoading(false);
      }
    }

    loadSeries();
  }, [studyUID]);

  // ── Camera sync fallback: belt-and-suspenders for CT/PET size parity ────────
  // ViewerBox.jsx does the primary sync via a one-shot IMAGE_RENDERED listener
  // on each PET viewport (fires after the first render, after resetCamera settles).
  // This fallback runs at 500ms — by then both CT and PET viewports have rendered
  // at least once and their cameras are stable.
  useEffect(() => {
    if (!volumesReady) return;
    const pairs = [
      ['ct-axial',    'pct-axial'],
      ['ct-coronal',  'pct-coronal'],
      ['ct-sagittal', 'pct-sagittal'],
    ];
    const timer = setTimeout(() => {
      try {
        const engine = getRenderingEngine(RENDERING_ENGINE_ID);
        if (!engine) return;
        for (const [ctId, petId] of pairs) {
          const ctVp  = engine.getViewport(ctId);
          const petVp = engine.getViewport(petId);
          if (!ctVp || !petVp) continue;
          const ctCam  = ctVp.getCamera();
          if (!ctCam?.parallelScale) continue;
          const petCam = petVp.getCamera();
          // Only apply if parallelScale still differs (primary sync may have already fixed it)
          if (Math.abs((petCam?.parallelScale || 0) - ctCam.parallelScale) > 0.01) {
            petVp.setCamera({ ...petCam, parallelScale: ctCam.parallelScale });
            petVp.render();
          }
        }
      } catch(e) {}
    }, 500);
    return () => clearTimeout(timer);
  }, [volumesReady]);

  // ── Layout helpers ────────────────────────────────────────────────────────
  if (!studyUID) return <EmptyState message="No study selected. Open a study from the left panel." />;
  if (loading)   return <EmptyState message="Loading series…" spinner />;
  if (error)     return <EmptyState message={`Error: ${error}`} isError />;

  const isVolume = RENDER_MODE === 'volume';
  // In volume mode the box waits on volumesReady; in stack mode it waits on imageIds.
  const ctReady  = isVolume ? volumesReady : ctImageIds.length  > 0;
  const petReady = isVolume ? volumesReady : petImageIds.length > 0;

  // Shared props that distinguish Phase 3 volume rendering from stack rendering.
  const volProps = (vp) => isVolume ? {
    renderMode:  'volume',
    orientation: vp.orientation,
    volumesReady,
    ctWLFusion:  ctWL,
    petWLFusion: petWL,
  } : { renderMode: 'stack' };

  // Fusion props added only to PET-CT viewports (modality === 'PET')
  const fusionProps = (vp) => vp.modality === 'PET' ? { fusionMode, fusionOffset } : {};

  // ── Expanded (single viewport full-screen) ────────────────────────────────
  if (expandedId) {
    const all = [...CT_VIEWPORTS, ...PET_VIEWPORTS, MIP_VIEWPORT];
    const vp  = all.find(v => v.id === expandedId);
    if (!vp) return null;
    const isCT  = vp.modality === 'CT';
    const isPET = vp.modality === 'PET';
    const ids   = isCT ? ctImageIds : isPET ? petImageIds : mipImageIds;
    return (
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <ViewerBox
          viewportId={vp.id}
          label={vp.label}
          modality={vp.modality}
          accentColor={vp.accentColor}
          imageIds={ids}
          toolGroupId={isCT || isPET ? (isVolume ? TOOL_GROUP_MPR : (isCT ? TOOL_GROUP_CT : TOOL_GROUP_PET)) : TOOL_GROUP_PET}
          wl={isCT ? ctWL : petWL}
          onWL={isCT ? onCTWL : onPETWL}
          suvMin={suvThreshold?.min} suvMax={suvThreshold?.max} onSUV={onSUV}
          petOpacity={petOpacity} onOpacity={onOpacity}
          activeToolOverride={isCT ? activeToolCT : activeToolPET}
          isExpanded
          onDoubleClick={() => onExpand(null)}
          {...volProps(vp)}
        />
      </div>
    );
  }

  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: 'hidden', display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      gap: 3, padding: 3,
    }}>
      {/* Row 1 — CT viewports (CT volume MPR) */}
      {CT_VIEWPORTS.map(vp => (
        <div key={vp.id} style={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
          <ViewerBox
            viewportId={vp.id}
            label={vp.label}
            modality={vp.modality}
            accentColor={vp.accentColor}
            imageIds={ctReady ? ctImageIds : []}
            toolGroupId={isVolume ? TOOL_GROUP_MPR : TOOL_GROUP_CT}
            wl={ctWL}
            onWL={onCTWL}
            activeToolOverride={activeToolCT}
            syncScroll={syncScroll} syncZoom={syncZoom} syncPan={syncPan}
            onDoubleClick={() => onExpand(vp.id)}
            {...volProps(vp)}
          />
        </div>
      ))}

      {/* MIP — spans 2 rows, col 4 (PET MIP, never crosshair-linked) */}
      <div style={{
        position: 'relative', minWidth: 0, minHeight: 0,
        gridColumn: 4, gridRow: '1 / 3',
      }}>
        <ViewerBox
          viewportId={MIP_VIEWPORT.id}
          label={MIP_VIEWPORT.label}
          modality={MIP_VIEWPORT.modality}
          accentColor={MIP_VIEWPORT.accentColor}
          imageIds={petReady ? mipImageIds : []}
          toolGroupId={TOOL_GROUP_PET}
          wl={petWL}
          onWL={onPETWL}
          onDoubleClick={() => onExpand(MIP_VIEWPORT.id)}
          {...(isVolume ? { renderMode: 'volume', orientation: MIP_VIEWPORT.orientation, volumesReady } : { renderMode: 'stack' })}
        />
      </div>

      {/* Row 2 — PET-CT viewports (CT+PET fusion) */}
      {PET_VIEWPORTS.map(vp => (
        <div key={vp.id} style={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
          <ViewerBox
            viewportId={vp.id}
            label={vp.label}
            modality={vp.modality}
            accentColor={vp.accentColor}
            imageIds={petReady ? petImageIds : []}
            toolGroupId={isVolume ? TOOL_GROUP_MPR : TOOL_GROUP_PET}
            wl={petWL}
            onWL={onPETWL}
            suvMin={suvThreshold?.min}
            suvMax={suvThreshold?.max}
            onSUV={onSUV}
            petOpacity={petOpacity}
            onOpacity={onOpacity}
            activeToolOverride={activeToolPET}
            syncScroll={syncScroll} syncZoom={syncZoom} syncPan={syncPan}
            onDoubleClick={() => onExpand(vp.id)}
            {...volProps(vp)}
            {...fusionProps(vp)}
          />
        </div>
      ))}
    </div>
  );
}

// ── Empty / loading state ─────────────────────────────────────────────────────
function EmptyState({ message, spinner, isError }) {
  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: isError ? '#ff6b6b' : '#666', fontSize: 12, fontFamily: 'monospace', gap: 8,
      background: '#050505',
    }}>
      {spinner && <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>}
      {message}
    </div>
  );
}

// ── Orthanc DICOMweb helpers ──────────────────────────────────────────────────
function _modality(series) {
  return series['00080060']?.Value?.[0] || '';
}
function _seriesUID(series) {
  return series['0020000E']?.Value?.[0] || '';
}
function _desc(series) {
  return series['0008103E']?.Value?.[0] || '';
}
// PatientName in QIDO-RS: { Alphabetic: "FAMILY^GIVEN" } or a plain string.
// Convert to "GIVEN FAMILY" display form.
function _parseName(nameObj) {
  const raw = typeof nameObj === 'string' ? nameObj
    : nameObj?.Alphabetic || nameObj?.value || String(nameObj || '')
  if (!raw) return ''
  if (raw.includes('^')) {
    const parts = raw.split('^').map(p => p.trim()).filter(Boolean)
    // [0]=family, [1]=given, [2]=middle — display as "Given Family"
    return [...parts.slice(1), parts[0]].join(' ')
  }
  return raw
}

async function _buildImageIds(studyUID, seriesUID) {
  const res = await fetch(`${BASE}/studies/${studyUID}/series/${seriesUID}/instances`);
  if (!res.ok) throw new Error(`QIDO-RS instances ${res.status}`);
  const instances = await res.json();

  // Sort by instance number (0020,0013)
  instances.sort((a, b) => {
    const an = parseInt(a['00200013']?.Value?.[0] || '0', 10);
    const bn = parseInt(b['00200013']?.Value?.[0] || '0', 10);
    return an - bn;
  });

  return instances.map(inst => {
    const sopUID     = inst['00080018']?.Value?.[0] || '';
    const serUID     = inst['0020000E']?.Value?.[0] || seriesUID;
    const studUID    = inst['0020000D']?.Value?.[0] || studyUID;
    return `wadouri:/orthanc/wado?requestType=WADO&studyUID=${studUID}&seriesUID=${serUID}&objectUID=${sopUID}&contentType=application/dicom`;
  });
}
