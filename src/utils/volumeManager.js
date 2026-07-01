/**
 * volumeManager.js — Phase 3 (MPR · Fusion · Crosshairs)
 *
 * Confirmed from actual source files:
 *
 * CS3D v2.1.16 BaseVolumeViewport:
 *   _getApplicableVolumeActor(volumeId) finds actor by referencedId
 *   setProperties stores colormap in viewportProperties (SHARED object)
 *   calling setProperties twice with different volumeIds overwrites viewportProperties.colormap
 *   This causes CT colormap to be replaced by PET colormap on re-render
 *
 * FIX: Set CT and PET properties directly on VTK actors, bypassing setProperties.
 *   vp.getActors() returns [{uid, actor, referencedId}, ...]
 *   actor.getProperty().setRGBTransferFunction(0, cfun)
 *   actor.getProperty().setScalarOpacity(0, ofun)
 *   These are persistent on the actor and not shared between volumes.
 *
 * VTK ColorTransferFunction.applyColorMap (confirmed from source line 1110-1149):
 *   reads colorMap.ColorSpace — sets model.colorSpace = ColorSpace[name.toUpperCase()]
 *   reads colorMap.RGBPoints  — builds model.nodes [{x,r,g,b,midpoint,sharpness}]
 *   then calls sortAndUpdateRange()
 *
 * VTK format confirmed: { ColorSpace: 'RGB', RGBPoints: [x,r,g,b, x,r,g,b, ...] }
 *   x = scalar value (any range — remapped by setMappingRange)
 *   r,g,b = 0-1 range
 */

import {
  volumeLoader,
  getRenderingEngine,
  cache,
  imageLoader,
  eventTarget,
  Enums as CoreEnums,
  utilities as csUtilities,
} from '@cornerstonejs/core';
import { RENDERING_ENGINE_ID } from '../cornerstone-init.js';
import { getColor } from './colourPalettes.js';

const { OrientationAxis, BlendModes } = CoreEnums;

const SCHEME = 'cornerstoneStreamingImageVolume';
export const CT_VOLUME_ID  = `${SCHEME}:PETCT_CT`;
export const PET_VOLUME_ID = `${SCHEME}:PETCT_PET`;

export const ORIENTATION = {
  axial:    OrientationAxis.AXIAL,
  coronal:  OrientationAxis.CORONAL,
  sagittal: OrientationAxis.SAGITTAL,
};

// ─── Volume build / cache ──────────────────────────────────────────────────────
const _volumePromises = { ct: null, pet: null };
const PREFETCH_CONCURRENCY = 4;

async function _loadWithRetry(id, retries = 1) {
  try {
    return await imageLoader.loadAndCacheImage(id);
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 200));
      return _loadWithRetry(id, retries - 1);
    }
    throw e;
  }
}

async function _prefetchMetadata(imageIds, label) {
  if (!imageIds || imageIds.length === 0) return { ok: 0, failed: 0 };
  console.log(`[volumeManager] prefetching ${imageIds.length} ${label} slices...`);
  let cursor = 0, ok = 0, failed = 0;
  async function worker() {
    while (cursor < imageIds.length) {
      const id = imageIds[cursor++];
      try { await _loadWithRetry(id); ok++; }
      catch (e) {
        failed++;
        if (failed <= 3) console.warn(`[volumeManager] ${label} load failed:`, e?.message);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PREFETCH_CONCURRENCY, imageIds.length) }, worker)
  );
  console.log(`[volumeManager] ${label} prefetch done -- ${ok} ok / ${failed} failed.`);
  return { ok, failed };
}

async function _ensureVolume(volumeId, imageIds, key) {
  if (!imageIds || imageIds.length === 0) return null;
  if (_volumePromises[key]) return _volumePromises[key];
  _volumePromises[key] = (async () => {
    try {
      const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
      volume.load();
      return volume;
    } catch (e) {
      _volumePromises[key] = null;
      throw e;
    }
  })();
  return _volumePromises[key];
}

export async function ensureVolumes(ctImageIds, petImageIds) {
  await _prefetchMetadata(ctImageIds,  'CT');
  await _prefetchMetadata(petImageIds, 'PET');
  let ctVolumeId = null, petVolumeId = null;
  try { if (await _ensureVolume(CT_VOLUME_ID,  ctImageIds,  'ct'))  ctVolumeId  = CT_VOLUME_ID;  }
  catch (e) { console.error('[volumeManager] CT volume build failed:', e?.message); }
  try { if (await _ensureVolume(PET_VOLUME_ID, petImageIds, 'pet')) petVolumeId = PET_VOLUME_ID; }
  catch (e) { console.error('[volumeManager] PET volume build failed:', e?.message); }
  return { ctVolumeId, petVolumeId };
}

export function purgeVolumes() {
  _volumePromises.ct = null;
  _volumePromises.pet = null;
  try {
    cache?.removeVolumeLoadObject?.(CT_VOLUME_ID);
    cache?.removeVolumeLoadObject?.(PET_VOLUME_ID);
  } catch (e) {}
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const voiFromWL = (wl) => ({
  lower: wl.wc - wl.ww / 2,
  upper: wl.wc + wl.ww / 2,
});

// Build a VTK ColorTransferFunction object from a palette id and scalar range.
// Bypasses CS3D setColormap entirely to avoid shared viewportProperties pollution.
function _buildVtkCTF(paletteId, lower, upper) {
  // Dynamically import vtkColorTransferFunction from the CS3D bundle.
  // CS3D re-exports VTK classes internally. We access it through an actor
  // to avoid needing a direct vtk.js import path.
  const RGBPoints = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const scalar = lower + t * (upper - lower);
    const [r, g, b] = getColor(paletteId, t);
    RGBPoints.push(scalar, r / 255, g / 255, b / 255);
  }
  return { ColorSpace: 'RGB', RGBPoints };
}

// Build a VTK PiecewiseFunction for PET opacity.
// Low values transparent, high values visible at blend opacity.
function _buildPetOpacityPoints(petWL, globalOpacity) {
  const blend = Math.max(0, Math.min(1, typeof globalOpacity === 'number' ? globalOpacity : 0.6));
  const lower = petWL.wc - petWL.ww / 2;
  const upper = petWL.wc + petWL.ww / 2;
  const range = upper - lower;
  if (range <= 0) return [[0, 0], [50000, blend]];
  return [
    [lower,                0          ],
    [lower + range * 0.05, 0          ],
    [lower + range * 0.30, blend * 0.4],
    [upper,                blend      ],
  ];
}

// Apply colormap directly on the VTK CTF object.
// applyColorMap() does not exist in the VTK version bundled with CS3D v2.1.16.
// We use removeAllPoints() + addRGBPoint() but call this ONLY between renders,
// never during an active render cycle, so uniform locations stay valid.
function _applyActorColormap(actor, paletteId, lower, upper, applyRemap = false, blackFloor = false, preInvertForWhiteBg = false) {
  try {
    const prop = actor.getProperty();
    const cfun = prop.getRGBTransferFunction(0);
    cfun.removeAllPoints();
    const isHotIron = paletteId === 'hot_iron';
    const isPET = applyRemap && paletteId && !paletteId.includes('gray') && !paletteId.includes('greyscale');
    for (let i = 0; i < 256; i++) {
      const t      = i / 255;
      // Only apply gamma remap for Canvas2D-matched paths, not MIP actor
      const tLookup = isPET ? Math.min(1, Math.pow(0.50 + t * 0.50, 0.75)) : t;
      const scalar = lower + t * (upper - lower);
      let [r, g, b] = getColor(paletteId, tLookup);
      // Boost red 50% for hot_iron (matches canvasFusion.js buildLUT)
      if (isHotIron) r = Math.min(255, Math.round(r + (255 - r) * 0.50));
      // Push upper 50% towards white (only for remapped path)
      const whitePush = (isPET && t > 0.5) ? (t - 0.5) * 2 * 0.25 : 0;
      r = Math.min(255, Math.round(r + (255 - r) * whitePush));
      g = Math.min(255, Math.round(g + (255 - g) * whitePush));
      b = Math.min(255, Math.round(b + (255 - b) * whitePush));
      if (blackFloor) {
        // Force low scalar values toward a single flat shade regardless of
        // the chosen palette's own colour at t=0 -- several DICOM-standard
        // palettes (pet, pet_20_step, rainbow) start at blue/green/magenta
        // rather than black, which for a MIP (max-intensity, no real
        // transparency compositing) means EVERY ray with even modest
        // background/noise signal paints solid colour across the whole image
        // instead of staying flat -- that's the "green background" symptom.
        // Fade from the floor colour up to the true palette colour over the
        // bottom ~18% of the range; above that, full true colour as normal.
        //
        // FLOOR TARGET: pre-invert and the mandatory CSS invert(1) below
        // cancel out exactly for every pixel that goes through this
        // function (invert(invert(x)) = x) -- so whatever is computed HERE
        // is exactly what ends up on screen. The viewport's actual clear
        // colour (true background, outside the rendered silhouette) is
        // black and only passes through ONE inversion (it never touches
        // this per-voxel LUT), so it displays as white. To match that, the
        // floor here must target WHITE too when preInvertForWhiteBg is on --
        // flooring toward black (the old target) made low-uptake areas
        // INSIDE the silhouette show literal black, clashing with the white
        // background just outside it.
        const floorFade = Math.min(1, t / 0.18);
        const floorTarget = preInvertForWhiteBg ? 255 : 0;
        r = Math.round(floorTarget + (r - floorTarget) * floorFade);
        g = Math.round(floorTarget + (g - floorTarget) * floorFade);
        b = Math.round(floorTarget + (b - floorTarget) * floorFade);
      }
      if (preInvertForWhiteBg) {
        // MIP LOCKED RULE (see setMIPColormap): the viewport's clear colour
        // is black and the canvas always gets CSS filter:invert(1) (white-
        // background convention). To still show the TRUE palette colour
        // after that mandatory invert, store the colour's complement here --
        // invert(255-r) = r, so the final on-screen result is the real
        // colour, while black (background / low uptake) still inverts to
        // white as expected. Applies uniformly to every palette including
        // gray, where it's a no-op in effect (double inversion cancels out
        // to the exact same look gray already had).
        r = 255 - r; g = 255 - g; b = 255 - b;
      }
      cfun.addRGBPoint(scalar, r / 255, g / 255, b / 255);
    }
    cfun.setMappingRange(lower, upper);
    cfun.modified();
    prop.modified();
  } catch(e) {
    console.error('[volumeManager] _applyActorColormap FAILED:', e?.message, e);
  }
}

function _applyActorOpacity(actor, opacityPoints) {
  try {
    const prop = actor.getProperty();
    const ofun = prop.getScalarOpacity(0);
    ofun.removeAllPoints();
    opacityPoints.forEach(([value, opacity]) => ofun.addPoint(value, opacity));
    ofun.modified();
    prop.setScalarOpacityUnitDistance(0, 1.0);
    prop.modified();
    console.log('[volumeManager] Applied PET opacity transfer function');
  } catch(e) {
    console.warn('[volumeManager] _applyActorOpacity failed:', e?.message);
  }
}

// Get the VTK actor for a specific volumeId from a viewport.
function _getActor(vp, volumeId) {
  const entry = vp.getActors()?.find(a => a.referencedId === volumeId);
  return entry?.actor || null;
}

// ─── CT-only MPR viewport ──────────────────────────────────────────────────────
export async function applyCTVolume(vp, { wl, colormapName }) {
  await vp.setVolumes([{ volumeId: CT_VOLUME_ID }]);
  vp.resetCamera();
  // Use CS3D setProperties for CT-only viewports — no shared state problem
  // because there is only one volume.
  try {
    vp.setProperties({ voiRange: voiFromWL(wl), colormap: { name: colormapName } });
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(wl) });
  }
  vp.render();
}

// ─── PET-CT FUSION viewport ────────────────────────────────────────────────────
// CT ONLY — one volume per viewport. PET overlay is Canvas2D (canvasFusion.js).
// Two-volume VTK compositing causes uncontrollable opacity/blend behaviour on
// Intel UHD 620 and cannot be fixed without forking VTK internals.
export async function applyFusionVolumes(vp, { ctWL }) {
  await vp.setVolumes([{ volumeId: CT_VOLUME_ID }]);
  vp.resetCamera();
  const ctLower = ctWL.wc - ctWL.ww / 2;
  const ctUpper = ctWL.wc + ctWL.ww / 2;
  // Single volume — setProperties is safe (no shared state problem)
  try {
    vp.setProperties({ voiRange: voiFromWL(ctWL), colormap: { name: 'gray' } });
  } catch(e) {
    vp.setProperties({ voiRange: voiFromWL(ctWL) });
  }
  vp.render();
  console.log('[volumeManager] applyFusionVolumes: CT-only', ctLower.toFixed(0), '–', ctUpper.toFixed(0));
}

// ─── Update PET overlay on already-rendered fusion viewport ───────────────────
// PET is Canvas2D — just trigger a render so drawFrame picks up new petWLFusionRef.
export function setFusionPetProperties(vp, { petWL, petColormapName, petOpacity }) {
  try { vp.render(); } catch(e) {}
}

// ─── Blend slider ─────────────────────────────────────────────────────────────
// PET opacity is Canvas2D — drawFrame reads petOpacityRef directly.
// Just trigger a render so IMAGE_RENDERED fires and drawFrame runs.
export function setPetOpacity(viewportId, petOpacity, petWL) {
  try {
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    vp.render();
  } catch(e) {}
}

// ─── MIP viewport ─────────────────────────────────────────────────────────────
export async function applyMIPVolume(vp, { petWL, colormapName, orientation = 'coronal' }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();
  // Apply VOI only via setProperties (safe -- no colormap to avoid VTK warning).
  try { vp.setProperties({ voiRange: voiFromWL(petWL) }); } catch(e) {}
  // Apply colormap directly on VTK actor using 'gray' palette.
  // App.css filter:invert(1) handles visual inversion -> inverse greyscale on white bg.
  // Using inv_greyscale + invert = double inversion = wrong result.
  const petActor = _getActor(vp, PET_VOLUME_ID);
  if (petActor) {
    const lower = petWL.wc - petWL.ww / 2;
    const upper = petWL.wc + petWL.ww / 2;
    _applyActorColormap(petActor, 'gray', lower, upper);
  }
  try {
    vp.setBlendMode(BlendModes.MAXIMUM_INTENSITY_BLEND);
    vp.setSlabThickness(1000);
  } catch (e) {}
  vp.render();
}

// ─── Orientation markers ──────────────────────────────────────────────────────
export function getOrientationMarkers(orientation) {
  switch (orientation) {
    case 'axial':    return { top: 'A', bottom: 'P', left: 'R', right: 'L' };
    case 'coronal':  return { top: 'S', bottom: 'I', left: 'R', right: 'L' };
    case 'sagittal': return { top: 'S', bottom: 'I', left: 'A', right: 'P' };
    default:         return { top: '',  bottom: '',  left: '',  right: '' };
  }
}

// ─── CT VOI update for fusion viewports ──────────────────────────────────────
// Legacy single-viewport version — safe only on CT-only viewports.
export function setFusionCtVOI(vp, ctWL) {
  try { vp.setProperties({ voiRange: voiFromWL(ctWL) }); }
  catch(e) {}
  try { vp.render(); } catch(e) {}
}

// ─── CT W/L update for two-volume fusion viewports ───────────────────────────
// Updates CT colormap directly on the CT actor — bypasses single-arg setProperties
// which on a two-volume viewport targets whichever volume CS3D considers current.
// Called from ViewerBox W/L effect when modality === 'PET'.
export function updateFusionCtWL(vp, ctWL) {
  try {
    const ctLower = ctWL.wc - ctWL.ww / 2;
    const ctUpper = ctWL.wc + ctWL.ww / 2;
    const ctActor = _getActor(vp, CT_VOLUME_ID);
    if (ctActor) {
      _applyActorColormap(ctActor, 'gray', ctLower, ctUpper);
      // Restate CT scalar opacity as fully opaque (actor manipulation can reset it)
      const ofun = ctActor.getProperty().getScalarOpacity(0);
      ofun.removeAllPoints();
      ofun.addPoint(ctLower, 1.0);
      ofun.addPoint(ctUpper, 1.0);
      ofun.modified();
    }
  } catch(e) {}
}


// ─── MIP colormap update ──────────────────────────────────────────────────────
// Previous approach: actor always forced to 'gray', colour palettes simulated
// via a hardcoded CSS hue-rotate/sepia guess-table applied to the canvas. That
// was fragile in two ways: (1) any palette id not in the hardcoded table
// silently fell through to 'none' -- no visible change at all, which is
// exactly the "colour not changing" symptom; (2) even for the mapped entries,
// hue-rotate is only an approximation of the real palette, not its true
// colours, and combined with the white-background invert(1) trick it could
// read as an inverted/wrong-looking colour rather than the actual palette.
//
// New approach: for any colour palette OTHER than gray/greyscale, apply the
// REAL palette colours directly to the actor's colour transfer function
// (same _applyActorColormap used by CT/PET elsewhere in this file) -- true
// colour, not a CSS approximation, and never inverted. Background for a
// colour palette is therefore the actor's own black-to-bright ramp on the
// viewport's normal (black) background -- the standard look for a coloured
// PET MIP (e.g. hot_iron: dark background, bright red/orange/yellow hot
// spots), and it matches the same colours used in the PET-CT fused colour
// strip elsewhere in the app. The white-background inverted-greyscale look
// (App.css's filter:invert(1), MIP actor forced to 'gray') is preserved
// exactly as before, but ONLY for the gray/greyscale/inv_greyscale selection
// -- that's the one case it was actually designed for.
export function setMIPColormap(vp, paletteId, petWL) {
  try {
    const lower = petWL.wc - petWL.ww / 2;
    const upper = petWL.wc + petWL.ww / 2;
    try { vp.setProperties({ voiRange: { lower, upper } }); } catch(e) {}

    const pid = paletteId.replace('petct_', '');

    const petActor = _getActor(vp, PET_VOLUME_ID);
    if (petActor) {
      // MIP LOCKED RULE -- white background + TRUE palette colour, for every
      // palette including gray. Do not change this mechanism without being
      // explicitly asked to.
      //   - blackFloor=true always: background/low-uptake stays dark so it
      //     reads as background regardless of where the chosen palette's own
      //     ramp starts (matters for pet/pet_20_step/rainbow, harmless no-op
      //     for palettes that already start at black).
      //   - preInvertForWhiteBg=true always: bakes the colour's complement
      //     into the actor so the mandatory CSS invert(1) below cancels back
      //     out to the TRUE colour, while black still inverts to white.
      _applyActorColormap(petActor, pid, lower, upper, false, true, true);
    }

    const _applyFilter = () => {
      try {
        const el = vp.element;
        if (!el) return;
        // querySelectorAll, not just the first match -- CS3D's render pipeline
        // can replace/recreate the canvas node on some renders (resize, layout
        // change, volume swap), which would silently leave a style set on a
        // now-detached node. Re-selecting fresh each time and applying to
        // every canvas under this viewport guards against that.
        // ALWAYS invert(1), for every palette -- see preInvertForWhiteBg note
        // above. This is what makes the white background work uniformly.
        // !important: a plain c.style.filter assignment loses to App.css's
        // rule, which evidently uses !important (confirmed via runtime
        // diagnostic -- inline was correctly 'none' but computed style still
        // showed 'invert(1)'). setProperty with 'important' wins over that.
        el.querySelectorAll('canvas').forEach(c => { c.style.setProperty('filter', 'invert(1)', 'important'); });
      } catch(e) {}
    };

    // Apply now, then again next frame after vp.render() below has actually
    // painted -- covers the case where CS3D's render swaps/recreates the
    // canvas element between this call and the paint completing.
    // Rule 32 guard: VTK resets cam.position + cam.parallelScale on every
    // render() call on an ORTHOGRAPHIC viewport (MIP included). This function
    // calls render() up to 3 times (immediate + 2x rAF, for the CSS-filter
    // re-apply timing below) -- without explicitly preserving the camera
    // across those, each call is a chance for MIP's locked zoom
    // (ct-coronal x2, set up in ViewportGrid.jsx) to silently shrink back
    // toward VTK's auto-fit scale. Snapshot before, restore after every
    // render() in this function.
    let _savedCam = null;
    try { _savedCam = vp.getCamera ? vp.getCamera() : null; } catch(e) {}
    const _restoreCam = () => {
      if (!_savedCam?.position || !_savedCam?.focalPoint || _savedCam?.parallelScale == null) return;
      try {
        vp.setCamera({
          position:      _savedCam.position,
          focalPoint:    _savedCam.focalPoint,
          viewUp:        _savedCam.viewUp,
          parallelScale: _savedCam.parallelScale,
        });
      } catch(e) {}
    };

    _applyFilter();
    requestAnimationFrame(_applyFilter);

    vp.render();
    _restoreCam();
    // Order matters: restore camera FIRST, then reapply the filter -- setCamera()
    // can itself trigger a repaint that touches the canvas DOM, which would
    // silently stomp a filter applied before it. Two settle passes for safety.
    requestAnimationFrame(() => {
      _restoreCam();
      _applyFilter();
      requestAnimationFrame(() => { _restoreCam(); _applyFilter(); });
    });
  } catch(e) {}
}
