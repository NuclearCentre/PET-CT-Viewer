// ColormapStrip.jsx — Right-side colormap strip for each viewport
// The palette flyout opens to the LEFT on hover.
// RULE: palette flyout is ONLY accessible via this strip sidebar.
//       Palettes must NEVER appear as a standalone section elsewhere in the UI.
// CT viewports: show only 4 CT palettes (gray, inv_greyscale, golden, rainbow)
// PET-CT viewports: show all 13 palettes, grouped: DICOM PET | DICOM fMRI | Custom

import { useRef, useEffect } from 'react'
import {
  CT_PALETTES,
  PET_PALETTES,
  renderPaletteToCanvas,
} from '../utils/colourPalettes'

const PET_GROUPS = [
  { key:'pet_dicom', label:'DICOM PET' },
  { key:'fmri',      label:'DICOM fMRI' },
  { key:'custom',    label:'Custom' },
]

export default function ColormapStrip({ modality, paletteId, wl, onPaletteChange, onWLChange }) {
  const stripCanvasRef = useRef(null)
  const isDragging     = useRef(false)
  const lastY          = useRef(0)

  // Redraw the strip whenever palette or W/L changes
  useEffect(() => {
    const c = stripCanvasRef.current
    if (!c) return
    c.width  = c.offsetWidth  || 12
    c.height = c.offsetHeight || 60
    renderPaletteToCanvas(c, paletteId, 'vertical')
  }, [paletteId, wl])

  // Drag on strip → adjust W/L (same behaviour as PetCtViewer.jsx Strip component)
  const onMouseDown = (e) => {
    e.preventDefault()
    isDragging.current = true
    lastY.current = e.clientY
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup',   onMouseUp)
  }
  const onMouseMove = (e) => {
    if (!isDragging.current) return
    const dy = e.clientY - lastY.current
    lastY.current = e.clientY
    const newWc = Math.max(-2000, Math.min(4000, wl.wl - dy * 4))
    const newWw = Math.max(1,     Math.min(4000, wl.ww + Math.abs(dy) * 2))
    onWLChange?.(newWw, newWc)
  }
  const onMouseUp = () => {
    isDragging.current = false
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup',   onMouseUp)
  }

  const palettes = modality === 'ct' ? CT_PALETTES : PET_PALETTES

  return (
    <div className="cm-strip" onMouseDown={onMouseDown} style={{ cursor:'ns-resize' }}>
      <canvas
        ref={stripCanvasRef}
        title="Drag to adjust W/L · hover for palette picker"
      />
      <span className="cm-strip-trigger" title="Change colour palette">▲map</span>

      {/* Flyout — opens LEFT, only visible on :hover (CSS) */}
      <div className="cm-flyout">
        {modality === 'ct' ? (
          <>
            <div className="cm-section">CT palettes</div>
            {palettes.map(pal => (
              <PaletteRow
                key={pal.id}
                pal={pal}
                active={pal.id === paletteId}
                modality={modality}
                onSelect={onPaletteChange}
              />
            ))}
          </>
        ) : (
          PET_GROUPS.map(group => {
            const groupPals = palettes.filter(p => p.group === group.key)
            if (!groupPals.length) return null
            return (
              <div key={group.key}>
                <div className="cm-section">{group.label}</div>
                {groupPals.map(pal => (
                  <PaletteRow
                    key={pal.id}
                    pal={pal}
                    active={pal.id === paletteId}
                    modality={modality}
                    onSelect={onPaletteChange}
                  />
                ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Single palette row with swatch canvas ─────────────────────────────────────
function PaletteRow({ pal, active, modality, onSelect }) {
  const ref = useRef(null)

  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = 9; c.height = 26
    renderPaletteToCanvas(c, pal.id, 'vertical')
  }, [pal.id])

  return (
    <div
      className={`cm-pal-row${active ? (modality === 'ct' ? ' active-ct' : ' active') : ''}`}
      onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onSelect(pal.id) }}
    >
      <canvas ref={ref} className="cm-pal-swatch"/>
      <span className="cm-pal-name">{pal.name}</span>
    </div>
  )
}
