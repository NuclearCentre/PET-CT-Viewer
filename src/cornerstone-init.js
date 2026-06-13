/**
 * cornerstone-init.js — v2.1.16 verified
 *
 * Mouse bindings (stack / Phase 1-2 groups):
 *   Left drag              → Pan
 *   Right drag             → Zoom
 *   Wheel                  → Scroll slices
 *   Middle drag            → Window/Level
 *   Shift + Left drag      → Draw straight line  (LengthTool)
 *   Shift + Right drag     → Draw circle ROI     (CircleROITool)
 *
 * Phase 3 MPR group (tg-mpr) — volume/orthographic viewports:
 *   Left drag              → Pan
 *   Right drag             → Zoom
 *   Wheel                  → Scroll slices
 *   Crosshairs             → PASSIVE (reference lines always visible + draggable
 *                            centre handle); toolbar "Crosshair" promotes it to
 *                            ACTIVE on Primary for full click-to-navigate.
 *
 * CRITICAL RULES:
 *   dicomLoaderInit({ maxWebWorkers: 1 })
 *   React StrictMode DISABLED
 *   @cornerstonejs/dicom-image-loader in vite optimizeDeps.exclude
 */

import {
  init as coreInit,
  RenderingEngine,
  getRenderingEngine,
  getEnabledElement,
  metaData,
  Enums as CoreEnums,
} from '@cornerstonejs/core';

import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  SynchronizerManager,
  synchronizers,
  Enums as ToolEnums,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  LengthTool,
  CircleROITool,
  RectangleROITool,
  EllipticalROITool,
  AngleTool,
  ArrowAnnotateTool,
  ProbeTool,
  PlanarFreehandROITool,
  CrosshairsTool,
  annotation,
} from '@cornerstonejs/tools';

import {
  init as dicomLoaderInit,
  wadouri,
} from '@cornerstonejs/dicom-image-loader';

import { registerCornerstonePalettes } from './utils/colourPalettes.js';

// ─── Exported IDs ─────────────────────────────────────────────────────────────
export const TOOL_GROUP_CT       = 'tg-ct';
export const TOOL_GROUP_PET      = 'tg-pet';
export const TOOL_GROUP_MPR      = 'tg-mpr';   // Phase 3 — volume viewports + crosshairs
export const RENDERING_ENGINE_ID = 'petct-engine';
export const SYNC_SCROLL_ID      = 'sync-scroll';
export const SYNC_ZOOM_ID        = 'sync-zoom';
export const SYNC_PAN_ID         = 'sync-pan';

export const SYNC_VIEWPORT_IDS = [
  'ct-axial','ct-coronal','ct-sagittal',
  'pct-axial','pct-coronal','pct-sagittal',
];

// The six MPR viewports that the CrosshairsTool links (MIP is never included).
export const MPR_VIEWPORT_IDS = [
  'ct-axial','ct-coronal','ct-sagittal',
  'pct-axial','pct-coronal','pct-sagittal',
];

// Reference-line colour per viewport — CT row blue, PET row green.
const REFERENCE_LINE_COLORS = {
  'ct-axial':    'rgb(136,196,255)', 'ct-coronal':  'rgb(136,196,255)', 'ct-sagittal':  'rgb(136,196,255)',
  'pct-axial':   'rgb(136,221,136)', 'pct-coronal': 'rgb(136,221,136)', 'pct-sagittal': 'rgb(136,221,136)',
};

const { MouseBindings, KeyboardBindings } = ToolEnums;

let _initialized = false;

export async function initCornerstone() {
  if (_initialized) return;
  _initialized = true;

  try {
    await coreInit();
    console.log('[CS3D] core ready');

    await dicomLoaderInit({ maxWebWorkers: 1 });
    console.log('[CS3D] dicom loader ready');

    await toolsInit();
    console.log('[CS3D] tools ready');

    // ── Global annotation style ────────────────────────────────────────────────
    // v2.1.16 exact API (verified from package source):
    //   annotation.config.style.setDefaultToolStyles({ global: { ... } })
    // Without this: textBoxVisibility defaults to true but colors may not
    // render. Setting explicitly ensures handles, textboxes and hover colours
    // are visible consistently.
    annotation.config.style.setDefaultToolStyles({
      global: {
        color:                   'rgb(255, 222, 0)',
        colorHighlighted:        'rgb(0, 255, 200)',
        colorSelected:           'rgb(0, 220, 255)',
        colorLocked:             'rgb(255, 222, 0)',
        lineWidth:               '1.5',
        lineDash:                '',
        shadow:                  true,
        textBoxVisibility:       true,
        textBoxFontFamily:       'monospace',
        textBoxFontSize:         '12px',
        textBoxColor:            'rgb(255, 222, 0)',
        textBoxColorHighlighted: 'rgb(0, 255, 200)',
        textBoxColorSelected:    'rgb(0, 220, 255)',
        textBoxColorLocked:      'rgb(255, 222, 0)',
        textBoxBackground:       'rgba(0,0,0,0.5)',
        textBoxLinkLineWidth:    '1',
        textBoxLinkLineDash:     '2,3',
        textBoxShadow:           true,
      },
    });

    [
      WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
      LengthTool, CircleROITool, RectangleROITool, EllipticalROITool,
      AngleTool, ArrowAnnotateTool, ProbeTool, PlanarFreehandROITool,
      CrosshairsTool,
    ].forEach(T => { try { addTool(T); } catch(e) {} });
    console.log('[CS3D] tools registered');

    // ── Patch CircleROI hit-test + rim resize (verified against v2.1.16 src) ───
    // Problem 1: isPointNearTool only hits within 3px of the outline ring, so
    //   clicking inside the ROI pans the image instead of moving the ROI.
    //   → interior patch: any point inside the circle = hit = move.
    // Problem 2: the resize handle (points[1]) is a single spot on the rim where
    //   the user happened to finish drawing — practically impossible to find.
    //   → rim patch: hovering ANYWHERE on the rim activates the resize handle
    //     (the dot becomes visible and dragging resizes the circle).
    // Handle check runs BEFORE the tool-move check in CS3D, so: rim → resize,
    // interior → move, outside → pan. Exactly the standard viewer behaviour.
    _patchCircleInteriorHit(CircleROITool);
    _patchCircleInteriorHit(EllipticalROITool);
    _patchCircleRimResize(CircleROITool);
    _patchAnnotationDisplayFilter(LengthTool);

    metaData.addProvider(wadouri.metaData.metaDataProvider, 10000);

    _createToolGroup(TOOL_GROUP_CT);
    _createToolGroup(TOOL_GROUP_PET);
    _createMPRToolGroup(TOOL_GROUP_MPR);   // Phase 3
    console.log('[CS3D] tool groups created');

    const cs = await import('@cornerstonejs/core');
    registerCornerstonePalettes(cs);

    try { new RenderingEngine(RENDERING_ENGINE_ID); } catch(e) {}

    _createSynchronizers();
    console.log('[CS3D] synchronizers created');

    console.log('[cornerstone-init] ✅ Ready');
  } catch(e) {
    console.error('[cornerstone-init] ❌ Init failed:', e);
    throw e;
  }
}

function _createToolGroup(groupId) {
  try { ToolGroupManager.destroyToolGroup(groupId); } catch(e) {}
  const tg = ToolGroupManager.createToolGroup(groupId);

  // ── Navigation — always active ────────────────────────────────────────────
  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);

  // Left drag → Pan
  tg.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  // Right drag → Zoom
  tg.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  // Wheel → Scroll slices
  tg.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });
  // Middle drag → Window/Level (kept for mice that have it)
  tg.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });

  // ── Annotation combos — Shift/Ctrl + drag ─────────────────────────────────
  // Shift + Left drag → Straight Line
  tg.addTool(LengthTool.toolName);
  tg.setToolActive(LengthTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Shift }],
  });

  // Shift + Right drag → Circle ROI (draw).  Ctrl + Left drag → move existing.
  tg.addTool(CircleROITool.toolName);
  tg.setToolActive(CircleROITool.toolName, {
    bindings: [
      { mouseButton: MouseBindings.Secondary, modifierKey: KeyboardBindings.Shift },
      { mouseButton: MouseBindings.Primary,   modifierKey: KeyboardBindings.Ctrl  },
    ],
  });

  // ── Other annotation tools — passive (activated via toolbar) ─────────────
  [RectangleROITool, EllipticalROITool, AngleTool, ArrowAnnotateTool, ProbeTool, PlanarFreehandROITool]
    .forEach(T => {
      tg.addTool(T.toolName);
      tg.setToolPassive(T.toolName);
    });

  // ROI move on Ctrl+Left for the rect/ellipse ROIs too.
  tg.setToolActive(EllipticalROITool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Ctrl }],
  });
  tg.setToolActive(RectangleROITool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Ctrl }],
  });

  return tg;
}

// ─── Phase 3 — MPR / volume tool group (with crosshairs) ───────────────────────
function _createMPRToolGroup(groupId) {
  try { ToolGroupManager.destroyToolGroup(groupId); } catch(e) {}
  const tg = ToolGroupManager.createToolGroup(groupId);

  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);

  // Same navigation bindings as the rest of the app (master-ref §7 preserved).
  tg.setToolActive(PanTool.toolName,         { bindings: [{ mouseButton: MouseBindings.Primary }] });
  tg.setToolActive(ZoomTool.toolName,        { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });

  // Crosshairs: reference lines coloured per row. Kept DISABLED by default —
  // a Passive/Enabled crosshairs runs mouseMoveCallback on every move and throws
  // ("cannot read 'length' of undefined") until its annotation is initialised,
  // which only happens reliably in the ACTIVE mode AFTER volumes are loaded.
  // The toolbar "Crosshair" button activates it on demand (see setCrosshairsActive).
  tg.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor: (viewportId) => REFERENCE_LINE_COLORS[viewportId] || 'rgb(200,200,200)',
    getReferenceLineControllable: () => true,
    getReferenceLineDraggableRotatable: () => true,
    getReferenceLineSlabThicknessControlsOn: () => false,
  });
  tg.setToolDisabled(CrosshairsTool.toolName);

  // Annotation tools (same combos as the stack groups) so ROIs work in MPR too.
  tg.addTool(LengthTool.toolName);
  tg.setToolActive(LengthTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Shift }],
  });
  tg.addTool(CircleROITool.toolName);
  // Draw a new circle: Shift + Right drag.  Move an existing circle: Ctrl + Left
  // drag (master-ref §7).  Both bindings coexist — CS3D's mouseDown prioritises
  // grabbing an existing annotation under the cursor (filterMoveableAnnotationTools
  // → our patched isPointNearTool) over starting a new one.
  tg.setToolActive(CircleROITool.toolName, {
    bindings: [
      { mouseButton: MouseBindings.Secondary, modifierKey: KeyboardBindings.Shift },
      { mouseButton: MouseBindings.Primary,   modifierKey: KeyboardBindings.Ctrl  },
    ],
  });
  [RectangleROITool, EllipticalROITool, AngleTool, ArrowAnnotateTool, ProbeTool, PlanarFreehandROITool]
    .forEach(T => { tg.addTool(T.toolName); tg.setToolPassive(T.toolName); });

  // ROI move on Ctrl+Left for the other ROI tools too (so an EllipticalROI
  // created via the toolbar can also be Ctrl-dragged to move).
  tg.setToolActive(EllipticalROITool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Ctrl }],
  });
  tg.setToolActive(RectangleROITool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: KeyboardBindings.Ctrl }],
  });

  return tg;
}

// Toggle crosshairs between ACTIVE (click-to-navigate + visible reference lines)
// and DISABLED (off — no event handling, so no mouseMoveCallback crash). We use
// DISABLED rather than PASSIVE for the "off" state because PASSIVE still runs the
// crashing mouseMoveCallback. Used by the toolbar "Crosshair" button.
export function setCrosshairsActive(active) {
  try {
    const tg = ToolGroupManager.getToolGroup(TOOL_GROUP_MPR);
    if (!tg) return;
    if (active) {
      tg.setToolActive(CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      tg.setToolPassive(PanTool.toolName);
    } else {
      tg.setToolDisabled(CrosshairsTool.toolName);
      tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
    }
  } catch(e) {}
}

function _createSynchronizers() {
  [SYNC_SCROLL_ID, SYNC_ZOOM_ID, SYNC_PAN_ID].forEach(id => {
    try { SynchronizerManager.destroySynchronizer(id); } catch(e) {}
  });
  synchronizers.createStackImageSynchronizer(SYNC_SCROLL_ID);

  // ── Zoom sync (orientation-safe) ──────────────────────────────────────────
  // createCameraPositionSynchronizer copies the WHOLE camera, which forces all
  // viewports to the same orientation — wrong for MPR (axial/coronal/sagittal
  // mixed). This custom synchronizer propagates ONLY the zoom factor
  // (parallelScale), so all 6 planes zoom together while keeping their own
  // orientation. The epsilon guard prevents an infinite render→sync feedback loop.
  SynchronizerManager.createSynchronizer(
    SYNC_ZOOM_ID,
    CoreEnums.Events.CAMERA_MODIFIED,
    (synchronizer, source, target) => {
      try {
        if (source.viewportId === target.viewportId) return;
        const re = getRenderingEngine(RENDERING_ENGINE_ID);
        if (!re) return;
        const sVp = re.getViewport(source.viewportId);
        const tVp = re.getViewport(target.viewportId);
        if (!sVp || !tVp) return;
        const sScale = sVp.getCamera()?.parallelScale;
        const tScale = tVp.getCamera()?.parallelScale;
        if (sScale == null) return;
        if (tScale != null && Math.abs(tScale - sScale) < 1e-3) return; // no-op → stop loop
        tVp.setCamera({ parallelScale: sScale });
        tVp.render();
      } catch(e) {}
    }
  );

  // Pan sync still uses full camera position (only meaningful between same-
  // orientation viewports; off by default).
  synchronizers.createCameraPositionSynchronizer(SYNC_PAN_ID);
}

// ── Per-viewport ownership filter ─────────────────────────────────────────────
// Patches filterInteractableAnnotationsForElement on AnnotationDisplayTool.prototype.
// Only filters by sourceViewportId. NO geometry injection — handles are drawn
// separately via the ANNOTATION_RENDERED event in ViewerBox.
function _patchAnnotationDisplayFilter(AnyConcreteToolClass) {
  try {
    const annotationDisplayProto = Object.getPrototypeOf(
      Object.getPrototypeOf(AnyConcreteToolClass.prototype)
    );
    if (!annotationDisplayProto || annotationDisplayProto.__vpFilterPatched) return;
    const original = annotationDisplayProto.filterInteractableAnnotationsForElement;
    if (typeof original !== 'function') return;

    annotationDisplayProto.filterInteractableAnnotationsForElement = function(element, annotations) {
      const planeFiltered = original.call(this, element, annotations);
      if (!planeFiltered?.length) return planeFiltered;
      const currentViewportId = getEnabledElement(element)?.viewportId;
      if (!currentViewportId) return planeFiltered;
      return planeFiltered.filter(ann => {
        const src = ann.metadata?.sourceViewportId;
        return !src || src === currentViewportId;
      });
    };

    annotationDisplayProto.__vpFilterPatched = true;
    console.log('[CS3D] per-viewport annotation filter installed');
  } catch(e) {
    console.warn('[CS3D] _patchAnnotationDisplayFilter failed:', e?.message);
  }
}

// ── CircleROI / EllipticalROI interior hit patch ──────────────────────────────
// Makes the whole ROI interior draggable for MOVING (v2.1.16 only hits the
// 3px-wide outline by default). Falls back to the original test on any error.
function _patchCircleInteriorHit(ToolClass) {
  try {
    const proto = ToolClass.prototype;
    if (!proto || proto.__interiorHitPatched) return;
    const original = proto.isPointNearTool;
    proto.isPointNearTool = function(element, annotation, canvasCoords, proximity) {
      try {
        // Original first: if the cursor is already "near" by the stock test
        // (on the outline), honour it. We only ADD interior coverage on top.
        const origHit = original?.call(this, element, annotation, canvasCoords, proximity);
        if (origHit) return true;

        const points = annotation?.data?.handles?.points;
        const vp = getEnabledElement(element)?.viewport;
        if (!points?.length || !vp?.worldToCanvas) return origHit;
        const cp = points.map(p => vp.worldToCanvas(p));
        const [px, py] = canvasCoords;

        if (cp.length === 2) {
          // CircleROI: points = [center, edge]. Inside if within radius (+12px).
          const cx = cp[0][0], cy = cp[0][1];
          const radius = Math.hypot(cp[1][0] - cx, cp[1][1] - cy);
          if (Math.hypot(px - cx, py - cy) <= radius + 12) return true;
        } else if (cp.length >= 4) {
          // EllipticalROI: points = [bottom, top, left, right]. Build the
          // bounding box, then test the normalised ellipse equation (+pad).
          const xs = cp.map(p => p[0]), ys = cp.map(p => p[1]);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
          const rx = (maxX - minX) / 2 + 12, ry = (maxY - minY) / 2 + 12;
          if (rx > 0 && ry > 0) {
            const nx = (px - cx) / rx, ny = (py - cy) / ry;
            if (nx * nx + ny * ny <= 1) return true;
          }
        }
        return origHit;
      } catch(e) {
        return original?.call(this, element, annotation, canvasCoords, proximity);
      }
    };
    proto.__interiorHitPatched = true;
  } catch(e) {
    console.warn('[CS3D] interior-hit patch failed:', e?.message);
  }
}

// ── CircleROI rim-resize patch ────────────────────────────────────────────────
// v2.1.16 only shows/activates the resize handle when the cursor is within 6px
// of points[1] — the single spot on the rim where drawing ended. This makes the
// handle effectively undiscoverable. This patch activates the resize handle when
// the cursor is near ANY point of the rim (|dist-to-centre − radius| ≤ 8px):
// the handle dot renders (activeHandleIndex set) and dragging resizes.
function _patchCircleRimResize(ToolClass) {
  try {
    const proto = ToolClass.prototype;
    if (!proto || proto.__rimResizePatched) return;
    // getHandleNearImagePoint is inherited from AnnotationTool — capture whatever
    // is resolved on this prototype chain so we can fall back to it.
    const original = proto.getHandleNearImagePoint;
    proto.getHandleNearImagePoint = function(element, annotation, canvasCoords, proximity) {
      // 1) Let the original run first: it grabs the textbox handle and the exact
      //    center/edge points, and (when nothing is near) resets activeHandleIndex
      //    to null. If it found something, honour that.
      const origHit = original?.call(this, element, annotation, canvasCoords, proximity);
      if (origHit) return origHit;
      // 2) Original found nothing. Check the rest of the rim so the resize handle
      //    is discoverable anywhere on the circle outline, not just at points[1].
      try {
        const points = annotation?.data?.handles?.points;
        const vp = getEnabledElement(element)?.viewport;
        if (points && points.length >= 2 && vp?.worldToCanvas) {
          const c0 = vp.worldToCanvas(points[0]);
          const c1 = vp.worldToCanvas(points[1]);
          const radius = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
          const dist   = Math.hypot(canvasCoords[0] - c0[0], canvasCoords[1] - c0[1]);
          if (Math.abs(dist - radius) <= 8) {
            annotation.data.handles.activeHandleIndex = 1;  // radius handle
            return points[1];
          }
        }
      } catch(e) { /* no rim hit */ }
      return undefined;
    };
    proto.__rimResizePatched = true;
  } catch(e) {
    console.warn('[CS3D] rim-resize patch failed:', e?.message);
  }
}

export function addViewportToSync(syncId, viewportId) {
  try {
    const sync = SynchronizerManager.getSynchronizer(syncId);
    if (sync) sync.addViewport({ viewportId, renderingEngineId: RENDERING_ENGINE_ID });
  } catch(e) {}
}

export function removeViewportFromSync(syncId, viewportId) {
  try {
    const sync = SynchronizerManager.getSynchronizer(syncId);
    if (sync) sync.removeViewport({ viewportId, renderingEngineId: RENDERING_ENGINE_ID });
  } catch(e) {}
}

export {
  WindowLevelTool, PanTool, ZoomTool, StackScrollTool,
  LengthTool, CircleROITool, RectangleROITool, EllipticalROITool,
  AngleTool, ArrowAnnotateTool, ProbeTool, PlanarFreehandROITool, CrosshairsTool,
  ToolGroupManager, SynchronizerManager,
};
