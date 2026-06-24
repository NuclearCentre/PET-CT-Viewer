/**
 * volumeManager.js — Phase 3 (MPR · Fusion · Crosshairs)
 * Session 8 — final. Canvas2D overlay (canvasFusion.js) handles colour.
 *
 * Strategy:
 *   CT volume: full opacity (0.99 keeps VTK alpha-compositing active).
 *   PET volume VTK actor: opacity 0.001 (nearly invisible).
 *   canvasFusion.js draws the PET colour overlay on a Canvas2D canvas.
 *   The blend slider controls Canvas2D alpha only — VTK is not involved.
 *
 * This approach bypasses all VTK colormap rendering issues.
 * CS3D still handles: pan, zoom, scroll, crosshairs, annotations.
 */

import {
  volumeLoader,
  getRenderingEngine,
  cache,
  imageLoader,
  Enums as CoreEnums,
} from '@cornerstonejs/core';
import { RENDERING_ENGINE_ID } from '../cornerstone-init.js';

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
      // Guard against stale cache entries left by a partially-failed purge.
      // If a volume with this ID is still in the cache, destroy it first so
      // createAndCacheVolume doesn't throw "volume already exists".
      try {
        const stale = cache?.getVolume?.(volumeId);
        if (stale) {
          try { stale.destroy?.(); } catch(e) {}
          try { cache?.removeVolumeLoadObject?.(volumeId); } catch(e) {}
        }
      } catch(e) {}
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
  // Three removal strategies in priority order — v2.1.16 may not have all three.
  // Any one succeeding is sufficient; failures are silently swallowed.
  for (const volumeId of [CT_VOLUME_ID, PET_VOLUME_ID]) {
    // Strategy 1: v2.x API
    try { cache?.removeVolumeLoadObject?.(volumeId); } catch(e) {}
    // Strategy 2: destroy via getVolume
    try { cache?.getVolume?.(volumeId)?.destroy?.(); } catch(e) {}
    // Strategy 3: image load object fallback
    try { cache?.removeImageLoadObject?.(volumeId); } catch(e) {}
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const voiFromWL = (wl) => ({
  lower: wl.wc - wl.ww / 2,
  upper: wl.wc + wl.ww / 2,
});

// ─── CT-only MPR viewport ──────────────────────────────────────────────────────
export async function applyCTVolume(vp, { wl, colormapName }) {
  await vp.setVolumes([{ volumeId: CT_VOLUME_ID }]);
  vp.resetCamera();
  try {
    vp.setProperties({ voiRange: voiFromWL(wl), colormap: { name: colormapName } });
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(wl) });
  }
  vp.render();
}

// ─── PET-only viewport (bottom row) ──────────────────────────────────────────
// Single PET volume only — single-arg setProperties, no two-volume compositing.
// Avoids vtkPolyDataVS shader crash on Intel UHD 620 (Session 10 M3).
// CT underlay deferred to a later session when GPU compatibility is resolved.
export async function applyFusionVolumes(vp, { ctWL, petWL, petColormapName, petOpacity }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petColormapName } });
  } catch(e) {
    vp.setProperties({ voiRange: voiFromWL(petWL) });
  }
  console.log('[volumeManager] PET-only viewport: single volume, single-arg setProperties');
  vp.render();
}

// --- Update PET W/L on PET-only viewport ---
export function setFusionPetProperties(vp, { petWL, petColormapName, petOpacity }) {
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petColormapName } });
  } catch(e) {
    try { vp.setProperties({ voiRange: voiFromWL(petWL) }); } catch(e2) {}
  }
  vp.render();
}

// --- CT VOI update: no-op (CT volume not loaded in PET-only viewports) ---
export function setFusionCtVOI(vp, ctWL) {
  // CT volume not present in bottom-row viewports. No-op intentional.
}

// ─── Blend slider ─────────────────────────────────────────────────────────────
// Canvas2D overlay reads petOpacity directly from React state via closure.
// Just trigger a CS3D render so IMAGE_RENDERED fires and canvasFusion redraws.
export function setPetOpacity(viewportId, petOpacity, petWL) {
  try {
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    vp.render();
  } catch (e) {}
}

// ─── MIP viewport ─────────────────────────────────────────────────────────────
export async function applyMIPVolume(vp, { petWL, colormapName, orientation = 'coronal' }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();

  // Capture parallelScale NOW — immediately after resetCamera() sets it correctly.
  // vp.render() below triggers VTK's internal pipeline which calls resetCamera()
  // again internally, overwriting parallelScale with a wrong small value.
  // We re-apply the correct value after render() and store it on window.__mipScale
  // so _stepMIP in CineBar can use it on every setCamera() call.
  let correctScale = null;
  try { correctScale = vp.getCamera()?.parallelScale || null; } catch(e) {}

  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: colormapName } });
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(petWL) });
  }
  // MAXIMUM_INTENSITY_BLEND disabled — crashes Intel UHD 620 (Session 10 M3).
  vp.render();

  // Re-apply correct parallelScale after render() reset it, then store globally.
  if (correctScale) {
    try {
      vp.setCamera({ parallelScale: correctScale });
      window.__mipScale = correctScale;
    } catch(e) {}
  }
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
