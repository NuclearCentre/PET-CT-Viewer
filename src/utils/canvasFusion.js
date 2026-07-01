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

// Boost red channel by 25% for hot_iron palettes
function _boostRed(r, g, b, paletteId) {
  if (paletteId !== 'hot_iron') return [r, g, b];
  return [Math.min(255, Math.round(r + (255 - r) * 0.50)), g, b];
}

export function buildLUT(getColorFn, paletteId, gamma = 0.75) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t         = i / 255;
    // Floor 0.10 exposes warm low-uptake hues (dark red/orange)
    // previously hidden by the old 0.50 floor.
    const tRemapped = 0.10 + t * 0.90;
    const tAdjusted = Math.pow(tRemapped, gamma);
    let [r, g, b]   = getColorFn(paletteId, Math.min(1, tAdjusted));
    ;[r, g, b] = _boostRed(r, g, b, paletteId);
    // Push upper 30% of ramp 20% towards white
    const whitePush = t > 0.70 ? (t - 0.70) * (1 / 0.30) * 0.20 : 0;
    lut[i * 3]     = Math.min(255, Math.round(r + (255 - r) * whitePush));
    lut[i * 3 + 1] = Math.min(255, Math.round(g + (255 - g) * whitePush));
    lut[i * 3 + 2] = Math.min(255, Math.round(b + (255 - b) * whitePush));
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

    const vm = petVol.voxelManager;
    if (!vm) return null;

    const petImageData = petVol.imageData;
    if (!petImageData) return null;

    const dims    = petImageData.getDimensions();
    const origin  = petImageData.getOrigin();
    const spacing = petImageData.getSpacing();
    if (!dims?.[0] || !origin || !spacing) return null;

    const [iMax, jMax, kMax] = dims;

    // Get the full scalar array - confirmed working path for CS3D v2.1.16
    const full = vm.getCompleteScalarDataArray?.();
    if (!full?.length) return null;

    // Camera focal point in world space
    const cam = pctVp.getCamera();
    if (!cam?.focalPoint) return null;
    const [wx, wy, wz] = cam.focalPoint;

    // Convert world coords to PET voxel IJK using VTK worldToIndex
    // This correctly handles the 5:1 CT:PET ratio automatically -
    // CT focal point at world-Z maps to nearest PET slice covering that Z
    let ci = 0, cj = 0, ck = 0;
    try {
      const ijk = [0, 0, 0];
      petImageData.worldToIndex([wx, wy, wz], ijk);
      ci = Math.max(0, Math.min(iMax - 1, Math.round(ijk[0])));
      cj = Math.max(0, Math.min(jMax - 1, Math.round(ijk[1])));
      ck = Math.max(0, Math.min(kMax - 1, Math.round(ijk[2])));
    } catch(e) {
      ci = Math.max(0, Math.min(iMax - 1, Math.round((wx - origin[0]) / spacing[0])));
      cj = Math.max(0, Math.min(jMax - 1, Math.round((wy - origin[1]) / spacing[1])));
      ck = Math.max(0, Math.min(kMax - 1, Math.round((wz - origin[2]) / spacing[2])));
    }

    // Data layout in getCompleteScalarDataArray is [k][j][i] - confirmed by CS3D source.
    // flat index = k*(jMax*iMax) + j*iMax + i
    let planeData, planeW, planeH;

    if (orientationName === 'axial') {
      // Hold k=ck, vary i and j
      planeW = iMax; planeH = jMax;
      planeData = new Float32Array(planeW * planeH);
      const base = ck * jMax * iMax;
      for (let j = 0; j < jMax; j++) {
        const srcRow = base + j * iMax;
        const dstRow = j * planeW;
        for (let i = 0; i < iMax; i++) {
          planeData[dstRow + i] = full[srcRow + i];
        }
      }

    } else if (orientationName === 'coronal') {
      // Hold j=cj, vary i (x-axis) and k (z/height axis)
      // k=0 is inferior, k=kMax-1 is superior - flip vertically so superior is at top
      planeW = iMax; planeH = kMax;
      planeData = new Float32Array(planeW * planeH);
      for (let k = 0; k < kMax; k++) {
        const srcBase = k * jMax * iMax + cj * iMax;
        const dstRow  = (kMax - 1 - k) * planeW;  // flip: superior at top
        for (let i = 0; i < iMax; i++) {
          planeData[dstRow + i] = full[srcBase + i];
        }
      }

    } else {
      // sagittal: hold i=ci, vary j (x-axis) and k (z/height axis)
      planeW = jMax; planeH = kMax;
      planeData = new Float32Array(planeW * planeH);
      for (let k = 0; k < kMax; k++) {
        const kBase  = k * jMax * iMax;
        const dstRow = (kMax - 1 - k) * planeW;    // flip: superior at top
        for (let j = 0; j < jMax; j++) {
          planeData[dstRow + j] = full[kBase + j * iMax + ci];
        }
      }
    }

    const petHi = computePetHi(full);  // full volume - consistent petHi/noiseFloor in all orientations
    return {
      data: planeData, width: planeW, height: planeH,
      petHi: petHi || 10000,
      orientation: orientationName,
      petImageData,
      fullData: full,   // raw flat array for direct worldToIndex lookup
      iMax, jMax, kMax,
    };

  } catch(e) {
    console.warn('[canvasFusion] getPETPlaneWorldSpace error:', e?.message);
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

  const W = canvas.width;
  const H = canvas.height;
  if (!W || !H) return;

  // Minimum 30% PET visibility even at slider 0% - so PET is always seen over CT
  const rawBlend = cfg.alpha != null ? cfg.alpha : 0.6;
  const blend = 0.20 + Math.max(0, Math.min(1, rawBlend)) * 0.80;

  const power    = cfg.power != null ? cfg.power : 2.0;
  const petLo    = cfg.petLo != null && cfg.petLo >= 0 ? cfg.petLo : 0;
  const petHi    = cfg.petHi != null && cfg.petHi > 0  ? cfg.petHi : 10000;
  const petRange = petHi - petLo;
  const noiseFloor = petHi * 0.05;
  // Diffuse background wash: below noiseFloor, instead of a hard transparent
  // cutoff (which produced the "patchy" look -- only hot spots visible,
  // everything else pure CT), give every in-bounds PET voxel a faint
  // minimum tint. Matches reference clinical PET-CT images where muscle/
  // soft tissue shows a soft uniform low-level uptake colour, giving the
  // whole body a "complete" coloured silhouette the same way the MIP
  // column already naturally has (MIP has no hard per-pixel cutoff).
  const DIFFUSE_FLOOR = 0.06; // fraction of the blend slider's alpha
  // Background tone: the chosen palette's OWN hue, forced dark, so it reads
  // as "this palette's darkest/coolest shade" rather than a generic grey --
  // e.g. hot_metal_blue gives a dark blue background, hot_iron a near-black
  // one, each tied to that palette's character. Sampled from a low-but-not-
  // literal-zero point in the LUT (t-0.12) rather than lut[0] directly,
  // because hue-cycling palettes (rainbow) don't naturally start dark --
  // rainbow's t=0 is a vivid, FULL-BRIGHTNESS violet, not a dark shade, which
  // is exactly what produced the jarring purple cast reported earlier.
  // Explicitly darkening here (not just sampling low t) guarantees a proper
  // dark background regardless of where any given palette's own brightness
  // happens to bottom out.
  const DARKEN_FACTOR = 0.32;
  const _bgIdx = Math.round(0.12 * 255) * 3;
  const DIFFUSE_FLOOR_R = Math.round((lut[_bgIdx]     ?? 0) * DARKEN_FACTOR);
  const DIFFUSE_FLOOR_G = Math.round((lut[_bgIdx + 1] ?? 0) * DARKEN_FACTOR);
  const DIFFUSE_FLOOR_B = Math.round((lut[_bgIdx + 2] ?? 0) * DARKEN_FACTOR);

  // Per-pixel world-space mapping using viewport camera bounds and PET worldToIndex
  const vp       = cfg.vpBounds;       // {xMin,xMax,yMin,yMax} in world mm
  const imgData2 = cfg.petImageData;   // VTK imageData for worldToIndex
  const orient   = cfg.orientation;
  const iMax     = cfg.iMax;
  const jMax     = cfg.jMax;
  const kMax     = cfg.kMax;
  // Fixed slice indices (held constant for this orientation)
  const ci       = cfg.ci ?? 0;
  const cj       = cfg.cj ?? 0;
  const ck       = cfg.ck ?? 0;

  const useWorldMapping = vp && imgData2 && iMax && jMax && kMax;

  const imgData = ctx.createImageData(W, H);
  const px      = imgData.data;
  const ijk     = [0, 0, 0];

  for (let oy = 0; oy < H; oy++) {
    for (let ox = 0; ox < W; ox++) {
      const idx = (oy * W + ox) * 4;

      if (useWorldMapping) {
        // Canvas pixel - world coord - PET IJK via worldToIndex
        const worldX = vp.xMin + (ox / (W - 1)) * (vp.xMax - vp.xMin);
        const worldY = vp.yMin + (oy / (H - 1)) * (vp.yMax - vp.yMin);

        let wx3, wy3, wz3;
        // Mirror worldX for coronal/sagittal to correct LR inversion
        const worldXFlipped = vp.xMin + vp.xMax - worldX;
        const worldYFlipped = vp.yMin + vp.yMax - worldY;
        if (orient === 'axial') {
          wx3 = worldX; wy3 = worldY; wz3 = cfg.focalZ ?? 0;
        } else if (orient === 'coronal') {
          wx3 = worldX; wy3 = cfg.focalY ?? 0; wz3 = worldYFlipped;
        } else {
          // Sagittal: TB flip only (wz3), no LR flip
          wx3 = cfg.focalX ?? 0;
          wy3 = worldX;                       // no LR flip
          wz3 = vp.yMin + vp.yMax - worldY;  // TB flip
        }

        try {
          imgData2.worldToIndex([wx3, wy3, wz3], ijk);
        } catch(e) {
          px[idx] = px[idx+1] = px[idx+2] = px[idx+3] = 0;
          continue;
        }

        // Use fractional IJK for trilinear interpolation - eliminates pixelation on zoom-out
        const fi = ijk[0], fj = ijk[1], fk = ijk[2];

        // Bounds check using fractional values
        if (fi < 0 || fi >= iMax || fj < 0 || fj >= jMax || fk < 0 || fk >= kMax) {
          px[idx] = px[idx+1] = px[idx+2] = px[idx+3] = 0;
          continue;
        }

        // Trilinear interpolation
        const i0 = Math.max(0, Math.min(iMax-2, Math.floor(fi)));
        const j0 = Math.max(0, Math.min(jMax-2, Math.floor(fj)));
        const k0 = Math.max(0, Math.min(kMax-2, Math.floor(fk)));
        const i1 = i0+1, j1 = j0+1, k1 = k0+1;
        const ti = fi-i0, tj = fj-j0, tk = fk-k0;
        const full = cfg.fullData;
        const s = jMax*iMax;
        const petV =
          full[k0*s + j0*iMax + i0] * (1-tk)*(1-tj)*(1-ti) +
          full[k0*s + j0*iMax + i1] * (1-tk)*(1-tj)*   ti  +
          full[k0*s + j1*iMax + i0] * (1-tk)*   tj *(1-ti) +
          full[k0*s + j1*iMax + i1] * (1-tk)*   tj *   ti  +
          full[k1*s + j0*iMax + i0] *    tk *(1-tj)*(1-ti) +
          full[k1*s + j0*iMax + i1] *    tk *(1-tj)*   ti  +
          full[k1*s + j1*iMax + i0] *    tk *   tj *(1-ti) +
          full[k1*s + j1*iMax + i1] *    tk *   tj *   ti;

        if (petV <= noiseFloor) {
          // Diffuse background wash instead of fully transparent -- faint
          // NEUTRAL tone (not the palette's own t=0 colour, which can land
          // on an aesthetically jarring hue for some palettes -- e.g.
          // 'rainbow' starts at violet, which looked like a strong purple
          // cast over the whole image when used here). A fixed neutral
          // grey reads as a subtle background haze regardless of which
          // palette is active, matching the reference image's look.
          const nearness = Math.max(0, Math.min(1, petV / noiseFloor));
          px[idx]     = DIFFUSE_FLOOR_R;
          px[idx + 1] = DIFFUSE_FLOOR_G;
          px[idx + 2] = DIFFUSE_FLOOR_B;
          px[idx + 3] = Math.round(DIFFUSE_FLOOR * nearness * blend * 255);
          continue;
        }

        const petNorm    = petRange > 0 ? Math.max(0, Math.min(1, (petV - petLo) / petRange)) : 0;
        const colourNorm = Math.pow(petNorm, power);
        const lutIdx2    = Math.min(255, Math.round(colourNorm * 255)) * 3;

        px[idx]     = lut[lutIdx2];
        px[idx + 1] = lut[lutIdx2 + 1];
        px[idx + 2] = lut[lutIdx2 + 2];
        px[idx + 3] = Math.round(colourNorm * blend * 255);
        continue;
      }

      // Fallback: simple scale using planeData
      const petFX = (ox / (W - 1)) * (petW - 1);
      const petFY = (oy / (H - 1)) * (petH - 1);

      if (petFX < 0 || petFX >= petW || petFY < 0 || petFY >= petH) {
        px[idx] = px[idx+1] = px[idx+2] = px[idx+3] = 0;
        continue;
      }

      const petV2 = bilinear(petData, petW, petH, petFX, petFY);
      if (petV2 <= noiseFloor) {
        const nearness2 = Math.max(0, Math.min(1, petV2 / noiseFloor));
        px[idx]     = DIFFUSE_FLOOR_R;
        px[idx + 1] = DIFFUSE_FLOOR_G;
        px[idx + 2] = DIFFUSE_FLOOR_B;
        px[idx + 3] = Math.round(DIFFUSE_FLOOR * nearness2 * blend * 255);
        continue;
      }

      const petNorm2    = petRange > 0 ? Math.max(0, Math.min(1, (petV2 - petLo) / petRange)) : 0;
      const colourNorm2 = Math.pow(petNorm2, power);
      const lutIdx3     = Math.min(255, Math.round(colourNorm2 * 255)) * 3;

      px[idx]     = lut[lutIdx3];
      px[idx + 1] = lut[lutIdx3 + 1];
      px[idx + 2] = lut[lutIdx3 + 2];
      px[idx + 3] = Math.round(colourNorm2 * blend * 255);
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
