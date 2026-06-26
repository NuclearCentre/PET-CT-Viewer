/**
 * canvasFusion.js -- Canvas2D PET-CT fusion renderer
 * Session 14 final -- Full CT grey + PET colour composite on Canvas2D.
 *
 * Data sources (unchanged from Session 8 -- proven working):
 *   CT pixels  : getSlicePixelData(ctVp)   where ctVp  = ct-axial/coronal/sagittal
 *   PET pixels : getSlicePixelData(petVp)  where petVp = pct-axial/coronal/sagittal
 *   Both are full-size ORTHOGRAPHIC VolumeViewports so getSliceViewInfo() returns
 *   the correct volume matrix dimensions (e.g. 512x512 CT, 128x128 PET). Confirmed S8.
 *
 * What changed vs Session 8:
 *   renderFusion() now draws CT as a greyscale BASE directly on the canvas, then
 *   bilinear-resamples PET colour on top. Previously CT was rendered by CS3D's
 *   WebGL into the viewport canvas and only PET was drawn on the overlay (transparent
 *   background). Now the overlay is fully opaque (alpha=255 every pixel) so CS3D's
 *   WebGL render underneath is entirely hidden -- no GPU shader dependency for display.
 *
 * Export surface is IDENTICAL to Session 8. No import changes needed anywhere.
 */

/**
 * Build a 256x3 Uint8Array LUT from getColor(paletteId, t 0-1) => [r,g,b] 0-255.
 * @param {Function} getColorFn
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
 * Nearest-neighbour sample. Used for CT (same or similar resolution to output).
 */
function sampleNN(data, W, H, fx, fy) {
  const x = Math.max(0, Math.min(W - 1, Math.round(fx)));
  const y = Math.max(0, Math.min(H - 1, Math.round(fy)));
  return data[y * W + x];
}

/**
 * Bilinear sample. Used for PET (lower resolution) to avoid blockiness.
 */
function bilinear(data, W, H, fx, fy) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return data[y0 * W + x0] * (1 - tx) * (1 - ty)
       + data[y0 * W + x1] *      tx  * (1 - ty)
       + data[y1 * W + x0] * (1 - tx) *      ty
       + data[y1 * W + x1] *      tx  *      ty;
}

/**
 * Render one PET-CT fusion frame onto a canvas.
 *
 * CT is drawn as greyscale base. PET is bilinear-resampled to the output grid
 * and alpha-composited on top. Output is fully opaque (alpha=255 everywhere).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {TypedArray} ctData    CT slice (raw stored pixel values / HU)
 * @param {number}     ctW       CT slice width  (pixels)
 * @param {number}     ctH       CT slice height (pixels)
 * @param {TypedArray} petData   PET slice (raw scalar values)
 * @param {number}     petW      PET slice width
 * @param {number}     petH      PET slice height
 * @param {Uint8Array} lut       256x3 RGB LUT for PET colour
 * @param {object}     cfg
 *   cfg.ctLow    {number}  CT lower window bound
 *   cfg.ctHigh   {number}  CT upper window bound
 *   cfg.petLow   {number}  PET lower window bound
 *   cfg.petHigh  {number}  PET upper window bound
 *   cfg.alpha    {number}  PET blend 0-1 (slider)
 *   cfg.power    {number}  Adaptive alpha exponent (default 1.5)
 */
export function renderFusion(canvas, ctData, ctW, ctH, petData, petW, petH, lut, cfg) {
  if (!canvas || !ctData || !petData) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Sync canvas logical size to CSS display size (avoids blurry scaling).
  const W = canvas.offsetWidth  || ctW;
  const H = canvas.offsetHeight || ctH;
  if (canvas.width  !== W) canvas.width  = W;
  if (canvas.height !== H) canvas.height = H;
  if (W === 0 || H === 0) return;

  const alpha    = Math.max(0, Math.min(1, cfg.alpha  != null ? cfg.alpha  : 0.6));
  const power    = cfg.power != null ? cfg.power : 1.5;
  const ctLo     = cfg.ctLow;
  const ctHi     = cfg.ctHigh;
  const ctRange  = ctHi - ctLo;
  const petLo    = cfg.petLow;
  const petHi    = cfg.petHigh;
  const petRange = petHi - petLo;

  const ctScaleX  = ctW  / W;
  const ctScaleY  = ctH  / H;
  const petScaleX = petW / W;
  const petScaleY = petH / H;

  const imgData = ctx.createImageData(W, H);
  const px = imgData.data;

  for (let oy = 0; oy < H; oy++) {
    const ctFY  = oy * ctScaleY;
    const petFY = oy * petScaleY;
    for (let ox = 0; ox < W; ox++) {
      const i = (oy * W + ox) * 4;

      // CT greyscale base
      const ctV  = sampleNN(ctData, ctW, ctH, ox * ctScaleX, ctFY);
      const grey = ctRange > 0
        ? Math.max(0, Math.min(255, Math.round(((ctV - ctLo) / ctRange) * 255)))
        : 128;

      // PET colour overlay
      const petV    = bilinear(petData, petW, petH, ox * petScaleX, petFY);
      const petNorm = petRange > 0
        ? Math.max(0, Math.min(1, (petV - petLo) / petRange))
        : 0;

      // Adaptive alpha: background transparent, hot spots opaque
      const petA   = Math.pow(petNorm, power) * alpha;
      const lutIdx = Math.min(255, Math.round(petNorm * 255)) * 3;

      px[i]     = Math.round(lut[lutIdx]     * petA + grey * (1 - petA));
      px[i + 1] = Math.round(lut[lutIdx + 1] * petA + grey * (1 - petA));
      px[i + 2] = Math.round(lut[lutIdx + 2] * petA + grey * (1 - petA));
      px[i + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

/**
 * Get current slice pixel data from a CS3D VolumeViewport.
 * Confirmed S8: axial=512x512 len=262144, coronal=512x165.
 * The viewport MUST be full-size -- a 1x1px viewport returns 1x1 data.
 * @returns {{data: TypedArray, width: number, height: number} | null}
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
  } catch (e) {
    return null;
  }
}
