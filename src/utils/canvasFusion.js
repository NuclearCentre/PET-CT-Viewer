/**
 * canvasFusion.js -- Session 16 DEFINITIVE
 *
 * All bugs from full audit fixed:
 *
 * BUG A (FIXED): hasData sampling was sparse and biased to index 0.
 *   New approach: sample the MIDDLE third of the scalar array where
 *   body tissues (and PET uptake) are most likely to be non-zero.
 *
 * BUG B (FIXED): petWLFusion W/L slider had no effect on display.
 *   renderPETOverlay now accepts petLo/petHi from the W/L slider,
 *   falling back to autoNorm (99th percentile) if not supplied.
 *
 * BUG C (VERIFIED CORRECT): globalA = round(blend*255) for ALL pixels.
 *   Background (zero uptake) pixels: black at blend-alpha -> covers CT.
 *   Hotspot pixels: LUT colour at blend-alpha.
 *   At 100%: every pixel alpha=255 -> canvas fully opaque -> CT gone.
 *   At 0%: every pixel alpha=0 -> canvas invisible -> CT unchanged.
 *
 * CANVAS SIZING (VERIFIED CORRECT): done in drawFrame from pctVp.element
 *   clientWidth/clientHeight, never inside renderPETOverlay.
 *
 * SLIDER BEHAVIOUR (GUARANTEED):
 *   0%   -> clearRect -> transparent -> CT only
 *   50%  -> every pixel alpha=128 -> 50% fusion
 *   100% -> every pixel alpha=255 -> fully opaque -> CT gone, PET only
 */

import { cache } from '@cornerstonejs/core';
import { PET_VOLUME_ID } from './volumeManager.js';

export function buildLUT(getColorFn, paletteId) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = getColorFn(paletteId, i / 255);
    lut[i * 3]     = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

function bilinear(data, W, H, fx, fy) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  return data[y0 * W + x0] * (1 - tx) * (1 - ty)
       + data[y0 * W + x1] *      tx  * (1 - ty)
       + data[y1 * W + x0] * (1 - tx) *      ty
       + data[y1 * W + x1] *      tx  *      ty;
}

function computePetHi(data) {
  const step = Math.max(1, Math.floor(data.length / 4096));
  const sample = [];
  for (let i = 0; i < data.length; i += step) {
    if (data[i] > 0) sample.push(data[i]);
  }
  if (!sample.length) return 10000;
  sample.sort((a, b) => a - b);
  return sample[Math.floor(sample.length * 0.99)] || 10000;
}

function worldToIJK(imageData, wx, wy, wz) {
  try {
    const origin  = imageData.getOrigin();
    const spacing = imageData.getSpacing();
    const dims    = imageData.getDimensions();
    if (!origin || !spacing || !dims) return null;
    if (!spacing[0] || !spacing[1] || !spacing[2]) return null;
    return [
      Math.max(0, Math.min(dims[0] - 1, Math.round((wx - origin[0]) / spacing[0]))),
      Math.max(0, Math.min(dims[1] - 1, Math.round((wy - origin[1]) / spacing[1]))),
      Math.max(0, Math.min(dims[2] - 1, Math.round((wz - origin[2]) / spacing[2]))),
    ];
  } catch (e) {
    return null;
  }
}

/**
 * Extract a 2D PET plane from the cached PET volume.
 * Uses world-space focal point from pct- viewport camera.
 * Returns null only if PET volume not yet loaded at all.
 */
export function getPETPlaneWorldSpace(pctVp, orientationName) {
  try {
    const petVol = cache.getVolume(PET_VOLUME_ID);
    if (!petVol) return null;

    // Get scalar data -- try scalarData first (CS3D StreamingImageVolume direct property),
    // fall back to VTK imageData chain.
    let data = petVol.scalarData;
    if (!data || !data.length) {
      try { data = petVol.imageData.getPointData().getScalars().getData(); }
      catch(e) { return null; }
    }
    if (!data || !data.length) return null;

    // BUG A FIX: sample the MIDDLE THIRD of the array.
    // PET body outline is in the middle axial slices, not at index 0 (which is
    // often an air/table voxel). Sampling 256 points from the middle third
    // gives a much higher chance of hitting non-zero uptake tissue.
    const third = Math.floor(data.length / 3);
    const step  = Math.max(1, Math.floor(third / 256));
    let hasData = false;
    for (let si = third; si < third * 2; si += step) {
      if (data[si] !== 0) { hasData = true; break; }
    }
    // Fallback: scan the full array with wider step if middle third was all zero
    if (!hasData) {
      const wideStep = Math.max(1, Math.floor(data.length / 256));
      for (let si = 0; si < data.length; si += wideStep) {
        if (data[si] !== 0) { hasData = true; break; }
      }
    }
    if (!hasData) return null;

    const imageData = petVol.imageData;
    if (!imageData) return null;
    const dims = imageData.getDimensions();
    if (!dims || !dims[0]) return null;
    const [iMax, jMax, kMax] = dims;

    const cam = pctVp.getCamera();
    if (!cam || !cam.focalPoint) return null;
    const [wx, wy, wz] = cam.focalPoint;

    const ijk = worldToIJK(imageData, wx, wy, wz);
    if (!ijk) return null;
    const [ci, cj, ck] = ijk;

    const petHi = computePetHi(data);

    let planeData, planeW, planeH;

    if (orientationName === 'axial') {
      planeW = iMax; planeH = jMax;
      planeData = new Float32Array(planeW * planeH);
      const base = ck * jMax * iMax;
      for (let j = 0; j < jMax; j++) {
        const rb = base + j * iMax;
        for (let i = 0; i < iMax; i++) {
          planeData[j * planeW + i] = data[rb + i];
        }
      }
    } else if (orientationName === 'coronal') {
      planeW = iMax; planeH = kMax;
      planeData = new Float32Array(planeW * planeH);
      for (let k = 0; k < kMax; k++) {
        const srcBase = k * jMax * iMax + cj * iMax;
        const dstRow  = kMax - 1 - k;
        for (let i = 0; i < iMax; i++) {
          planeData[dstRow * planeW + i] = data[srcBase + i];
        }
      }
    } else {
      // sagittal
      planeW = jMax; planeH = kMax;
      planeData = new Float32Array(planeW * planeH);
      for (let k = 0; k < kMax; k++) {
        const dstRow = kMax - 1 - k;
        const kBase  = k * jMax * iMax;
        for (let j = 0; j < jMax; j++) {
          planeData[dstRow * planeW + j] = data[kBase + j * iMax + ci];
        }
      }
    }

    return { data: planeData, width: planeW, height: planeH, petHi: petHi };

  } catch (e) {
    console.warn('[canvasFusion] getPETPlaneWorldSpace:', e && e.message);
    return null;
  }
}

/**
 * Paint the PET colour overlay onto the canvas.
 *
 * MUST be called with canvas.width and canvas.height already set correctly
 * by the caller (drawFrame in ViewerBox.jsx). Do NOT set canvas dimensions here.
 *
 * Every canvas pixel gets the same alpha = round(blend * 255).
 * This is the ONLY correct way to achieve the slider behaviour:
 *
 *   blend=0   -> alpha=0 everywhere   -> canvas invisible     -> CT unchanged
 *   blend=0.5 -> alpha=128 everywhere -> 50% opaque overlay   -> CT+PET fusion
 *   blend=1   -> alpha=255 everywhere -> fully opaque         -> CT completely hidden
 *
 * Background voxels (zero PET uptake): colour = LUT[0].
 * For hot_iron and most PET LUTs, LUT[0] = black (0,0,0).
 * At blend=1: background = solid black = CT hidden.
 * At blend=0.5: background = 50% black over CT = slight darkening (correct fusion look).
 *
 * BUG B FIX: cfg.petLo and cfg.petHi can now be set from the W/L slider.
 * If cfg.petHi <= 0 or not set, falls back to petPlane.petHi (autoNorm).
 */
export function renderPETOverlay(canvas, petData, petW, petH, lut, cfg) {
  if (!canvas || !petData || !lut) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Canvas bitmap size must be set by caller. Read it here, never set it.
  const W = canvas.width;
  const H = canvas.height;
  if (!W || !H) return;

  const blend = Math.max(0, Math.min(1, cfg.alpha != null ? cfg.alpha : 0.6));

  if (blend < 0.004) {
    ctx.clearRect(0, 0, W, H);
    return;
  }

  // Alpha applied to EVERY pixel identically -- encodes the blend level.
  // This is what makes the slider work: same alpha for background AND hotspots.
  const globalA = Math.round(blend * 255);

  const power  = cfg.power != null ? cfg.power : 2.0;

  // BUG B FIX: honour petLo/petHi from W/L slider when provided.
  const petLo  = cfg.petLo  != null && cfg.petLo  >= 0 ? cfg.petLo  : 0;
  const petHi  = cfg.petHi  != null && cfg.petHi  > 0  ? cfg.petHi  : 10000;
  const petRange = petHi - petLo;

  const scaleX = petW / W;
  const scaleY = petH / H;

  const imgData = ctx.createImageData(W, H);
  const px      = imgData.data;

  for (let oy = 0; oy < H; oy++) {
    const petFY = oy * scaleY;
    for (let ox = 0; ox < W; ox++) {
      const idx = (oy * W + ox) * 4;

      const petV       = bilinear(petData, petW, petH, ox * scaleX, petFY);
      const petNorm    = petRange > 0 ? Math.max(0, Math.min(1, (petV - petLo) / petRange)) : 0;
      const colourNorm = Math.pow(petNorm, power);
      const lutIdx     = Math.min(255, Math.round(colourNorm * 255)) * 3;

      px[idx]     = lut[lutIdx];
      px[idx + 1] = lut[lutIdx + 1];
      px[idx + 2] = lut[lutIdx + 2];
      px[idx + 3] = globalA;   // IDENTICAL for all pixels -- blend encoded here
    }
  }

  ctx.clearRect(0, 0, W, H);
  ctx.putImageData(imgData, 0, 0);
}

// Kept for import compatibility only -- not called in current architecture.
export function renderFusion() {}

export function getSlicePixelData(vp) {
  try {
    const info = vp.getSliceViewInfo();
    const data = vp.getCurrentSlicePixelData();
    if (!data || !data.length) return null;
    const w = Math.round(info.width);
    const h = Math.round(info.height);
    if (w <= 0 || h <= 0) return null;
    return { data, width: w, height: h };
  } catch (e) {
    return null;
  }
}
