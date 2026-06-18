/**
 * volumeManager.js — Phase 3 (MPR · Fusion · Crosshairs)
 * Session 9 — fixes applied:
 *   1. orientation forwarded to setCamera() in applyFusionVolumes
 *   2. colormapName guarded (falls back to 'petct_gray' if undefined)
 *   3. purgeVolumes tries 3 removal strategies (was silently failing in v2.1.16)
 *   4. _ensureVolume guards against stale cache entry before createAndCacheVolume
 *   5. Window.__csVolumeCache populated so ViewerBox can access voxelManager
 *
 * Strategy (confirmed working from Session 8):
 *   CT volume:      full opacity (0.99 — keeps VTK alpha-compositing active)
 *   PET VTK actor:  opacity 0.001 (nearly invisible)
 *   canvasFusion.js draws PET colour overlay on a Canvas2D canvas on top
 *   Blend slider:   controls Canvas2D alpha only — VTK opacity unchanged by slider
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

// Expose volume cache to ViewerBox for voxelManager access
if (!window.__csVolumeCache) window.__csVolumeCache = {};

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
  console.log(`[volumeManager] ${label} prefetch done — ${ok} ok / ${failed} failed.`);
  return { ok, failed };
}

async function _ensureVolume(volumeId, imageIds, key, cacheKey) {
  if (!imageIds || imageIds.length === 0) return null;
  if (_volumePromises[key]) return _volumePromises[key];

  _volumePromises[key] = (async () => {
    try {
      // Guard: destroy any stale cache entry before creating a new volume
      try {
        const stale = cache.getVolume(volumeId);
        if (stale) {
          console.log(`[volumeManager] Destroying stale cache entry for ${volumeId}`);
          stale.destroy?.();
        }
      } catch {}

      const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
      volume.load();

      // Expose voxelManager for canvasFusion.js slice data access
      if (cacheKey) window.__csVolumeCache[cacheKey] = volume;

      console.log(`[volumeManager] Volume created: ${volumeId} (${imageIds.length} frames)`);
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
  try {
    if (await _ensureVolume(CT_VOLUME_ID,  ctImageIds,  'ct',  CT_VOLUME_ID))  ctVolumeId  = CT_VOLUME_ID;
  } catch (e) { console.error('[volumeManager] CT volume build failed:', e?.message); }
  try {
    if (await _ensureVolume(PET_VOLUME_ID, petImageIds, 'pet', PET_VOLUME_ID)) petVolumeId = PET_VOLUME_ID;
  } catch (e) { console.error('[volumeManager] PET volume build failed:', e?.message); }

  return { ctVolumeId, petVolumeId };
}

export function purgeVolumes() {
  _volumePromises.ct  = null;
  _volumePromises.pet = null;

  // Clear voxelManager refs
  delete window.__csVolumeCache[CT_VOLUME_ID];
  delete window.__csVolumeCache[PET_VOLUME_ID];

  // Try 3 removal strategies in order — v2.1.16 may or may not have each API
  for (const vid of [CT_VOLUME_ID, PET_VOLUME_ID]) {
    try { cache?.removeVolumeLoadObject?.(vid); } catch {}
    try { cache?.getVolume?.(vid)?.destroy?.();  } catch {}
    try { cache?.removeImageLoadObject?.(vid);   } catch {}
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const voiFromWL = (wl) => ({
  lower: wl.wc - wl.ww / 2,
  upper: wl.wc + wl.ww / 2,
});

/** Map orientation string to CS3D OrientationAxis enum value */
function _orientationEnum(orientation) {
  switch (orientation) {
    case 'coronal':  return OrientationAxis.CORONAL;
    case 'sagittal': return OrientationAxis.SAGITTAL;
    default:         return OrientationAxis.AXIAL;
  }
}

// ─── CT-only MPR viewport ──────────────────────────────────────────────────────
export async function applyCTVolume(vp, { wl, orientation, colormapName }) {
  await vp.setVolumes([{ volumeId: CT_VOLUME_ID }]);

  // Apply orientation BEFORE resetCamera so camera resets to the correct plane
  try { vp.setCamera({ viewPlaneNormal: undefined }); } catch {}
  try { vp.setOrientation(_orientationEnum(orientation)); } catch {}

  vp.resetCamera();

  const cmName = colormapName || 'petct_gray';
  try {
    vp.setProperties({ voiRange: voiFromWL(wl), colormap: { name: cmName } });
  } catch {
    vp.setProperties({ voiRange: voiFromWL(wl) });
  }
  vp.render();
  console.log(`[volumeManager] CT volume applied — ${orientation} — colormap: ${cmName}`);
}

// ─── PET-CT FUSION viewport ────────────────────────────────────────────────────
/**
 * Apply CT + PET volumes to a fusion viewport.
 * CT is rendered grey at 0.99 opacity by CS3D VTK.
 * PET VTK actor is set to 0.001 opacity — Canvas2D draws the colour instead.
 *
 * CRITICAL: PET must be listed LAST in setVolumes so that
 * getCurrentSlicePixelData() returns PET data (not CT).
 */
export async function applyFusionVolumes(vp, { ctWL, petWL, petColormapName, petOpacity, orientation }) {
  // PET is LAST so getCurrentSlicePixelData() returns PET pixel data
  await vp.setVolumes([
    { volumeId: CT_VOLUME_ID  },
    { volumeId: PET_VOLUME_ID },
  ]);

  // Apply orientation (Fix 2)
  try { vp.setOrientation(_orientationEnum(orientation)); } catch {}

  vp.resetCamera();

  // CT: grey colormap, real VOI, 0.99 opacity so VTK alpha-compositing is active
  const ctMap = 'petct_gray';
  try { vp.setProperties({ voiRange: voiFromWL(ctWL), colormap: { name: ctMap } }, CT_VOLUME_ID); } catch {}
  try { vp.setProperties({ colormap: { opacity: 0.99 } }, CT_VOLUME_ID); } catch {}

  // PET: nearly invisible VTK actor — Canvas2D handles colour
  const petMap = petColormapName || 'petct_hot_iron';
  try { vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petMap } }, PET_VOLUME_ID); } catch {}
  try { vp.setProperties({ colormap: { opacity: 0.001 } }, PET_VOLUME_ID); } catch {}

  console.log(`[volumeManager] Fusion applied — ${orientation} — CT grey + PET Canvas2D (${petMap})`);
  vp.render();
}

// ─── Update PET W/L on fusion viewport ────────────────────────────────────────
export function setFusionPetProperties(vp, { petWL, colormapName }) {
  try { vp.setProperties({ voiRange: voiFromWL(petWL) }, PET_VOLUME_ID); } catch {}
  vp.render();
}

// ─── Update CT VOI on fusion viewport ─────────────────────────────────────────
export function setFusionCtVOI(vp, ctWL) {
  try {
    vp.setProperties({ voiRange: voiFromWL(ctWL) }, CT_VOLUME_ID);
    vp.render();
  } catch {}
}

// ─── Blend slider ─────────────────────────────────────────────────────────────
// Canvas2D alpha is controlled by petOpacityRef in ViewerBox.
// This just triggers a render so IMAGE_RENDERED fires and canvasFusion redraws.
export function setPetOpacity(viewportId, petOpacity, petWL) {
  try {
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    vp.render();
  } catch {}
}

// ─── MIP viewport ─────────────────────────────────────────────────────────────
export async function applyMIPVolume(vp, { petWL, colormapName, orientation = 'coronal' }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);

  try { vp.setOrientation(OrientationAxis.CORONAL); } catch {}

  vp.resetCamera();

  const cmName = colormapName || 'petct_gray';
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: cmName } });
  } catch {
    vp.setProperties({ voiRange: voiFromWL(petWL) });
  }

  try {
    vp.setBlendMode(BlendModes.MAXIMUM_INTENSITY_BLEND);
    vp.setSlabThickness(1000);
  } catch {}

  vp.render();
  console.log(`[volumeManager] MIP applied — colormap: ${cmName}`);
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
