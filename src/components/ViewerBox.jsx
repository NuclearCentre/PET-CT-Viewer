/**
 * ViewerBox.jsx — Single Cornerstone3D viewport
 *
 * Mouse bindings:
 *   Left drag    → Pan
 *   Right drag   → Zoom
 *   Middle drag  → Window/Level
 *   Wheel        → Scroll slices
 *
 * Combo bindings (hold both buttons, then drag):
 *   Middle + Right → draw Straight Line  (LengthTool)
 *   Middle + Left  → draw Circle ROI     (CircleROITool)
 *   Right  + Left  → move annotations    (passive tool grab)
 *
 * Combo state machine:
 *   On first pointerdown, we record which button was pressed.
 *   On second pointerdown (while first still held), we detect the combo,
 *   suppress the default CS3D tool for that button, and activate the
 *   annotation tool on Primary binding instead.
 *   On either button release, we deactivate the combo tool and restore
 *   the original navigation tool.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  getRenderingEngine,
  Enums as CoreEnums,
  eventTarget,
  getEnabledElementByViewportId,
} from '@cornerstonejs/core';
import {
  ToolGroupManager,
  Enums as ToolEnums,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  annotation,
} from '@cornerstonejs/tools';

function triggerAnnotationRenderForViewportIds(viewportIds) {
  if (!viewportIds || !viewportIds.length) return;
  viewportIds.forEach((vid) => {
    const ee = getEnabledElementByViewportId(vid);
    if (ee && ee.viewport) {
      annotation.state.getAnnotationManager();
      ee.viewport.render();
    }
  });
}
import {
  RENDERING_ENGINE_ID,
  SYNC_SCROLL_ID, SYNC_ZOOM_ID, SYNC_PAN_ID, SYNC_VIEWPORT_IDS,
  addViewportToSync,
  removeViewportFromSync,
  setCrosshairsActive,
} from '../cornerstone-init.js';
import { getColor, getCssGradient, CT_PALETTES, PET_PALETTES } from '../utils/colourPalettes.js';
import {
  ORIENTATION,
  CT_VOLUME_ID,
  applyCTVolume,
  applyFusionVolumes,
  applyMIPVolume,
  setFusionPetProperties,
  setPetOpacity,
  getOrientationMarkers,
} from '../utils/volumeManager.js';
import { applyFusionTransform, resetFusionTransform } from '../utils/fusionManager.js';

const { ViewportType, Events, OrientationAxis } = CoreEnums;
const { MouseBindings, KeyboardBindings } = ToolEnums;

const DEFAULT_COLORMAP = { CT: 'gray', PET: 'hot_iron', MIP: 'gray' }

// MIP renders on a BLACK clear colour, then App.css inverts the whole canvas
// (filter: invert(1)) → black background becomes white, bright uptake becomes
// dark. CT/PET stay black, un-inverted.
const VP_BACKGROUND = { CT: [0,0,0], PET: [0,0,0], MIP: [0,0,0] };

// Ribbon tool ids → CS3D v2.1.16 toolNames (verified from package source).
// The Ribbon passes ids like 'line'; setToolActive needs 'Length'. Without this
// mapping, toolbar tool buttons silently failed to activate any tool.
const TOOL_ID_TO_CS = {
  pan:         'Pan',
  zoom:        'Zoom',
  wl:          'WindowLevel',
  scroll:      'StackScroll',
  line:        'Length',
  circle:      'CircleROI',
  rect:        'RectangleROI',
  ellipse:     'EllipticalROI',
  angle:       'Angle',
  arrow_thin:  'ArrowAnnotate',
  arrow_thick: 'ArrowAnnotate',
  text:        'ArrowAnnotate',
  probe:       'Probe',
  voi:         'RectangleROI',
  freehand:    'PlanarFreehandROI',
  // 'crosshair' handled separately (setCrosshairsActive)
  // 'delete' / 'clear' are actions, not tools — ignored here
};

const CT_PRESETS = [
  { label:'Brain',       ww:80,   wc:40   },
  { label:'Subdural',    ww:200,  wc:75   },
  { label:'Lungs',       ww:1500, wc:-600 },
  { label:'Mediastinum', ww:350,  wc:50   },
  { label:'Liver',       ww:150,  wc:30   },
  { label:'Abdomen',     ww:400,  wc:50   },
  { label:'Bone',        ww:2000, wc:450  },
  { label:'Sinuses',     ww:3000, wc:500  },
];
const PET_PRESETS = [
  { label:'Standard',    ww:10000, wc:5000  },
  { label:'High uptake', ww:5000,  wc:2500  },
  { label:'Low uptake',  ww:20000, wc:10000 },
];

export default function ViewerBox({
  viewportId,
  modality = 'CT',
  label = 'CT · Axial',
  accentColor = '#88c4ff',
  imageIds = [],
  toolGroupId,
  wl = { wc: 40, ww: 400 },
  onWL,
  petOpacity = 0.6,
  onOpacity,
  suvMin = 0,
  suvMax = 10,
  onSUV,
  activeToolOverride = null,
  isExpanded = false,
  onDoubleClick,
  // Sync flags passed from parent
  syncScroll = true,
  syncZoom   = false,
  syncPan    = false,
  // ── Phase 3 — volume / MPR / fusion ──────────────────────────────────────
  renderMode = 'stack',          // 'stack' (Phase 1/2) | 'volume' (Phase 3)
  orientation = 'axial',         // 'axial' | 'coronal' | 'sagittal'
  volumesReady = false,          // gate: volumes built before we render
  ctWLFusion,                    // CT base W/L for fusion viewports
  petWLFusion,                   // PET overlay W/L for fusion viewports
  // -- Phase 4 -- fusion mode controls
  fusionMode = 'auto',           // 'auto' | 'manual'
  fusionOffset = { tx:0,ty:0,tz:0,rx:0,ry:0,rz:0 },
}) {
  const divRef      = useRef(null);
  const hasVP          = useRef(false);
  const cameraSyncedRef = useRef(false);  // one-shot flag for PET↔CT camera sync
  const [paletteId, setPaletteId]     = useState(DEFAULT_COLORMAP[modality] || 'gray');
  const [showPalMenu, setShowPalMenu] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [sliceInfo, setSliceInfo]     = useState({ current: 0, total: 0 });
  const closeTimers = useRef({});

  const isVolume = renderMode === 'volume';

  // ── Viewport setup ────────────────────────────────────────────────────────
  useEffect(() => {
    // Gate: stack mode needs imageIds; volume mode needs the shared volumes built.
    const ready = isVolume ? volumesReady : imageIds.length > 0;
    if (!divRef.current || !ready) return;
    let cancelled = false;

    async function setup() {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID);
      if (!engine || cancelled) return;
      const el = divRef.current;

      engine.enableElement({
        viewportId,
        type: isVolume ? ViewportType.ORTHOGRAPHIC : ViewportType.STACK,
        element: el,
        defaultOptions: {
          background: VP_BACKGROUND[modality] || [0,0,0],
          ...(isVolume ? { orientation: ORIENTATION[orientation] || OrientationAxis.AXIAL } : {}),
        },
      });

      // div.viewport-element already has overflow:hidden (CS3D sets it in
      // getOrCreateCanvas.js). The SVG is inside it. Belt-and-suspenders:
      // also set overflow:hidden on the SVG itself.
      try {
        const svgLayer = el.querySelector('div.viewport-element > svg.svg-layer');
        if (svgLayer) svgLayer.style.overflow = 'hidden';
      } catch(e) {}

      const vp = engine.getViewport(viewportId);
      if (!vp || cancelled) return;

      if (toolGroupId) {
        const tg = ToolGroupManager.getToolGroup(toolGroupId);
        if (tg) tg.addViewport(viewportId, RENDERING_ENGINE_ID);
      }

      if (isVolume) {
        // ── Phase 3 — volume / MPR / fusion ─────────────────────────────────
        if (modality === 'CT') {
          await applyCTVolume(vp, { wl, colormapName: `petct_${paletteId}` });
        } else if (modality === 'PET') {
          await applyFusionVolumes(vp, {
            ctWL:  ctWLFusion  || { wc: 40,   ww: 400   },
            petWL: petWLFusion || wl,
            petColormapName: `petct_${paletteId}`,
            petOpacity,
          });
          // ── CT/PET size parity ─────────────────────────────────────────────
          // applyCTVolume and applyFusionVolumes each call resetCamera() which
          // fits the volume to the viewport. CT (600 slices, large FOV) and PET
          // (200 slices, smaller FOV) end up at different parallelScale values
          // → images appear different sizes.
          //
          // Fix: after the PET viewport's FIRST IMAGE_RENDERED (guarantees
          // applyCTVolume/applyFusionVolumes and their resetCamera() calls have
          // both completed), read the matching CT viewport's parallelScale and
          // apply it here. parallelScale only — position/focalPoint stay
          // independent so each plane shows the correct anatomy centre.
          //
          // cameraSyncedRef prevents this from running on every scroll render.
          // It resets to false in the useEffect cleanup so a re-mount re-syncs.
          cameraSyncedRef.current = false
          const syncCameraOnce = () => {
            if (cameraSyncedRef.current || cancelled) return
            cameraSyncedRef.current = true
            try {
              const engine = getRenderingEngine(RENDERING_ENGINE_ID)
              // pct-axial → ct-axial, pct-coronal → ct-coronal, pct-sagittal → ct-sagittal
              const ctId = viewportId.replace(/^pct-/, 'ct-')
              const ctVp = engine?.getViewport(ctId)
              if (!ctVp) return
              const ctCam  = ctVp.getCamera()
              if (!ctCam?.parallelScale) return
              const ourCam = vp.getCamera()
              vp.setCamera({ ...ourCam, parallelScale: ctCam.parallelScale })
              vp.render()
            } catch(e) {}
          }
          el.addEventListener(Events.IMAGE_RENDERED, syncCameraOnce, { once: true })
        } else { // MIP
          await applyMIPVolume(vp, { petWL: wl, colormapName: `petct_${paletteId}`, orientation });
        }
        if (cancelled) return;
        hasVP.current = true;

        // Volume viewports don't emit STACK_NEW_IMAGE — derive slice from the
        // camera on every render.
        const updateSlice = () => {
          try {
            const cur   = vp.getSliceIndex?.();
            const total = vp.getNumberOfSlices?.();
            if (typeof cur === 'number' && typeof total === 'number') {
              setSliceInfo({ current: cur + 1, total });
            }
          } catch(e) {}
        };
        el.addEventListener(Events.IMAGE_RENDERED, updateSlice);
        el.addEventListener(Events.CAMERA_MODIFIED, () => {
          updateSlice();
          setTimeout(_applyViewportVisibility, 50);
        });
        updateSlice();
      } else {
        // ── Phase 1/2 — stack ───────────────────────────────────────────────
        await vp.setStack(imageIds, 0);
        vp.resetCamera();
        _applyProps(vp, wl, paletteId);
        vp.render();
        hasVP.current = true;

        el.addEventListener(Events.STACK_NEW_IMAGE, (evt) => {
          const { imageIndex, numberOfFrames } = evt.detail;
          setSliceInfo({ current: imageIndex + 1, total: numberOfFrames });
          // Reapply viewport-scoped annotation visibility on each slice change
          setTimeout(_applyViewportVisibility, 50);
        });
      }

      // Add to synchronizers if this is a sync-eligible viewport.
      // (Volume MPR viewports are linked by the CrosshairsTool, so we skip the
      //  stack-image scroll synchronizer for them to avoid double-driving.)
      if (SYNC_VIEWPORT_IDS.includes(viewportId)) {
        if (syncScroll && !isVolume) addViewportToSync(SYNC_SCROLL_ID, viewportId);
        if (syncZoom)   addViewportToSync(SYNC_ZOOM_ID,   viewportId);
        if (syncPan)    addViewportToSync(SYNC_PAN_ID,    viewportId);
      }
    }

    setup().catch(e => console.error('[ViewerBox] setup error:', e));

    const ro = new ResizeObserver(() => {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID);
      if (engine) engine.resize(true, true);
    });
    if (divRef.current) ro.observe(divRef.current);

    return () => {
      cancelled = true;
      cameraSyncedRef.current = false;
      ro.disconnect();
      if (SYNC_VIEWPORT_IDS.includes(viewportId)) {
        removeViewportFromSync(SYNC_SCROLL_ID, viewportId);
        removeViewportFromSync(SYNC_ZOOM_ID,   viewportId);
        removeViewportFromSync(SYNC_PAN_ID,    viewportId);
      }
      try {
        const engine = getRenderingEngine(RENDERING_ENGINE_ID);
        if (engine) engine.disableElement(viewportId);
      } catch(e) {}
      hasVP.current = false;
    };
  }, [viewportId, imageIds, toolGroupId, renderMode, orientation, volumesReady]);

  // ── Sync flag changes → add/remove from synchronizers ────────────────────
  useEffect(() => {
    if (!hasVP.current || !SYNC_VIEWPORT_IDS.includes(viewportId)) return;
    if (syncScroll) addViewportToSync(SYNC_SCROLL_ID, viewportId);
    else removeViewportFromSync(SYNC_SCROLL_ID, viewportId);
  }, [syncScroll, viewportId]);

  useEffect(() => {
    if (!hasVP.current || !SYNC_VIEWPORT_IDS.includes(viewportId)) return;
    if (syncZoom) addViewportToSync(SYNC_ZOOM_ID, viewportId);
    else removeViewportFromSync(SYNC_ZOOM_ID, viewportId);
  }, [syncZoom, viewportId]);

  useEffect(() => {
    if (!hasVP.current || !SYNC_VIEWPORT_IDS.includes(viewportId)) return;
    if (syncPan) addViewportToSync(SYNC_PAN_ID, viewportId);
    else removeViewportFromSync(SYNC_PAN_ID, viewportId);
  }, [syncPan, viewportId]);

  // ── W/L update ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasVP.current) return;
    try {
      const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
      if (!vp) return;
      if (isVolume) {
        const cmap = `petct_${paletteId}`;
        if (modality === 'CT') {
          try { vp.setProperties({ voiRange: _voi(wl), colormap: { name: cmap } }); }
          catch(e) { vp.setProperties({ voiRange: _voi(wl) }); }
        } else if (modality === 'PET') {
          // CT base keeps its own W/L; PET overlay gets the green W/L + colormap.
          try { vp.setProperties({ voiRange: _voi(ctWLFusion || { wc:40, ww:400 }) }, CT_VOLUME_ID); } catch(e) {}
          setFusionPetProperties(vp, { petWL: petWLFusion || wl, petColormapName: cmap, petOpacity });
        } else { // MIP
          try { vp.setProperties({ voiRange: _voi(wl), colormap: { name: cmap } }); }
          catch(e) { vp.setProperties({ voiRange: _voi(wl) }); }
        }
        vp.render();
      } else {
        _applyProps(vp, wl, paletteId);
        vp.render();
      }
    } catch(e) {}
  }, [wl, paletteId, ctWLFusion, petWLFusion]);

  // ── PET overlay opacity (fusion blend slider) ─────────────────────────────
  useEffect(() => {
    if (!hasVP.current || !isVolume || modality !== 'PET') return;
    setPetOpacity(viewportId, petOpacity);
  }, [petOpacity]);

  // -- Phase 4: apply fusion transform when offset changes (PET viewports only) --
  // fusionOffset changes come from FusionPanel sliders in App.jsx.
  // fusionManager.applyFusionTransform sets the vtkActor user matrix on all 3
  // PET-CT viewports simultaneously, so this effect fires on any PET viewport
  // but the transform is applied to all three.
  useEffect(() => {
    if (!hasVP.current || !isVolume || modality !== 'PET') return
    const { tx, ty, tz, rx, ry, rz } = fusionOffset
    applyFusionTransform(tx, ty, tz, rx, ry, rz)
  }, [fusionOffset, modality, isVolume])

  // ── Toolbar tool override ─────────────────────────────────────────────────
  useEffect(() => {
    if (!toolGroupId) return;
    const tg = ToolGroupManager.getToolGroup(toolGroupId);
    if (!tg) return;

    // Phase 3: in volume/MPR mode the "Crosshair" toolbar button promotes the
    // always-visible reference lines to full click-to-navigate on left drag.
    if (isVolume) setCrosshairsActive(activeToolOverride === 'crosshair');
    if (activeToolOverride === 'crosshair') return; // handled by setCrosshairsActive

    // Map ribbon ids → CS3D toolNames; unknown/action ids restore Pan.
    const csName = activeToolOverride ? TOOL_ID_TO_CS[activeToolOverride] : null;

    if (csName) {
      try {
        // Activate the chosen tool on plain Primary (draw/use), keeping Pan off it.
        tg.setToolActive(csName, {
          bindings: [{ mouseButton: MouseBindings.Primary }],
        });
        tg.setToolPassive(PanTool.toolName);
      } catch(e) {}
    } else {
      try {
        tg.setToolActive(PanTool.toolName, {
          bindings: [{ mouseButton: MouseBindings.Primary }],
        });
      } catch(e) {}
    }

    // ALWAYS re-assert the ROI move/draw modifier bindings. setToolActive above
    // replaces a tool's binding list, which would otherwise wipe out Ctrl+drag
    // (move) and Shift+drag (draw). Re-applying them here keeps those gestures
    // working no matter what the toolbar selection is. A tool can hold several
    // bindings at once, so plain-Primary use + Ctrl-move coexist for ROIs.
    try {
      // CircleROI: Shift+Right draws, Ctrl+Left moves.
      tg.setToolActive('CircleROI', {
        bindings: [
          { mouseButton: MouseBindings.Secondary, modifierKey: KeyboardBindings.Shift },
          { mouseButton: MouseBindings.Primary,   modifierKey: KeyboardBindings.Ctrl  },
          ...(csName === 'CircleROI' ? [{ mouseButton: MouseBindings.Primary }] : []),
        ],
      });
      // Ellipse / Rect: Ctrl+Left moves (draw is via toolbar plain-Primary).
      ['EllipticalROI', 'RectangleROI'].forEach(name => {
        tg.setToolActive(name, {
          bindings: [
            { mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Ctrl },
            ...(csName === name ? [{ mouseButton: MouseBindings.Primary }] : []),
          ],
        });
      });
      // Length: Shift+Left draws, plus plain-Primary when chosen from toolbar.
      tg.setToolActive('Length', {
        bindings: [
          { mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Shift },
          ...(csName === 'Length' ? [{ mouseButton: MouseBindings.Primary }] : []),
        ],
      });
    } catch(e) {}
  }, [activeToolOverride, toolGroupId]);

  // ── Right-click delete popup ──────────────────────────────────────────────
  // CS3D captures right-button for Zoom. We detect a right-click that didn't
  // move (not a zoom drag) via pointerdown/pointerup distance check.
  const [deletePopup, setDeletePopup] = useState(null) // { x, y }
  const rightDownRef = useRef(null)

  useEffect(() => {
    const el = divRef.current
    if (!el) return

    function onPointerDown(e) {
      if (e.button !== 2) return
      rightDownRef.current = { x: e.clientX, y: e.clientY }
    }

    function onPointerUp(e) {
      if (e.button !== 2) return
      const down = rightDownRef.current
      if (!down) return
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      rightDownRef.current = null
      if (dist < 5) {
        // Only show the delete popup if the right-click landed ON an annotation
        // belonging to this viewport. Otherwise right-click is just Zoom.
        const hit = _annotationAtClient(e.clientX, e.clientY)
        if (hit) setDeletePopup({ x: e.clientX, y: e.clientY, uid: hit.annotationUID })
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup',   onPointerUp)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup',   onPointerUp)
    }
  }, [])

  useEffect(() => {
    if (!deletePopup) return
    const close = () => setDeletePopup(null)
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true }), 50)
  }, [deletePopup])

  // ── Viewport-scoped annotations ───────────────────────────────────────────
  // ANNOTATION_ADDED fires on eventTarget with evt.detail.viewportId.
  // Tag each annotation with sourceViewportId immediately, before first render.
  // Then _applyViewportVisibility hides it on all other viewports.
  useEffect(() => {
    const ADDED_EVENT     = 'CORNERSTONE_TOOLS_ANNOTATION_ADDED'
    const COMPLETED_EVENT = 'CORNERSTONE_TOOLS_ANNOTATION_COMPLETED'

    function onAdded(evt) {
      try {
        const ann = evt.detail?.annotation
        const vid = evt.detail?.viewportId
        if (!ann || !vid) return
        if (vid !== viewportId) return
        ann.metadata.sourceViewportId = viewportId

        // SUV ROI propagation rule (mirrors CT VOI across all 3 CT planes):
        // A CircleROI (or any ROI) drawn on a PET-CT fused viewport is tagged
        // rowShared=true + viewportRow='pct'. The annotation display filter in
        // cornerstone-init.js lets through any annotation whose viewportRow
        // matches the current viewport's row, so it renders in all 3 PET-CT
        // planes (axial, coronal, sagittal) with per-plane stats.
        // CT viewports are left exclusive (sourceViewportId only) per Rule 13.
        const isPCT = viewportId.startsWith('pct-')
        if (isPCT) {
          ann.metadata.rowShared   = true
          ann.metadata.viewportRow = 'pct'
        }

        console.log(`[ViewerBox] tagged annotation to ${viewportId}${isPCT ? ' (row-shared pct)' : ''}`)

        // Do NOT pre-position the textbox here. CS3D's getTextBoxCoordsCanvas
        // places text at the rightmost annotation point + 25px, which is
        // ADJACENT to the annotation with zero gap in the link line.
        // The ANNOTATION_RENDERED handler below clamps it into the safe zone
        // if it overflows a viewport edge — without introducing an artificial gap.
      } catch(e) {}
    }

    function onCompleted(evt) {
      setDrawingComplete(true)
      // Force stats recalculation with retry.
      // Root cause: CS3D's _calculateCachedStats silently skips when
      // getTargetImageData() returns null — the volume slice containing this
      // ROI hasn't streamed yet. We poll until stats appear.
      //
      // Uses triggerAnnotationRenderForViewportIds (CS3D's own API) instead of
      // vp.render() — this specifically re-runs renderAnnotation on every tool,
      // which calls _calculateCachedStats for any annotation with invalidated=true.
      // Plain vp.render() can skip annotation re-rendering in some CS3D code paths.
      //
      // 8 retries × 500ms = 4 seconds total coverage (handles slow networks /
      // large PET volumes where the specific slice may take time to stream).
      //
      // Row-shared PET-CT ROIs: trigger all 3 pct- viewports so each plane
      // computes its own cachedStats for the correct slice it is showing.
      try {
        const ann = evt?.detail?.annotation
        if (!ann) return
        ann.invalidated = true

        // Build the list of viewports to trigger.
        // If this is a row-shared pct annotation, include all pct- viewports
        // so every plane gets its own stats (axial SUV ≠ coronal SUV because
        // each plane intersects the ROI at a different depth through the volume).
        const isRowShared = ann.metadata?.rowShared && ann.metadata?.viewportRow === 'pct'
        const triggerIds = isRowShared
          ? ['pct-axial', 'pct-coronal', 'pct-sagittal']
          : [viewportId]

        let attempts = 0
        const tryRender = () => {
          attempts++
          try {
            const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
            if (!vp) return
            ann.invalidated = true
            // Use CS3D's targeted annotation render API — guarantees renderAnnotation
            // is called for every tool on this viewport, which re-runs cachedStats.
            try {
              triggerAnnotationRenderForViewportIds(triggerIds)
            } catch(e) {
              vp.render()  // fallback if the API throws
            }
            // Check if stats have landed
            const stats = ann.data?.cachedStats
            const hasStats = stats && Object.keys(stats).length > 0 &&
              Object.values(stats).some(v => v && typeof v === 'object' && v.mean != null)
            if (!hasStats && attempts < 8) {
              setTimeout(tryRender, 500)
            }
          } catch(e) {}
        }
        setTimeout(tryRender, 200)
      } catch(e) {}
    }

    eventTarget.addEventListener(ADDED_EVENT,     onAdded)
    eventTarget.addEventListener(COMPLETED_EVENT, onCompleted)
    return () => {
      eventTarget.removeEventListener(ADDED_EVENT,     onAdded)
      eventTarget.removeEventListener(COMPLETED_EVENT, onCompleted)
    }
  }, [viewportId])

  // ── Volume-loaded fallback for missing stats ──────────────────────────────
  // IMAGE_VOLUME_LOADING_COMPLETE fires once when the full volume has finished
  // streaming. Any ROI drawn during streaming whose poll window (4s) expired
  // before its slice loaded will have null cachedStats. This handler finds all
  // such annotations owned by this viewport and triggers one final render.
  useEffect(() => {
    const VOLUME_LOADED = CoreEnums.Events.IMAGE_VOLUME_LOADING_COMPLETE
    if (!VOLUME_LOADED) return  // guard: older CS3D versions

    function onVolumeLoaded() {
      try {
        const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
        if (!vp) return
        const all = annotation.state.getAllAnnotations() || []
        const needsStats = all.some(ann => {
          if (ann.metadata?.sourceViewportId !== viewportId) return false
          const stats = ann.data?.cachedStats
          // Has no stats or all stat objects are empty
          return !stats || Object.keys(stats).length === 0 ||
            !Object.values(stats).some(v => v && typeof v === 'object' && v.mean != null)
        })
        if (!needsStats) return
        // Invalidate all stat-missing annotations and trigger a render
        all.forEach(ann => {
          if (ann.metadata?.sourceViewportId !== viewportId) return
          const stats = ann.data?.cachedStats
          const missing = !stats || Object.keys(stats).length === 0 ||
            !Object.values(stats).some(v => v && typeof v === 'object' && v.mean != null)
          if (missing) ann.invalidated = true
        })
        try {
          triggerAnnotationRenderForViewportIds([viewportId])
        } catch(e) {
          try { vp.render() } catch(e2) {}
        }
      } catch(e) {}
    }

    eventTarget.addEventListener(VOLUME_LOADED, onVolumeLoaded)
    return () => eventTarget.removeEventListener(VOLUME_LOADED, onVolumeLoaded)
  }, [viewportId])

  // ---- Textbox safe-zone clamping ----------------------------------------
  // Hard constraint: the textbox NEVER leaves the viewport safe zone, including
  // after user drag. hasMoved=true makes CS3D use our corrected worldPosition
  // instead of recalculating from annotation geometry on the next render.
  //
  // Safe-zone margins:
  //   PL=8   left
  //   PR=30  right: 22px colormap strip + 8px margin
  //   PT=22  top: ~20px label bar + 2px
  //   PB=28  bottom: ~20px slice/info bar + 8px
  //
  // SHIFT MATH FIX (Session 6):
  //   worldBoundingBox corners are projected to canvas min/max (left/right/top/bottom).
  //   The correction is computed as the amount each edge overshoots its safe boundary,
  //   then applied to pos (the worldPosition anchor). Both X and Y checks are
  //   independent -- only the violated boundary contributes, never both at once,
  //   so the box is pinned to exactly the safe boundary rather than
  //   overshooting into the other edge when the box is large.
  //
  //   After correction we call triggerAnnotationRenderForViewportIds (not vp.render)
  //   so CS3D re-runs renderAnnotation immediately, committing the corrected SVG
  //   position in the same frame and preventing a stale-position flash.
  //
  // TIMING: three pointerup retries (t=0, 150, 300ms) cover the range from
  //   "CS3D has committed worldPosition" to "CS3D has set worldBoundingBox from
  //   the rendered position". The third retry catches slow GPU frames.
  const _clampAllTextboxes = useCallback(() => {
    try {
      const el = divRef.current
      if (!el) return
      const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
      if (!vp) return
      const W = el.clientWidth
      const H = el.clientHeight
      const PL = 8, PR = 30, PT = 22, PB = 28

      const all = annotation.state.getAllAnnotations()
      let needsRender = false

      for (const ann of (all || [])) {
        // Clamp textboxes for annotations that belong to this viewport
        // (either exclusively via sourceViewportId, or row-shared SUV ROIs
        //  that are being displayed here because viewportRow matches).
        const src = ann.metadata?.sourceViewportId
        const rowShared = ann.metadata?.rowShared
        const inRow = ann.metadata?.viewportRow
        const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null
        const belongsHere = src === viewportId || (rowShared && inRow && inRow === myRow)
        if (!belongsHere) continue
        const tb = ann.data?.handles?.textBox
        if (!tb) continue

        const wb = tb.worldBoundingBox
        if (!wb?.topLeft || !wb?.topRight || !wb?.bottomLeft || !wb?.bottomRight) continue
        try {
          // Project all 4 corners to canvas. worldToCanvas can flip axes in MPR
          // orientations so wb.topLeft is NOT necessarily the canvas top-left.
          // Using min/max is always orientation-correct.
          const cvCorners = [wb.topLeft, wb.topRight, wb.bottomLeft, wb.bottomRight]
            .map(w => vp.worldToCanvas(w))
          const xs     = cvCorners.map(c => c[0])
          const ys     = cvCorners.map(c => c[1])
          const left   = Math.min(...xs), right  = Math.max(...xs)
          const top    = Math.min(...ys), bottom = Math.max(...ys)
          const boxW   = right - left
          const boxH   = bottom - top

          // Current canvas position of the worldPosition anchor
          const pos = vp.worldToCanvas(tb.worldPosition)

          // --- X axis clamp ---
          // Compute desired canvas X so the box stays inside [PL, W-PR].
          // We clamp the left edge and right edge independently, then resolve.
          let targetX = pos[0]
          const overRight = right - (W - PR)     // positive = box extends past right safe edge
          const overLeft  = PL - left             // positive = box extends past left safe edge
          if (overRight > 0) targetX = pos[0] - overRight
          if (overLeft  > 0) targetX = pos[0] + overLeft
          // If box is wider than safe zone, pin left edge to PL
          if (boxW > (W - PL - PR)) targetX = pos[0] + (PL - left)

          // --- Y axis clamp ---
          let targetY = pos[1]
          const overBottom = bottom - (H - PB)
          const overTop    = PT - top
          if (overBottom > 0) targetY = pos[1] - overBottom
          if (overTop    > 0) targetY = pos[1] + overTop
          if (boxH > (H - PT - PB)) targetY = pos[1] + (PT - top)

          const dx = targetX - pos[0]
          const dy = targetY - pos[1]
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            tb.worldPosition = vp.canvasToWorld([targetX, targetY])
            tb.hasMoved = true
            needsRender = true
          }
        } catch(e) {}
      }

      if (needsRender) {
        // triggerAnnotationRenderForViewportIds re-runs renderAnnotation on every
        // tool for this viewport -- guarantees the corrected position is painted
        // in the same frame, preventing a stale-frame flash when the user drags
        // the box to a boundary and releases.
        try {
          triggerAnnotationRenderForViewportIds([viewportId])
        } catch(e) {
          try { vp.render() } catch(e2) {}
        }
      }
    } catch(e) {}
  }, [viewportId])

  // ── ANNOTATION_RENDERED: clamp textbox + draw handle dots ─────────────────
  // Fires after every SVG annotation repaint with current canvas coordinates.
  useEffect(() => {
    const RENDERED = 'CORNERSTONE_TOOLS_ANNOTATION_RENDERED'

    function onAnnotationRendered(evt) {
      if (evt.detail?.viewportId !== viewportId) return
      // 1) Clamp all textboxes into the safe zone.
      _clampAllTextboxes()

      // 2) Draw handle dots for ROI tools.
      try {
        const el = divRef.current
        if (!el) return
        const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
        if (!vp) return

        // ── Handle overlay ────────────────────────────────────────────────────
        // CS3D draws its own native <circle class="handle"> dots at the raw
        // points[] positions (2 for Circle, 4 for Ellipse, 2 for Rect).
        // We want richer geometry. Hide CS3D's dots per annotation UID (scoped —
        // LengthTool / Arrow etc. keep their own dots), then draw ours.
        const svgLayer = el.querySelector('div.viewport-element > svg.svg-layer')
        if (!svgLayer) return
        svgLayer.querySelector('#handle-overlay')?.remove()
        const svgns = 'http://www.w3.org/2000/svg'
        const g = document.createElementNS(svgns, 'g')
        g.setAttribute('id', 'handle-overlay')

        const OVERLAY_TOOLS = ['CircleROI', 'EllipticalROI', 'RectangleROI']
        const all = annotation.state.getAllAnnotations()
        const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null

        for (const ann of (all || [])) {
          // Draw handles for annotations that belong to this viewport either
          // exclusively (sourceViewportId) or as row-shared (viewportRow matches).
          const src = ann.metadata?.sourceViewportId
          const rowShared = ann.metadata?.rowShared && ann.metadata?.viewportRow === myRow
          if (src !== viewportId && !rowShared) continue
          if (!annotation.visibility.isAnnotationVisible(ann.annotationUID)) continue
          const toolName = ann.metadata?.toolName || ''
          if (!OVERLAY_TOOLS.includes(toolName)) continue
          const pts = ann.data?.handles?.points
          if (!pts || pts.length < 2) continue

          // Hide CS3D's native handle dots for this annotation only.
          try {
            svgLayer.querySelectorAll(`[data-id="${ann.annotationUID}"] circle.handle`)
              .forEach(c => { c.style.display = 'none' })
          } catch(e) {}

          const addDot = (wp, r, fill) => {
            try {
              const cv = vp.worldToCanvas(wp)
              const dot = document.createElementNS(svgns, 'circle')
              dot.setAttribute('cx', String(Math.round(cv[0])))
              dot.setAttribute('cy', String(Math.round(cv[1])))
              dot.setAttribute('r',  String(r))
              dot.setAttribute('fill', fill)
              dot.setAttribute('stroke', '#000')
              dot.setAttribute('stroke-width', '1')
              dot.setAttribute('pointer-events', 'none')
              g.appendChild(dot)
            } catch(e) {}
          }

          if (toolName === 'CircleROI') {
            // Canvas-space rim dots — correct for all MPR orientations.
            const c_cv   = vp.worldToCanvas(pts[0])
            const rim_cv = vp.worldToCanvas(pts[1])
            const r_px   = Math.hypot(rim_cv[0]-c_cv[0], rim_cv[1]-c_cv[1])
            addDot(pts[0], 5, 'rgba(0,220,255,0.9)')  // center cyan
            ;[0,45,90,135,180,225,270,315].forEach(deg => {
              const a = deg * Math.PI / 180
              const dot_cv = [c_cv[0] + r_px*Math.cos(a), c_cv[1] + r_px*Math.sin(a)]
              try { addDot(vp.canvasToWorld(dot_cv), 4, 'rgba(255,222,0,0.85)') } catch(e) {}
            })

          } else if (toolName === 'EllipticalROI') {
            pts.forEach(wp => addDot(wp, 4, 'rgba(255,222,0,0.85)'))

          } else if (toolName === 'RectangleROI') {
            const p0=pts[0], p1=pts[1]
            const x1=p0[0], y1=p0[1], z1=p0[2]||0
            const x2=p1[0], y2=p1[1], z2=p1[2]||0, mz=(z1+z2)/2
            ;[
              [x1,y1,z1],[x2,y1,z1],[x2,y2,z2],[x1,y2,z2],
              [(x1+x2)/2,y1,mz],[x2,(y1+y2)/2,mz],
              [(x1+x2)/2,y2,mz],[x1,(y1+y2)/2,mz],
            ].forEach(wp => addDot(wp, 4, 'rgba(255,222,0,0.85)'))
          }
        }

        if (g.childNodes.length) svgLayer.appendChild(g)
      } catch(e) {}
    }

    const MODIFIED = 'CORNERSTONE_TOOLS_ANNOTATION_MODIFIED'

    // Register clamp on every repaint and on annotation data changes
    eventTarget.addEventListener(RENDERED, onAnnotationRendered)
    eventTarget.addEventListener(MODIFIED, onAnnotationRendered)

    // pointerup backstop: fires after user releases a textbox drag.
    // t=0:   CS3D has committed worldPosition to the dragged location.
    // t=150: CS3D has set worldBoundingBox from the rendered position.
    // t=300: belt-and-suspenders for slow GPU render frames.
    // All three together guarantee the clamp always fires with current data
    // and the box can never be left outside the safe zone after a drag.
    const el = divRef.current
    const onPointerUp = () => {
      setTimeout(_clampAllTextboxes, 0)
      setTimeout(_clampAllTextboxes, 150)
      setTimeout(_clampAllTextboxes, 300)
    }
    if (el) el.addEventListener('pointerup', onPointerUp)

    return () => {
      eventTarget.removeEventListener(RENDERED, onAnnotationRendered)
      eventTarget.removeEventListener(MODIFIED, onAnnotationRendered)
      if (el) el.removeEventListener('pointerup', onPointerUp)
    }
  }, [viewportId, _clampAllTextboxes])

  function _applyViewportVisibility() {
    // VOLUME / MPR mode: do NOT touch annotation visibility. CS3D's annotation
    // visibility is GLOBAL, not per-viewport — and in MPR all six viewports share
    // the CT frame of reference, so hiding "other viewports'" annotations here
    // hides them EVERYWHERE, including the box they were just drawn in (they flash
    // then vanish). CS3D already scopes annotations by plane in MPR, so no manual
    // hiding is needed; an axial line simply won't render in coronal/sagittal.
    if (isVolume) return;
    try {
      const all = annotation.state.getAllAnnotations()
      if (!all?.length) return
      let changed = false
      all.forEach(ann => {
        const src = ann.metadata?.sourceViewportId
        if (!src) return // untagged — don't touch

        let shouldShow
        if (ann.metadata?.rowShared && ann.metadata?.viewportRow) {
          // Row-shared annotation: visible on all viewports in the same row.
          // (In stack mode this keeps the annotation visible on its source viewport;
          //  volume mode handles row visibility via filterInteractableAnnotationsForElement.)
          const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null
          shouldShow = myRow === ann.metadata.viewportRow
        } else {
          shouldShow = src === viewportId
        }

        const currently  = annotation.visibility.isAnnotationVisible(ann.annotationUID)
        if (shouldShow !== currently) {
          annotation.visibility.setAnnotationVisibility(ann.annotationUID, shouldShow)
          changed = true
        }
      })
      if (changed) _renderViewport()
    } catch(e) {}
  }

  // ── Annotation deletion ───────────────────────────────────────────────────
  // Track selected annotation UIDs via CS3D ANNOTATION_SELECTION_CHANGE event.
  // Show a floating delete toolbar when any annotation is selected.
  // NO right-click context menu — right-click is reserved for Zoom.
  const [selectedUIDs,    setSelectedUIDs]    = useState([]);
  const [drawingComplete, setDrawingComplete] = useState(false);

  useEffect(() => {
    function onSelectionChange() {
      try {
        const selected = annotation.selection.getAnnotationsSelected()
        if (!selected?.length) {
          setSelectedUIDs([])
          setDrawingComplete(false) // reset when deselected
          return
        }
        const mine = selected.filter(uid => {
          try {
            const ann = annotation.state.getAnnotation(uid)
            return ann?.metadata?.sourceViewportId === viewportId
          } catch(e) { return false }
        })
        setSelectedUIDs(mine)
      } catch(e) {
        setSelectedUIDs([])
      }
    }

    function onCompleted() {
      setDrawingComplete(true)
    }

    eventTarget.addEventListener('CORNERSTONE_TOOLS_ANNOTATION_SELECTION_CHANGE', onSelectionChange)
    eventTarget.addEventListener('CORNERSTONE_TOOLS_ANNOTATION_COMPLETED',        onCompleted)

    return () => {
      eventTarget.removeEventListener('CORNERSTONE_TOOLS_ANNOTATION_SELECTION_CHANGE', onSelectionChange)
      eventTarget.removeEventListener('CORNERSTONE_TOOLS_ANNOTATION_COMPLETED',        onCompleted)
    }
  }, [viewportId]);

  // ── Delete key — scoped to this viewport ─────────────────────────────────
  const pointerInsideRef = useRef(false)

  useEffect(() => {
    const el = divRef.current
    if (!el) return
    const onEnter = () => { pointerInsideRef.current = true }
    const onLeave = () => { pointerInsideRef.current = false }
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // Only delete if pointer is inside this viewport
      if (!pointerInsideRef.current) return
      _deleteSelected()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function _deleteSelected() {
    try {
      // Prefer the UIDs we captured on selection-change (the live selection is
      // often already cleared by the time the click handler runs).
      let uids = selectedUIDs;
      if (!uids?.length) uids = annotation.selection.getAnnotationsSelected() || [];
      uids.forEach(uid => { try { annotation.state.removeAnnotation(uid); } catch(e) {} });
      _renderAll();
    } catch(e) {}
    setSelectedUIDs([]);
  }

  function _deleteAnnotation(uid) {
    try {
      annotation.state.removeAnnotation(uid);
      _renderAll();
    } catch(e) {}
    setSelectedUIDs([]);
  }

  // Find the annotation belonging to THIS viewport nearest a screen point.
  // Right-click doesn't select annotations, so we hit-test the click against
  // each annotation's handle points + centroid (catches the outline AND the
  // middle of a line / centre of an ROI). Returns the annotation or null.
  function _annotationAtClient(clientX, clientY) {
    try {
      const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
      if (!vp || !vp.element || typeof vp.worldToCanvas !== 'function') return null;
      const rect = vp.element.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      const all = annotation.state.getAllAnnotations() || [];
      let best = null, bestDist = Infinity;
      for (const ann of all) {
        if (ann.metadata?.sourceViewportId !== viewportId) continue;
        const pts = ann.data?.handles?.points || [];
        if (!pts.length) continue;
        let sx = 0, sy = 0, n = 0;
        for (const wp of pts) {
          const cp = vp.worldToCanvas(wp);
          sx += cp[0]; sy += cp[1]; n++;
          const d = Math.hypot(cp[0] - cx, cp[1] - cy);
          if (d < bestDist) { bestDist = d; best = ann; }
        }
        if (n) { // centroid (≈ line midpoint / ROI centre)
          const d = Math.hypot(sx / n - cx, sy / n - cy);
          if (d < bestDist) { bestDist = d; best = ann; }
        }
      }
      return bestDist <= 50 ? best : null;
    } catch(e) { return null; }
  }

  // Right-click delete: remove the annotation under the cursor; if none is hit,
  // fall back to whatever is selected.
  function _deleteAtPoint(clientX, clientY) {
    const hit = _annotationAtClient(clientX, clientY);
    if (hit) {
      try { annotation.state.removeAnnotation(hit.annotationUID); _renderAll(); } catch(e) {}
      setSelectedUIDs([]);
      return;
    }
    _deleteSelected();
  }

  function _clearAllAnnotations() {
    try {
      const all = annotation.state.getAllAnnotations()
      if (!all?.length) return
      const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null
      // Only remove annotations tagged to this viewport directly, or row-shared
      // to this row. (Row-shared: single annotation object, removing it clears
      // all pct- planes simultaneously.)
      all.forEach(ann => {
        const src = ann.metadata?.sourceViewportId
        const rowShared = ann.metadata?.rowShared && ann.metadata?.viewportRow === myRow
        if (!src || src === viewportId || rowShared) {
          annotation.state.removeAnnotation(ann.annotationUID)
        }
      })
      _renderAll()
    } catch(e) {}
    setSelectedUIDs([])
  }

  function _renderViewport() {
    try {
      getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)?.render();
    } catch(e) {}
  }

  // Render every viewport — used after a delete so the annotation disappears
  // from all planes/boxes that were showing it (same-plane fusion view etc.).
  function _renderAll() {
    try { getRenderingEngine(RENDERING_ENGINE_ID)?.render(); } catch(e) {}
  }

  // ── Palette helpers ───────────────────────────────────────────────────────
  const palettes = modality === 'PET' ? PET_PALETTES : CT_PALETTES;
  const presets  = modality === 'PET' ? PET_PRESETS  : CT_PRESETS;

  const openPal  = () => { clearTimeout(closeTimers.current.pal); setShowPalMenu(true); };
  const closePal = () => { closeTimers.current.pal = setTimeout(() => setShowPalMenu(false), 180); };
  const openPre  = () => { clearTimeout(closeTimers.current.pre); setShowPresets(true); };
  const closePre = () => { closeTimers.current.pre = setTimeout(() => setShowPresets(false), 180); };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      onDoubleClick={onDoubleClick}
      className={modality === 'MIP' ? 'vp-mip' : undefined}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: modality === 'MIP' ? '#ffffff' : '#000000',
        border: `1.5px solid ${isExpanded ? accentColor : modality === 'MIP' ? '#cccccc' : '#252525'}`,
        borderRadius: 3,
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* CS3D viewport element — clipPath on BOTH the wrapper AND the element
          itself. CS3D appends its SVG annotation layer as a child of divRef,
          so clipping only the outer wrapper isn't enough — we must clip divRef
          too. Both use inset(0) which clips at the element boundary. */}
      <div style={{
        flex: 1, minHeight: 0, position: 'relative',
        overflow: 'hidden',
        clipPath: 'inset(0)',
      }}>
        <div
          ref={divRef}
          onContextMenu={e => e.preventDefault()}
          style={{
            position: 'absolute', inset: 0,
            overflow: 'hidden',
            clipPath: 'inset(0)',   // clips SVG annotation labels at this div's edge
          }}
        />
      </div>

      {/* Fusion alignment overlay -- manual mode, PET-CT viewports only.
          Dashed blue crosshair giving visual feedback that the PET layer is being
          shifted/rotated. Centred in the viewport; translates proportionally to TX/TY
          so the user can see the PET moving before the VTK actor re-renders. */}
      {isVolume && modality === 'PET' && fusionMode === 'manual' && (
        <FusionOverlay fusionOffset={fusionOffset} />
      )}

      {/* Orientation markers (R/L/A/P/S/I) — volume MPR viewports only */}
      {isVolume && modality !== 'MIP' && <OrientationMarkers orientation={orientation} />}

      {/* Label — top left */}
      <div style={{
        position: 'absolute', top: 6, left: 8,
        fontSize: 10, fontFamily: 'monospace',
        color: '#ffffff',
        pointerEvents: 'none', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,.9)',
      }}>
        {label}
      </div>

      {/* Patient info — top right */}
      <div style={{
        position: 'absolute', top: 6, right: 28,
        textAlign: 'right', pointerEvents: 'none', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,.9)',
      }}>
        <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#ffffff', lineHeight: 1.4 }}>
          ALKA JAGTAP · F · 52y
        </div>
        <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#dddddd', lineHeight: 1.4 }}>
          PET-CT · 28 Jan 2026
        </div>
        {sliceInfo.total > 0 && (
          <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#bbbbbb', lineHeight: 1.4 }}>
            {sliceInfo.current}/{sliceInfo.total}
          </div>
        )}
      </div>

      {/* Slice number — left middle */}
      {sliceInfo.total > 0 && (
        <div style={{
          position: 'absolute', left: 8, top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 11, fontFamily: 'monospace',
          color: '#ffffff', fontWeight: 'bold',
          pointerEvents: 'none', userSelect: 'none',
          textShadow: '0 1px 4px rgba(0,0,0,.9)',
          writingMode: 'vertical-rl',
          transform: 'translateY(-50%) rotate(180deg)',
        }}>
          {sliceInfo.current} / {sliceInfo.total}
        </div>
      )}

      {/* W/L display — bottom left, above cine bar */}
      <div style={{
        position: 'absolute', bottom: modality === 'PET' ? 52 : 24, left: 28,
        fontSize: 9, fontFamily: 'monospace', color: '#ffffff',
        pointerEvents: 'none', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,.9)',
      }}>
        W:{wl.ww} L:{wl.wc}
      </div>

      {/* SUV bar — PET only */}
      {modality === 'PET' && (
        <SUVBar suvMin={suvMin} suvMax={suvMax} onSUV={onSUV} />
      )}

      {/* Presets hover trigger */}
      <PresetBar
        presets={presets} accentColor={accentColor}
        open={showPresets} onEnter={openPre} onLeave={closePre}
        onSelect={p => { onWL?.(p.wc, p.ww); setShowPresets(false); }}
      />

      {/* Colormap strip — right edge */}
      <ColormapStrip
        paletteId={paletteId} palettes={palettes} wl={wl}
        modality={modality}
        onWLDrag={(c,w) => onWL?.(c,w)}
        showMenu={showPalMenu} onEnterMenu={openPal} onLeaveMenu={closePal}
        onSelectPalette={id => { setPaletteId(id); setShowPalMenu(false); }}
      />

      {/* PET opacity slider */}
      {modality === 'PET' && onOpacity && (
        <OpacityHandle opacity={petOpacity} onChange={onOpacity} />
      )}

      {/* MIP orientation bar — A/P/R/L/H/F buttons, MIP viewport only */}
      {modality === 'MIP' && <MIPOrientationBar viewportId={viewportId} />}

      {/* Cine controls — bottom of every box */}
      <CineBar viewportId={viewportId} modality={modality} isMIP={modality === 'MIP'} />

      {/* (Removed) auto-appearing "N selected / Delete" toolbar — it popped up
          immediately after every draw. Deletion is now via right-click on the
          annotation, or the Del key while hovering this box. */}

      {/* Clear all button — bottom right */}
      <div
        onMouseDown={e => { e.stopPropagation(); _clearAllAnnotations(); }}
        title="Clear all annotations"
        style={{
          position: 'absolute', bottom: modality === 'PET' ? 50 : 22, right: 28,
          fontSize: 8, color: '#aaaaaa', cursor: 'pointer',
          userSelect: 'none', zIndex: 60, padding: '1px 4px',
          textShadow: '0 1px 3px rgba(0,0,0,.9)',
        }}
        onMouseEnter={e => e.currentTarget.style.color = '#ff6666'}
        onMouseLeave={e => e.currentTarget.style.color = '#aaaaaa'}
      >⊘</div>

      {/* Right-click delete popup — only shows after a non-drag right click */}
      {deletePopup && (
        <div
          style={{
            position: 'fixed', left: deletePopup.x, top: deletePopup.y,
            background: '#111', border: '1px solid #444',
            borderRadius: 4, zIndex: 9999, overflow: 'hidden',
            boxShadow: '0 4px 16px rgba(0,0,0,.9)', minWidth: 160,
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div style={{ padding: '4px 10px', fontSize: 8, color: '#555', borderBottom: '1px solid #1e1e1e', textTransform: 'uppercase', letterSpacing: 1 }}>
            Annotations
          </div>
          <div
            onMouseDown={() => { if (deletePopup.uid) _deleteAnnotation(deletePopup.uid); else _deleteAtPoint(deletePopup.x, deletePopup.y); setDeletePopup(null); }}
            style={{ padding: '7px 12px', fontSize: 10, color: '#ff8888', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={e => e.currentTarget.style.background = '#1e1e1e'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          ><span>✕</span><span>Delete this annotation</span></div>
          <div
            onMouseDown={() => { _clearAllAnnotations(); setDeletePopup(null); }}
            style={{ padding: '7px 12px', fontSize: 10, color: '#cc6666', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #1a1a1a' }}
            onMouseEnter={e => e.currentTarget.style.background = '#1e1e1e'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          ><span>⊘</span><span>Clear all in this box</span></div>
          <div style={{ padding: '4px 10px', fontSize: 8, color: '#444', borderTop: '1px solid #1a1a1a' }}>
            Del key = delete selected
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Orientation markers (R/L/A/P/S/I) ──────────────────────────────────────────
function OrientationMarkers({ orientation }) {
  const m = getOrientationMarkers(orientation);
  const base = {
    position: 'absolute', color: '#ffcc66', fontSize: 10, fontWeight: 'bold',
    fontFamily: 'monospace', pointerEvents: 'none', userSelect: 'none',
    textShadow: '0 1px 3px rgba(0,0,0,.95)', opacity: 0.85, zIndex: 50,
  };
  return (
    <>
      <div style={{ ...base, top: 4,  left: '50%', transform: 'translateX(-50%)' }}>{m.top}</div>
      <div style={{ ...base, bottom: 24, left: '50%', transform: 'translateX(-50%)' }}>{m.bottom}</div>
      <div style={{ ...base, left: 26, top: '50%', transform: 'translateY(-50%)' }}>{m.left}</div>
      <div style={{ ...base, right: 26, top: '50%', transform: 'translateY(-50%)' }}>{m.right}</div>
    </>
  );
}


// --- FusionOverlay component --------------------------------------------------
// Dashed blue crosshair overlay for manual PET-CT fusion mode.
// Rendered as two absolutely-positioned divs on top of the CS3D canvas.
// The crosshair origin shifts proportionally to TX/TY (1px per mm, capped at 40px)
// so the user can see the PET layer moving even before the VTK actor re-renders.
// RZ rotation is shown as a small arc indicator in the corner.
function FusionOverlay({ fusionOffset }) {
  const { tx, ty, rz } = fusionOffset
  // Visual feedback scale: 1px per mm, capped so lines stay inside the viewport
  const ox = Math.max(-40, Math.min(40, tx))
  const oy = Math.max(-40, Math.min(40, ty))

  const lineStyle = {
    position: 'absolute',
    background: 'rgba(100,200,255,0.75)',
    pointerEvents: 'none',
    zIndex: 55,
  }

  return (
    <>
      {/* Horizontal line */}
      <div style={{
        ...lineStyle,
        left: 8, right: 22,
        height: 1,
        top: 'calc(50% + ' + Math.round(oy) + 'px)',
        borderTop: '1px dashed rgba(100,200,255,0.9)',
        background: 'transparent',
      }} />
      {/* Vertical line */}
      <div style={{
        ...lineStyle,
        top: 0, bottom: 0,
        width: 1,
        left: 'calc(50% + ' + Math.round(ox) + 'px)',
        borderLeft: '1px dashed rgba(100,200,255,0.9)',
        background: 'transparent',
      }} />
      {/* Centre handle dot */}
      <div style={{
        ...lineStyle,
        width: 8, height: 8,
        borderRadius: '50%',
        background: 'rgba(100,200,255,0.9)',
        border: '1.5px solid #fff',
        top: 'calc(50% + ' + Math.round(oy) + 'px - 4px)',
        left: 'calc(50% + ' + Math.round(ox) + 'px - 4px)',
      }} />
      {/* Manual fusion label */}
      <div style={{
        position: 'absolute',
        top: 22, left: '50%',
        transform: 'translateX(-50%)',
        fontSize: 9,
        color: 'rgba(100,200,255,0.85)',
        fontFamily: 'monospace',
        pointerEvents: 'none',
        zIndex: 56,
        textShadow: '0 1px 3px rgba(0,0,0,0.9)',
        whiteSpace: 'nowrap',
      }}>
        {rz !== 0
          ? 'MANUAL FUSION  TX:' + (tx >= 0 ? '+' : '') + tx.toFixed(1) + '  TY:' + (ty >= 0 ? '+' : '') + ty.toFixed(1) + '  RZ:' + (rz >= 0 ? '+' : '') + rz.toFixed(1) + 'deg'
          : 'MANUAL FUSION  TX:' + (tx >= 0 ? '+' : '') + tx.toFixed(1) + '  TY:' + (ty >= 0 ? '+' : '') + ty.toFixed(1)
        }
      </div>
    </>
  )
}

// ─── Apply viewport properties ────────────────────────────────────────────────
function _voi(wl) {
  return { lower: wl.wc - wl.ww / 2, upper: wl.wc + wl.ww / 2 };
}

function _applyProps(vp, wl, paletteId) {
  try {
    vp.setProperties({
      voiRange: { lower: wl.wc - wl.ww / 2, upper: wl.wc + wl.ww / 2 },
      colormap: { name: `petct_${paletteId}` },
    });
  } catch(e) {
    try {
      vp.setProperties({
        voiRange: { lower: wl.wc - wl.ww / 2, upper: wl.wc + wl.ww / 2 },
      });
    } catch(e2) {}
  }
}

// ─── Cine bar — bottom of every viewport ─────────────────────────────────────
// For non-MIP viewports: cycles through slices (scroll cine).
// For MIP viewport: rotates the camera around the Z-axis (360° rotation).
//
// MIP rotation strategy (Rule 12):
//   The MIP is a volume viewport (ORTHOGRAPHIC + MAXIMUM_INTENSITY_BLEND).
//   We store a rotation angle in degrees and advance it each rAF frame.
//   setCamera({ viewUp, position }) changes the projection direction.
//   We keep the focal point at the volume centre and orbit the camera
//   at a fixed radius around the IS (Z) axis, matching clinical convention
//   where the patient rotates left→right in the coronal plane.
//
// Slice scroll cine for non-MIP (stack and volume modes):
//   We use setInterval at the chosen fps and call vp.scroll(1) which works
//   for both STACK (stackScroll moves slice index) and ORTHOGRAPHIC volume
//   (stackScroll advances the slab position on the current axis).
function CineBar({ viewportId, modality, isMIP }) {
  const [playing, setPlaying]   = useState(false)
  const [fps, setFps]           = useState(isMIP ? 6 : 8)
  const rAFRef   = useRef(null)   // rAF id for MIP rotation
  const timerRef = useRef(null)   // setInterval id for slice scroll
  const angleRef = useRef(0)      // current rotation angle in degrees (MIP)
  // Track playing in a ref so the rAF closure always sees the latest value
  const playingRef = useRef(false)

  // ── Step: advance by one unit (slice or MIP angle step) ──────────────────
  function _stepMIP(angleDelta) {
    try {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID)
      const vp = engine?.getViewport(viewportId)
      if (!vp) return
      const cam = vp.getCamera()
      if (!cam?.focalPoint) return
      const fp = cam.focalPoint          // volume centre — stays fixed
      const dist = Math.hypot(
        cam.position[0] - fp[0],
        cam.position[1] - fp[1],
        cam.position[2] - fp[2],
      ) || 800                           // fallback radius
      angleRef.current = (angleRef.current + angleDelta + 360) % 360
      const rad = (angleRef.current * Math.PI) / 180
      // Orbit in the coronal plane: camera swings around the patient Z-axis.
      // Position: rotate (initial front = -Y direction) around Z.
      // Clinical MIP rotation: A→RAO→R→RPO→P→LPO→L→LAO→A
      // In RAS coordinates: front = +Y (anterior), right = +X
      const newPos = [
        fp[0] + dist * Math.sin(rad),   // X: 0 at 0°, +dist at 90° (right lat)
        fp[1] - dist * Math.cos(rad),   // Y: -dist at 0° (anterior view)
        fp[2],                           // Z: unchanged
      ]
      vp.setCamera({
        position:   newPos,
        focalPoint: fp,
        viewUp:     [0, 0, 1],           // always head-up
      })
      vp.render()
    } catch(e) {}
  }

  function _stepSlice(delta) {
    try {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID)
      const vp = engine?.getViewport(viewportId)
      if (!vp) return
      // Both StackViewport and VolumeViewport in v2.1.16 expose scroll()
      // which advances by N slices (positive = forward, negative = back).
      if (typeof vp.scroll === 'function') {
        vp.scroll(delta)
      } else {
        // Fallback: setImageIdIndex for stack viewports
        const cur = vp.getCurrentImageIdIndex?.() ?? 0
        const tot = vp.getImageIds?.()?.length ?? 1
        vp.setImageIdIndex(Math.max(0, Math.min(tot - 1, cur + delta)))
        vp.render()
      }
    } catch(e) {}
  }

  // ── rAF loop for MIP ─────────────────────────────────────────────────────
  const fpsRef = useRef(fps)
  useEffect(() => { fpsRef.current = fps }, [fps])

  useEffect(() => {
    if (!isMIP || !playing) return
    let last = 0
    playingRef.current = true

    function loop(ts) {
      if (!playingRef.current) return
      // Throttle to chosen rpm converted to degrees-per-frame.
      // fpsRef.current here is actually "rpm" for MIP but we use the same slider.
      // At fps=6: 6 rev/min = 0.1 rev/s = 36 deg/s.
      const interval = 1000 / Math.max(1, fpsRef.current) // ms between steps
      if (ts - last >= interval) {
        // degrees per step: one full revolution spread across 120 steps (smooth)
        _stepMIP(3)   // 3 degrees per step ≈ 120 steps for full rotation
        last = ts
      }
      rAFRef.current = requestAnimationFrame(loop)
    }
    rAFRef.current = requestAnimationFrame(loop)

    return () => {
      playingRef.current = false
      if (rAFRef.current) { cancelAnimationFrame(rAFRef.current); rAFRef.current = null }
    }
  }, [playing, isMIP, viewportId])

  // ── Interval loop for slice scroll ────────────────────────────────────────
  useEffect(() => {
    if (isMIP || !playing) return
    playingRef.current = true
    timerRef.current = setInterval(() => {
      _stepSlice(1)
    }, 1000 / Math.max(1, fps))

    return () => {
      playingRef.current = false
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [playing, isMIP, viewportId, fps])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      playingRef.current = false
      if (rAFRef.current)   { cancelAnimationFrame(rAFRef.current);   rAFRef.current   = null }
      if (timerRef.current) { clearInterval(timerRef.current);         timerRef.current = null }
    }
  }, [])

  function stop() {
    setPlaying(false)
    playingRef.current = false
    if (rAFRef.current)   { cancelAnimationFrame(rAFRef.current);   rAFRef.current   = null }
    if (timerRef.current) { clearInterval(timerRef.current);         timerRef.current = null }
  }

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      height: 20,
      background: isMIP ? 'rgba(220,220,220,.92)' : 'rgba(0,0,0,.75)',
      borderTop: `1px solid ${isMIP ? 'rgba(0,0,0,.15)' : 'rgba(255,255,255,.1)'}`,
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '0 6px', userSelect: 'none', zIndex: 55,
    }}>
      {/* Play/Pause */}
      <button
        onMouseDown={e => { e.stopPropagation(); setPlaying(v => !v) }}
        style={{
          background: 'none', border: 'none',
          color: isMIP ? '#333333' : '#ffffff',
          fontSize: 11, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
        }}
        title={playing ? 'Pause' : 'Play'}
      >{playing ? '⏸' : '▶'}</button>

      {/* Stop */}
      <button
        onMouseDown={e => { e.stopPropagation(); stop() }}
        style={{
          background: 'none', border: 'none',
          color: isMIP ? '#333333' : '#ffffff',
          fontSize: 11, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
        }}
        title="Stop"
      >⏹</button>

      {/* Step back */}
      <button
        onMouseDown={e => {
          e.stopPropagation()
          if (isMIP) _stepMIP(-15)
          else        _stepSlice(-1)
        }}
        style={{
          background: 'none', border: 'none',
          color: isMIP ? '#333333' : '#ffffff',
          fontSize: 11, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
        }}
        title={isMIP ? 'Rotate -15°' : 'Previous slice'}
      >⏮</button>

      {/* Step forward */}
      <button
        onMouseDown={e => {
          e.stopPropagation()
          if (isMIP) _stepMIP(+15)
          else        _stepSlice(+1)
        }}
        style={{
          background: 'none', border: 'none',
          color: isMIP ? '#333333' : '#ffffff',
          fontSize: 11, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
        }}
        title={isMIP ? 'Rotate +15°' : 'Next slice'}
      >⏭</button>

      {/* FPS / RPM label */}
      <span style={{ fontSize: 8, color: isMIP ? '#555' : '#aaa', marginLeft: 4 }}>
        {isMIP ? 'rpm' : 'fps'}
      </span>
      <input
        type="range" min={1} max={30} value={fps}
        onChange={e => setFps(+e.target.value)}
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 44, accentColor: isMIP ? '#336699' : '#00e5ff', height: 3 }}
      />
      <span style={{ fontSize: 8, color: isMIP ? '#333' : '#ffffff', minWidth: 14 }}>{fps}</span>

      {/* Playing indicator */}
      {playing && (
        <span style={{ fontSize: 8, color: isMIP ? '#336699' : '#00e5ff', marginLeft: 4 }}>
          {isMIP ? '↻ ROT' : '● CINE'}
        </span>
      )}
    </div>
  )
}

// ─── MIP Orientation Bar — 6 standard projection views ───────────────────────
// Renders inside the MIP viewport only. One click instantly re-orients the
// camera to the chosen standard view: A/P/R/L/H(ead)/F(oot).
//
// Camera strategy:
//   1. Read current camera to get focal point (volume centre) + distance.
//   2. Apply the new position + viewUp for the chosen direction.
//   3. Call resetCamera() to refit parallelScale, then render().
//
// RAS convention (standard DICOM): X=Right, Y=Anterior, Z=Superior/Head.
// So for an Anterior view we look from in front (-Y side, position Y < fp.Y).
//
// Note: resetCamera() after setCamera() is intentional — it refits the whole
// volume to the viewport while using the orientation we just set. CS3D v2.1.16
// resetCamera() respects the current camera viewUp and position direction.
const MIP_VIEWS = [
  { id: 'A', label: 'A',  title: 'Anterior',     pos: [0, -1, 0], up: [0, 0, 1] },
  { id: 'P', label: 'P',  title: 'Posterior',    pos: [0, +1, 0], up: [0, 0, 1] },
  { id: 'R', label: 'R',  title: 'Right Lateral', pos: [+1, 0, 0], up: [0, 0, 1] },
  { id: 'L', label: 'L',  title: 'Left Lateral',  pos: [-1, 0, 0], up: [0, 0, 1] },
  { id: 'H', label: 'H',  title: 'Head (Cranial)',pos: [0, 0, +1], up: [0, 1, 0] },
  { id: 'F', label: 'F',  title: 'Foot (Caudal)', pos: [0, 0, -1], up: [0, 1, 0] },
]

function MIPOrientationBar({ viewportId }) {
  const [activeView, setActiveView] = useState('A')

  function _applyView(view) {
    try {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID)
      const vp = engine?.getViewport(viewportId)
      if (!vp) return

      const cam = vp.getCamera()
      if (!cam?.focalPoint) return

      const fp = cam.focalPoint
      // Compute current orbit radius (distance from camera to focal point).
      const dist = Math.hypot(
        cam.position[0] - fp[0],
        cam.position[1] - fp[1],
        cam.position[2] - fp[2],
      ) || 800

      // Position the camera along the chosen direction, at the same distance.
      const newPos = [
        fp[0] + view.pos[0] * dist,
        fp[1] + view.pos[1] * dist,
        fp[2] + view.pos[2] * dist,
      ]

      // Set position + viewUp first so resetCamera() inherits the correct orientation.
      vp.setCamera({
        position:   newPos,
        focalPoint: fp,
        viewUp:     view.up,
      })
      // resetCamera() refits parallelScale to show the whole volume.
      vp.resetCamera()
      vp.render()
      setActiveView(view.id)
    } catch(e) {
      console.warn('[MIPOrientationBar] applyView error:', e)
    }
  }

  return (
    <div style={{
      position: 'absolute', top: 26, left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex', gap: 3,
      zIndex: 60, pointerEvents: 'auto',
    }}>
      {MIP_VIEWS.map(v => (
        <button
          key={v.id}
          title={v.title}
          onMouseDown={e => { e.stopPropagation(); _applyView(v) }}
          style={{
            width: 22, height: 18,
            fontSize: 9, fontWeight: 'bold',
            fontFamily: 'monospace',
            cursor: 'pointer', lineHeight: 1,
            border: `1px solid ${activeView === v.id ? '#336699' : '#999'}`,
            borderRadius: 3,
            background: activeView === v.id
              ? '#336699'
              : 'rgba(255,255,255,0.85)',
            color: activeView === v.id ? '#ffffff' : '#333333',
            padding: 0,
            boxShadow: activeView === v.id
              ? '0 1px 4px rgba(0,100,180,0.4)'
              : '0 1px 2px rgba(0,0,0,0.15)',
            transition: 'all 0.12s ease',
          }}
          onMouseEnter={e => {
            if (activeView !== v.id) {
              e.currentTarget.style.background = '#ddeeff'
              e.currentTarget.style.borderColor = '#336699'
            }
          }}
          onMouseLeave={e => {
            if (activeView !== v.id) {
              e.currentTarget.style.background = 'rgba(255,255,255,0.85)'
              e.currentTarget.style.borderColor = '#999'
            }
          }}
        >
          {v.label}
        </button>
      ))}
    </div>
  )
}

// ─── SUV bar ──────────────────────────────────────────────────────────────────
function SUVBar({ suvMin, suvMax, onSUV }) {
  const [lMin, setLMin] = useState(suvMin);
  const [lMax, setLMax] = useState(suvMax);
  useEffect(() => { setLMin(suvMin); setLMax(suvMax); }, [suvMin, suvMax]);
  return (
    <div style={{
      position: 'absolute', bottom: 20, left: 0, right: 22,
      background: 'rgba(0,0,0,.85)', borderTop: '1px solid #1a1a1a',
      padding: '3px 6px', display: 'flex', alignItems: 'center', gap: 5,
      userSelect: 'none',
    }}>
      <span style={{ fontSize: 9, color: '#ffcc66', minWidth: 26 }}>SUV</span>
      <span style={{ fontSize: 9, color: '#666', minWidth: 16 }}>min</span>
      <input type="range" min={0} max={20} step={0.1} value={lMin}
        onChange={e => setLMin(+e.target.value)}
        onMouseUp={() => onSUV?.({ min: lMin, max: lMax })}
        style={{ flex: 1, accentColor: '#ffcc66', height: 3 }} />
      <span style={{ fontSize: 9, color: '#ffcc66', minWidth: 24 }}>{lMin.toFixed(1)}</span>
      <span style={{ fontSize: 9, color: '#666', minWidth: 18 }}>max</span>
      <input type="range" min={0} max={30} step={0.5} value={lMax}
        onChange={e => setLMax(+e.target.value)}
        onMouseUp={() => onSUV?.({ min: lMin, max: lMax })}
        style={{ flex: 1, accentColor: '#ffcc66', height: 3 }} />
      <span style={{ fontSize: 9, color: '#ffcc66', minWidth: 24 }}>{lMax.toFixed(1)}</span>
    </div>
  );
}

// ─── Colormap strip ───────────────────────────────────────────────────────────
function ColormapStrip({ paletteId, palettes, wl, modality, onWLDrag, showMenu, onEnterMenu, onLeaveMenu, onSelectPalette }) {
  const canvasRef = useRef();
  const dragRef   = useRef({ active: false, lastY: 0 });
  const wlRef     = useRef(wl);
  useEffect(() => { wlRef.current = wl; }, [wl]);

  const frac = Math.max(0, Math.min(1, (wl.wc + 2000) / 6000));

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ro = new ResizeObserver(() => _drawStrip(c, paletteId, frac));
    ro.observe(c);
    _drawStrip(c, paletteId, frac);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (c) _drawStrip(c, paletteId, frac);
  }, [paletteId, frac]);

  const onMouseDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { active: true, lastY: e.clientY };
    const mv = (ev) => {
      if (!dragRef.current.active) return;
      const dy = ev.clientY - dragRef.current.lastY;
      dragRef.current.lastY = ev.clientY;
      const { wc, ww } = wlRef.current;
      onWLDrag(Math.max(-2000, Math.min(4000, wc - dy * 4)),
               Math.max(1, Math.min(8000, ww + Math.abs(dy) * 2)));
    };
    const up = () => { dragRef.current.active = false; window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  const groups = _groupPalettes(palettes);

  return (
    <div
      style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: 22,
        borderLeft: `1px solid ${modality === 'MIP' ? '#cccccc' : '#333'}`,
        cursor: 'ns-resize', userSelect: 'none',
        background: modality === 'MIP' ? '#ffffff' : 'transparent',
      }}
      onMouseDown={onMouseDown}
    >
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      <div
        onMouseEnter={onEnterMenu} onMouseLeave={onLeaveMenu}
        style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: modality === 'MIP' ? 'rgba(240,240,240,.95)' : 'rgba(0,0,0,.85)',
          fontSize: 7, color: modality === 'MIP' ? '#333' : '#aaa',
          textAlign: 'center', padding: '2px 0',
          borderTop: `1px solid ${modality === 'MIP' ? '#ccc' : '#333'}`,
          cursor: 'pointer',
        }}
      >▲map</div>

      {showMenu && (
        <div
          onMouseEnter={onEnterMenu} onMouseLeave={onLeaveMenu}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', bottom: 14, right: '100%', marginRight: 2,
            background: 'rgba(12,12,12,.97)', border: '1px solid #444',
            borderRadius: 4, boxShadow: '-4px 4px 20px rgba(0,0,0,.9)',
            whiteSpace: 'nowrap', zIndex: 80, minWidth: 160,
          }}
        >
          {groups.map(grp => (
            <div key={grp.label}>
              <div style={{ fontSize: 9, color: '#555', padding: '4px 8px 2px', borderBottom: '1px solid #1e1e1e', textTransform: 'uppercase', letterSpacing: 1 }}>
                {grp.label}
              </div>
              {grp.palettes.map(p => {
                const active = p.id === paletteId;
                return (
                  <div key={p.id}
                    onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onSelectPalette(p.id); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '4px 8px', cursor: 'pointer',
                      background: active ? 'rgba(255,255,255,.07)' : 'transparent',
                      borderLeft: active ? '2px solid #00e5ff' : '2px solid transparent',
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#1a1a1a'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ width: 10, height: 32, borderRadius: 1, background: getCssGradient(p.id), border: '1px solid #333', flexShrink: 0 }} />
                    <span style={{ fontSize: 10, color: active ? '#fff' : '#ccc' }}>{p.label}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function _drawStrip(canvas, paletteId, frac) {
  canvas.width  = canvas.offsetWidth  || 22;
  canvas.height = canvas.offsetHeight || 200;
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  if (!ctx || !w || !h) return;
  for (let y = 0; y < h; y++) {
    const [r,g,b] = getColor(paletteId, 1 - y/(h-1));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, w, 1);
  }
  const my = Math.round((1 - frac) * (h - 1));
  ctx.fillStyle = '#00e5ff';
  ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 3;
  ctx.fillRect(0, Math.max(0, my - 1), w, 2);
  ctx.shadowBlur = 0;
}

function _groupPalettes(palettes) {
  const map = {};
  palettes.forEach(p => { if (!map[p.group]) map[p.group] = []; map[p.group].push(p); });
  const labels = { ct: 'CT', pet_dicom: 'DICOM PET', fmri: 'DICOM fMRI', custom: 'Custom' };
  return Object.entries(map).map(([g, ps]) => ({ label: labels[g] || g, palettes: ps }));
}

// ─── Preset bar ───────────────────────────────────────────────────────────────
function PresetBar({ presets, accentColor, open, onEnter, onLeave, onSelect }) {
  return (
    <div onMouseEnter={onEnter} onMouseLeave={onLeave} onDoubleClick={e => e.stopPropagation()}
      style={{ position: 'absolute', bottom: 22, left: 8, zIndex: 60, userSelect: 'none' }}>
      <span style={{ fontSize: 8, color: '#ffffff', cursor: 'default', textShadow: '0 1px 3px rgba(0,0,0,.9)' }}>⬡ W/L</span>
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 3,
          background: 'rgba(12,12,12,.97)', border: `1px solid #555`,
          borderRadius: 3, overflow: 'hidden',
          boxShadow: '0 -3px 14px rgba(0,0,0,.85)', whiteSpace: 'nowrap',
        }}>
          {presets.map(p => (
            <div key={p.label}
              onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onSelect(p); }}
              style={{ display: 'flex', alignItems: 'center', padding: '3px 8px', cursor: 'pointer', gap: 6 }}
              onMouseEnter={e => e.currentTarget.style.background = '#1e1e1e'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: 10, color: '#fff', minWidth: 90 }}>{p.label}</span>
              <span style={{ fontSize: 9, color: '#aaa', minWidth: 50 }}>WW {p.ww}</span>
              <span style={{ fontSize: 9, color: '#aaa' }}>WC {p.wc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Opacity handle ───────────────────────────────────────────────────────────
function OpacityHandle({ opacity, onChange }) {
  return (
    <div style={{
      position: 'absolute', top: '50%', left: 4, transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
      zIndex: 70, userSelect: 'none',
    }}>
      <span style={{ fontSize: 8, color: '#88dd88', writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>blend</span>
      <input type="range" min={0} max={1} step={0.05} value={opacity}
        onChange={e => onChange(+e.target.value)}
        style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 12, height: 60, accentColor: '#88dd88', cursor: 'pointer' }} />
      <span style={{ fontSize: 8, color: '#88dd88' }}>{Math.round(opacity * 100)}%</span>
    </div>
  );
}
