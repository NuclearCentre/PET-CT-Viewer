/**
 * ViewerBox.jsx -- Single Cornerstone3D viewport
 *
 * Mouse bindings:
 *   Left drag    -> Pan
 *   Right drag   -> Zoom
 *   Middle drag  -> Window/Level
 *   Wheel        -> Scroll slices
 *
 * Combo bindings (hold both buttons, then drag):
 *   Middle + Right -> draw Straight Line  (LengthTool)
 *   Middle + Left  -> draw Circle ROI     (CircleROITool)
 *   Right  + Left  -> move annotations    (passive tool grab)
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
  cache,
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
  PET_VOLUME_ID,
  applyCTVolume,
  applyFusionVolumes,
  applyMIPVolume,
  setFusionPetProperties,
  setFusionCtVOI,
  updateFusionCtWL,
  setMIPColormap,
  setPetOpacity,
  getOrientationMarkers,
} from '../utils/volumeManager.js';
import { applyFusionTransform, resetFusionTransform } from '../utils/fusionManager.js';
import { renderPETOverlay, getPETPlaneWorldSpace, buildLUT } from '../utils/canvasFusion.js';
import { roiStatsFromAnnotation, suvAvailable, suvUncalibratedReason } from '../utils/suvUtils.js';

// triggerAnnotationRenderForViewportIds polyfill for CS3D v2.1.16
//
// Rule 32 guard: VTK resets cam.position + cam.parallelScale on EVERY
// render() call on an ORTHOGRAPHIC viewport. This helper is called from many
// places (SUV-stats retry loop after every ROI completes, up to 8x over 4s;
// W/L updates; palette changes; etc.), so without an explicit snapshot/
// restore here, each of those render() calls is a chance for the viewport's
// zoom/pan to silently drift -- visible as the image "jumping" after drawing
// a ROI. STACK viewports (non-volume) don't have this VTK quirk and don't
// need the guard, so it's skipped for those.
// triggerAnnotationRenderForViewportIds -- Rule 32 guard.
// camOverrides: optional { viewportId -> camera } to force-set after render()
// instead of restoring the pre-render snapshot. Used by cross-plane navigation
// so sibling viewports stay at the navigated slice position.
function triggerAnnotationRenderForViewportIds(viewportIds, camOverrides) {
  if (!viewportIds || !viewportIds.length) return;
  viewportIds.forEach((vid) => {
    const ee = getEnabledElementByViewportId(vid);
    if (!ee || !ee.viewport) return;
    const vp = ee.viewport;
    const override = camOverrides?.[vid] || null;
    let cam = null;
    if (!override) {
      try { cam = typeof vp.getCamera === 'function' ? vp.getCamera() : null; } catch(e) {}
    }
    vp.render();
    const restoreCam = override || cam;
    if (restoreCam?.position && restoreCam?.focalPoint && restoreCam?.parallelScale != null) {
      // VTK's ORTHOGRAPHIC camera reset runs in a deferred microtask after
      // render() returns. A synchronous setCamera() here runs BEFORE the reset
      // and gets overwritten. setTimeout(0) pushes our restore after VTK's
      // reset, so it wins. Two nested rAFs ensure we are past the reset.
      const restore = () => {
        try {
          vp.setCamera({
            position:      restoreCam.position,
            focalPoint:    restoreCam.focalPoint,
            viewUp:        restoreCam.viewUp,
            parallelScale: restoreCam.parallelScale,
          });
        } catch(e) {}
      };
      requestAnimationFrame(() => requestAnimationFrame(restore));
    }
  });
}

const { ViewportType, Events, OrientationAxis } = CoreEnums;
const { MouseBindings, KeyboardBindings } = ToolEnums;

// Session 14: MIP uses inv_greyscale (inverse greyscale) -- user request.
// PET fusion overlays use inv_hot_iron colourmap blended over CT greyscale base.
const DEFAULT_COLORMAP = { CT: 'gray', PET: 'hot_iron', MIP: 'inv_greyscale' }

// MIP renders on a BLACK clear colour, then App.css inverts the whole canvas
// (filter: invert(1)) -> black background becomes white, bright uptake becomes
// dark. CT/PET stay black, un-inverted.
const VP_BACKGROUND = { CT: [0,0,0], PET: [0,0,0], MIP: [0,0,0] };

// Ribbon tool ids -> CS3D v2.1.16 toolNames (verified from package source).
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
  // 'delete' / 'clear' are actions, not tools -- ignored here
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
  { label:'Standard',    ww:50000, wc:25000 },
  { label:'High uptake', ww:25000, wc:12500 },
  { label:'Low uptake',  ww:100000,wc:50000 },
];

export default function ViewerBox({
  viewportId,
  modality = 'CT',
  label = 'CT . Axial',
  accentColor = '#88c4ff',
  imageIds = [],
  volumeKey = 0,
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
  syncScroll = true,
  syncZoom   = false,
  syncPan    = false,
  renderMode = 'stack',
  orientation = 'axial',
  volumesReady = false,
  ctWLFusion,
  petWLFusion,
  fusionMode = 'auto',
  fusionOffset = { tx:0,ty:0,tz:0,rx:0,ry:0,rz:0 },
  // Palette sync: parent can override local palette (for pct- sync)
  paletteOverride = null,
  onPaletteChange = null,
  // Drag-and-drop series loading (from SeriesPanel) -- only set for ct-axial
  // and pct-axial by ViewportGrid.jsx; coronal/sagittal never receive these.
  onSeriesDrop = null,
  dropStudyUID = null,
}) {
  const divRef      = useRef(null);
  const hasVP          = useRef(false);
  const cameraSyncedRef = useRef(false);  // one-shot flag for PET<->CT camera sync
  const glCanvasRef    = useRef(null);   // Canvas2D overlay (PET viewports)
  const glLUTRef         = useRef(null);   // current LUT array
  // Refs for values read inside drawFrame closure -- avoids stale capture
  // (drawFrame effect deps are [modality, isVolume, viewportId] so petOpacity,
  //  ctWLFusion, petWLFusion would be stale if captured directly in the closure).
  const petOpacityRef    = useRef(0.6);
  const ctWLFusionRef    = useRef({ wc: 40,   ww: 400   });
  const petWLFusionRef   = useRef({ wc: 25000, ww: 50000 });
  const orientationRef   = useRef(orientation);  // avoids stale closure in drawFrame
  const glFramePending = useRef(false);  // rAF dedup
  // MIP colour filter, applied continuously on every IMAGE_RENDERED (see
  // MIP LOCKED RULE (resolved, do not change without being explicitly
  // asked): white background + TRUE palette colour for every palette,
  // including gray. Filter is always 'invert(1)' -- the actor's own colours
  // are pre-inverted (see setMIPColormap / _applyActorColormap's
  // preInvertForWhiteBg) so the mandatory invert cancels back out to the
  // real colour, while black (background / low uptake) still flips to
  // white. Reapplied continuously on every IMAGE_RENDERED (see
  // _setMIPCanvasBg below), not just once after a palette change --  MIP's
  // continuous rotation loop calls render() every frame, and each one is a
  // fresh chance for CS3D to recreate the canvas node and drop the inline
  // style. A ref (not a plain closure variable) because this effect's deps
  // don't include the palette, so a closure would go stale the moment the
  // palette changes.
  const mipFilterRef = useRef('invert(1)');

  const [paletteId, setPaletteId]     = useState(DEFAULT_COLORMAP[modality] || 'gray');
  // If parent supplies paletteOverride (for pct- sync), use it
  const effectivePaletteId = (paletteOverride && modality === 'PET') ? paletteOverride : paletteId;
  const [showPalMenu, setShowPalMenu] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [sliceInfo, setSliceInfo]     = useState({ current: 0, total: 0 });
  const [mipPlaying, setMipPlaying]   = useState(false);  // lifted so orientation bar can stop rotation
  const [seriesDragOver, setSeriesDragOver] = useState(false); // drop-target highlight for drag-and-drop series loading
  const closeTimers = useRef({});

  const isVolume = renderMode === 'volume';

  // MIP auto-start: poll every 500ms until cam.focalPoint is non-zero.
  useEffect(() => {
    if (modality !== 'MIP') return
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      try {
        const engine = getRenderingEngine(RENDERING_ENGINE_ID)
        const vp = engine?.getViewport(viewportId)
        const cam = vp?.getCamera()
        if (cam?.focalPoint && cam.focalPoint.some(v => Math.abs(v) > 0.1)) {
          clearInterval(timer)
          setMipPlaying(true)
        }
      } catch(e) {}
      if (attempts >= 30) clearInterval(timer)
    }, 500)
    return () => clearInterval(timer)
  }, [modality, viewportId])

  // -- Viewport setup --------------------------------------------------------
  useEffect(() => {
    // Gate: stack mode needs imageIds; volume mode needs the shared volumes built.
    const ready = isVolume ? volumesReady : imageIds.length > 0;
    if (!divRef.current || !ready) return;
    let cancelled = false;

    async function setup() {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID);
      if (!engine || cancelled) return;
      const el = divRef.current;

      // Check if this is a re-run after a series swap (volumeKey bump).
      // In that case the element is already enabled -- calling enableElement
      // again causes a shader-compile crash (CONTEXT_LOST_WEBGL) on Intel UHD.
      // Instead, just re-apply volumes to re-wire the VTK actor to the new
      // volume cache that ensureVolumes() just created.
      const alreadyEnabled = !!engine.getViewport(viewportId);
      if (!alreadyEnabled) {
        engine.enableElement({
          viewportId,
          type: isVolume ? ViewportType.ORTHOGRAPHIC : ViewportType.STACK,
          element: el,
          defaultOptions: {
            background: VP_BACKGROUND[modality] || [0,0,0],
            ...(isVolume ? { orientation: ORIENTATION[orientation] || OrientationAxis.AXIAL } : {}),
          },
        });
      }

      // div.viewport-element already has overflow:hidden (CS3D sets it in
      // getOrCreateCanvas.js). The SVG is inside it. Belt-and-suspenders:
      // also set overflow:hidden on the SVG itself.
      try {
        const svgLayer = el.querySelector('div.viewport-element > svg.svg-layer');
        if (svgLayer) svgLayer.style.overflow = 'hidden';
      } catch(e) {}

      // MIP white background fix:
      // CS3D creates a WebGL canvas inside el. Its CSS background defaults to
      // transparent/black regardless of the VP_BACKGROUND [1,1,1] setting.
      // VP_BACKGROUND controls the WebGL CLEAR colour (what CS3D clears to before
      // each frame) but NOT the CSS background of the canvas element itself.
      // When the WebGL canvas has transparent CSS background, the black divRef
      // background shows through wherever CS3D hasn't painted.
      // Fix: after every IMAGE_RENDERED, set the WebGL canvas CSS background to
      // white for MIP. This is a CSS property -- CS3D never touches it.
      if (modality === 'MIP') {
        const _setMIPCanvasBg = () => {
          try {
            const webglCanvas = el.querySelector('canvas');
            if (webglCanvas) {
              webglCanvas.style.background = '#ffffff';
              // MIP LOCKED RULE: filter is always invert(1) (mipFilterRef is
              // now constant) -- reapplied on every single render because
              // MIP's continuous rotation loop calls render() every frame,
              // and each one is a fresh chance for CS3D to recreate the
              // canvas node and drop the inline style. !important because
              // App.css's own rule uses !important too (confirmed via
              // runtime diagnostic: a plain assignment set the inline style
              // correctly but lost to the stylesheet's computed value
              // regardless) -- setProperty(..., 'important') wins over that.
              webglCanvas.style.setProperty('filter', mipFilterRef.current, 'important');
            }
            el.style.background = '#ffffff';
          } catch(e) {}
        };
        el.addEventListener(Events.IMAGE_RENDERED, _setMIPCanvasBg);
      }

      const vp = engine.getViewport(viewportId);
      if (!vp || cancelled) return;

      if (toolGroupId && !alreadyEnabled) {
        const tg = ToolGroupManager.getToolGroup(toolGroupId);
        if (tg) tg.addViewport(viewportId, RENDERING_ENGINE_ID);
      }

      if (isVolume) {
        // -- Phase 3 -- volume / MPR / fusion ---------------------------------
        if (modality === 'CT') {
          await applyCTVolume(vp, { wl, colormapName: `petct_${effectivePaletteId}` });
        } else if (modality === 'PET') {
          await applyFusionVolumes(vp, {
            ctWL: ctWLFusion || { wc: 40, ww: 400 },
          });

        } else { // MIP
          // MIP colormap fixed to inv_greyscale (Session 14 request).
          // paletteId is not used for MIP -- the MIP colormap is always inv_greyscale.
          await applyMIPVolume(vp, { petWL: wl, colormapName: 'petct_greyscale', orientation });
          // Lock camera values and start rotation HERE -- this is the only reliable
          // moment where the viewport is enabled, the volume is loaded, and VTK
          // has not yet had a chance to reset the camera values via a render call.
          // All poll-based approaches failed because the viewport isn't available
          // when __mipScale is first set, and focalPoint is [0,0,0] after any render.
          // Rotation auto-started by poll useEffect (Session 8 approach).
        }
        if (cancelled) return;
        hasVP.current = true;

        // Volume viewports don't emit STACK_NEW_IMAGE -- derive slice from the
        // camera on every render.
        const updateSlice = () => {
          try {
            if (modality === 'MIP') return; // MIP is a projection not a slice stack
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
        // -- Phase 1/2 -- stack -----------------------------------------------
        await vp.setStack(imageIds, 0);
        vp.resetCamera();
        _applyProps(vp, wl, effectivePaletteId);
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
  }, [viewportId, imageIds, toolGroupId, renderMode, orientation, volumesReady, volumeKey]);

  // -- Canvas2D fusion overlay -----------------------------------------------
  useEffect(() => {
    if (modality !== 'PET' || !isVolume) return;
    const canvas = glCanvasRef.current;
    if (!canvas) return;

    // Fusion canvas uses inv_hot_iron (white=high uptake, black=zero uptake).
    glLUTRef.current = buildLUT(getColor, effectivePaletteId);

    function drawFrame() {
      glFramePending.current = false;
      try {
        // Raw blend from slider - renderPETOverlay applies 30% floor so PET
        // is always visible even at slider 0%
        const blend = Math.max(0, Math.min(1, petOpacityRef.current));
        const el    = divRef.current;
        if (!canvas || !el) return;

        const cw = el.clientWidth  || el.offsetWidth;
        const ch = el.clientHeight || el.offsetHeight;
        if (!cw || !ch) return;
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width  = cw;
          canvas.height = ch;
        }

        // No early exit at blend=0 - renderPETOverlay ensures 30% minimum

        const engine = getRenderingEngine(RENDERING_ENGINE_ID);
        const pctVp  = engine?.getViewport(viewportId);
        if (!pctVp) return;

        const petPlane = getPETPlaneWorldSpace(pctVp, orientationRef.current);
        if (!petPlane) {
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, cw, ch);
          return;
        }

        const lut = glLUTRef.current;
        if (!lut) return;

        // Compute viewport camera world bounds for world-space pixel mapping
        let vpBounds = null;
        const focalPt = [0, 0, 0];
        try {
          const cam2   = pctVp.getCamera();
          const fp     = cam2.focalPoint;
          focalPt[0] = fp[0]; focalPt[1] = fp[1]; focalPt[2] = fp[2];
          const ps     = cam2.parallelScale;
          const aspect = cw / ch;
          const orient = orientationRef.current;

          if (orient === 'axial') {
            vpBounds = { xMin: fp[0]-ps*aspect, xMax: fp[0]+ps*aspect, yMin: fp[1]-ps, yMax: fp[1]+ps };
          } else if (orient === 'coronal') {
            vpBounds = { xMin: fp[0]-ps*aspect, xMax: fp[0]+ps*aspect, yMin: fp[2]-ps, yMax: fp[2]+ps };
          } else {
            vpBounds = { xMin: fp[1]-ps*aspect, xMax: fp[1]+ps*aspect, yMin: fp[2]-ps, yMax: fp[2]+ps };
          }
        } catch(e) {}

        // petLo/petHi now driven by the actual PET W/L window (wc-ww/2),
        // not a hardcoded 0..auto-percentile range -- this is what the
        // colour-strip's two compression cursors actually control. Falls
        // back to the auto-computed petHi only if W/L isn't available yet
        // (e.g. very first frame before petWLFusionRef has a real value).
        const _wl = petWLFusionRef.current;
        const _hasWL = _wl && Number.isFinite(_wl.wc) && Number.isFinite(_wl.ww);
        const _petLo = _hasWL ? Math.max(0, _wl.wc - _wl.ww / 2) : 0;
        const _petHi = _hasWL ? Math.max(_petLo + 1, _wl.wc + _wl.ww / 2) : petPlane.petHi;

        renderPETOverlay(canvas, petPlane.data, petPlane.width, petPlane.height, lut, {
          alpha:        blend,
          petLo:        _petLo,
          petHi:        _petHi,
          power:        2.0,
          vpBounds,
          petImageData: petPlane.petImageData,
          fullData:     petPlane.fullData,
          orientation:  petPlane.orientation,
          iMax:         petPlane.iMax,
          jMax:         petPlane.jMax,
          kMax:         petPlane.kMax,
          focalX:       focalPt[0],
          focalY:       focalPt[1],
          focalZ:       focalPt[2],
        });
      } catch(e) {
        console.warn('[canvasFusion] drawFrame error:', e?.message);
      }
    }
    function onRendered() {
      if (glFramePending.current) return;
      glFramePending.current = true;
      requestAnimationFrame(drawFrame);
    }

    const el = divRef.current;
    if (el) {
      el.addEventListener(Events.IMAGE_RENDERED, onRendered);
      // Repaint on camera change (pan/zoom) so overlay stays in sync with CT
      el.addEventListener(Events.CAMERA_MODIFIED, onRendered);
    }

    // Poll until PET voxelManager has non-zero data (streaming in progress)
    // Start after 2s to avoid colliding with MIP zoom sync (500ms timer in ViewportGrid)
    let pollCount = 0;
    const retryPoll = setInterval(() => {
      pollCount++;
      try {
        const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
        if (!vp) return;
        const petVol = cache.getVolume(PET_VOLUME_ID);
        if (!petVol) return;

        let raw = petVol.scalarData;
        if (!raw?.length) raw = petVol.voxelManager?.scalarData;
        if (!raw?.length && typeof petVol.voxelManager?.getCompleteScalarDataArray === 'function') {
          try { raw = petVol.voxelManager.getCompleteScalarDataArray(); } catch(e) {}
        }
        if (!raw?.length) return;

        const step = Math.max(1, Math.floor(raw.length / 2000));
        for (let i = 0; i < raw.length; i += step) {
          if (raw[i] !== 0) {
            clearInterval(retryPoll);
            vp.render();
            return;
          }
        }
      } catch(e) {}
      if (pollCount >= 58) { clearInterval(retryPoll); }
    }, 2000);

    return () => {
      if (el) {
        el.removeEventListener(Events.IMAGE_RENDERED, onRendered);
        el.removeEventListener(Events.CAMERA_MODIFIED, onRendered);
      }
      clearInterval(retryPoll);
      try {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      } catch(e) {}
    };
  }, [modality, isVolume, viewportId]);

  // When palette changes on the colourmap strip, the strip updates visually.
  // The fusion canvas LUT stays hot_iron always (see comment above).
  // We still trigger a re-render so the strip repaints.
  useEffect(() => {
    if (modality !== 'PET' || !isVolume) return;
    // Fusion canvas uses inv_hot_iron (white=high uptake, black=zero uptake).
    glLUTRef.current = buildLUT(getColor, effectivePaletteId);
    try { getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)?.render(); } catch(e) {}
  }, [paletteId]);

  // Always rebuild LUT here so gamma/remap changes apply immediately to all pct- viewports
  // Stack mode + MIP/PET: volume not allocated, show placeholder.
  // CT viewports in stack mode work normally (setStack path).
  if (!isVolume && (modality === 'MIP' || modality === 'PET')) {
    return (
      <div style={{
        position: 'absolute', inset: 0, background: '#111',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6,
      }}>
        <div style={{ fontSize: 20, color: '#555' }}>{modality === 'MIP' ? 'MIP' : 'PET-CT'}</div>
        <div style={{ fontSize: 9, color: '#444', textAlign: 'center', maxWidth: 140 }}>
          Switch to Volume mode to enable {modality === 'MIP' ? 'MIP projection' : 'PET fusion'}
        </div>
        <div style={{ fontSize: 8, color: '#336699', marginTop: 4 }}>
          Use the S/V button in System ribbon
        </div>
      </div>
    );
  }

  if (modality === 'PET' && isVolume) {
    glLUTRef.current = buildLUT(getColor, effectivePaletteId);
  }

  // When palette changes, trigger a render so drawFrame fires with the new LUT
  useEffect(() => {
    if (modality !== 'PET' || !isVolume || !hasVP.current) return;
    try {
      getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)?.render();
    } catch(e) {}
  }, [effectivePaletteId]);

  // Keep drawFrame refs in sync with latest prop values.
  // drawFrame reads these refs so it always uses current W/L and opacity
  // even though the canvas effect only mounts once (deps=[modality,isVolume,viewportId]).
  petOpacityRef.current  = petOpacity;
  ctWLFusionRef.current  = ctWLFusion  || { wc: 40,   ww: 400   };
  petWLFusionRef.current = petWLFusion || wl;
  orientationRef.current = orientation;

  // -- Sync flag changes -> add/remove from synchronizers --------------------
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

  // -- W/L update ------------------------------------------------------------
  useEffect(() => {
    if (!hasVP.current) return;
    try {
      const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
      if (!vp) return;
      if (isVolume) {
        const cmap = `petct_${effectivePaletteId}`;
        if (modality === 'CT') {
          try { vp.setProperties({ voiRange: _voi(wl), colormap: { name: cmap } }); }
          catch(e) { vp.setProperties({ voiRange: _voi(wl) }); }
        } else if (modality === 'PET') {
          // updateFusionCtWL targets CT actor directly by referencedId - safe on
          // two-volume viewport. setFusionCtVOI (single-arg setProperties) must
          // NOT be used here - it hits whichever volume CS3D considers current,
          // which corrupts the PET VOI range and makes the overlay invisible.
          try { updateFusionCtWL(vp, ctWLFusion || { wc: 40, ww: 400 }); } catch(e) {}
          setFusionPetProperties(vp, { petWL: petWLFusion || wl, petColormapName: cmap, petOpacity });
        } else { // MIP - use actor-direct colormap to avoid changing background
          try { vp.setProperties({ voiRange: _voi(wl) }); } catch(e) {}
          // MIP LOCKED RULE: white background + true palette colour, for
          // every palette including gray -- filter is always invert(1); the
          // actor's own colours are pre-inverted to compensate (see
          // setMIPColormap / _applyActorColormap's preInvertForWhiteBg).
          // Do not change this without being explicitly asked to.
          mipFilterRef.current = 'invert(1)';
          setMIPColormap(vp, effectivePaletteId, wl);
        }
        vp.render();
      } else {
        _applyProps(vp, wl, effectivePaletteId);
        vp.render();
      }
    } catch(e) {}
  }, [wl, paletteId, effectivePaletteId, ctWLFusion, petWLFusion]);

  // -- PET overlay opacity (fusion blend slider) -----------------------------
  useEffect(() => {
    if (!hasVP.current || !isVolume || modality !== 'PET') return;
    // Pass petWL so buildPetOpacityArray can build the correct value-mapped
    // transfer function (the scalar range depends on the current W/L).
    setPetOpacity(viewportId, petOpacity, petWLFusion || wl);
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

  // -- Toolbar tool override -------------------------------------------------
  useEffect(() => {
    if (!toolGroupId) return;
    const tg = ToolGroupManager.getToolGroup(toolGroupId);
    if (!tg) return;

    // Phase 3: in volume/MPR mode the "Crosshair" toolbar button promotes the
    // always-visible reference lines to full click-to-navigate on left drag.
    // Crosshairs now lives on Auxiliary (middle-click) and is switched on once
    // by ViewportGrid.jsx after volumes finish loading -- it no longer needs
    // to be force-disabled here just because a different toolbar tool (Pan,
    // Circle ROI, etc.) became active, since none of those use the middle
    // button. The toolbar "Crosshair" id is kept only as an explicit re-toggle
    // (e.g. to switch back to WindowLevel-on-middle-click).
    if (isVolume && activeToolOverride === 'crosshair') {
      setCrosshairsActive(true);
      return; // handled by setCrosshairsActive
    }

    // Map ribbon ids -> CS3D toolNames; unknown/action ids restore Pan.
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

  // -- Middle mouse wheel - PET opacity (PET viewports only) ------------------
  // Scroll up = more PET, scroll down = less PET. Step 5% per notch.
  // Only fires when middle button (button=1) is held OR as a standalone wheel
  // on PET viewports (since middle drag is already W/L via CS3D).
  useEffect(() => {
    if (modality !== 'PET' || !isVolume || !onOpacity) return;
    const el = divRef.current;
    if (!el) return;
    const onWheel = (e) => {
      // Only intercept if middle button is held (buttons & 4) to avoid
      // conflicting with normal scroll-to-slice
      if (!(e.buttons & 4)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 0.05 : -0.05;  // up = more, down = less
      const newVal = Math.max(0, Math.min(1, petOpacityRef.current + delta));
      onOpacity(newVal);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [modality, isVolume, onOpacity]);

  // -- Right-click delete popup ----------------------------------------------
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

  // -- Viewport-scoped annotations -------------------------------------------
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

          // P0 ROOT CAUSE FIX: CS3D sets metadata.referencedImageId on every
          // annotation to the specific imageId active at draw time. In MPR/
          // volume mode each orientation has its own imageId sequence. When
          // pct-coronal tries to render an annotation whose referencedImageId
          // belongs to pct-axial's sequence, CS3D rejects it (imageId mismatch)
          // and skips drawing entirely regardless of visibility flags.
          // Clearing referencedImageId forces CS3D to fall through to
          // FrameOfReferenceUID comparison (shared by all 6 viewports), making
          // the annotation eligible on any pct- plane. CS3D's world-space
          // plane-intersection test then determines whether the annotation
          // geometry actually intersects the current slice.
          ann.metadata.referencedImageId = undefined

          // SUV-only display rule: hide native HU textbox for pct- annotations
          // (pct- viewports only load CT into VTK; PET is Canvas2D overlay).
          // Global textBoxVisibility stays ON for ct- rows.
          try {
            annotation.config.style.setAnnotationStyles(ann.annotationUID, {
              textBoxVisibility: false,
            })
          } catch(e) {}
        }

        console.log(`[ViewerBox] tagged annotation to ${viewportId}${isPCT ? ' (row-shared pct)' : ''}`)

        // IMAGE-SHIFT FIX (Rule 32, during-draw):
        // CAMERA_MODIFIED fires synchronously the moment VTK resets the camera
        // during a render() call. This is the correct event to intercept --
        // IMAGE_RENDERED fires after the frame is already painted (too late to
        // prevent the visible shift). We restore the locked parallelScale and
        // focalPoint immediately inside the CAMERA_MODIFIED handler, before the
        // next paint. Released on ANNOTATION_COMPLETED.
        try {
          const _engine = getRenderingEngine(RENDERING_ENGINE_ID)
          const LOCK_IDS = ['pct-axial', 'pct-coronal', 'pct-sagittal', 'mip']
          const _lockedCams = {}
          const _camModFns  = {}
          const _unlockFns  = {}
          let _drawActive = true
          LOCK_IDS.forEach(vpId => {
            try {
              const _vp = _engine?.getViewport(vpId)
              if (!_vp?.element) return
              _lockedCams[vpId] = _vp.getCamera()
              // Restore parallelScale + focalPoint on every CAMERA_MODIFIED
              // that occurs while drawing is active. Guarded so that legitimate
              // user pan/zoom (which fires after _drawActive=false) is not blocked.
              _camModFns[vpId] = () => {
                if (!_drawActive) return
                try {
                  const cur = _vp.getCamera()
                  const locked = _lockedCams[vpId]
                  if (!locked?.parallelScale) return
                  // Only restore if parallelScale or focalPoint drifted
                  const scaleDrift = Math.abs((cur?.parallelScale || 0) - locked.parallelScale) > 1
                  if (scaleDrift) {
                    _vp.setCamera({ ...cur, parallelScale: locked.parallelScale, focalPoint: locked.focalPoint, position: locked.position })
                  }
                } catch(e) {}
              }
              _unlockFns[vpId] = () => {
                _vp.element?.removeEventListener(Events.CAMERA_MODIFIED, _camModFns[vpId])
              }
              _vp.element.addEventListener(Events.CAMERA_MODIFIED, _camModFns[vpId])
            } catch(e) {}
          })
          const _unlockAll = () => {
            _drawActive = false
            LOCK_IDS.forEach(vpId => { try { _unlockFns[vpId]?.() } catch(e) {} })
          }
          eventTarget.addEventListener('CORNERSTONE_TOOLS_ANNOTATION_COMPLETED', _unlockAll, { once: true })
          // Safety: also unlock on cancel (e.g. Escape key)
          eventTarget.addEventListener('CORNERSTONE_TOOLS_ANNOTATION_CANCELLED', _unlockAll, { once: true })
        } catch(e) {}

        // Do NOT pre-position the textbox here. CS3D's getTextBoxCoordsCanvas
        // places text at the rightmost annotation point + 25px, which is
        // ADJACENT to the annotation with zero gap in the link line.
        // The ANNOTATION_RENDERED handler below clamps it into the safe zone
        // if it overflows a viewport edge -- without introducing an artificial gap.
      } catch(e) {}
    }

    function onCompleted(evt) {
      setDrawingComplete(true)
      // Force stats recalculation with retry.
      // Root cause: CS3D's _calculateCachedStats silently skips when
      // getTargetImageData() returns null -- the volume slice containing this
      // ROI hasn't streamed yet. We poll until stats appear.
      //
      // Uses triggerAnnotationRenderForViewportIds (CS3D's own API) instead of
      // vp.render() -- this specifically re-runs renderAnnotation on every tool,
      // which calls _calculateCachedStats for any annotation with invalidated=true.
      // Plain vp.render() can skip annotation re-rendering in some CS3D code paths.
      //
      // 8 retries x 500ms = 4 seconds total coverage (handles slow networks /
      // large PET volumes where the specific slice may take time to stream).
      //
      // Row-shared PET-CT ROIs: trigger all 3 pct- viewports so each plane
      // computes its own cachedStats for the correct slice it is showing.
      try {
        const ann = evt?.detail?.annotation
        if (!ann) return
        ann.invalidated = true

        // -- Auto cross-plane navigation (re-attempted, minimal) -----------------
        // Two prior attempts both caused the source viewport itself to jump.
        // Both of those attempts explicitly snapshotted and restored the
        // SOURCE viewport's camera as a defensive measure -- but this code
        // never directly modifies the source viewport's camera at all, only
        // the two SIBLING viewports. That source-camera "restore" was
        // unnecessary defensive complexity, and is the most likely single
        // variable responsible for the jump (a malformed/late setCamera call
        // against a viewport this code has no real reason to touch). This
        // version removes it entirely: only the sibling planes' cameras are
        // moved, the source viewport is never read or written here.
        try {
          const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null
          const pts = ann.data?.handles?.points
          if (myRow && pts?.length) {
            // Centroid of all handle points: for CircleROI points[0] already IS
            // the centre (mean of 1 point = itself); for Ellipse (4 pts) and
            // Rectangle (2 corner pts) the mean gives the true geometric centre.
            const n = pts.length
            const centre = [0, 1, 2].map(
              axis => pts.reduce((s, p) => s + (p[axis] || 0), 0) / n
            )
            const ROW_VIEWPORTS = {
              ct:  ['ct-axial',  'ct-coronal',  'ct-sagittal'],
              pct: ['pct-axial', 'pct-coronal', 'pct-sagittal'],
            }
            const engine = getRenderingEngine(RENDERING_ENGINE_ID)
            const camOverrides = {}
            ;(ROW_VIEWPORTS[myRow] || []).forEach(vpId => {
              if (vpId === viewportId) return // never touch the source plane
              try {
                const otherVp = engine?.getViewport(vpId)
                if (!otherVp) return
                const cam = otherVp.getCamera()
                if (!cam?.focalPoint || !cam?.position) return
                const delta = [0, 1, 2].map(axis => centre[axis] - cam.focalPoint[axis])
                const newPosition = cam.position.map((p, axis) => p + delta[axis])
                const newCam = { ...cam, focalPoint: [...centre], position: newPosition }
                otherVp.setCamera(newCam)
                camOverrides[vpId] = newCam
                // No render() here -- tryRender below handles all rendering
                // with camOverrides so cameras survive VTK reset (Rule 32).
              } catch(e) {}
            })
          }
        } catch(e) {}

        // Build the list of viewports to trigger.
        // If this is a row-shared pct annotation, include all pct- viewports
        // so every plane gets its own stats (axial SUV != coronal SUV because
        // each plane intersects the ROI at a different depth through the volume).
        const isRowShared = ann.metadata?.rowShared && ann.metadata?.viewportRow === 'pct'
        const triggerIds = isRowShared
          ? ['pct-axial', 'pct-coronal', 'pct-sagittal']
          : [viewportId]

        const _camOverrides = (typeof camOverrides !== 'undefined') ? camOverrides : {}

        let attempts = 0
        const tryRender = () => {
          attempts++
          try {
            const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
            if (!vp) return
            ann.invalidated = true
            // Pass _camOverrides so sibling viewports stay at the navigated
            // slice position after VTK reset (Rule 32).
            try {
              triggerAnnotationRenderForViewportIds(triggerIds, _camOverrides)
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

  // -- Volume-loaded fallback for missing stats ------------------------------
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

  // -- ANNOTATION_RENDERED: clamp textbox + draw handle dots + SUV text ------
  // Fires after every SVG annotation repaint with current canvas coordinates.
  //
  // HOVER-GATED HANDLES (fix for "dots always visible"):
  //   Handle dots (resize/move affordances) are only drawn for the annotation
  //   the pointer is currently near (hoveredUIDRef) or that is selected
  //   (selectedUIDsRef) -- not for every ROI all the time. A pointermove
  //   listener hit-tests proximity each frame (rAF-throttled) and rebuilds
  //   just the overlay (cheap: no CS3D render needed) on change.
  //
  // SUV TEXTBOX (fix for "SUV never shown"):
  //   pct- viewports only ever load the CT volume into VTK (PET is a Canvas2D
  //   overlay -- see canvasFusion.js), so CS3D's native ROI textbox can only
  //   ever compute CT/HU stats there. The native textbox for row-shared pct
  //   annotations is suppressed at creation time (see onAdded above, which
  //   sets textBoxVisibility:false per-annotation). Here we paint our own
  //   textbox using suvUtils.roiStatsFromAnnotation, which samples the real
  //   PET volume. ct- (CT-only) viewports are untouched and keep the native
  //   HU textbox (global textBoxVisibility is ON for them).
  const hoveredUIDRef   = useRef(null)
  const [selectedUIDs, setSelectedUIDs] = useState([]);
  const selectedUIDsRef = useRef([])
  useEffect(() => { selectedUIDsRef.current = selectedUIDs }, [selectedUIDs])

  useEffect(() => {
    const RENDERED = 'CORNERSTONE_TOOLS_ANNOTATION_RENDERED'
    const svgns = 'http://www.w3.org/2000/svg'
    const OVERLAY_TOOLS = ['CircleROI', 'EllipticalROI', 'RectangleROI']

    function _rebuildOverlay() {
      try {
        const el = divRef.current
        if (!el) return
        const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
        if (!vp) return

        // -- Handle overlay ----------------------------------------------------
        // CS3D draws its own native <circle class="handle"> dots at the raw
        // points[] positions (2 for Circle, 4 for Ellipse, 2 for Rect).
        // We want richer geometry AND hover-only visibility. Hide CS3D's dots
        // per annotation UID (scoped -- LengthTool / Arrow etc. keep their own
        // dots), then draw ours only for the hovered/selected annotation.
        const svgLayer = el.querySelector('div.viewport-element > svg.svg-layer')
        if (!svgLayer) return
        svgLayer.querySelector('#handle-overlay')?.remove()
        const g = document.createElementNS(svgns, 'g')
        g.setAttribute('id', 'handle-overlay')

        const all = annotation.state.getAllAnnotations()
        const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null
        const isPCTRow = myRow === 'pct'

        for (const ann of (all || [])) {
          // Belongs to this viewport either exclusively (sourceViewportId) or
          // as row-shared (viewportRow matches, e.g. SUV ROI on all 3 pct- planes).
          const src = ann.metadata?.sourceViewportId
          const rowShared = ann.metadata?.rowShared && ann.metadata?.viewportRow === myRow
          if (src !== viewportId && !rowShared) continue
          if (!annotation.visibility.isAnnotationVisible(ann.annotationUID)) continue
          const toolName = ann.metadata?.toolName || ''
          if (!OVERLAY_TOOLS.includes(toolName)) continue
          const pts = ann.data?.handles?.points
          if (!pts || pts.length < 2) continue

          // Always hide CS3D's native handle dots for this annotation -- ours
          // replace them whenever shown, and we don't want a flash of the
          // native dots while ours are hidden.
          try {
            svgLayer.querySelectorAll(`[data-id="${ann.annotationUID}"] circle.handle`)
              .forEach(c => { c.style.display = 'none' })
          } catch(e) {}

          // -- SUV textbox (pct- rows only) ------------------------------------
          // Drawn regardless of hover state -- the VALUE should always be
          // visible, only the resize/move HANDLES are hover-gated.
          //
          // CLAMPING: this is a plain SVG <text>, not a CS3D textBox, so it
          // never went through _clampAllTextboxes and could render past the
          // viewport edge (clipped by the colour strip / label bars, or off
          // the box entirely for an ROI near the boundary). Clamp it into the
          // same safe zone used elsewhere (PL/PR/PT/PB), estimating text width
          // from character count since the node isn't in the DOM yet to measure.
          if (isPCTRow) {
            try {
              const stats = roiStatsFromAnnotation(ann, true)
              const label = stats.uncalibrated
                ? (stats.uncalibratedReason || 'SUV unavailable')
                : `SUV Mean ${stats.suvMean ?? '—'}  Max ${stats.suvMax ?? '—'}`

              const c_cv = vp.worldToCanvas(pts[0])
              const PL = 8, PR = 30, PT = 22, PB = 28
              const FONT_PX  = 12
              const CHAR_W   = FONT_PX * 0.62   // monospace approx
              const txtW     = label.length * CHAR_W
              const txtH     = FONT_PX
              const elW      = el.clientWidth  || vp.element?.clientWidth  || 0
              const elH      = el.clientHeight || vp.element?.clientHeight || 0

              let tx = Math.round(c_cv[0]) + 14   // text-anchor is start (left edge)
              let ty = Math.round(c_cv[1]) - 14   // baseline

              if (elW > 0) {
                if (tx + txtW > elW - PR) tx = elW - PR - txtW
                if (tx < PL) tx = PL
              }
              if (elH > 0) {
                // ty is the text baseline; top of glyphs is roughly ty - txtH
                if (ty - txtH < PT) ty = PT + txtH
                if (ty > elH - PB) ty = elH - PB
              }

              const txt = document.createElementNS(svgns, 'text')
              txt.setAttribute('x', String(Math.round(tx)))
              txt.setAttribute('y', String(Math.round(ty)))
              txt.setAttribute('font-family', 'monospace')
              txt.setAttribute('font-size', `${FONT_PX}px`)
              txt.setAttribute('fill', 'rgb(255,222,0)')
              txt.setAttribute('paint-order', 'stroke')
              txt.setAttribute('stroke', 'rgba(0,0,0,0.7)')
              txt.setAttribute('stroke-width', '3')
              txt.setAttribute('pointer-events', 'none')
              txt.textContent = label
              g.appendChild(txt)
            } catch(e) {}
          }

          // -- Handle dots: hover/selected only ---------------------------------
          // Hover-only, per spec: a freshly-drawn annotation is auto-selected
          // by CS3D and stays selected until something else is clicked, which
          // previously kept its handles visible "at all times" even with the
          // pointer elsewhere. Selection is still used for the delete toolbar
          // (selectedUIDs state), just not for handle-dot visibility here.
          const isHovered = hoveredUIDRef.current === ann.annotationUID
          if (!isHovered) continue

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
            // Canvas-space rim dots -- correct for all MPR orientations.
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

    function onAnnotationRendered(evt) {
      if (evt.detail?.viewportId !== viewportId) return
      _clampAllTextboxes()
      _rebuildOverlay()
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

    // -- Hover detection (rAF-throttled) for handle-dot visibility -------------
    // Hit-tests pointer proximity against this viewport's ROI annotations
    // (same geometry the interior-hit patch in cornerstone-init.js uses) and
    // only rebuilds the overlay when the hovered UID actually changes, so we
    // don't thrash the SVG on every mousemove.
    let rafPending = false
    let lastClientXY = null
    function _hitTestHover() {
      rafPending = false
      if (!lastClientXY) return
      try {
        const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)
        if (!vp || !vp.element) return
        const rect = vp.element.getBoundingClientRect()
        const cx = lastClientXY[0] - rect.left
        const cy = lastClientXY[1] - rect.top
        const all = annotation.state.getAllAnnotations() || []
        const myRow = viewportId.startsWith('pct-') ? 'pct' : viewportId.startsWith('ct-') ? 'ct' : null
        let foundUID = null, bestDist = Infinity
        for (const ann of all) {
          const src = ann.metadata?.sourceViewportId
          const rowShared = ann.metadata?.rowShared && ann.metadata?.viewportRow === myRow
          if (src !== viewportId && !rowShared) continue
          const toolName = ann.metadata?.toolName || ''
          if (!OVERLAY_TOOLS.includes(toolName)) continue
          const pts = ann.data?.handles?.points
          if (!pts?.length) continue
          if (toolName === 'CircleROI') {
            const c_cv = vp.worldToCanvas(pts[0])
            const r_cv = vp.worldToCanvas(pts[1])
            const radius = Math.hypot(r_cv[0]-c_cv[0], r_cv[1]-c_cv[1])
            const dist = Math.hypot(cx - c_cv[0], cy - c_cv[1])
            if (Math.abs(dist - radius) <= 14 || dist <= 14) {
              if (dist < bestDist) { bestDist = dist; foundUID = ann.annotationUID }
            }
          } else {
            // Generic: near any handle point (covers Ellipse/Rect corners + edges).
            for (const wp of pts) {
              const cv = vp.worldToCanvas(wp)
              const dist = Math.hypot(cx - cv[0], cy - cv[1])
              if (dist <= 14 && dist < bestDist) { bestDist = dist; foundUID = ann.annotationUID }
            }
          }
        }
        if (hoveredUIDRef.current !== foundUID) {
          hoveredUIDRef.current = foundUID
          _rebuildOverlay()
        }
      } catch(e) {}
    }
    const onPointerMove = (e) => {
      lastClientXY = [e.clientX, e.clientY]
      if (!rafPending) { rafPending = true; requestAnimationFrame(_hitTestHover) }
    }
    const onPointerLeave = () => {
      lastClientXY = null
      if (hoveredUIDRef.current !== null) { hoveredUIDRef.current = null; _rebuildOverlay() }
    }
    if (el) {
      el.addEventListener('pointermove', onPointerMove)
      el.addEventListener('pointerleave', onPointerLeave)
    }

    return () => {
      eventTarget.removeEventListener(RENDERED, onAnnotationRendered)
      eventTarget.removeEventListener(MODIFIED, onAnnotationRendered)
      if (el) {
        el.removeEventListener('pointerup', onPointerUp)
        el.removeEventListener('pointermove', onPointerMove)
        el.removeEventListener('pointerleave', onPointerLeave)
      }
    }
  }, [viewportId, _clampAllTextboxes])

  function _applyViewportVisibility() {
    // Ensure all tagged annotations have correct visibility state.
    // Row-shared pct annotations are globally visible (CS3D plane-intersection
    // handles which plane they appear on). Single-viewport annotations are
    // shown only on their own source viewport.
    try {
      const all = annotation.state.getAllAnnotations()
      if (!all?.length) return
      all.forEach(ann => {
        const src = ann.metadata?.sourceViewportId
        if (!src) return // untagged (crosshairs, CS3D internals) -- never touch
        try {
          // Row-shared: always globally visible (plane filter handles the rest)
          if (ann.metadata?.rowShared) {
            if (!annotation.visibility.isAnnotationVisible(ann.annotationUID)) {
              annotation.visibility.setAnnotationVisibility(ann.annotationUID, true)
            }
            return
          }
          // Single-viewport: visible only; never explicitly hide from here
          // (global hide would remove it from the source viewport too)
          if (src === viewportId) {
            if (!annotation.visibility.isAnnotationVisible(ann.annotationUID)) {
              annotation.visibility.setAnnotationVisibility(ann.annotationUID, true)
            }
          }
        } catch(e) {}
      })
    } catch(e) {}
  }

  // -- Annotation deletion ---------------------------------------------------
  // Track selected annotation UIDs via CS3D ANNOTATION_SELECTION_CHANGE event.
  // Show a floating delete toolbar when any annotation is selected.
  // NO right-click context menu -- right-click is reserved for Zoom.
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

  // -- Delete key -- scoped to this viewport ---------------------------------
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

  // Explicitly clear the custom SVG overlay (handle dots + SUV/HU text drawn
  // by _rebuildOverlay elsewhere in this file) on every viewport that could
  // be showing it for a just-deleted annotation. Necessary because that
  // overlay only rebuilds in response to CS3D's ANNOTATION_RENDERED/MODIFIED
  // events, and deleting the LAST annotation on a viewport apparently doesn't
  // reliably fire those (there's nothing left for CS3D itself to render) --
  // which is exactly why the "Patient weight missing" SUV text was staying
  // on screen after the ROI that produced it was deleted. A plain image
  // render() (used elsewhere for _renderAll) doesn't touch this overlay at
  // all, since it's not part of CS3D's own annotation rendering pipeline.
  function _clearStaleOverlays() {
    try {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID)
      const ids = ['ct-axial', 'ct-coronal', 'ct-sagittal', 'pct-axial', 'pct-coronal', 'pct-sagittal']
      ids.forEach(id => {
        try {
          const vp = engine?.getViewport(id)
          const el = vp?.element
          if (!el) return
          el.querySelector('div.viewport-element > svg.svg-layer')
            ?.querySelector('#handle-overlay')
            ?.remove()
        } catch(e) {}
      })
    } catch(e) {}
  }

  function _deleteSelected() {
    try {
      // Prefer the UIDs we captured on selection-change (the live selection is
      // often already cleared by the time the click handler runs).
      let uids = selectedUIDs;
      if (!uids?.length) uids = annotation.selection.getAnnotationsSelected() || [];
      uids.forEach(uid => { try { annotation.state.removeAnnotation(uid); } catch(e) {} });
      _clearStaleOverlays();
      _renderAll();
    } catch(e) {}
    setSelectedUIDs([]);
  }

  function _deleteAnnotation(uid) {
    try {
      annotation.state.removeAnnotation(uid);
      _clearStaleOverlays();
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
        if (n) { // centroid (~= line midpoint / ROI centre)
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
      try { annotation.state.removeAnnotation(hit.annotationUID); _clearStaleOverlays(); _renderAll(); } catch(e) {}
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
      _clearStaleOverlays()
      _renderAll()
    } catch(e) {}
    setSelectedUIDs([])
  }

  function _renderViewport() {
    try {
      getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId)?.render();
    } catch(e) {}
  }

  // Render every viewport -- used after a delete so the annotation disappears
  // from all planes/boxes that were showing it (same-plane fusion view etc.).
  function _renderAll() {
    try { getRenderingEngine(RENDERING_ENGINE_ID)?.render(); } catch(e) {}
  }

  // -- Palette helpers -------------------------------------------------------
  const rawPalettes = (modality === 'PET' || modality === 'MIP') ? PET_PALETTES : CT_PALETTES;
  const palettes    = modality === 'MIP' ? rawPalettes.filter(p => p.group !== 'fmri') : rawPalettes;
  const presets  = modality === 'PET' ? PET_PRESETS  : CT_PRESETS;

  const openPal  = () => { clearTimeout(closeTimers.current.pal); setShowPalMenu(true); };
  const closePal = () => { closeTimers.current.pal = setTimeout(() => setShowPalMenu(false), 180); };
  const openPre  = () => { clearTimeout(closeTimers.current.pre); setShowPresets(true); };
  const closePre = () => { closeTimers.current.pre = setTimeout(() => setShowPresets(false), 180); };

  // -- Drag-and-drop series loading -------------------------------------------
  // Only wired when ViewportGrid passed onSeriesDrop (ct-axial / pct-axial
  // only). Validates the dropped series' modality matches what this box
  // expects, and that it belongs to the currently-loaded study (SeriesPanel
  // should only ever offer the current study's series, but a stale drag from
  // before a study switch is defensively rejected too) before bubbling it up.
  const _expectedModalities = modality === 'CT' ? ['CT'] : (modality === 'PET' || modality === 'MIP') ? ['PT', 'PET'] : [];
  const handleSeriesDragOver = (e) => {
    if (!onSeriesDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!seriesDragOver) setSeriesDragOver(true);
  };
  const handleSeriesDragLeave = () => { if (seriesDragOver) setSeriesDragOver(false); };
  const handleSeriesDrop = (e) => {
    if (!onSeriesDrop) return;
    e.preventDefault();
    setSeriesDragOver(false);
    try {
      const raw = e.dataTransfer.getData('application/petct-series');
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (!payload?.seriesUID || !payload?.modality) return;
      if (!_expectedModalities.includes(payload.modality)) {
        console.warn(`[ViewerBox] rejected drop: ${payload.modality} series onto ${modality} box`);
        return;
      }
      if (dropStudyUID && payload.studyUID && payload.studyUID !== dropStudyUID) {
        console.warn('[ViewerBox] rejected drop: series belongs to a different study');
        return;
      }
      onSeriesDrop(payload.modality, payload.seriesUID);
    } catch(e) {
      console.warn('[ViewerBox] series drop parse failed:', e?.message);
    }
  };

  // -- Render ----------------------------------------------------------------
  return (
    <div
      onDoubleClick={onDoubleClick}
      className={modality === 'MIP' ? 'vp-mip' : undefined}
      style={{
        position: 'absolute', inset: 0, overflow: 'visible',
        background: modality === 'MIP' ? '#ffffff' : '#000000',
        border: `1.5px solid ${isExpanded ? accentColor : modality === 'MIP' ? '#cccccc' : '#252525'}`,
        borderRadius: 3,
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* CS3D viewport element -- clipPath on BOTH the wrapper AND the element
          itself. CS3D appends its SVG annotation layer as a child of divRef,
          so clipping only the outer wrapper isn't enough -- we must clip divRef
          too. Both use inset(0) which clips at the element boundary. */}
      <div style={{
        flex: 1, minHeight: 0, position: 'relative',
        overflow: 'hidden',
        clipPath: 'inset(0)',
        background: modality === 'MIP' ? '#ffffff' : '#000000',
      }}>
        <div
          ref={divRef}
          onContextMenu={e => e.preventDefault()}
          onDragOver={handleSeriesDragOver}
          onDragLeave={handleSeriesDragLeave}
          onDrop={handleSeriesDrop}
          style={{
            position: 'absolute', inset: 0,
            overflow: 'hidden',
            clipPath: 'inset(0)',
            background: modality === 'MIP' ? '#ffffff' : '#000000',
            outline: seriesDragOver ? `2px dashed ${accentColor}` : 'none',
            outlineOffset: -2,
          }}
        />

        {/* Canvas2D PET fusion overlay - INSIDE position:relative so inset:0
            places it exactly over the WebGL canvas. pointer-events:none passes
            all mouse events through to CS3D underneath. */}
        {modality === 'PET' && isVolume && (
          <canvas ref={glCanvasRef} style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: 6,
          }} />
        )}
      </div>

      {/* Fusion alignment overlay -- manual mode, PET-CT viewports only.
          Dashed blue crosshair giving visual feedback that the PET layer is being
          shifted/rotated. Centred in the viewport; translates proportionally to TX/TY
          so the user can see the PET moving before the VTK actor re-renders. */}
      {isVolume && modality === 'PET' && fusionMode === 'manual' && (
        <FusionOverlay fusionOffset={fusionOffset} />
      )}

      {/* Orientation markers (R/L/A/P/S/I) -- volume MPR viewports only */}
      {isVolume && modality !== 'MIP' && <OrientationMarkers orientation={orientation} />}

      {/* Label -- top left */}
      <div style={{
        position: 'absolute', top: 6, left: 8,
        fontSize: 10, fontFamily: 'monospace',
        color: '#ffffff',
        pointerEvents: 'none', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,.9)',
      }}>
        {label}
      </div>

      {/* Patient info -- top right */}
      <div style={{
        position: 'absolute', top: 6, right: 28,
        textAlign: 'right', pointerEvents: 'none', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,.9)',
      }}>
        <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#ffffff', lineHeight: 1.4 }}>
          ALKA JAGTAP . F . 52y
        </div>
        <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#dddddd', lineHeight: 1.4 }}>
          PET-CT . 28 Jan 2026
        </div>
        {sliceInfo.total > 0 && (
          <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#bbbbbb', lineHeight: 1.4 }}>
            {sliceInfo.current}/{sliceInfo.total}
          </div>
        )}
      </div>

      {/* Slice number -- left middle */}
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

      {/* W/L display -- bottom left, above cine bar */}
      <div style={{
        position: 'absolute', bottom: modality === 'PET' ? 52 : 24, left: 28,
        fontSize: 9, fontFamily: 'monospace', color: '#ffffff',
        pointerEvents: 'none', userSelect: 'none',
        textShadow: '0 1px 3px rgba(0,0,0,.9)',
      }}>
        W:{wl?.ww != null ? (wl.ww >= 1000 ? (wl.ww/1000).toFixed(0)+'K' : wl.ww) : '—'} L:{wl?.wc != null ? (wl.wc >= 1000 ? (wl.wc/1000).toFixed(0)+'K' : wl.wc) : '—'}
      </div>

      {/* SUV bar -- PET only */}
      {modality === 'PET' && (
        <SUVBar suvMin={suvMin} suvMax={suvMax} onSUV={onSUV} />
      )}

      {/* Presets hover trigger */}
      <PresetBar
        presets={presets} accentColor={accentColor}
        open={showPresets} onEnter={openPre} onLeave={closePre}
        onSelect={p => { onWL?.({ wc: p.wc, ww: p.ww }); setShowPresets(false); }}
      />

      {/* Colormap strip -- right edge */}
      <ColormapStrip
        paletteId={effectivePaletteId} palettes={palettes} wl={wl}
        modality={modality}
        onWLDrag={(c,w) => onWL?.(c,w)}
        showMenu={showPalMenu} onEnterMenu={openPal} onLeaveMenu={closePal}
        onSelectPalette={id => {
          setPaletteId(id);
          setShowPalMenu(false);
          // PET: notify parent to sync all 3 pct- boxes (not MIP - no onPaletteChange passed for MIP)
          if (modality === 'PET' && onPaletteChange) onPaletteChange(id);
        }}
      />

      {/* PET opacity slider -- REMOVED per explicit instruction: redundant
          now that the colour-strip's two compression cursors (below) serve
          the same "make subtle differences stand out" purpose. */}

      {/* MIP orientation bar -- A/P/R/L/H/F buttons, MIP viewport only */}
      {modality === 'MIP' && (
        <MIPOrientationBar viewportId={viewportId} onStopRotation={() => setMipPlaying(false)} />
      )}

      {/* Cine controls -- bottom of every box */}
      <CineBar
        viewportId={viewportId} modality={modality} isMIP={modality === 'MIP'}
        mipPlaying={mipPlaying} onMipPlayingChange={setMipPlaying}
      />

      {/* (Removed) auto-appearing "N selected / Delete" toolbar -- it popped up
          immediately after every draw. Deletion is now via right-click on the
          annotation, or the Del key while hovering this box. */}

      {/* Clear all button -- bottom right */}
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
      >{String.fromCharCode(0x2298)}</div>

      {/* Right-click delete popup -- only shows after a non-drag right click */}
      {deletePopup && (
        <div
          style={{
            position: 'fixed', left: deletePopup.x, top: deletePopup.y,
            background: '#111', border: '1px solid #444',
            borderRadius: 4, zIndex: 9999, overflow: 'hidden',
            boxShadow: '0 4px 16px rgba(0,0,0,.9)', minWidth: 160,
          }}
          onMouseDown={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
        >
          <div style={{ padding: '4px 10px', fontSize: 8, color: '#555', borderBottom: '1px solid #1e1e1e', textTransform: 'uppercase', letterSpacing: 1 }}>
            Annotations
          </div>
          <div
            onMouseDown={() => { if (deletePopup.uid) _deleteAnnotation(deletePopup.uid); else _deleteAtPoint(deletePopup.x, deletePopup.y); setDeletePopup(null); }}
            style={{ padding: '7px 12px', fontSize: 10, color: '#ff8888', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={e => e.currentTarget.style.background = '#1e1e1e'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          ><span>x</span><span>Delete this annotation</span></div>
          <div
            onMouseDown={() => { _clearAllAnnotations(); setDeletePopup(null); }}
            style={{ padding: '7px 12px', fontSize: 10, color: '#cc6666', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid #1a1a1a' }}
            onMouseEnter={e => e.currentTarget.style.background = '#1e1e1e'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          ><span>{String.fromCharCode(0x2298)}</span><span>Clear all in this box</span></div>
          <div style={{ padding: '4px 10px', fontSize: 8, color: '#444', borderTop: '1px solid #1a1a1a' }}>
            Del key = delete selected
          </div>
        </div>
      )}
    </div>
  );
}

// --- Orientation markers (R/L/A/P/S/I) ------------------------------------------
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

// --- Apply viewport properties ------------------------------------------------
function _voi(wl) {
  return { lower: wl.wc - wl.ww / 2, upper: wl.wc + wl.ww / 2 };
}

function _applyProps(vp, wl, effectivePaletteId) {
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

// --- Cine bar -- bottom of every viewport -------------------------------------
// For non-MIP viewports: cycles through slices (scroll cine).
// For MIP viewport: rotates the camera around the Z-axis (360deg rotation).
//
// MIP rotation strategy (Rule 12):
//   The MIP is a volume viewport (ORTHOGRAPHIC + MAXIMUM_INTENSITY_BLEND).
//   We store a rotation angle in degrees and advance it each rAF frame.
//   setCamera({ viewUp, position }) changes the projection direction.
//   We keep the focal point at the volume centre and orbit the camera
//   at a fixed radius around the IS (Z) axis, matching clinical convention
//   where the patient rotates left->right in the coronal plane.
//
// Slice scroll cine for non-MIP (stack and volume modes):
//   We use setInterval at the chosen fps and call vp.scroll(1) which works
//   for both STACK (stackScroll moves slice index) and ORTHOGRAPHIC volume
//   (stackScroll advances the slab position on the current axis).
function CineBar({ viewportId, modality, isMIP, mipPlaying, onMipPlayingChange }) {
  // MIP: playing state is lifted to ViewerBox so orientation bar can stop it.
  // Non-MIP: local state.
  const [localPlaying, setLocalPlaying] = useState(false)
  const playing    = isMIP ? (mipPlaying ?? false)      : localPlaying
  const setPlaying = isMIP ? (onMipPlayingChange ?? (() => {})) : setLocalPlaying

  const [fps, setFps]           = useState(isMIP ? 30 : 8)
  const rAFRef   = useRef(null)   // rAF id for MIP rotation
  const timerRef = useRef(null)   // setInterval id for slice scroll
  const angleRef = useRef(0)      // current rotation angle in degrees (MIP)
  // Track playing in a ref so the rAF closure always sees the latest value
  const playingRef = useRef(false)

  // -- Step: advance by one unit (slice or MIP angle step) ------------------
  function _stepMIP(angleDelta) {
    try {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID)
      const vp = engine?.getViewport(viewportId)
      if (!vp) return
      const cam = vp.getCamera()
      if (!cam?.focalPoint) return
      const fp = cam.focalPoint          // volume centre - stays fixed
      const dist = Math.hypot(
        cam.position[0] - fp[0],
        cam.position[1] - fp[1],
        cam.position[2] - fp[2],
      ) || 800                           // fallback radius
      angleRef.current = (angleRef.current + angleDelta + 360) % 360
      const rad = (angleRef.current * Math.PI) / 180
      // Orbit in the coronal plane: camera swings around the patient Z-axis.
      // Position: rotate (initial front = -Y direction) around Z.
      // Clinical MIP rotation: A-RAO-R-RPO-P-LPO-L-LAO-A
      // In RAS coordinates: front = +Y (anterior), right = +X
      const newPos = [
        fp[0] + dist * Math.sin(rad),   // X: 0 at 0-, +dist at 90- (right lat)
        fp[1] - dist * Math.cos(rad),   // Y: -dist at 0- (anterior view)
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

  // -- rAF loop for MIP -----------------------------------------------------
  const fpsRef = useRef(fps)
  useEffect(() => { fpsRef.current = fps }, [fps])

  useEffect(() => {
    if (!isMIP || !playing) return
    let last = 0
    playingRef.current = true

    function loop(ts) {
      if (!playingRef.current) return
      // degrees/frame = rpm - 360- / 60sec / 60fps = rpm - 0.1
      // At rpm=30: 3-/frame - 1 rev in 2s. At rpm=70: 7-/frame - 1 rev in 0.86s.
      _stepMIP(fpsRef.current * 0.1)
      rAFRef.current = requestAnimationFrame(loop)
    }
    rAFRef.current = requestAnimationFrame(loop)

    return () => {
      playingRef.current = false
      if (rAFRef.current) { cancelAnimationFrame(rAFRef.current); rAFRef.current = null }
    }
  }, [playing, isMIP, viewportId])

  // -- Interval loop for slice scroll ----------------------------------------
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
        type="range"
        min={isMIP ? 20 : 1} max={isMIP ? 70 : 30} step={isMIP ? 10 : 1}
        value={fps}
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

// --- MIP Orientation Bar - 6 standard projection views -----------------------
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
// Note: resetCamera() after setCamera() is intentional - it refits the whole
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

function MIPOrientationBar({ viewportId, onStopRotation }) {
  const [activeView, setActiveView] = useState('A')

  function _applyView(view) {
    // Stop rotation first so rAF loop doesn't overwrite our camera position
    onStopRotation?.()
    try {
      const engine = getRenderingEngine(RENDERING_ENGINE_ID)
      const vp = engine?.getViewport(viewportId)
      if (!vp) return

      const cam = vp.getCamera()
      if (!cam?.focalPoint) return

      const fp = cam.focalPoint
      // Preserve current zoom. NEVER call resetCamera() -- it discards user zoom.
      const parallelScale = cam.parallelScale

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

      vp.setCamera({ position: newPos, focalPoint: fp, viewUp: view.up, parallelScale })
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

// --- SUV bar ------------------------------------------------------------------
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

// --- Colormap strip -----------------------------------------------------------
function ColormapStrip({ paletteId, palettes, wl, modality, onWLDrag, showMenu, onEnterMenu, onLeaveMenu, onSelectPalette }) {
  const canvasRef = useRef();
  const dragRef   = useRef({ active: false, lastY: 0 });
  const wlRef     = useRef(wl);
  useEffect(() => { wlRef.current = wl; }, [wl]);
  const stripWrapRef = useRef(null);
  const [hoverHandle, setHoverHandle]   = useState(null);  // 'upper' | 'lower' | null -- idle hover
  const [activeHandle, setActiveHandle] = useState(null);  // 'upper' | 'lower' | null -- currently dragging

  // PET-CT (3 boxes) + MIP share this "compression cursor" behaviour, per
  // explicit design: two independently-draggable absolute-position handles
  // representing the LOWER and UPPER bound of the displayed W/L window
  // directly (rather than the old single relative-drag-by-delta handle).
  // Narrowing the gap between them is mathematically identical to narrowing
  // ww while moving wc -- exactly like a standard CT HU windowing control --
  // which is why it makes subtle PET/MIP intensity differences stand out.
  // wl is already shared App-level state across all 3 pct- boxes AND mip
  // (see ViewportGrid.jsx's wl={modality==='CT' ? ctWL : petWL}), so no new
  // plumbing is needed for the "changing it in any of the 4 updates all 4"
  // requirement -- dragging either handle just calls the existing onWLDrag.
  const isCompressible = modality === 'PET' || modality === 'MIP';
  const SCALE_MAX = 50000; // = DEF_PET_WL.wc + DEF_PET_WL.ww/2 -- default cursors land exactly at the strip's top/bottom edges
  const MIN_GAP_255 = 25;    // minimum gap, in the SAME 0-255 scale the cursor labels show
  const MIN_GAP   = (MIN_GAP_255 / 255) * SCALE_MAX; // converted to raw W/L units for the clamp math below

  const lowerBound = isCompressible ? Math.max(0, wl.wc - wl.ww / 2) : 0;
  const upperBound = isCompressible ? Math.min(SCALE_MAX, wl.wc + wl.ww / 2) : SCALE_MAX;
  const fracLower = Math.max(0, Math.min(1, lowerBound / SCALE_MAX));
  const fracUpper = Math.max(0, Math.min(1, upperBound / SCALE_MAX));
  // Display only: cursor labels show a 0-255 scale position, not raw PET
  // W/L units -- the underlying drag math is unchanged (still drives real
  // wc/ww), this only affects what number the user sees on the label.
  const upperDisplay255 = Math.round(fracUpper * 255);
  const lowerDisplay255 = Math.round(fracLower * 255);

  const frac = Math.max(0, Math.min(1, (wl.wc + 2000) / 6000)); // CT-only, unchanged

  // Always-fresh snapshot for the ResizeObserver callback below, which is
  // registered once (mount-only effect) and must never read stale closure
  // values -- a resize firing after a cross-box drag updated fracLower/
  // fracUpper would otherwise repaint with outdated numbers, silently
  // undoing a correct compression that just happened.
  const drawArgsRef = useRef(null);
  drawArgsRef.current = { paletteId, frac, drawMarker: !isCompressible, fracLower, fracUpper };

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ro = new ResizeObserver(() => {
      const a = drawArgsRef.current;
      _drawStrip(c, a.paletteId, a.frac, a.drawMarker, a.fracLower, a.fracUpper);
    });
    ro.observe(c);
    const a = drawArgsRef.current;
    _drawStrip(c, a.paletteId, a.frac, a.drawMarker, a.fracLower, a.fracUpper);
    return () => ro.disconnect();
  }, []);

  // No dependency array -- runs after EVERY render, unconditionally. This
  // sidesteps a cross-box gradient-sync bug (PCT and MIP strips intermittently
  // not reflecting each other's cursor changes) that survived multiple
  // targeted fixes and could not be root-caused through static analysis of
  // the prop chain. Rather than rely on a dependency-array comparison that
  // may be missing something subtle, the canvas is now unconditionally
  // redrawn with whatever fracLower/fracUpper/paletteId this render computed
  // -- guaranteed correct on every single render, full stop.
  useEffect(() => {
    const c = canvasRef.current;
    if (c) _drawStrip(c, paletteId, frac, !isCompressible, fracLower, fracUpper);
  });

  // -- CT-only: original single relative-drag-by-delta handle ---------------
  const onMouseDown = (e) => {
    if (isCompressible) return; // PET/MIP use the two dedicated handles below
    e.preventDefault(); e.stopPropagation();
    dragRef.current = { active: true, lastY: e.clientY };
    const mv = (ev) => {
      if (!dragRef.current.active) return;
      const dy = ev.clientY - dragRef.current.lastY;
      dragRef.current.lastY = ev.clientY;
      const cur = wlRef.current;
      const wc = (cur && typeof cur === 'object' && Number.isFinite(cur.wc)) ? cur.wc : 40;
      const ww = (cur && typeof cur === 'object' && Number.isFinite(cur.ww)) ? cur.ww : 400;
      onWLDrag(Math.max(-2000, Math.min(4000, wc - dy * 4)),
               Math.max(1, Math.min(8000, ww + Math.abs(dy) * 2)));
    };
    const up = () => { dragRef.current.active = false; window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  // -- PET/MIP: two independent absolute-position handles -------------------
  // clientY -> fraction within the strip's current on-screen bounds (0 at
  // bottom, 1 at top, matching the canvas gradient's own orientation).
  function _fracFromClientY(clientY) {
    const el = stripWrapRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const topOffset = 20; // matches the compressible-mode marginTop above (18px header + 2px buffer)
    const usable = Math.max(1, rect.height - topOffset);
    const y = clientY - rect.top - topOffset;
    return Math.max(0, Math.min(1, 1 - y / usable));
  }

  function _startHandleDrag(which) {
    return (e) => {
      e.preventDefault(); e.stopPropagation();
      setActiveHandle(which);
      // Capture the OTHER (non-dragged) handle's bound ONCE, at drag start --
      // it doesn't move during this drag, so there's no reason to re-read it
      // from wlRef (which lags behind fast mousemove events) on every move.
      const cur = wlRef.current;
      const fixedLower = Math.max(0, (cur?.wc ?? 0) - (cur?.ww ?? 0) / 2);
      const fixedUpper = Math.min(SCALE_MAX, (cur?.wc ?? 0) + (cur?.ww ?? 0) / 2);

      // THROTTLE (not just rAF-dedup): each onWLDrag call cascades into a
      // full CS3D re-render on all 4 PET-CT/MIP viewports, MIP rebuilding
      // its entire 256-entry colour LUT every time. Console violations
      // showed requestAnimationFrame handlers taking 300+ms and setInterval
      // blocking 3+ seconds during a drag -- firing this cascade up to 60x/
      // second was overwhelming the main thread badly enough that updates
      // queued up and appeared to apply inconsistently across boxes. 80ms
      // minimum between actual state commits; the final mouse position is
      // always applied immediately on release, never lost to the throttle.
      const MIN_INTERVAL_MS = 80;
      let lastFireTime = 0;
      let pendingTimer = null;
      let rafPending = false;
      let latestClientY = e.clientY;

      const _commit = () => {
        lastFireTime = Date.now();
        const f = _fracFromClientY(latestClientY);
        const raw = f * SCALE_MAX;
        let newLower = fixedLower, newUpper = fixedUpper;
        if (which === 'lower') {
          newLower = Math.max(0, Math.min(raw, fixedUpper - MIN_GAP));
        } else {
          newUpper = Math.min(SCALE_MAX, Math.max(raw, fixedLower + MIN_GAP));
        }
        const newWc = (newLower + newUpper) / 2;
        const newWw = Math.max(MIN_GAP, newUpper - newLower);
        onWLDrag(newWc, newWw);
      };
      const _apply = () => {
        rafPending = false;
        const elapsed = Date.now() - lastFireTime;
        if (elapsed >= MIN_INTERVAL_MS) {
          if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
          _commit();
        } else if (!pendingTimer) {
          pendingTimer = setTimeout(() => { pendingTimer = null; _commit(); }, MIN_INTERVAL_MS - elapsed);
        }
      };
      const mv = (ev) => {
        latestClientY = ev.clientY;
        if (!rafPending) { rafPending = true; requestAnimationFrame(_apply); }
      };
      const up = () => {
        // Guarantee the exact release position is applied, bypassing the throttle.
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        _commit();
        setActiveHandle(null);
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    };
  }

  // -- PET/MIP: pan BOTH cursors together, preserving the exact gap ---------
  // Hovering the strip body (anywhere except directly on a cursor line) shows
  // a move/pan cursor; dragging there shifts the whole window up/down without
  // changing its width -- e.g. upper=200/lower=25 (gap 175) stays gap-175
  // throughout the pan, only wc shifts. Clamped at the edges so the gap can
  // never be altered by hitting 0 or SCALE_MAX -- the delta itself gets
  // capped, not either bound individually.
  function _startPanDrag(e) {
    e.preventDefault(); e.stopPropagation();
    setActiveHandle('pan');
    const cur = wlRef.current;
    const startLower = Math.max(0, (cur?.wc ?? 0) - (cur?.ww ?? 0) / 2);
    const startUpper = Math.min(SCALE_MAX, (cur?.wc ?? 0) + (cur?.ww ?? 0) / 2);
    const gap = startUpper - startLower;
    const startFrac = _fracFromClientY(e.clientY);

    const MIN_INTERVAL_MS = 80; // same throttle rationale as _startHandleDrag
    let lastFireTime = 0;
    let pendingTimer = null;
    let rafPending = false;
    let latestClientY = e.clientY;

    const _commit = () => {
      lastFireTime = Date.now();
      const f = _fracFromClientY(latestClientY);
      const rawDelta = (f - startFrac) * SCALE_MAX;
      // Clamp the DELTA itself (not either bound separately) so the gap is
      // never altered by hitting an edge -- both bounds move together or not at all.
      const clampedDelta = Math.max(-startLower, Math.min(SCALE_MAX - startUpper, rawDelta));
      const newLower = startLower + clampedDelta;
      const newUpper = newLower + gap;
      const newWc = (newLower + newUpper) / 2;
      const newWw = gap;
      onWLDrag(newWc, newWw);
    };
    const _apply = () => {
      rafPending = false;
      const elapsed = Date.now() - lastFireTime;
      if (elapsed >= MIN_INTERVAL_MS) {
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
        _commit();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => { pendingTimer = null; _commit(); }, MIN_INTERVAL_MS - elapsed);
      }
    };
    const mv = (ev) => {
      latestClientY = ev.clientY;
      if (!rafPending) { rafPending = true; requestAnimationFrame(_apply); }
    };
    const up = () => {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      _commit();
      setActiveHandle(null);
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  }

  const groups = _groupPalettes(palettes);

  return (
    <div
      ref={stripWrapRef}
      style={{
        position: 'absolute', top: 0, right: 0,
        bottom: modality === 'PET' ? 38 : modality === 'MIP' ? 37 : 20,
        width: 22,
        borderLeft: `1px solid ${modality === 'MIP' ? '#cccccc' : '#333'}`,
        cursor: 'ns-resize', userSelect: 'none',
        background: modality === 'MIP' ? '#ffffff' : 'transparent',
        overflow: 'visible',
        zIndex: 20,
      }}
      onMouseDown={onMouseDown}
    >
      {/* Palette selector button - TOP of strip, always visible */}
      <div
        onMouseEnter={onEnterMenu} onMouseLeave={onLeaveMenu}
        onMouseDown={e => { e.stopPropagation(); e.preventDefault(); }}
        onClick={e => { e.stopPropagation(); onEnterMenu(); }}
        title="Change colour palette"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 18,
          background: modality === 'MIP' ? 'rgba(220,220,220,.97)' : 'rgba(0,0,0,.85)',
          fontSize: 8, color: modality === 'MIP' ? '#333' : '#00e5ff',
          textAlign: 'center', lineHeight: '18px',
          borderBottom: `1px solid ${modality === 'MIP' ? '#ccc' : '#444'}`,
          cursor: 'pointer', zIndex: 25, userSelect: 'none',
          fontWeight: 'bold', letterSpacing: 0.5,
        }}
      >&#9660;pal</div>

      <div style={{ position: 'relative', marginTop: isCompressible ? 20 : 18, height: `calc(100% - ${isCompressible ? 20 : 18}px)` }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

        {isCompressible && (
          <div
            onMouseDown={_startPanDrag}
            title="Drag to move both cursors together (gap preserved)"
            style={{
              position: 'absolute', inset: 0,
              cursor: 'move', zIndex: 25, // below the handles (30) so they stay individually grabbable
            }}
          />
        )}

        {isCompressible && (
          <>
            {/* Upper bound cursor -- thick line, drag to compress/stretch the
                TOP of the displayed intensity window. Bar renders DOWNWARD
                from its target line (marginTop:0) so at the default
                fracUpper=1 (very top) it stays fully inside the strip
                instead of poking above it. */}
            <div
              onMouseDown={_startHandleDrag('upper')}
              onMouseEnter={() => setHoverHandle('upper')}
              onMouseLeave={() => setHoverHandle(h => h === 'upper' ? null : h)}
              title={`Upper: ${upperDisplay255}`}
              style={{
                position: 'absolute', left: -2, right: -2,
                top: `${(1 - fracUpper) * 100}%`,
                height: 4, marginTop: 0,
                background: '#ff3344', boxShadow: '0 0 3px rgba(255,51,68,.9)',
                cursor: 'ns-resize', zIndex: 30,
              }}
            />
            {/* Lower bound cursor -- bar renders UPWARD from its target line
                (marginTop:-4) so at the default fracLower=0 (very bottom) it
                stays fully inside instead of poking below it -- this was the
                actual cause of the lower cursor being unreachable: at the
                old centred (marginTop:-2) position, roughly half its hit
                area sat outside the strip's bounds. */}
            <div
              onMouseDown={_startHandleDrag('lower')}
              onMouseEnter={() => setHoverHandle('lower')}
              onMouseLeave={() => setHoverHandle(h => h === 'lower' ? null : h)}
              title={`Lower: ${lowerDisplay255}`}
              style={{
                position: 'absolute', left: -2, right: -2,
                top: `${(1 - fracLower) * 100}%`,
                height: 4, marginTop: -4,
                background: '#3388ff', boxShadow: '0 0 3px rgba(51,136,255,.9)',
                cursor: 'ns-resize', zIndex: 30,
              }}
            />
            {/* Live value label -- shown on hover AND throughout dragging
                (activeHandle covers the drag case, hoverHandle the idle-
                hover case), so the user always sees exactly where a cursor
                is, both at rest and while moving it. */}
            {(hoverHandle || (activeHandle && activeHandle !== 'pan')) && (
              <div style={{
                position: 'absolute', right: '100%', marginRight: 4,
                top: `${(1 - ((activeHandle || hoverHandle) === 'upper' ? fracUpper : fracLower)) * 100}%`,
                transform: 'translateY(-50%)',
                background: 'rgba(12,12,12,.95)', color: '#fff',
                fontSize: 9, padding: '2px 5px', borderRadius: 3,
                whiteSpace: 'nowrap', zIndex: 40, pointerEvents: 'none',
                border: `1px solid ${(activeHandle || hoverHandle) === 'upper' ? '#ff3344' : '#3388ff'}`,
              }}>
                {(activeHandle || hoverHandle) === 'upper' ? 'Upper' : 'Lower'}: {(activeHandle || hoverHandle) === 'upper' ? upperDisplay255 : lowerDisplay255}
              </div>
            )}
            {activeHandle === 'pan' && (
              <div style={{
                position: 'absolute', right: '100%', marginRight: 4,
                top: `${(1 - (fracLower + fracUpper) / 2) * 100}%`,
                transform: 'translateY(-50%)',
                background: 'rgba(12,12,12,.95)', color: '#fff',
                fontSize: 9, padding: '2px 5px', borderRadius: 3,
                whiteSpace: 'nowrap', zIndex: 40, pointerEvents: 'none',
                border: '1px solid #aaaaaa',
              }}>
                {lowerDisplay255}&ndash;{upperDisplay255} (gap {upperDisplay255 - lowerDisplay255})
              </div>
            )}
          </>
        )}
      </div>

      {showMenu && (
        <div
          onMouseEnter={onEnterMenu} onMouseLeave={onLeaveMenu}
          onDoubleClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', top: 18, right: '100%', marginRight: 2,
            background: 'rgba(12,12,12,.97)', border: '1px solid #444',
            borderRadius: 4, boxShadow: '-4px 4px 20px rgba(0,0,0,.9)',
            whiteSpace: 'nowrap', zIndex: 80, minWidth: 160,
            maxHeight: 300, overflowY: 'auto',
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
                    <div style={{ width: 60, height: 10, borderRadius: 2, background: getCssGradient(p.id), border: '1px solid #333', flexShrink: 0 }} />
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

function _drawStrip(canvas, paletteId, frac, drawMarker = true, fracLower = 0, fracUpper = 1) {
  canvas.width  = canvas.offsetWidth  || 22;
  canvas.height = canvas.offsetHeight || 200;
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  if (!ctx || !w || !h) return;
  // Determine if this is a PET palette (apply gamma remap) or CT/MIP (direct)
  // -- but ONLY for the old single-marker (CT) mode. Once the two-cursor
  // compression is active (drawMarker === false), this gamma curve is
  // skipped entirely -- see comment below for why.
  const isCompressed = !drawMarker;
  const isPET = !isCompressed && paletteId && !paletteId.includes('gray') && !paletteId.includes('greyscale');
  const isHotIron = paletteId === 'hot_iron';
  // Compression span: when the two cursors aren't at their default 0/1
  // positions, squeeze the full 256-colour gradient into the region between
  // them (clamping solid colour outside) so the strip itself visibly
  // compresses/expands along with the cursors -- the obvious visual
  // confirmation that one or both have been moved from their default place.
  const span = Math.max(0.001, fracUpper - fracLower);
  for (let y = 0; y < h; y++) {
    const tScreen   = 1 - y / (h - 1);
    // Clamped (shaved-off) region: solid white, regardless of which end --
    // this is what makes it obvious which cursor has been moved no matter
    // what colour the palette naturally has there (some palettes are
    // naturally near-white at one end already, which is exactly the case
    // that made the OTHER end's dark clamp invisible before -- forcing
    // white uniformly removes that dependency on the palette's own colours).
    if (isCompressed && (tScreen < fracLower || tScreen > fracUpper)) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, y, w, 1);
      continue;
    }
    const t         = Math.max(0, Math.min(1, (tScreen - fracLower) / span));
    // FIX: the old gamma remap pow(0.5+t*0.5, 0.75) has a floor of ~0.59 at
    // t=0 -- it never reaches the dark/extreme end of the palette. Applied
    // on top of the NEW compression (which already deliberately stretches
    // the full spectrum across the user's chosen range), this made the
    // LOWER cursor's boundary blend into a visually-similar mid-tone for
    // any non-grey palette, looking exactly like "the strip isn't moving"
    // even though the data and the gradient itself were both updating
    // correctly. Skipped entirely once compression is active -- the two
    // cursors already provide the intended visual stretch on their own.
    const tLookup   = isPET ? Math.min(1, Math.pow(0.10 + t * 0.90, 0.75)) : t;
    let [r, g, b]   = getColor(paletteId, tLookup);
    // Boost red 50% for hot_iron (matches buildLUT in canvasFusion.js)
    if (isHotIron) r = Math.min(255, Math.round(r + (255 - r) * 0.50));
    const whitePush = (isPET && t > 0.70) ? (t - 0.70) * (1 / 0.30) * 0.20 : 0;
    const fr = Math.min(255, Math.round(r + (255 - r) * whitePush));
    const fg = Math.min(255, Math.round(g + (255 - g) * whitePush));
    const fb = Math.min(255, Math.round(b + (255 - b) * whitePush));
    ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
    ctx.fillRect(0, y, w, 1);
  }
  if (isCompressed) {
    // Boundary line at the white-clamp / gradient transition -- still useful
    // even with the white fill above, since a palette that's ALSO near-white
    // right at the edge of its own gradient (some palettes top out near
    // white) would otherwise blend the white clamp into the gradient with no
    // visible seam. A black/white dash is visible regardless of what's on
    // either side.
    const _drawBoundary = (yPos) => {
      const y = Math.max(0, Math.min(h - 1, Math.round(yPos)));
      for (let x = 0; x < w; x++) {
        ctx.fillStyle = (x % 4 < 2) ? '#ffffff' : '#000000';
        ctx.fillRect(x, y, 1, 1);
      }
    };
    if (fracLower > 0) _drawBoundary((1 - fracLower) * (h - 1));
    if (fracUpper < 1) _drawBoundary((1 - fracUpper) * (h - 1));
  }
  if (!drawMarker) return; // PET/MIP: the two DOM cursor handles replace this
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

// --- Preset bar ---------------------------------------------------------------
function PresetBar({ presets, accentColor, open, onEnter, onLeave, onSelect }) {
  return (
    <div onMouseEnter={onEnter} onMouseLeave={onLeave} onDoubleClick={e => e.stopPropagation()}
      style={{ position: 'absolute', bottom: 22, left: 8, zIndex: 60, userSelect: 'none' }}>
      <span style={{ fontSize: 8, color: '#ffffff', cursor: 'default', textShadow: '0 1px 3px rgba(0,0,0,.9)' }}>{String.fromCharCode(0x2b21)} W/L</span>
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

// --- Opacity handle -----------------------------------------------------------
function OpacityHandle({ opacity, onChange }) {
  return (
    <div style={{
      position: 'absolute', top: '50%', left: 4, transform: 'translateY(-50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
      zIndex: 70, userSelect: 'none', width: 26,
    }}>
      <span style={{ fontSize: 8, color: '#88dd88', width: 26, textAlign: 'center' }}>{Math.round(opacity * 100)}%</span>
      <input type="range" min={0} max={1} step={0.05} value={opacity}
        onChange={e => onChange(+e.target.value)}
        style={{
          writingMode: 'vertical-lr',
          transform: 'rotate(180deg)',  // 0% at bottom, 100% at top
          width: 12, height: 60, accentColor: '#88dd88', cursor: 'pointer',
        }} />
      <span style={{ fontSize: 8, color: '#88dd88', writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>blend</span>
    </div>
  );
}
