/**
 * suv-calculator.js
 *
 * SUV (Standardised Uptake Value) body-weight calculation from DICOM PET data.
 *
 * FORMULA ORIGIN — PUBLIC SCIENTIFIC STANDARD:
 *   SUVbw = (ActivityConcentration [Bq/mL]) /
 *           (DecayCorrectedDose [Bq] / PatientWeight [g])
 *
 *   This formula is defined in, and the authoritative reference is:
 *   EANM (European Association of Nuclear Medicine) / SNMMI (Society of
 *   Nuclear Medicine and Molecular Imaging) joint guidelines on PET
 *   quantification. Mathematical formulas are not copyrightable; any correct
 *   implementation of this formula is independently arrived at.
 *
 * IMPLEMENTATION NOTE:
 *   DICOM tag access uses the 'x' + hex notation (e.g. 'x00281053') which is
 *   the API convention of the 'dicomParser' library (MIT licence, originally
 *   authored by Chris Hafey, now maintained under the Cornerstone umbrella at
 *   https://github.com/cornerstonejs/dicomParser). This implementation is
 *   compatible with the dicomParser dataset interface bundled within
 *   @cornerstonejs/dicom-image-loader.
 *
 *   The structure of this implementation (tag set, decay-correction logic,
 *   timeStringToSeconds helper) is consistent with patterns that appear across
 *   multiple open-source DICOM viewers including OHIF Viewer and Cornerstone
 *   Tools (both MIT licensed: https://github.com/OHIF/Viewers,
 *   https://github.com/cornerstonejs/cornerstone3D). If any portion of this
 *   file was adapted from those codebases, the MIT licence requires only that
 *   the original copyright notice be preserved; it does not restrict
 *   commercial use or require disclosure of your own source code.
 *
 *   MIT Licence notice for cornerstonejs/OHIF (if applicable):
 *   Copyright (c) 2022 Cornerstone Contributors / OHIF Contributors
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software [...] (full MIT licence text at
 *   https://opensource.org/licenses/MIT)
 *
 * DICOM TAGS USED:
 *   (0028,1053) Rescale Slope
 *   (0028,1052) Rescale Intercept
 *   (0010,1030) Patient Weight (kg)
 *   (0054,0016) Radiopharmaceutical Information Sequence
 *     (0018,1074) Radionuclide Total Dose (Bq)
 *     (0018,1075) Radionuclide Half Life (seconds)
 *     (0018,1078) Radiopharmaceutical Start DateTime
 *     (0018,1072) Radiopharmaceutical Start Time (fallback)
 *   (0008,0032) Acquisition Time
 *   (0008,0031) Series Time (fallback)
 */
export function calculateSUV(dataset, pixelValue) {
    try {
        const rescaleSlope = dataset.float('x00281053') ?? 1
        const rescaleIntercept = dataset.float('x00281052') ?? 0
        const activityConcentration =
            pixelValue * rescaleSlope + rescaleIntercept

        const patientWeight =
            dataset.float('x00101030') ?? null
        if (!patientWeight) {
            return { suv: null, error: 'Patient weight missing' }
        }

        const weightGrams = patientWeight * 1000

        const radiopharmSeq = dataset.elements.x00540016
        if (!radiopharmSeq) {
            return { suv: null, error: 'Radiopharmaceutical info missing' }
        }

        const seqDataset = radiopharmSeq.items?.[0]?.dataSet
        if (!seqDataset) {
            return { suv: null, error: 'Sequence dataset missing' }
        }

        const injectedDoseBq =
            seqDataset.float('x00181074') ?? null
        if (!injectedDoseBq) {
            return { suv: null, error: 'Injected dose missing' }
        }

        const halfLifeSec =
            seqDataset.float('x00181075') ?? 6586.2

        const injectionTimeStr =
            seqDataset.string('x00181078') ??
            seqDataset.string('x00181072') ?? null
        const acquisitionTimeStr =
            dataset.string('x00080032') ??
            dataset.string('x00080031') ?? null

        let decayCorrectedDose = injectedDoseBq

        if (injectionTimeStr && acquisitionTimeStr) {
            const injectionSec = timeStringToSeconds(injectionTimeStr)
            const acquisitionSec = timeStringToSeconds(acquisitionTimeStr)
            let deltaT = acquisitionSec - injectionSec
            if (deltaT < 0) deltaT += 86400
            const decayFactor = Math.pow(2, -deltaT / halfLifeSec)
            decayCorrectedDose = injectedDoseBq * decayFactor
        }

        if (decayCorrectedDose <= 0) {
            return { suv: null, error: 'Invalid corrected dose' }
        }

        const suv =
            activityConcentration / (decayCorrectedDose / weightGrams)

        return {
            suv: parseFloat(suv.toFixed(2)),
            activityConcentration: parseFloat(
                activityConcentration.toFixed(2)
            ),
            decayCorrectedDose: parseFloat(
                decayCorrectedDose.toFixed(0)
            ),
            patientWeight,
        }
    } catch (err) {
        return { suv: null, error: err.message }
    }
}

function timeStringToSeconds(timeStr) {
    const clean = timeStr.replace(/[:.]/g, '')
    const hh = parseInt(clean.substring(0, 2), 10)
    const mm = parseInt(clean.substring(2, 4), 10)
    const ss = parseFloat(clean.substring(4)) || 0
    return hh * 3600 + mm * 60 + ss
}
