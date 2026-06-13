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
