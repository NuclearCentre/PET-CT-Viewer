/**
 * volumeManager.js — Phase 3 (MPR · Fusion · Crosshairs)
 *
 * Builds and caches the CT and PET volumes ONCE from their imageIds, then lets
 * any ORTHOGRAPHIC viewport render them in axial / coronal / sagittal without
 * reloading (Cornerstone3D shares the volume texture across viewports).
 *
 * Cornerstone3D v2.1.16 verified API:
 *   volumeLoader.createAndCacheVolume('cornerstoneStreamingImageVolume:ID', { imageIds })
 *   volume.load()
 *   await vp.setVolumes([{ volumeId }, ...])                  // 1 vol = MPR, 2 vols = fusion
 *   vp.setProperties({ voiRange, colormap }, volumeId)        // 2nd arg targets one volume
 *   vp.setBlendMode(BlendModes.MAXIMUM_INTENSITY_BLEND)       // MIP
 *   vp.setSlabThickness(mm)
 *
 * The streaming image volume loader is the DEFAULT loader in v2 — no manual
 * registration is required after coreInit().
 *
 * Colormaps are the same `petct_${id}` names registered in cornerstone-init.js
 * via registerCornerstonePalettes(); registered colormaps work on volume actors
 * exactly as they do on stack viewports.
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

// ─── Volume IDs ────────────────────────────────────────────────────────────────
const SCHEME = 'cornerstoneStreamingImageVolume';
export const CT_VOLUME_ID  = `${SCHEME}:PETCT_CT`;
export const PET_VOLUME_ID = `${SCHEME}:PETCT_PET`;

// Map a viewport "orientation" string → CS3D OrientationAxis enum
export const ORIENTATION = {
  axial:    OrientationAxis.AXIAL,
  coronal:  OrientationAxis.CORONAL,
  sagittal: OrientationAxis.SAGITTAL,
};

// ─── Build / cache volumes ─────────────────────────────────────────────────────
// Cache the in-flight promises so repeated calls (re-renders) never rebuild.
const _volumePromises = { ct: null, pet: null };

/**
 * Prefetch every slice so its DICOM metadata is parsed and registered.
 *
 * WADO-URI metadata (imagePositionPatient / pixelRepresentation / pixelSpacing)
 * only exists AFTER each file is downloaded and parsed. Volume construction needs
 * all of it up front, so we load+cache every image first. Without this,
 * setVolumes() throws "Cannot destructure property 'imagePositionPatient'".
 *
 * CRITICAL: requests are THROTTLED. Firing all ~200 slices at once
 * (Promise.all over every imageId) floods the Vite proxy / Orthanc and triggers
 * net::ERR_CONNECTION_REFUSED, which then leaves metadata undefined and blanks
 * the viewer. We run only PREFETCH_CONCURRENCY requests at a time, with one
 * retry per slice for transient refusals.
 */
const PREFETCH_CONCURRENCY = 4;   // lower this if Orthanc still refuses connections

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
  console.log(`[volumeManager] prefetching ${imageIds.length} ${label} slices (×${PREFETCH_CONCURRENCY})…`);
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

async function _ensureVolume(volumeId, imageIds, key) {
  if (!imageIds || imageIds.length === 0) return null;
  if (_volumePromises[key]) return _volumePromises[key];

  _volumePromises[key] = (async () => {
    // createAndCacheVolume + load. Metadata was prefetched in ensureVolumes()
    // BEFORE this runs, so geometry is available. If the volume fails to build
    // we clear the cached promise and rethrow so the caller can fall back.
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

/**
 * Ensure both CT and PET volumes are created and loading.
 * Prefetch is done SERIALLY per series (CT then PET) so we never exceed
 * PREFETCH_CONCURRENCY total in-flight requests. Returns
 * { ctVolumeId, petVolumeId } (either may be null on failure).
 */
export async function ensureVolumes(ctImageIds, petImageIds) {
  // 1) Prefetch metadata, throttled, one series at a time.
  await _prefetchMetadata(ctImageIds,  'CT');
  await _prefetchMetadata(petImageIds, 'PET');

  // 2) Build volumes (metadata now cached). Each is independent — if one fails
  //    we still return the other rather than blanking everything.
  let ctVolumeId = null, petVolumeId = null;
  try { if (await _ensureVolume(CT_VOLUME_ID,  ctImageIds,  'ct'))  ctVolumeId  = CT_VOLUME_ID;  }
  catch (e) { console.error('[volumeManager] CT volume build failed:', e?.message); }
  try { if (await _ensureVolume(PET_VOLUME_ID, petImageIds, 'pet')) petVolumeId = PET_VOLUME_ID; }
  catch (e) { console.error('[volumeManager] PET volume build failed:', e?.message); }

  return { ctVolumeId, petVolumeId };
}

/** Drop cached volumes (e.g. when switching studies). */
export function purgeVolumes() {
  _volumePromises.ct = null;
  _volumePromises.pet = null;
  try {
    cache?.removeVolumeLoadObject?.(CT_VOLUME_ID);
    cache?.removeVolumeLoadObject?.(PET_VOLUME_ID);
  } catch (e) { /* best-effort; volume may not be cached yet */ }
}

// ─── voiRange helper ────────────────────────────────────────────────────────────
const voiFromWL = (wl) => ({
  lower: wl.wc - wl.ww / 2,
  upper: wl.wc + wl.ww / 2,
});

// ─── Apply: CT-only MPR viewport ───────────────────────────────────────────────
export async function applyCTVolume(vp, { wl, colormapName }) {
  await vp.setVolumes([{ volumeId: CT_VOLUME_ID }]);
  vp.resetCamera();
  try {
    vp.setProperties({
      voiRange: voiFromWL(wl),
      colormap: { name: colormapName },
    });
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(wl) });
  }
  vp.render();
}

// ─── Apply: PET-CT FUSION viewport (CT base + PET overlay) ──────────────────────
// CT is volume[0] (grayscale anatomy), PET is volume[1] (hot colormap, blended).
// Putting CT first means the fusion viewport's Frame Of Reference == CT's, so the
// CrosshairsTool links these viewports to the CT-only row.
export async function applyFusionVolumes(vp, { ctWL, petWL, petColormapName, petOpacity }) {
  await vp.setVolumes([
    { volumeId: CT_VOLUME_ID },
    { volumeId: PET_VOLUME_ID },
  ]);
  vp.resetCamera();

  // CT base — grayscale
  try {
    vp.setProperties({ voiRange: voiFromWL(ctWL), colormap: { name: 'petct_gray' } }, CT_VOLUME_ID);
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(ctWL) }, CT_VOLUME_ID);
  }

  // PET overlay — colormap + a uniform blend opacity (the "blend" slider value).
  // NOTE: this is a flat global opacity, NOT a per-value transparency ramp — low
  // uptake is blended at the same opacity as hot spots, so CT anatomy shows through
  // everywhere at (1 - petOpacity). SUV-based transparency (zero uptake fully
  // transparent) needs the rescale/units handling from dicomMetadata.js and is
  // deferred to Phase 4.
  setFusionPetProperties(vp, { petWL, petColormapName, petOpacity });

  vp.render();
}

/** Update only the PET overlay properties on a fusion viewport (W/L, colormap, opacity). */
export function setFusionPetProperties(vp, { petWL, petColormapName, petOpacity }) {
  try {
    vp.setProperties({
      voiRange: voiFromWL(petWL),
      colormap: {
        name: petColormapName,
        // global multiplier 0..1 from the blend slider
        opacity: clampOpacity(petOpacity),
      },
    }, PET_VOLUME_ID);
  } catch (e) {
    try { vp.setProperties({ voiRange: voiFromWL(petWL) }, PET_VOLUME_ID); } catch (e2) {}
  }
}

/** Update just the blend opacity of the PET overlay (called from the blend slider). */
export function setPetOpacity(viewportId, petOpacity) {
  try {
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    vp.setProperties({ colormap: { opacity: clampOpacity(petOpacity) } }, PET_VOLUME_ID);
    vp.render();
  } catch (e) { /* noop */ }
}

function clampOpacity(o) {
  const v = typeof o === 'number' ? o : 0.6;
  return Math.max(0, Math.min(1, v));
}

// ─── Apply: MIP viewport (whole-body PET maximum intensity projection) ──────────
// A true MIP: render the PET volume with MAXIMUM_INTENSITY_BLEND and a slab
// thicker than the body so every slice along the view contributes.
export async function applyMIPVolume(vp, { petWL, colormapName, orientation = 'coronal' }) {
  await vp.setVolumes([{ volumeId: PET_VOLUME_ID }]);
  vp.resetCamera();
  try {
    vp.setProperties({ voiRange: voiFromWL(petWL), colormap: { name: colormapName } });
  } catch (e) {
    vp.setProperties({ voiRange: voiFromWL(petWL) });
  }
  try {
    vp.setBlendMode(BlendModes.MAXIMUM_INTENSITY_BLEND);
    // 1000 mm comfortably exceeds whole-body extent → full-depth MIP
    vp.setSlabThickness(1000);
  } catch (e) { /* blend/slab unsupported → falls back to single-slice */ }
  vp.render();
}

// ─── Orientation markers (R/L/A/P/S/I) ──────────────────────────────────────────
// Standard radiological convention for the default CS3D orthographic cameras.
// (These assume the patient is in the usual HFS orientation; for arbitrary
//  acquisitions the camera-derived markers in Phase 4 will supersede these.)
export function getOrientationMarkers(orientation) {
  switch (orientation) {
    case 'axial':    return { top: 'A', bottom: 'P', left: 'R', right: 'L' };
    case 'coronal':  return { top: 'S', bottom: 'I', left: 'R', right: 'L' };
    case 'sagittal': return { top: 'S', bottom: 'I', left: 'A', right: 'P' };
    default:         return { top: '',  bottom: '',  left: '',  right: '' };
  }
}
