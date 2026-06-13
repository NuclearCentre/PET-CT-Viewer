/**
 * dicomMetadata.js
 * DICOM tag extraction + SUV calculation
 *
 * Tags extracted:
 *   Patient:   (0010,0010) name, (0010,0020) MRN, (0010,0030) DOB,
 *              (0010,0040) sex,  (0010,1030) weight kg, (0010,1020) height cm
 *   Study:     (0008,0020) date, (0008,0030) time, (0008,1030) description,
 *              (0008,0050) accession, (0008,0090) ref physician
 *   Equipment: (0008,0080) institution, (0008,0070) manufacturer,
 *              (0008,1090) model, (0008,1010) station
 *   CT:        (0018,0060) kVp, (0018,1152) mAs, (0018,9345) CTDIvol,
 *              (0040,0306) DLP, (0028,0030) pixel spacing, (0050,0018) slice thickness
 *   PET:       (0054,1001) units, (0054,0016) radiopharm seq, (0018,1075) half-life,
 *              (0018,1074) injected dose Bq, (0018,1078) start datetime,
 *              (0028,1053) rescale slope, (0028,1052) rescale intercept
 */

import { metaData } from '@cornerstonejs/core';

/**
 * Extract all metadata for a given imageId.
 * Returns a structured object safe to store in React state.
 */
export function extractDicomMetadata(imageId) {
  if (!imageId) return null;
  try {
    const pt  = metaData.get('patient',          imageId) || {};
    const st  = metaData.get('generalStudy',     imageId) || {};
    const eq  = metaData.get('generalEquipment', imageId) || {};
    const ctA = metaData.get('ctImageStorage',   imageId) || {};
    const img = metaData.get('imagePixelModule', imageId) || {};
    const voi = metaData.get('voiLut',           imageId) || {};
    const ser = metaData.get('generalSeries',    imageId) || {};
    const pet = metaData.get('petIsotopeModule', imageId) || {};
    const dos = metaData.get('petImage',         imageId) || {};

    return {
      // Patient
      patientName:    _str(pt.patientName   || pt.PatientName),
      patientId:      _str(pt.patientId     || pt.PatientID),
      dob:            _str(pt.patientBirthDate || pt.PatientBirthDate),
      sex:            _str(pt.patientSex    || pt.PatientSex),
      weightKg:       _num(pt.patientWeight || pt.PatientWeight),
      heightCm:       _num(pt.patientSize   || pt.PatientSize),
      // Study
      studyDate:      _str(st.studyDate     || st.StudyDate),
      studyTime:      _str(st.studyTime     || st.StudyTime),
      studyDesc:      _str(st.studyDescription || st.StudyDescription),
      accession:      _str(st.accessionNumber  || st.AccessionNumber),
      referringPhysician: _str(st.referringPhysicianName || st.ReferringPhysicianName),
      // Equipment
      institution:    _str(eq.institutionName || eq.InstitutionName),
      manufacturer:   _str(eq.manufacturer   || eq.Manufacturer),
      model:          _str(eq.manufacturerModelName || eq.ManufacturerModelName),
      station:        _str(eq.stationName    || eq.StationName),
      // Modality
      modality:       _str(ser.modality      || ser.Modality),
      // CT acquisition
      kvp:            _num(ctA.kvp || ctA.KVP),
      mas:            _num(ctA.exposureInMas || ctA.ExposureInMas),
      ctdiVol:        _num(ctA.ctdiVol       || ctA.CTDIvol),
      dlp:            _num(ctA.exposureDoseSequence?.[0]?.DLP),
      pixelSpacing:   img.pixelSpacing || img.PixelSpacing || null,
      sliceThickness: _num(img.sliceThickness || img.SliceThickness || ctA.sliceThickness),
      // PET quantification
      petUnits:       _str(dos.units          || pet.Units || 'BQML'),
      halfLifeSec:    _num(pet.radionuclideHalfLife || pet.RadionuclideHalfLife || 6586.2),
      injectedDoseBq: _num(pet.radionuclideTotalDose || pet.RadionuclideTotalDose),
      injectionTime:  _str(pet.radiopharmaceuticalStartDatetime || pet.RadiopharmaceuticalStartDatetime),
      rescaleSlope:   _num(voi.rescaleSlope   || img.rescaleSlope   || 1),
      rescaleIntercept:_num(voi.rescaleIntercept || img.rescaleIntercept || 0),
    };
  } catch(e) {
    console.error('[dicomMetadata] extractDicomMetadata error:', e);
    return null;
  }
}

// ─── SUV calculation ──────────────────────────────────────────────────────────

/**
 * Calculate SUV for a stored pixel value.
 *
 * Formula:
 *   ActivityConcentration = storedPixel × RescaleSlope + RescaleIntercept  [Bq/mL]
 *   decayFactor = 2^(-deltaT / halfLifeSec)
 *   decayCorrectedDose = injectedDoseBq × decayFactor
 *   SUV = ActivityConcentration / (decayCorrectedDose / patientWeightGrams)
 *
 * Only valid when Units = BQML.
 * Returns null with a reason string when calculation is not possible.
 *
 * @param {number} storedPixel
 * @param {object} meta — from extractDicomMetadata()
 * @param {string|Date} scanDatetime — acquisition datetime for decay correction
 * @returns {{ suv: number|null, reason: string|null }}
 */
export function calculateSUV(storedPixel, meta, scanDatetime) {
  if (!meta) return { suv: null, reason: 'No metadata' };

  const units = (meta.petUnits || '').toUpperCase();
  if (units === 'CNTS') {
    return { suv: null, reason: 'Units=CNTS — scanner calibration factor required. Cannot calculate SUV.' };
  }
  if (units !== 'BQML') {
    return { suv: null, reason: `Unknown units: ${units}` };
  }

  const slope     = meta.rescaleSlope     ?? 1;
  const intercept = meta.rescaleIntercept ?? 0;
  const ac        = storedPixel * slope + intercept; // Bq/mL

  const weightKg  = meta.weightKg;
  if (!weightKg || weightKg <= 0) return { suv: null, reason: 'Missing patient weight' };

  const injDose   = meta.injectedDoseBq;
  if (!injDose || injDose <= 0) return { suv: null, reason: 'Missing injected dose' };

  const halfLife  = meta.halfLifeSec || 6586.2; // F-18 default

  // Decay correction
  let deltaT = 0;
  if (meta.injectionTime && scanDatetime) {
    const injT  = _parseDicomDatetime(meta.injectionTime);
    const scanT = scanDatetime instanceof Date ? scanDatetime : new Date(scanDatetime);
    if (injT && scanT) deltaT = Math.max(0, (scanT - injT) / 1000); // seconds
  }

  const decayFactor         = Math.pow(2, -deltaT / halfLife);
  const decayCorrectedDose  = injDose * decayFactor; // Bq
  const weightGrams         = weightKg * 1000;

  if (decayCorrectedDose <= 0) return { suv: null, reason: 'Decay-corrected dose is zero' };

  const suv = ac / (decayCorrectedDose / weightGrams);
  return { suv: Math.round(suv * 100) / 100, reason: null };
}

/**
 * Build the technique paragraph for a structured report.
 */
export function buildTechniqueString(meta) {
  if (!meta) return 'PET-CT scan performed.';
  const parts = [];
  if (meta.petUnits) parts.push(`PET acquisition in ${meta.petUnits} units`);
  if (meta.kvp)       parts.push(`CT: ${meta.kvp} kVp`);
  if (meta.mas)       parts.push(`${meta.mas} mAs`);
  if (meta.ctdiVol)   parts.push(`CTDIvol ${meta.ctdiVol} mGy`);
  if (meta.halfLifeSec && meta.injectedDoseBq) {
    const mCi = (meta.injectedDoseBq / 37e6).toFixed(1);
    parts.push(`Radiopharmaceutical dose ~${mCi} mCi (F-18, T½ ${(meta.halfLifeSec/60).toFixed(0)} min)`);
  }
  if (meta.manufacturer) parts.push(`Scanner: ${meta.manufacturer} ${meta.model || ''}`.trim());
  return parts.join('; ') + '.';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _str(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v.Alphabetic) return v.Alphabetic;
  return String(v).trim();
}
function _num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function _parseDicomDatetime(s) {
  if (!s) return null;
  // DICOM datetime: YYYYMMDDHHMMSS.ffffff or YYYYMMDDHHMMSS
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
}
