/**
 * volumeManager.js -- Phase 3 (MPR + Fusion + Crosshairs)
 * Session 14 final.
 *
 * Architecture (Session 8 proven, kept intact):
 *   ct-axial/coronal/sagittal  : CT volume, full CS3D greyscale rendering.
 *   pct-axial/coronal/sagittal : PET volume loaded. CS3D renders PET into its
 *                                WebGL canvas. The Canvas2D overlay (zIndex:5,
 *                                fully opaque) covers it completely so the WebGL
 *                                PET render is invisible. No actor opacity change
 *                                needed -- the canvas covers it physically.
 *                                canvasFusion reads PET pixels from these viewports
 *                                (getSlicePixelData -> 512x512 confirmed S8) and CT
 *                                pixels from the matching ct- viewports, composites
 *                                CT grey + PET colour, writes fully opaque pixels.
 *   mip                        : PET volume, petct_inv_greyscale colormap (S14).
 *
 * Changes vs Session 12/13:
 *   - applyFusionVolumes: removed setOpacity(0.001) actor call.
 *     vtkVolumeProperty.setOpacity(scalar) does not exist in vtk.js -- it would
 *     silently fail or throw. Canvas2D overlay covers the WebGL render physically
 *     via z-order (zIndex:5, alpha=255 every pixel). No actor manipulation needed.
 *   - applyMIPVolume: default colormap is petct_inv_greyscale (S14 user request).
 *   - All other logic unchanged.
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

// ---------------------------------------------------------------------------
// Volume build / cache (unchanged from Session 12)
// ---------------------------------------------------------------------------
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
  for (const volumeId of [CT_VOLUME_ID, PET_VOLUME_ID]) {
    try { cache?.removeVolumeLoadObject?.(volumeId); } catch(e) {}
    try { cache?.getVolume?.(volumeId)?.destroy?.(); } catch(e) {}
    try { cache?.removeImageLoadObject?.(volumeId); } catch(e) {}
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const voiFromWL = (wl) => ({
  lower: wl.wc - wl.ww / 2,
  upper: wl.wc + wl.ww / 2,
});

// ---------------------------------------------------------------------------
// CT-only MPR viewports (ct-axial / ct-coronal / ct-sagittal) -- unchanged
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// PET-CT fusion viewports (pct-axial / pct-coronal / pct-sagittal)
//
// PET volume is loaded so getSlicePixelData(pctVp) returns the correct
// 512x512 (or actual PET matrix) raw pixel array. canvasFusion uses this
// together with CT pixels from ct- viewports to draw CT grey + PET colour.
//
// The Canvas2D overlay in ViewerBox (position:absolute, inset:0, zIndex:5,
// alpha=255 every pixel) physically covers the CS3D WebGL canvas underneath.
// No actor opacity manipulation needed.
// ---------------------------------------------------------------------------
export async function applyFusionVolumes(vp, { ctWL, petWL, petColormapName, petOpacity }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petColormapName } });
  } catch(e) {
    vp.setProperties({ voiRange: voiFromWL(petWL) });
  }
  // No actor opacity change. Canvas2D overlay covers the WebGL render via z-order.
  vp.render();
  console.log('[volumeManager] applyFusionVolumes: PET volume loaded, canvas2D overlay active');
}

export function setFusionPetProperties(vp, { petWL, petColormapName, petOpacity }) {
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petColormapName } });
  } catch(e) {
    try { vp.setProperties({ voiRange: voiFromWL(petWL) }); } catch(e2) {}
  }
  vp.render();
}

// CT VOI no-op: CT volume not present in pct- viewports.
// canvasFusion receives ctWL directly via cfg.ctLow/ctHigh.
export function setFusionCtVOI(vp, ctWL) {}

// ---------------------------------------------------------------------------
// Blend slider -- trigger canvas redraw via render
// ---------------------------------------------------------------------------
export function setPetOpacity(viewportId, petOpacity, petWL) {
  try {
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    vp.render();
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// MIP viewport
// Session 14: colormap changed to petct_inv_greyscale.
// MAXIMUM_INTENSITY_BLEND disabled -- crashes Intel UHD 620 (S10 M3).
// ---------------------------------------------------------------------------
export async function applyMIPVolume(vp, { petWL, colormapName, orientation = 'coronal' }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();

  // Capture parallelScale BEFORE render resets it (Rule 32).
  let correctScale = null;
  try { correctScale = vp.getCamera()?.parallelScale || null; } catch(e) {}

  const cmapToUse = colormapName || 'petct_inv_greyscale';
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: cmapToUse } });
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(petWL) });
  }
  vp.render();

  if (correctScale) {
    try {
      vp.setCamera({ parallelScale: correctScale });
      window.__mipScale = correctScale;
    } catch(e) {}
  }
}

// ---------------------------------------------------------------------------
// Orientation markers
// ---------------------------------------------------------------------------
export function getOrientationMarkers(orientation) {
  switch (orientation) {
    case 'axial':    return { top: 'A', bottom: 'P', left: 'R', right: 'L' };
    case 'coronal':  return { top: 'S', bottom: 'I', left: 'R', right: 'L' };
    case 'sagittal': return { top: 'S', bottom: 'I', left: 'A', right: 'P' };
    default:         return { top: '',  bottom: '',  left: '',  right: '' };
  }
}
