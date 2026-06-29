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
function _applyActorColormap(actor, paletteId, lower, upper) {
  try {
    const prop = actor.getProperty();
    const cfun = prop.getRGBTransferFunction(0);
    cfun.removeAllPoints();
    for (let i = 0; i < 256; i++) {
      const t      = i / 255;
      const scalar = lower + t * (upper - lower);
      const [r, g, b] = getColor(paletteId, t);
      cfun.addRGBPoint(scalar, r / 255, g / 255, b / 255);
    }
    cfun.setMappingRange(lower, upper);
    cfun.modified();
    prop.modified();
    console.log(`[volumeManager] Applied colormap '${paletteId}' range [${lower.toFixed(0)}, ${upper.toFixed(0)}]`);
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


