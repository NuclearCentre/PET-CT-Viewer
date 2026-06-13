/**
 * suvUtils.js — Phase 4
 *
 * Converts CS3D annotation cached-stats (raw scalar mean / max from the PET
 * volume) into SUV values using the patient's DICOM metadata.
 *
 * IMPORTANT — scalar domain:
 *   CS3D's streaming volume pre-applies rescale slope/intercept ONLY for
 *   display (VOI mapping). The values in annotation.data.cachedStats (mean,
 *   max, stdDev) are in the volume's STORED pixel space — i.e. raw integers,
 *   NOT yet Bq/mL. We must apply the rescale here before calling calculateSUV.
 *
 *   Exception: if the PET DICOM was exported with the pixel data already in
 *   Bq/mL (rescale slope = 1, intercept = 0), both paths are equivalent.
 *
 * Used by:
 *   ViewerBox.jsx  → annotation completed/modified event → ROI panel
 *   ViewerBox.jsx  → Probe tool mousemove → pixel SUV tooltip
 */

import { extractDicomMetadata, calculateSUV } from './dicomMetadata.js';

// ─── Module-level cache ───────────────────────────────────────────────────────
// The metadata is the same for every slice in the PET series, so we extract
// it once from imageIds[0] and cache it. Call initSUVMeta() when the PET
// imageIds are first available (e.g. after volumeManager finishes prefetch).

let _meta       = null;   // from extractDicomMetadata(petImageIds[0])
let _scanDate   = null;   // Date object for the acquisition time

/**
 * Initialise the SUV metadata cache from the first PET imageId.
 * Safe to call multiple times — re-extracts only when imageId changes.
 *
 * @param {string} petImageId  e.g. "wadouri:http://localhost:5173/orthanc/wado?..."
 * @param {string} [seriesDate]  YYYYMMDD string from DICOM (0008,0021) / (0008,0020)
 * @param {string} [seriesTime]  HHMMSS string from DICOM (0008,0031)
 */
export function initSUVMeta(petImageId, seriesDate, seriesTime) {
  if (!petImageId) return;
  try {
    _meta = extractDicomMetadata(petImageId);

    // Build scan datetime for decay correction.
    // Prefer the series date/time passed in by the caller (from DICOM tags on the
    // instance already loaded); fall back to today's date which gives an approximate
    // result but at least won't crash.
    if (seriesDate && seriesTime) {
      const ds = String(seriesDate);
      const ts = String(seriesTime);
      // "20260128" + "120500" → new Date(2026, 0, 28, 12, 5, 0)
      const m = (ds + ts).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      _scanDate = m
        ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
        : new Date();
    } else {
      _scanDate = new Date();
    }

    if (_meta) {
      console.log(
        '[suvUtils] SUV meta loaded —',
        `units=${_meta.petUnits}`,
        `weight=${_meta.weightKg}kg`,
        `dose=${_meta.injectedDoseBq ? (_meta.injectedDoseBq / 1e6).toFixed(1) + 'MBq' : 'missing'}`,
        `halfLife=${_meta.halfLifeSec}s`,
        `slope=${_meta.rescaleSlope}`,
        `intercept=${_meta.rescaleIntercept}`,
      );
    }
  } catch (e) {
    console.warn('[suvUtils] initSUVMeta error:', e?.message);
  }
}

/** Returns true if we have enough metadata to compute SUV. */
export function suvAvailable() {
  return !!(
    _meta &&
    (_meta.petUnits || '').toUpperCase() === 'BQML' &&
    _meta.weightKg  > 0 &&
    _meta.injectedDoseBq > 0
  );
}

/**
 * Returns the uncalibrated reason string if SUV cannot be computed,
 * or null if calculation is possible.
 */
export function suvUncalibratedReason() {
  if (!_meta) return 'No PET metadata loaded';
  const units = (_meta.petUnits || '').toUpperCase();
  if (units === 'CNTS') return 'Units = CNTS — scanner calibration factor required';
  if (units !== 'BQML') return `Units = ${units || 'unknown'} — SUV requires BQML`;
  if (!_meta.weightKg || _meta.weightKg <= 0) return 'Patient weight missing';
  if (!_meta.injectedDoseBq || _meta.injectedDoseBq <= 0) return 'Injected dose missing';
  return null;
}

/**
 * Convert a raw stored pixel value → SUV.
 * Applies rescale slope/intercept first (stored → Bq/mL), then SUV formula.
 *
 * @param {number} rawPixel  raw scalar from cachedStats (mean or max)
 * @returns {{ suv: number|null, reason: string|null }}
 */
export function rawPixelToSUV(rawPixel) {
  if (!_meta) return { suv: null, reason: 'SUV meta not initialised' };
  // cachedStats values are in stored-pixel space.  Apply rescale to get Bq/mL,
  // then pass that as the "storedPixel" to calculateSUV which internally does:
  //   ac = storedPixel * slope + intercept
  // Since we've already converted, pass slope=1, intercept=0 by overriding
  // the meta, OR (simpler) just do the full formula manually here.

  const slope     = _meta.rescaleSlope     ?? 1;
  const intercept = _meta.rescaleIntercept ?? 0;
  const ac        = rawPixel * slope + intercept;   // Bq/mL

  return calculateSUV(rawPixel, _meta, _scanDate);  // calculateSUV also applies slope internally
}

/**
 * Convert a raw pixel value to activity concentration in Bq/mL.
 * Useful for the Probe tooltip where you want both Bq/mL and SUV.
 */
export function rawPixelToActivity(rawPixel) {
  if (!_meta) return null;
  const slope     = _meta.rescaleSlope     ?? 1;
  const intercept = _meta.rescaleIntercept ?? 0;
  return rawPixel * slope + intercept;
}

/**
 * Compute the full SUV stats for a CS3D ROI annotation.
 *
 * Reads annotation.data.cachedStats which CS3D populates after the ROI is
 * completed (ANNOTATION_COMPLETED) and on every render thereafter.
 *
 * Returns an object suitable for display in the ROI panel:
 * {
 *   radius: number|null,    mm
 *   area:   number|null,    mm²
 *   mean:   number|null,    raw scalar
 *   max:    number|null,    raw scalar
 *   stdDev: number|null,    raw scalar
 *   suvMean: number|null,   SUVbw
 *   suvMax:  number|null,   SUVbw
 *   uncalibrated: boolean,
 *   uncalibratedReason: string|null,
 * }
 *
 * @param {object} ann  CS3D annotation object
 * @param {boolean} isPET  only compute SUV for PET viewports
 */
export function roiStatsFromAnnotation(ann, isPET = true) {
  const stats = ann?.data?.cachedStats;
  const points = ann?.data?.handles?.points;

  // CS3D stores stats under nested keys like { imageId: { mean, max, ... } }
  // or at the top level. Flatten to get the first (and usually only) entry.
  let raw = null;
  if (stats) {
    // Try top-level first (stack mode)
    if (typeof stats.mean === 'number' || typeof stats.max === 'number') {
      raw = stats;
    } else {
      // Volume mode: stats keyed by volumeId
      const keys = Object.keys(stats);
      for (const k of keys) {
        if (stats[k] && typeof stats[k] === 'object' &&
            (typeof stats[k].mean === 'number' || typeof stats[k].max === 'number')) {
          raw = stats[k];
          break;
        }
      }
    }
  }

  const result = {
    radius:  null,
    area:    null,
    mean:    null,
    max:     null,
    stdDev:  null,
    suvMean: null,
    suvMax:  null,
    uncalibrated:       !isPET || !!suvUncalibratedReason(),
    uncalibratedReason: isPET  ?  suvUncalibratedReason() : null,
  };

  if (raw) {
    result.mean   = _round2(raw.mean   ?? raw.Mean   ?? null);
    result.max    = _round2(raw.max    ?? raw.Max    ?? null);
    result.stdDev = _round2(raw.stdDev ?? raw.StdDev ?? null);
    result.area   = _round2(raw.area   ?? raw.Area   ?? null);  // mm²

    // Radius: for CircleROI, points[0]=center, points[1]=edge.
    if (points?.length >= 2) {
      const [c, e] = points;
      result.radius = _round2(
        Math.sqrt(
          Math.pow(e[0] - c[0], 2) +
          Math.pow(e[1] - c[1], 2) +
          Math.pow((e[2] ?? 0) - (c[2] ?? 0), 2)
        )
      );
    }
  }

  if (isPET && !result.uncalibrated && result.mean !== null && result.max !== null) {
    const mRes = rawPixelToSUV(result.mean);
    const xRes = rawPixelToSUV(result.max);
    result.suvMean = mRes.suv;
    result.suvMax  = xRes.suv;
  }

  return result;
}

function _round2(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}
