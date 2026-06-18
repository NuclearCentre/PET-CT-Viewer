/**
 * SeriesPanel.jsx — Series thumbnail strip for the left panel
 *
 * Fetches all series in the current study from Orthanc via DICOMweb.
 * Renders each series as a draggable thumbnail card:
 *   - Thumbnail: middle-frame JPEG via WADO-URI /orthanc/wado?...&contentType=image/jpeg
 *   - Modality badge, series description, instance count
 *   - Drag sets dataTransfer JSON: { seriesUID, modality, instanceCount, desc, studyUID }
 *
 * Drop rules (enforced by ViewportGrid, communicated via modality):
 *   CT series  → can only be dropped on CT-Axial (top row, col 1)
 *   PT series  → can only be dropped on PET-CT-Axial (bottom row, col 1)
 *   Coronal/Sagittal are always MPR-reconstructed — they never accept drops.
 *
 * The Scout (localizer) series is detected by modality 'CR', 'DX', 'SC', or
 * SeriesDescription containing 'scout'/'loc'/'surview' (case-insensitive).
 * It is shown first with a special "SCOUT" badge, display-only (not draggable
 * into a viewing box, but shown so the user can see it).
 */

import { useState, useEffect } from 'react'

const BASE = '/orthanc/dicom-web'
const WADO = '/orthanc/wado'

// Modality display colours — matches the viewer accent colours
const MODALITY_COLOR = {
  CT:  '#88c4ff',
  PT:  '#88dd88',
  CR:  '#ffdd88',
  DX:  '#ffdd88',
  SC:  '#cccccc',
  NM:  '#cc99ff',
  MR:  '#ff9966',
}
const MODALITY_LABEL = {
  CT: 'CT',
  PT: 'PET',
  CR: 'Scout',
  DX: 'Scout',
  SC: 'Scout',
  NM: 'NM',
  MR: 'MR',
}

function isScout(series) {
  const mod  = series['00080060']?.Value?.[0] || ''
  const desc = (series['0008103E']?.Value?.[0] || '').toLowerCase()
  if (['CR','DX','SC'].includes(mod)) return true
  if (/scout|loc|surview|topogram|overview/.test(desc)) return true
  return false
}

function seriesNumber(series) {
  return parseInt(series['00200011']?.Value?.[0] || '9999', 10)
}

export default function SeriesPanel({ studyUID, onDragStart }) {
  const [series,  setSeries]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [thumbs,  setThumbs]  = useState({})  // seriesUID → object URL or 'error'

  // ── Fetch series list ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!studyUID) return
    setLoading(true)
    setError(null)
    setSeries([])
    setThumbs({})

    async function load() {
      try {
        const res = await fetch(`${BASE}/studies/${studyUID}/series`)
        if (!res.ok) throw new Error(`QIDO-RS ${res.status}`)
        const data = await res.json()

        // Sort: scouts first, then by series number
        const sorted = [...data].sort((a, b) => {
          const aS = isScout(a) ? 0 : 1
          const bS = isScout(b) ? 0 : 1
          if (aS !== bS) return aS - bS
          return seriesNumber(a) - seriesNumber(b)
        })
        setSeries(sorted)

        // Fetch middle-frame thumbnail for each series in parallel
        sorted.forEach(s => fetchThumb(s, studyUID, setThumbs))

      } catch(e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()

    // Cleanup object URLs on unmount / study change
    return () => {
      setThumbs(prev => {
        Object.values(prev).forEach(u => {
          if (u && u !== 'error' && u.startsWith('blob:')) URL.revokeObjectURL(u)
        })
        return {}
      })
    }
  }, [studyUID])

  if (loading) return (
    <div style={{ padding: '8px 6px', fontSize: 9, color: '#888', textAlign: 'center' }}>
      <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span>
      {' '}Loading series…
    </div>
  )

  if (error) return (
    <div style={{ padding: '8px 6px', fontSize: 9, color: '#ff6b6b' }}>
      ⚠ {error}
    </div>
  )

  if (!series.length) return (
    <div style={{ padding: '8px 6px', fontSize: 9, color: '#999' }}>
      No series found.
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {series.map(s => (
        <SeriesCard
          key={_seriesUID(s)}
          series={s}
          studyUID={studyUID}
          thumbUrl={thumbs[_seriesUID(s)]}
          onDragStart={onDragStart}
        />
      ))}
    </div>
  )
}

// ── Single series card ─────────────────────────────────────────────────────────
function SeriesCard({ series, studyUID, thumbUrl, onDragStart }) {
  const [dragging, setDragging] = useState(false)

  const uid      = _seriesUID(series)
  const mod      = series['00080060']?.Value?.[0] || '??'
  const desc     = series['0008103E']?.Value?.[0] || 'No description'
  const count    = series['00201209']?.Value?.[0]
                || series['00201208']?.Value?.[0]
                || '?'
  const scout    = isScout(series)
  const acqDate  = series['00080021']?.Value?.[0] || ''
  const color    = MODALITY_COLOR[mod] || '#aaaaaa'
  const badgeLabel = MODALITY_LABEL[mod] || mod

  // Scouts are shown but not draggable into viewing boxes
  const draggable = !scout && (mod === 'CT' || mod === 'PT')

  const handleDragStart = (e) => {
    if (!draggable) { e.preventDefault(); return }
    setDragging(true)
    const payload = JSON.stringify({ seriesUID: uid, modality: mod, desc, count, studyUID })
    e.dataTransfer.setData('application/petct-series', payload)
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart?.({ seriesUID: uid, modality: mod })
  }

  const handleDragEnd = () => setDragging(false)

  const formattedDate = acqDate.length === 8
    ? `${acqDate.slice(6,8)}/${acqDate.slice(4,6)}/${acqDate.slice(0,4)}`
    : acqDate

  return (
    <div
      draggable={draggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      title={draggable
        ? `Drag to ${mod === 'CT' ? 'CT Axial' : 'PET-CT Axial'} viewport`
        : scout ? 'Scout image — display only' : desc}
      style={{
        display: 'flex',
        gap: 6,
        padding: '4px 5px',
        background: dragging ? '#e8f0ff' : '#f4f6fa',
        border: `1px solid ${dragging ? '#6699cc' : '#dde1e8'}`,
        borderRadius: 4,
        cursor: draggable ? 'grab' : 'default',
        opacity: dragging ? 0.6 : 1,
        transition: 'background 0.1s, border-color 0.1s',
        userSelect: 'none',
        position: 'relative',
      }}
      onMouseEnter={e => {
        if (!dragging) {
          e.currentTarget.style.background = draggable ? '#eef3ff' : '#f0f2f6'
          e.currentTarget.style.borderColor = draggable ? '#aabbd8' : '#cdd1d8'
        }
      }}
      onMouseLeave={e => {
        if (!dragging) {
          e.currentTarget.style.background = '#f4f6fa'
          e.currentTarget.style.borderColor = '#dde1e8'
        }
      }}
    >
      {/* Thumbnail */}
      <div style={{
        width: 42, height: 42, flexShrink: 0,
        background: '#111',
        borderRadius: 3,
        overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${color}44`,
      }}>
        {thumbUrl && thumbUrl !== 'error' ? (
          <img
            src={thumbUrl}
            alt={desc}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            draggable={false}
          />
        ) : thumbUrl === 'error' ? (
          <span style={{ fontSize: 16, opacity: 0.4 }}>🖼</span>
        ) : (
          <span style={{ fontSize: 9, color: '#555', animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, justifyContent: 'center' }}>
        {/* Modality badge + description */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontSize: 7, fontWeight: 'bold',
            padding: '1px 4px', borderRadius: 2,
            background: color + '33', color: color,
            border: `1px solid ${color}66`,
            flexShrink: 0,
            letterSpacing: 0.3,
          }}>{badgeLabel}</span>
          {scout && (
            <span style={{
              fontSize: 7, padding: '1px 4px', borderRadius: 2,
              background: '#ffdd8844', color: '#997700',
              border: '1px solid #ffdd8888', flexShrink: 0,
            }}>SCOUT</span>
          )}
        </div>

        {/* Series description */}
        <div style={{
          fontSize: 8, color: '#222', lineHeight: 1.3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: '100%',
        }} title={desc}>{desc}</div>

        {/* Instance count + date */}
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 7, color: '#888' }}>{count} img</span>
          {formattedDate && (
            <span style={{ fontSize: 7, color: '#aaa' }}>{formattedDate}</span>
          )}
        </div>

        {/* Drag hint */}
        {draggable && (
          <div style={{ fontSize: 7, color: '#6699cc', lineHeight: 1 }}>
            ⇢ drag to {mod === 'CT' ? 'CT·Axial' : 'PET·Axial'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _seriesUID(series) {
  return series['0020000E']?.Value?.[0] || ''
}

async function fetchThumb(series, studyUID, setThumbs) {
  const uid = _seriesUID(series)
  if (!uid) return

  try {
    // Get instance list, pick middle frame
    const res = await fetch(`${BASE}/studies/${studyUID}/series/${uid}/instances`)
    if (!res.ok) throw new Error('instances fetch failed')
    const instances = await res.json()

    // Sort by instance number
    instances.sort((a, b) => {
      const an = parseInt(a['00200013']?.Value?.[0] || '0', 10)
      const bn = parseInt(b['00200013']?.Value?.[0] || '0', 10)
      return an - bn
    })

    const mid = instances[Math.floor(instances.length / 2)]
    if (!mid) throw new Error('no instances')

    const sopUID    = mid['00080018']?.Value?.[0] || ''
    const serUID    = mid['0020000E']?.Value?.[0] || uid
    const studUID   = mid['0020000D']?.Value?.[0] || studyUID

    if (!sopUID) throw new Error('no SOP UID')

    // Fetch JPEG thumbnail via WADO-URI
    const url = `${WADO}?requestType=WADO&studyUID=${studUID}&seriesUID=${serUID}&objectUID=${sopUID}&contentType=image/jpeg&columns=64&rows=64`
    const imgRes = await fetch(url)
    if (!imgRes.ok) throw new Error('wado fetch failed')

    const blob     = await imgRes.blob()
    const objURL   = URL.createObjectURL(blob)
    setThumbs(prev => ({ ...prev, [uid]: objURL }))
  } catch(e) {
    setThumbs(prev => ({ ...prev, [uid]: 'error' }))
  }
}
