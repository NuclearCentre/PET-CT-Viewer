/**
 * volumeManager.js — Phase 3 (MPR · Fusion · Crosshairs)
 * Session 8 — FINAL. Based on reading actual source files.
 *
 * ─── ROOT CAUSE (confirmed from source files) ─────────────────────────────────
 *
 * The PET overlay is invisible because VTK renders the CT volume fully opaque,
 * blocking PET completely. Here is the confirmed chain:
 *
 * createVolumeActor.js: does NOT set a scalar opacity function on the actor.
 * VTK default scalar opacity for a vtkVolume = 1.0 everywhere (fully opaque).
 * setVolumes([CT, PET]): CT is actor[0], PET is actor[1].
 * VTK composites volumes in order: CT renders fully opaque → PET never visible.
 *
 * FIX: Set CT opacity to 0.99 (not 1.0).
 * With CT at exactly 1.0, VTK's compositing pipeline treats it as a solid wall.
 * At 0.99 VTK switches to alpha-compositing mode and blends PET through CT.
 * setProperties({ colormap: { opacity: 0.99 } }, CT_VOLUME_ID) is the correct
 * API — confirmed from setOpacity() source which does:
 *   ofun.addPoint(range[0], opacity)
 *   ofun.addPoint(range[1], opacity)
 * where range comes from cfun.getRange() (the real data range already set by
 * setDefaultVolumeVOI before this call).
 *
 * ─── OTHER CONFIRMED FACTS ────────────────────────────────────────────────────
 *
 * setDefaultVolumeVOI (confirmed source):
 *   Calls cfun.setMappingRange(voi.lower, voi.upper) on each actor after
 *   setVolumes resolves. So cfun.getRange() returns the real data range
 *   (CT: DICOM windowWidth/windowCenter or middle-slice min/max;
 *    PET BQML: middle-slice raw pixel min/max or [0,5] if pre-scaled SUV).
 *
 * setColormap (confirmed source, line 297-312):
 *   Creates NEW cfun via vtkColorTransferFunction.newInstance().
 *   Reads getRange() from the OLD cfun (already has real range from above).
 *   Calls cfun.applyColorMap(colormapObj) then cfun.setMappingRange(range).
 *   Assigns new cfun with setRGBTransferFunction(0, cfun).
 *   Stores colormap name in viewportProperties.colormap (shared — but this
 *   is NOT re-applied on renders, only on clearDefaultProperties()).
 *
 * setProperties order (confirmed source, lines 577-584):
 *   colormap applied BEFORE voiRange. Since getRange() already has the real
 *   data range (not [0,1]), colormap is applied correctly regardless of order.
 *   Passing both together in one call is fine.
 *
 * setOpacity (confirmed source, lines 324-349):
 *   opacity as number → flat opacity across full data range.
 *   opacity as array [{ value, opacity }] → custom ramp.
 *   Calls volumeActor.getProperty().setScalarOpacity(0, ofun).
 *
 * _getApplicableVolumeActor (confirmed source, line 738-760):
 *   Finds actor by referencedId === volumeId. Falls back to actorEntries[0].
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

// PET opacity ramp: background transparent, uptake visible at blend level.
// Array format confirmed from setOpacity source: [{ value, opacity }, ...]
function _petOpacityArray(petWL, globalOpacity) {
  const blend = Math.max(0, Math.min(1, typeof globalOpacity === 'number' ? globalOpacity : 0.6));
  const lower = petWL.wc - petWL.ww / 2;
  const upper = petWL.wc + petWL.ww / 2;
  const range = upper - lower;
  if (range <= 0) return [{ value: 0, opacity: 0 }, { value: 10000, opacity: blend }];
  return [
    { value: lower,                opacity: 0           },
    { value: lower + range * 0.05, opacity: 0           },
    { value: lower + range * 0.20, opacity: blend * 0.3 },
    { value: lower + range * 0.50, opacity: blend * 0.7 },
    { value: upper,                opacity: blend        },
  ];
}

// ─── CT-only MPR viewport ──────────────────────────────────────────────────────
export async function applyCTVolume(vp, { wl, colormapName }) {
  await vp.setVolumes([{ volumeId: CT_VOLUME_ID }]);
  vp.resetCamera();
  vp.setProperties({ voiRange: voiFromWL(wl), colormap: { name: colormapName } });
  vp.render();
}

// ─── PET-CT FUSION viewport ────────────────────────────────────────────────────
export async function applyFusionVolumes(vp, { ctWL, petWL, petColormapName, petOpacity }) {
  await vp.setVolumes([
    { volumeId: CT_VOLUME_ID },
    { volumeId: PET_VOLUME_ID },
  ]);
  vp.resetCamera();

  // CT: colormap + VOI. Then opacity 0.99 to force VTK alpha-compositing mode.
  // Without this, CT renders fully opaque and PET is completely invisible.
  vp.setProperties({ voiRange: voiFromWL(ctWL), colormap: { name: 'petct_gray' } }, CT_VOLUME_ID);
  vp.setProperties({ colormap: { opacity: 0.99 } }, CT_VOLUME_ID);
  console.log('[volumeManager] CT: colormap + opacity 0.99 applied');

  // PET: colormap + VOI + transparency ramp.
  vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petColormapName } }, PET_VOLUME_ID);
  vp.setProperties({ colormap: { opacity: _petOpacityArray(petWL, petOpacity) } }, PET_VOLUME_ID);
  console.log('[volumeManager] PET: colormap + opacity ramp applied');

  vp.render();
}

// ─── Update PET overlay (W/L, colormap, or opacity change) ────────────────────
export function setFusionPetProperties(vp, { petWL, petColormapName, petOpacity }) {
  vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: petColormapName } }, PET_VOLUME_ID);
  vp.setProperties({ colormap: { opacity: _petOpacityArray(petWL, petOpacity) } }, PET_VOLUME_ID);
  vp.render();
}

// ─── Update CT VOI only (colormap stays, just window changes) ─────────────────
export function setFusionCtVOI(vp, ctWL) {
  try {
    vp.setProperties({ voiRange: voiFromWL(ctWL) }, CT_VOLUME_ID);
    vp.render();
  } catch(e) {}
}

// ─── Blend slider ─────────────────────────────────────────────────────────────
export function setPetOpacity(viewportId, petOpacity, petWL) {
  const wl = petWL || { wc: 5000, ww: 10000 };
  try {
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    vp.setProperties({ colormap: { opacity: _petOpacityArray(wl, petOpacity) } }, PET_VOLUME_ID);
    vp.render();
  } catch (e) {}
}

// ─── MIP viewport ─────────────────────────────────────────────────────────────
export async function applyMIPVolume(vp, { petWL, colormapName, orientation = 'coronal' }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();
  vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: colormapName } });
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
