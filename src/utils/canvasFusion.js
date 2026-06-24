/**
 * canvasFusion.js — Canvas2D PET-CT fusion overlay renderer
 * Session 8 — confirmed working from live test + actual slice data format.
 *
 * Confirmed from diagnostic logs:
 *   getSlicePixelData returns { data, width, height } where:
 *   - Axial:   512×512, len=262144
 *   - Coronal: 512×165, len=84480
 *   - data is a typed array (Int16/Float32 depending on volume type)
 *
 * Approach: Canvas2D ImageData — no WebGL, no shader compilation,
 * no GPU texture format issues. Works in every browser.
 *
 * The overlay canvas is transparent (no fillRect) until render() is called.
 * CS3D renders CT grey in the viewport underneath. This overlay draws
 * PET colour only — background pixels transparent, hot spots coloured.
 */

/**
 * Build a 256×3 Uint8Array LUT from getColor(paletteId, t).
 * @param {Function} getColorFn  (paletteId, t 0-1) => [r,g,b] 0-255
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

/**
 * Apply DICOM windowing: clamp raw value to [0,255].
 * Inline for performance inside pixel loops.
 */
function win(v, lo, hi) {
  const range = hi - lo;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(255, Math.round(((v - lo) / range) * 255)));
}

/**
 * Render one PET-CT fusion frame onto an overlay canvas.
 *
 * @param {HTMLCanvasElement} canvas   The overlay canvas
 * @param {TypedArray}  ctData         CT slice (Int16 or Float32, raw HU values)
 * @param {number}      ctW            CT slice width
 * @param {number}      ctH            CT slice height
 * @param {TypedArray}  petData        PET slice (Int16 or Float32, raw scalar values)
 * @param {number}      petW           PET slice width
 * @param {number}      petH           PET slice height
 * @param {Uint8Array}  lut            256×3 RGB lookup table
 * @param {object}      cfg
 *   cfg.ctLow    {number}  CT lower display bound (HU)
 *   cfg.ctHigh   {number}  CT upper display bound (HU)
 *   cfg.petLow   {number}  PET lower display bound
 *   cfg.petHigh  {number}  PET upper display bound
 *   cfg.alpha    {number}  Global blend 0-1 (slider value)
 *   cfg.power    {number}  Adaptive power curve exponent (default 1.5)
 */
export function renderFusion(canvas, ctData, ctW, ctH, petData, petW, petH, lut, cfg) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width  = canvas.offsetWidth  || ctW;
  const H = canvas.height = canvas.offsetHeight || ctH;

  const alpha = Math.max(0, Math.min(1, cfg.alpha ?? 0.6));
  const power = cfg.power ?? 1.5;
  const ctLo  = cfg.ctLow;
  const ctHi  = cfg.ctHigh;
  const petLo = cfg.petLow;
  const petHi = cfg.petHigh;

  // Clear canvas to fully transparent — CS3D renders CT grey underneath.
  // We draw PET colour only on top. Background PET pixels stay transparent.
  ctx.clearRect(0, 0, W, H);

  // --- Draw PET colour overlay only ---
  const petOff = new OffscreenCanvas(petW, petH);
  const petCtx = petOff.getContext('2d');
  const petId  = petCtx.createImageData(petW, petH);
  const petPx  = petId.data;
  const petRange = petHi - petLo;

  for (let i = 0; i < petData.length; i++) {
    const norm = petRange > 0
      ? Math.max(0, Math.min(1, (petData[i] - petLo) / petRange))
      : 0;

    const lutIdx = Math.min(255, Math.round(norm * 255)) * 3;
    const p = i * 4;
    petPx[p]   = lut[lutIdx];
    petPx[p+1] = lut[lutIdx + 1];
    petPx[p+2] = lut[lutIdx + 2];

    // Adaptive alpha: pow(norm, power) * alpha
    // Background (norm≈0) stays transparent, hot spots get full alpha
    const a = Math.pow(norm, power) * alpha;
    petPx[p+3] = Math.min(255, Math.round(a * 255));
  }
  petCtx.putImageData(petId, 0, 0);

  // Composite PET on top of CT
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(petOff, 0, 0, W, H);
  ctx.restore();
}

/**
 * Get current slice pixel data from a CS3D VolumeViewport.
 * Confirmed from VolumeViewport.js + VoxelManager.js source:
 *   getSliceViewInfo() → { width, height, slicePlane, sliceIndex, ... }
 *   getCurrentSlicePixelData() → typed array, length = width × height
 * Returns { data, width, height } or null.
 */
export function getSlicePixelData(vp) {
  try {
    const info = vp.getSliceViewInfo();
    const data = vp.getCurrentSlicePixelData();
    if (!data || !data.length) return null;
    const w = Math.round(info.width);
    const h = Math.round(info.height);
    if (w <= 0 || h <= 0) return null;
    return { data, width: w, height: h };
  } catch(e) {
    return null;
  }
}
