/**
 * canvasFusion.js — Canvas2D PET-CT fusion overlay renderer
 * Session 9 — fixed for multi-volume viewport PET-only path.
 *
 * Architecture (confirmed working):
 *   - CS3D renders CT grey via VTK underneath (opacity 0.99)
 *   - PET VTK actor is hidden (opacity 0.001)
 *   - This module draws PET colour ONLY on a transparent Canvas2D overlay
 *   - ctData is NOT needed here — CT grey comes from CS3D, not from us
 *
 * getCurrentSlicePixelData() on a multi-volume VolumeViewport returns the
 * last volume in the setVolumes() array. Since applyFusionVolumes sets
 * [CT_VOLUME_ID, PET_VOLUME_ID], PET is last → PET data comes back.
 * This is confirmed behaviour in CS3D v2.1.16 VolumeViewport.js.
 *
 * Scalar domain:
 *   CS3D applies rescale slope/intercept when building the streaming volume
 *   (cornerstoneStreamingImageVolume loader, preScale: { scalingParameters }).
 *   So getCurrentSlicePixelData() returns PRE-SCALED values:
 *     CT  → Hounsfield Units (HU), typically -1000 to +3000
 *     PET → Bq/mL (or SUV if pre-scaled by loader), typically 0 to 30000
 *
 *   Window values passed in MUST match this domain.
 *   Default petLow=0, petHigh=10000 is correct for Bq/mL.
 *   If PET appears all-white: petHigh is too low (values exceed window).
 *   If PET appears all-black: petHigh is too high (all values < window).
 *
 * To diagnose scalar domain at any time, call logDomainSample(vp) once.
 */

// ─── Scalar domain diagnostic ─────────────────────────────────────────────────

/**
 * One-shot diagnostic — call from browser console or from ViewerBox setup:
 *   import { logDomainSample } from './canvasFusion.js';
 *   logDomainSample(vp);
 * Reports the first 3 values and min/max of first 1000 pixels of PET slice.
 */
export function logDomainSample(vp) {
  try {
    const info = vp.getSliceViewInfo();
    const data = vp.getCurrentSlicePixelData();
    if (!data || !data.length) { console.warn('[canvasFusion] No pixel data returned'); return; }
    const sample = data.slice(0, 1000);
    console.log('[canvasFusion] PET pixel data[0,1,2]:', data[0], data[1], data[2]);
    console.log('[canvasFusion] PET sample min:', Math.min(...sample), '  max:', Math.max(...sample));
    console.log('[canvasFusion] Slice info:', info);
    console.log('[canvasFusion] Data type:', data.constructor.name, '  length:', data.length);
  } catch(e) {
    console.error('[canvasFusion] logDomainSample failed:', e);
  }
}

// ─── LUT builder ──────────────────────────────────────────────────────────────

/**
 * Build a 256×3 Uint8Array LUT from getColor(paletteId, t).
 * @param {Function} getColorFn  (paletteId, t 0–1) => [r, g, b] 0–255
 * @param {string}   paletteId
 */
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

// ─── Core renderer ────────────────────────────────────────────────────────────

/**
 * Render one PET colour frame onto an overlay canvas.
 * CT grey is rendered by CS3D underneath — we do not touch it.
 *
 * @param {HTMLCanvasElement} canvas   The overlay canvas
 * @param {null}              ctData   NOT USED — pass null. CT is from CS3D VTK.
 * @param {number}            ctW      unused
 * @param {number}            ctH      unused
 * @param {TypedArray}        petData  PET slice (pre-scaled: Bq/mL or SUV)
 * @param {number}            petW     PET slice width (pixels)
 * @param {number}            petH     PET slice height (pixels)
 * @param {Uint8Array}        lut      256×3 RGB lookup table from buildLUT()
 * @param {object}            cfg
 *   cfg.petLow   {number}  PET lower display bound (Bq/mL, default 0)
 *   cfg.petHigh  {number}  PET upper display bound (Bq/mL, default 10000)
 *   cfg.alpha    {number}  Global blend 0–1 (slider value, default 0.6)
 *   cfg.power    {number}  Adaptive alpha exponent (default 1.5)
 *                           Higher = more background suppression
 *                           1.0 = linear, 2.0 = aggressive suppression
 */
export function renderFusion(canvas, ctData, ctW, ctH, petData, petW, petH, lut, cfg) {
  if (!canvas || !petData || petW <= 0 || petH <= 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Match canvas pixel dimensions to its CSS display size
  const W = canvas.offsetWidth  || petW;
  const H = canvas.offsetHeight || petH;
  if (canvas.width !== W)  canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;

  const alpha  = Math.max(0, Math.min(1, cfg.alpha ?? 0.6));
  const power  = cfg.power ?? 1.5;
  const petLo  = cfg.petLow  ?? 0;
  const petHi  = cfg.petHigh ?? 10000;
  const range  = petHi - petLo;

  // Clear to fully transparent — CS3D CT grey is visible through this.
  ctx.clearRect(0, 0, W, H);

  if (range <= 0 || alpha <= 0) return;

  // Build PET RGBA image at native slice resolution
  const offscreen = new OffscreenCanvas(petW, petH);
  const offCtx    = offscreen.getContext('2d');
  const imgData   = offCtx.createImageData(petW, petH);
  const px        = imgData.data;  // Uint8ClampedArray, RGBA

  for (let i = 0, n = petData.length; i < n; i++) {
    // Normalise to [0,1], clamp
    const norm = Math.max(0, Math.min(1, (petData[i] - petLo) / range));

    // LUT colour
    const li = Math.min(255, norm * 255 | 0) * 3;  // integer multiply faster than round()
    const p  = i * 4;
    px[p]   = lut[li];
    px[p+1] = lut[li + 1];
    px[p+2] = lut[li + 2];

    // Adaptive alpha: background (norm≈0) stays transparent; hot spots get full alpha.
    // pow(norm, power) * alpha gives smooth ramp with suppressed background.
    px[p+3] = Math.min(255, (Math.pow(norm, power) * alpha * 255) | 0);
  }

  offCtx.putImageData(imgData, 0, 0);

  // Scale PET slice image to fill the canvas display area
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(offscreen, 0, 0, W, H);
  ctx.restore();
}

// ─── Slice data helper ────────────────────────────────────────────────────────

/**
 * Get current slice pixel data from a CS3D VolumeViewport.
 * On multi-volume viewports, returns data for the LAST volume in setVolumes().
 * In our fusion setup [CT, PET]: returns PET data.
 *
 * Returns { data, width, height } or null.
 */
export function getSlicePixelData(vp) {
  try {
    const info = vp.getSliceViewInfo();
    if (!info) return null;
    const data = vp.getCurrentSlicePixelData();
    if (!data || !data.length) return null;
    const w = Math.round(info.width);
    const h = Math.round(info.height);
    if (w <= 0 || h <= 0) return null;
    return { data, width: w, height: h };
  } catch {
    return null;
  }
}
