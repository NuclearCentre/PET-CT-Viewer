// App.jsx — PET-CT Viewer
// Stack: React 18 + Vite 8, Cornerstone3D v2.1.16, Orthanc v1.12.10
// StrictMode MUST remain DISABLED in main.jsx

import { useState, useCallback, useRef } from 'react'
import { annotation as csAnnotation } from '@cornerstonejs/tools'
import ViewportGrid, { LAYOUT_DEFS } from './components/ViewportGrid.jsx'
import FusionPanel from './components/FusionPanel.jsx'
import SeriesPanel from './components/SeriesPanel.jsx'
import './App.css'

const STUDY_UID  = '1.3.12.2.1107.5.1.4.60070.30000026012804495395400000013'
const DEF_CT_WL  = { wc: 40,   ww: 400   }
const DEF_PET_WL = { wc: 5000, ww: 10000 }
const DEF_SUV    = { min: 0,   max: 10   }

// ─── Tool definitions (2 rows × 9 cols = 18 tools) ───────────────────────────
const TOOLS = [
  // Row 1
  { id:'pan',        label:'Pan',            icon:'✥',  cs:'PanTool' },
  { id:'zoom',       label:'Zoom',           icon:'⊕',  cs:'ZoomTool' },
  { id:'wl',         label:'W/L',            icon:'◑',  cs:'WindowLevelTool' },
  { id:'scroll',     label:'Scroll',         icon:'⇕',  cs:'StackScrollTool' },
  { id:'line',       label:'Line',           icon:'╱',  cs:'LengthTool' },
  { id:'circle',     label:'Circle ROI',     icon:'○',  cs:'CircleROITool' },
  { id:'rect',       label:'Rect ROI',       icon:'□',  cs:'RectangleROITool' },
  { id:'ellipse',    label:'Ellipse ROI',    icon:'⬭',  cs:'EllipticalROITool' },
  { id:'angle',      label:'Angle',          icon:'∠',  cs:'AngleTool' },
  // Row 2
  { id:'arrow_thin', label:'Thin Arrow',     icon:'→',  cs:'ArrowAnnotateTool' },
  { id:'arrow_thick',label:'Thick Arrow',    icon:'⇒',  cs:'ArrowAnnotateTool' },
  { id:'text',       label:'Text',           icon:'T',  cs:'ArrowAnnotateTool' },
  { id:'probe',      label:'Probe/SUV',      icon:'⊹',  cs:'ProbeTool' },
  { id:'crosshair',  label:'Crosshair',      icon:'⊕',  cs:'ProbeTool' },
  { id:'voi',        label:'Volume (VOI)',   icon:'⬚',  cs:'RectangleROITool' },
  { id:'freehand',   label:'Freehand ROI',   icon:'✏',  cs:'PlanarFreehandROITool' },
  { id:'delete',     label:'Delete annot.',  icon:'🗑', cs:null },
  { id:'clear',      label:'Clear all',      icon:'⊘',  cs:null },
]

// Each layout: icon drawn as small ASCII/Unicode art, label is exact text shown below
const LAYOUT_PRESETS = [
  // id, label shown below icon, mini icon character
  { id:'2x3mip', label:'2×3+MIP', icon:'⊞' },  // 4-square grid
  { id:'1x1',    label:'1×1',     icon:'▣'  },  // single filled square
  { id:'2x2',    label:'2×2',     icon:'⊟'  },  // 2×2 grid
  { id:'3x3',    label:'3×3',     icon:'⊞'  },  // 3×3 (same ⊞ but label differs)
  { id:'1x3mpr', label:'MPR',     icon:'⊠'  },  // split panels
  { id:'1x2',    label:'1×2',     icon:'▭'  },  // wide rectangle = 2 side by side
]

// Mini SVG icons drawn inline for Display Layout — each is a tiny grid diagram
function LayoutIcon({ id, active }) {
  const s = active ? '#336699' : '#666'
  const bg = active ? '#ddeeff' : '#f8f8f8'
  const W = 32, H = 24
  const icons = {
    '2x3mip': ( // 3 CT top + 3 PET bottom + tall MIP column
  <svg width={W} height={H} viewBox="0 0 32 24">
    <rect x="1"  y="1"  width="6" height="10" fill="none" stroke={s} strokeWidth="1.1"/>
    <rect x="8"  y="1"  width="6" height="10" fill="none" stroke={s} strokeWidth="1.1"/>
    <rect x="15" y="1"  width="6" height="10" fill="none" stroke={s} strokeWidth="1.1"/>
    <rect x="23" y="1"  width="8" height="21" fill={active?'#b8d4f0':'#e8e8e8'} stroke={s} strokeWidth="1.1"/>
    <rect x="1"  y="13" width="6" height="10" fill="none" stroke={s} strokeWidth="1.1"/>
    <rect x="8"  y="13" width="6" height="10" fill="none" stroke={s} strokeWidth="1.1"/>
    <rect x="15" y="13" width="6" height="10" fill="none" stroke={s} strokeWidth="1.1"/>
  </svg>
),
    '1x1': (
      <svg width={W} height={H} viewBox="0 0 32 24">
        <rect x="4" y="2" width="24" height="20" fill="none" stroke={s} strokeWidth="1.5"/>
      </svg>
    ),
    '2x2': (
      <svg width={W} height={H} viewBox="0 0 32 24">
        <rect x="1" y="1" width="13" height="10" fill="none" stroke={s} strokeWidth="1.2"/>
        <rect x="16" y="1" width="15" height="10" fill="none" stroke={s} strokeWidth="1.2"/>
        <rect x="1" y="13" width="13" height="10" fill="none" stroke={s} strokeWidth="1.2"/>
        <rect x="16" y="13" width="15" height="10" fill="none" stroke={s} strokeWidth="1.2"/>
      </svg>
    ),
    '3x3': (
      <svg width={W} height={H} viewBox="0 0 32 24">
        {[0,1,2].map(r=>[0,1,2].map(c=>(
          <rect key={`${r}${c}`} x={1+c*10.5} y={1+r*7.5} width={9} height={6} fill="none" stroke={s} strokeWidth="1"/>
        )))}
      </svg>
    ),
    '1x3mpr': (
      <svg width={W} height={H} viewBox="0 0 32 24">
        <rect x="1" y="1" width="9" height="21" fill="none" stroke={s} strokeWidth="1.2"/>
        <rect x="12" y="1" width="9" height="21" fill="none" stroke={s} strokeWidth="1.2"/>
        <rect x="23" y="1" width="8" height="21" fill="none" stroke={s} strokeWidth="1.2"/>
      </svg>
    ),
    '1x2': (
      <svg width={W} height={H} viewBox="0 0 32 24">
        <rect x="1" y="1" width="13" height="21" fill="none" stroke={s} strokeWidth="1.2"/>
        <rect x="16" y="1" width="15" height="21" fill="none" stroke={s} strokeWidth="1.2"/>
      </svg>
    ),
  }
  return icons[id] || <svg width={W} height={H}/>
}

// ─── Shared card style ────────────────────────────────────────────────────────
const cardStyle = (color = '#cccccc') => ({
  border: `1.5px solid ${color}`,
  borderRadius: 5,
  background: '#ffffff',
  marginBottom: 8,
  overflow: 'hidden',
})
const cardHeaderStyle = (color = '#cccccc') => ({
  padding: '6px 10px',
  background: '#1a1a1a',
  borderBottom: `1px solid ${color}`,
  fontSize: 10, fontWeight: 'bold',
  color: '#ffffff', textTransform: 'uppercase', letterSpacing: 1,
  cursor: 'pointer', userSelect: 'none',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
})
const cardBodyStyle = () => ({
  padding: '8px 10px',
  background: '#ffffff',
})

// ─── Collapsible card ─────────────────────────────────────────────────────────
function Card({ title, color = '#bbbbbb', defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={cardStyle(color)}>
      <div style={cardHeaderStyle(color)} onClick={() => setOpen(v => !v)}>
        <span>{title}</span>
        <span style={{ fontSize: 9, color: '#aaa' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && <div style={cardBodyStyle()}>{children}</div>}
    </div>
  )
}

// ─── Print Layout Card ────────────────────────────────────────────────────────
function PrintLayoutCard() {
  const [hover, setHover]     = useState({ r: 0, c: 0 })
  const [selected, setSelected] = useState({ r: 4, c: 4 })
  const [showGrid, setShowGrid] = useState(false)
  const ROWS = 10, COLS = 10

  return (
    <Card title="Print Layout" color="#aaaa77" defaultOpen={false}>
      {/* Print button */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px', marginBottom: 3,
        background: '#f8f8f8', border: '1px solid #ddd', borderRadius: 3,
        fontSize: 10, color: '#222', cursor: 'pointer',
      }}
        onClick={() => window.print()}
        onMouseEnter={e => e.currentTarget.style.background = '#e8f0ff'}
        onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
      >
        <span style={{ fontSize: 18 }}>🖨</span>
        <span style={{ fontSize: 10 }}>Print</span>
      </div>

      {/* Print layout designer — toggles 10×10 grid inline */}
      <div style={{
        padding: '6px 8px', marginBottom: 3,
        background: showGrid ? '#f0f4ff' : '#f8f8f8',
        border: `1px solid ${showGrid ? '#99aacc' : '#ddd'}`, borderRadius: 3,
        cursor: 'pointer',
      }}
        onClick={() => setShowGrid(v => !v)}
        onMouseEnter={e => { if (!showGrid) e.currentTarget.style.background = '#fffff0' }}
        onMouseLeave={e => { if (!showGrid) e.currentTarget.style.background = '#f8f8f8' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 18 }}>📐</span>
          <span style={{ fontSize: 10, color: '#222' }}>Print layout designer</span>
          <span style={{ fontSize: 9, color: '#888', marginLeft: 'auto' }}>
            {selected.c}×{selected.r}
          </span>
          <span style={{ fontSize: 9, color: '#888' }}>{showGrid ? '▲' : '▼'}</span>
        </div>

        {/* Inline 10×10 grid picker */}
        {showGrid && (
          <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 8, color: '#888', marginBottom: 4, textAlign: 'center' }}>
              Hover to select · Click to confirm
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${COLS}, 1fr)`,
              gap: 2, cursor: 'pointer',
            }}>
              {Array.from({ length: ROWS }, (_, r) =>
                Array.from({ length: COLS }, (_, c) => {
                  const active  = r < hover.r && c < hover.c
                  const chosen  = r < selected.r && c < selected.c
                  return (
                    <div key={`${r}-${c}`}
                      style={{
                        width: 12, height: 10, borderRadius: 1,
                        background: active ? '#6699cc' : chosen ? '#b8d0f0' : '#e0e0e0',
                        border: `1px solid ${active ? '#336699' : '#ccc'}`,
                        transition: 'background 0.05s',
                      }}
                      onMouseEnter={() => setHover({ r: r + 1, c: c + 1 })}
                      onMouseLeave={() => setHover({ r: 0, c: 0 })}
                      onClick={() => { setSelected({ r: r + 1, c: c + 1 }); setShowGrid(false) }}
                    />
                  )
                })
              )}
            </div>
            {hover.r > 0 && (
              <div style={{ textAlign: 'center', fontSize: 9, color: '#336699', marginTop: 4, fontWeight: 'bold' }}>
                {hover.c} × {hover.r}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Other print options */}
      {[
        { icon: '📄', label: 'Save as PDF' },
        { icon: '🖼', label: 'Save as PNG' },
        { icon: '📨', label: 'Share / Send' },
      ].map(({ icon, label }) => (
        <div key={label} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 8px', marginBottom: 3,
          background: '#f8f8f8', border: '1px solid #ddd', borderRadius: 3,
          fontSize: 10, color: '#222', cursor: 'pointer',
        }}
          onMouseEnter={e => e.currentTarget.style.background = '#fffff0'}
          onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
        >
          <span style={{ fontSize: 18 }}>{icon}</span>
          <span style={{ fontSize: 10 }}>{label}</span>
        </div>
      ))}
    </Card>
  )
}

// ─── Left Panel — telephone-index tab design ──────────────────────────────────
// Each section has a coloured vertical label strip between the left edge and
// the card content, exactly like the lettered tabs in a telephone index diary.
function LeftPanel({ layout, onLayoutChange, fusionMode, fusionOffset, fusionFixed, onFusionModeChange, onFusionOffsetChange, onFixRequest, onFusionReset }) {
  const [selectedCard, setSelectedCard] = useState('Current Study')
  const [avatarColor,  setAvatarColor]  = useState('#185fa5')

  // Swatch palette — 6 options covering warm, cool, and neutral tones
  const AVATAR_SWATCHES = [
    { color: '#185fa5', label: 'Blue'   },
    { color: '#0f6e56', label: 'Teal'   },
    { color: '#534ab7', label: 'Purple' },
    { color: '#993c1d', label: 'Coral'  },
    { color: '#3b6d11', label: 'Green'  },
    { color: '#885533', label: 'Brown'  },
  ]

  // Derive a lighter tint for the zone background from the selected colour
  const zoneBg = avatarColor + '18'   // 10% alpha overlay

  return (
    <div style={{
      width: 192, minWidth: 192,
      background: '#f0f0f0',
      borderRight: '1.5px solid #cccccc',
      display: 'flex', flexDirection: 'column',
      height: '100%', overflow: 'hidden',
    }}>

      {/* ── Zone 1: User profile with colour picker ── */}
      <div style={{
        flexShrink: 0,
        background: zoneBg,
        borderBottom: `2px solid ${avatarColor}`,
        padding: '7px 10px 5px',
      }}>
        {/* Avatar + name row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%',
            background: avatarColor,
            border: `2px solid ${avatarColor}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, color: '#fff', fontWeight: 'bold', flexShrink: 0,
          }}>DR</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, color: '#111', fontWeight: 'bold' }}>Dr. Radiologist</div>
            <div style={{ fontSize: 8, color: '#444' }}>Nuclear Medicine</div>
          </div>
        </div>
        {/* Colour swatches */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 7, color: '#666', marginRight: 1 }}>Theme</span>
          {AVATAR_SWATCHES.map(sw => (
            <div
              key={sw.color}
              title={sw.label}
              onClick={() => setAvatarColor(sw.color)}
              style={{
                width: 14, height: 14, borderRadius: '50%',
                background: sw.color,
                border: avatarColor === sw.color
                  ? `2px solid #fff`
                  : '2px solid transparent',
                outline: avatarColor === sw.color ? `2px solid ${sw.color}` : 'none',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Zone 2: Tab-card list — scrolls vertically ── */}
      <div style={{
        flex: 1, minHeight: 0,
        overflowY: 'auto', overflowX: 'hidden',
        scrollbarWidth: 'thin', scrollbarColor: '#bbb #f0f0f0',
      }}>

        {/* Current Study */}
        <TabCard label="Current Study" color="#185fa5" maxHeight={260}
          selected={selectedCard === 'Current Study'} onSelect={setSelectedCard}>
          <div style={{ fontSize: 9, color: '#2255aa', fontWeight: 'bold', marginBottom: 2 }}>Alka Jagtap</div>
          <div style={{ fontSize: 8, color: '#444', marginBottom: 1 }}>PET-CT Whole Body</div>
          <div style={{ fontSize: 8, color: '#666', marginBottom: 1 }}>28 Jan 2026 · F · 52y</div>
          <div style={{ fontSize: 8, color: '#888', marginBottom: 5 }}>Tata Memorial Hospital</div>
          <div style={{
            fontSize: 7, color: '#6699cc', padding: '2px 5px', lineHeight: 1.5,
            background: '#eef3ff', border: '1px dashed #aabbd8', borderRadius: 3, marginBottom: 5,
          }}>⇢ Drag <b>CT</b> → CT·Axial &nbsp;·&nbsp; ⇢ Drag <b>PET</b> → PET·Axial</div>
          <SeriesPanel studyUID={STUDY_UID} />
        </TabCard>

        {/* Worklist */}
        <TabCard label="Worklist" color="#378add" maxHeight={150}
          selected={selectedCard === 'Worklist'} onSelect={setSelectedCard}>
          <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
            <div style={{ flex: 1, padding: '3px 5px', background: '#f8f8f8', border: '1px solid #ccc', borderRadius: 3, fontSize: 8, color: '#888' }}>🔍 Search…</div>
            <div style={{ padding: '3px 7px', background: '#f0f4ff', border: '1px solid #99aacc', borderRadius: 3, fontSize: 10, cursor: 'pointer', color: '#336699' }}>⟳</div>
          </div>
          {[
            { name: 'Alka Jagtap',  date: '28 Jan', type: 'PET-CT', active: true },
            { name: 'Suresh Kumar', date: '27 Jan', type: 'CT',     active: false },
            { name: 'Priya Mehta',  date: '26 Jan', type: 'PET-CT', active: false },
          ].map((p, i) => (
            <div key={i} style={{
              padding: '3px 5px', marginBottom: 2, borderRadius: 3, cursor: 'pointer',
              background: p.active ? '#dde8f8' : '#f8f8f8',
              border: `1px solid ${p.active ? '#99aacc' : '#ddd'}`,
            }}>
              <div style={{ fontSize: 8, color: p.active ? '#0c447c' : '#222', fontWeight: p.active ? 'bold' : 'normal' }}>{p.name}</div>
              <div style={{ fontSize: 7, color: p.active ? '#185fa5' : '#888' }}>{p.date} · {p.type}</div>
            </div>
          ))}
        </TabCard>

        {/* Display Layout */}
        <TabCard label="Display Layout" color="#534ab7" maxHeight={190}
          selected={selectedCard === 'Display Layout'} onSelect={setSelectedCard}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 3 }}>
            {LAYOUT_PRESETS.map(p => (
              <div key={p.id} onClick={() => onLayoutChange(p.id)}
                style={{
                  padding: '4px 2px', textAlign: 'center', cursor: 'pointer',
                  background: layout === p.id ? '#ddeeff' : '#f8f8f8',
                  border: `1.5px solid ${layout === p.id ? '#6699cc' : '#ddd'}`,
                  borderRadius: 3, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 2,
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (layout !== p.id) e.currentTarget.style.background = '#eef2ff'; }}
                onMouseLeave={e => { if (layout !== p.id) e.currentTarget.style.background = '#f8f8f8'; }}
              >
                <LayoutIcon id={p.id} active={layout === p.id} />
                <div style={{ fontSize: 7, color: layout === p.id ? '#336699' : '#666', lineHeight: 1 }}>{p.label}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 4, fontSize: 7, color: '#999', lineHeight: 1.4 }}>
            Hover a viewport box → ⚙ to reassign what's shown in it.
          </div>
        </TabCard>

        {/* Save & Export */}
        <TabCard label="Save & Export" color="#0f6e56" maxHeight={150}
          selected={selectedCard === 'Save & Export'} onSelect={setSelectedCard}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            {[
              { icon: '🖼', label: 'Save viewport', sub: 'PNG' },
              { icon: '📁', label: 'Save all',      sub: 'viewports' },
              { icon: '🎬', label: 'Export MIP',    sub: 'video' },
              { icon: '🎞', label: 'Export cine',   sub: 'scroll' },
            ].map(({ icon, label, sub }) => (
              <div key={label} style={{
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                padding: '7px 4px', borderRadius: 5, cursor: 'pointer',
                background: '#f4f7f4', border: '1px solid #c8ddd0',
                gap: 3,
              }}
                onMouseEnter={e => { e.currentTarget.style.background = '#e0f0e8'; e.currentTarget.style.borderColor = '#0f6e56'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#f4f7f4'; e.currentTarget.style.borderColor = '#c8ddd0'; }}
              >
                <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
                <span style={{ fontSize: 8, color: '#1a4a2a', fontWeight: 'bold', textAlign: 'center', lineHeight: 1.2 }}>{label}</span>
                <span style={{ fontSize: 7, color: '#5a8a6a', textAlign: 'center', lineHeight: 1 }}>{sub}</span>
              </div>
            ))}
          </div>
        </TabCard>

        {/* PET Fusion */}
        <TabCard label="PET Fusion" color="#3b6d11" maxHeight={260}
          labelExtra={fusionFixed ? <span style={{ fontSize: 7, color: '#ffcc44' }}>FIXED</span> : null}
          selected={selectedCard === 'PET Fusion'} onSelect={setSelectedCard}>

          {/* Mode selector — icon tiles side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 8 }}>
            {[
              {
                mode: 'auto',
                label: 'Auto Fusion',
                // Two overlapping concentric circles — auto alignment icon
                icon: (
                  <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                    <circle cx="10" cy="14" r="7" stroke="currentColor" strokeWidth="1.8" fill="none" opacity="0.7"/>
                    <circle cx="18" cy="14" r="7" stroke="currentColor" strokeWidth="1.8" fill="none" opacity="0.7"/>
                    <path d="M14 8.5 C16.5 10 16.5 18 14 19.5 C11.5 18 11.5 10 14 8.5Z" fill="currentColor" opacity="0.35"/>
                    {/* small arrows suggesting auto-snap */}
                    <path d="M22 11 L24 13 L22 15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ),
              },
              {
                mode: 'manual',
                label: 'Manual Fusion',
                // Hand/sliders icon — manual control
                icon: (
                  <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                    {/* three horizontal slider lines */}
                    <line x1="5" y1="9"  x2="23" y2="9"  stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.5"/>
                    <line x1="5" y1="14" x2="23" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.5"/>
                    <line x1="5" y1="19" x2="23" y2="19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.5"/>
                    {/* slider thumbs at different positions */}
                    <circle cx="10" cy="9"  r="3" fill="currentColor" opacity="0.9"/>
                    <circle cx="17" cy="14" r="3" fill="currentColor" opacity="0.9"/>
                    <circle cx="13" cy="19" r="3" fill="currentColor" opacity="0.9"/>
                  </svg>
                ),
              },
            ].map(({ mode, label, icon }) => {
              const active = fusionMode === mode
              const col    = active ? '#3b6d11' : '#666'
              return (
                <div
                  key={mode}
                  onMouseDown={e => { e.stopPropagation(); onFusionModeChange(mode); }}
                  style={{
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    padding: '8px 4px', borderRadius: 5, cursor: 'pointer', gap: 4,
                    background: active ? '#e8f5e0' : '#f4f7f4',
                    border: `${active ? '2px' : '1px'} solid ${active ? '#3b6d11' : '#c8ddd0'}`,
                    color: col,
                  }}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.background = '#edf5e8'; e.currentTarget.style.borderColor = '#7aaa55'; }}}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.background = '#f4f7f4'; e.currentTarget.style.borderColor = '#c8ddd0'; }}}
                >
                  <span style={{ color: col, display: 'flex' }}>{icon}</span>
                  <span style={{
                    fontSize: 7, fontWeight: active ? 'bold' : 'normal',
                    color: active ? '#1a4a0a' : '#446644',
                    textAlign: 'center', lineHeight: 1.2,
                  }}>{label}</span>
                </div>
              )
            })}
          </div>

          {/* Sliders + fix/reset from FusionPanel */}
          <FusionPanel
            fusionMode={fusionMode} fusionOffset={fusionOffset} fusionFixed={fusionFixed}
            onModeChange={onFusionModeChange} onOffsetChange={onFusionOffsetChange}
            onFixRequest={onFixRequest} onReset={onFusionReset}
          />
        </TabCard>

        {/* Print */}
        <TabCard label="Print / PDF" color="#993c1d" maxHeight={200}
          selected={selectedCard === 'Print / PDF'} onSelect={setSelectedCard}>

          {/* Primary actions — icon tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginBottom: 8 }}>
            {[
              {
                label: 'Print', sub: 'layout',
                icon: (
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                    <rect x="5" y="8" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <rect x="8" y="4" width="10" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                    <rect x="8" y="15" width="10" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                    <circle cx="19" cy="12" r="1.2" fill="currentColor"/>
                  </svg>
                ),
                onClick: () => window.print(),
              },
              {
                label: 'Layout', sub: 'designer',
                icon: (
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                    <rect x="3" y="3" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <rect x="14" y="3" width="9" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <rect x="14" y="9" width="9" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <rect x="3" y="14" width="20" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                  </svg>
                ),
                onClick: null,
              },
              {
                label: 'Save PDF', sub: 'report',
                icon: (
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                    <rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <path d="M15 3 L21 9 L15 9 Z" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                    <line x1="8" y1="13" x2="18" y2="13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    <line x1="8" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    <text x="7" y="11" fontSize="5" fill="currentColor" fontWeight="bold">PDF</text>
                  </svg>
                ),
                onClick: null,
              },
              {
                label: 'Share', sub: '/ send',
                icon: (
                  <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
                    <circle cx="19" cy="6"  r="3" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <circle cx="7"  cy="13" r="3" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <circle cx="19" cy="20" r="3" stroke="currentColor" strokeWidth="1.8" fill="none"/>
                    <line x1="10" y1="11.5" x2="16" y2="7.5"  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <line x1="10" y1="14.5" x2="16" y2="18.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                ),
                onClick: null,
              },
            ].map(({ label, sub, icon, onClick }) => (
              <div key={label}
                onMouseDown={e => { e.stopPropagation(); onClick?.(); }}
                style={{
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  padding: '7px 4px', borderRadius: 5, cursor: 'pointer', gap: 3,
                  background: '#fdf5f2', border: '1px solid #e0c0b0', color: '#7a2a0a',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f8e8e0'; e.currentTarget.style.borderColor = '#993c1d'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fdf5f2'; e.currentTarget.style.borderColor = '#e0c0b0'; }}
              >
                <span style={{ color: '#993c1d', display: 'flex' }}>{icon}</span>
                <span style={{ fontSize: 8, fontWeight: 'bold', color: '#5a1a08', textAlign: 'center', lineHeight: 1.2 }}>{label}</span>
                <span style={{ fontSize: 7, color: '#aa6655', textAlign: 'center', lineHeight: 1 }}>{sub}</span>
              </div>
            ))}
          </div>
        </TabCard>

        {/* Display */}
        <TabCard label="Display" color="#5f5e5a" maxHeight={120}
          selected={selectedCard === 'Display'} onSelect={setSelectedCard}>
          {[
            { icon: '⚙', label: 'Image settings' },
            { icon: '📋', label: 'Hanging protocol' },
            { icon: '🎨', label: 'UI theme' },
          ].map(({ icon, label }) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 6px', marginBottom: 2, borderRadius: 3,
              background: '#f8f8f8', border: '1px solid #ddd', cursor: 'pointer', fontSize: 9, color: '#222',
            }}
              onMouseEnter={e => e.currentTarget.style.background = '#fff4f0'}
              onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
            ><span style={{ fontSize: 14 }}>{icon}</span>{label}</div>
          ))}
        </TabCard>

      </div>{/* end Zone 2 */}

      {/* ── Zone 3: Quick-access icon bar + sign out — always visible ── */}
      <div style={{ flexShrink: 0, borderTop: '1px solid #ccc', background: '#e8e8e8' }}>
        {/* Horizontal scrollable icon bar */}
        <div style={{
          display: 'flex', gap: 3, padding: '4px 6px',
          overflowX: 'auto', overflowY: 'hidden',
          scrollbarWidth: 'thin', scrollbarColor: '#bbb #e8e8e8',
          borderBottom: '1px solid #d0d0d0',
        }}>
          {[
            { icon: '🖼', tip: 'Save PNG' }, { icon: '🎬', tip: 'Export MIP' },
            { icon: '🖨', tip: 'Print' },    { icon: '📐', tip: 'Layout' },
            { icon: '⚙',  tip: 'Settings' }, { icon: '🔍', tip: 'Search' },
            { icon: '📊', tip: 'Stats' },    { icon: '💾', tip: 'Save' },
          ].map(({ icon, tip }) => (
            <div key={tip} title={tip} style={{
              width: 24, height: 24, flexShrink: 0, borderRadius: 3,
              background: '#e0e0e0', border: '1px solid #ccc',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, cursor: 'pointer',
            }}
              onMouseEnter={e => e.currentTarget.style.background = '#d0d8f0'}
              onMouseLeave={e => e.currentTarget.style.background = '#e0e0e0'}
            >{icon}</div>
          ))}
        </div>
        {/* Sign out */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '7px 10px', fontSize: 11, color: '#222',
          fontWeight: 'bold', cursor: 'pointer',
          borderTop: '1px solid #d8d8d8',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = '#ffeeee'; e.currentTarget.style.color = '#cc0000'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#222'; }}
        >
          <span style={{ fontSize: 15 }}>⎋</span> Sign out
        </div>
      </div>
    </div>
  )
}

// ─── TabCard — telephone-index style card ─────────────────────────────────────
// • No collapse. Content always visible.
// • Click anywhere → onSelect(label) → neon border on that card.
// • Neon uses outline (not border) so it is never clipped by parent overflow.
//   outline renders outside the border-box and is unaffected by ancestor
//   overflow:hidden/auto containers.
// • Scrollbar stays inside: content div has paddingRight so the scrollbar
//   track occupies the padding area, always inside the card frame.
function TabCard({ label, color, children, maxHeight = 200, labelExtra, selected, onSelect }) {
  return (
    <div
      onMouseDown={() => onSelect?.(label)}
      style={{
        display: 'flex',
        border: '1px solid #d0d0d0',
        // outline renders outside the border-box, never clipped by overflow containers
        outline: selected ? `2px solid ${color}` : 'none',
        outlineOffset: '-1px',   // inset 1px so it aligns with the border edge
        background: '#fff',
        position: 'relative',
        zIndex: selected ? 2 : 0,
        cursor: 'default',
        marginBottom: '1px',
      }}
    >
      {/* Vertical label strip — always visible */}
      <div style={{
        width: 20, minWidth: 20, flexShrink: 0,
        background: color,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        borderRight: '1px solid rgba(0,0,0,0.15)',
        paddingTop: 6, paddingBottom: 4,
        cursor: 'pointer',
      }}>
        <span style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          transform: 'rotate(180deg)',
          fontSize: 8, fontWeight: 'bold',
          letterSpacing: 0.9,
          textTransform: 'uppercase',
          color: '#fff',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
          dangerouslySetInnerHTML={{ __html: label }}
        />
        {labelExtra && <div style={{ marginTop: 4 }}>{labelExtra}</div>}
      </div>

      {/* Content — always fully rendered */}
      <div style={{
        flex: 1, minWidth: 0,
        maxHeight,
        overflowY: 'auto',
        overflowX: 'hidden',
        // paddingRight leaves room for the scrollbar so it sits inside the outline.
        // The thin scrollbar is ~8px; 10px padding gives 2px breathing room.
        paddingTop: '7px',
        paddingBottom: '7px',
        paddingLeft: '8px',
        paddingRight: '10px',
        boxSizing: 'border-box',
        scrollbarWidth: 'thin',
        scrollbarColor: `${color}88 #f0f0f0`,
      }}>
        {children}
      </div>
    </div>
  )
}

// ─── Shortcuts Modal ─────────────────────────────────────────────────────────
function ShortcutsModal({ onClose }) {
  const SECTIONS = [
    {
      title: 'Mouse — Navigation',
      color: '#336699',
      items: [
        { keys: 'Left drag',       action: 'Pan image' },
        { keys: 'Right drag',      action: 'Zoom in / out' },
        { keys: 'Mouse wheel',     action: 'Scroll through slices' },
        { keys: 'Middle drag',     action: 'Window / Level' },
        { keys: 'Double-click',    action: 'Expand / collapse viewport' },
      ],
    },
    {
      title: 'Mouse — Annotations',
      color: '#886600',
      items: [
        { keys: '⇧ + Left drag',   action: 'Draw straight line (Length)' },
        { keys: '⇧ + Right drag',  action: 'Draw circle ROI' },
        { keys: 'Ctrl + Left drag',action: 'Move annotation' },
        { keys: 'Click annotation',action: 'Select annotation' },
        { keys: 'Delete key',      action: 'Delete selected annotation' },
      ],
    },
    {
      title: 'Keyboard',
      color: '#446633',
      items: [
        { keys: 'Delete / Backspace', action: 'Delete selected annotation' },
        { keys: 'Esc',                action: 'Deselect / cancel tool' },
        { keys: 'Ctrl + Z',           action: 'Undo (planned Phase 5)' },
        { keys: 'Ctrl + A',           action: 'Select all annotations' },
        { keys: 'Space',              action: 'Toggle cine play/pause' },
      ],
    },
    {
      title: 'Window / Level Presets',
      color: '#664466',
      items: [
        { keys: 'CT presets',      action: 'Brain · Subdural · Lungs · Mediastinum · Liver · Abdomen · Bone · Sinuses' },
        { keys: 'PET presets',     action: 'Standard · High uptake · Low uptake' },
        { keys: 'Strip drag',      action: 'Drag colormap strip (right edge of viewport) to adjust W/L' },
      ],
    },
    {
      title: 'Sync',
      color: '#006699',
      items: [
        { keys: '⇕ Scroll sync',   action: 'All 6 viewports scroll to same slice (ON by default)' },
        { keys: '⊕ Zoom sync',     action: 'All 6 viewports zoom together' },
        { keys: '✥ Pan sync',      action: 'All 6 viewports pan together' },
        { keys: 'MIP',             action: 'Always independent — never synced' },
      ],
    },
  ]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#ffffff', borderRadius: 6,
        border: '2px solid #336699',
        boxShadow: '0 8px 40px rgba(0,0,0,.4)',
        width: 620, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          background: '#1a1a1a', color: '#fff',
          padding: '10px 16px', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 13, fontWeight: 'bold', letterSpacing: 1 }}>⌨ Keyboard & Mouse Shortcuts</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#aaa',
            fontSize: 18, cursor: 'pointer', lineHeight: 1,
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '12px 16px', flex: 1 }}>
          {SECTIONS.map(sec => (
            <div key={sec.title} style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 'bold', color: sec.color,
                borderBottom: `2px solid ${sec.color}`,
                paddingBottom: 3, marginBottom: 6,
                textTransform: 'uppercase', letterSpacing: 1,
              }}>{sec.title}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                <tbody>
                  {sec.items.map(item => (
                    <tr key={item.keys}
                      style={{ borderBottom: '1px solid #f0f0f0' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f5f8ff'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ padding: '4px 8px', minWidth: 160 }}>
                        <code style={{
                          background: '#f0f0f0', border: '1px solid #ddd',
                          borderRadius: 3, padding: '1px 6px',
                          fontSize: 10, color: '#333', whiteSpace: 'nowrap',
                        }}>{item.keys}</code>
                      </td>
                      <td style={{ padding: '4px 8px', color: '#444' }}>{item.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid #ddd', padding: '8px 16px',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button onClick={onClose} style={{
            padding: '5px 18px', background: '#1a1a1a', color: '#fff',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10,
          }}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ─── Ribbon ───────────────────────────────────────────────────────────────────
function RibbonCard({ label, children, color = '#444444' }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      margin: '3px', border: `1.5px solid ${color}`,
      borderRadius: 4, background: '#ffffff',
      minWidth: 'fit-content', flexShrink: 0,
    }}>
      {/* Black header — full width, white text */}
      <div style={{
        background: '#1a1a1a', color: '#ffffff',
        fontSize: 9, fontWeight: 'bold',
        textTransform: 'uppercase', letterSpacing: 1,
        padding: '3px 8px', textAlign: 'center',
        borderBottom: `1px solid ${color}`,
        flexShrink: 0, whiteSpace: 'nowrap',
      }}>{label}</div>
      {/* Content */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '5px 8px' }}>
        {children}
      </div>
    </div>
  )
}

function RibbonBtn({ label, onClick }) {
  return (
    <div onClick={onClick} style={{
      padding: '3px 8px', fontSize: 8, color: '#333',
      background: '#f5f5f5', border: '1px solid #ccc',
      borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: 2,
    }}
      onMouseEnter={e => e.currentTarget.style.background = '#e8e8ff'}
      onMouseLeave={e => e.currentTarget.style.background = '#f5f5f5'}
    >{label}</div>
  )
}

function Ribbon({
  activeTool, onToolChange, sync, onSync,
  ctWL, setCTWL, petWL, setPETWL, suv, setSUV,
  petOpacity, setPetOpacity, onResetAll, onClearROI, onShortcuts,
}) {
  return (
    <div style={{
      background: '#f0f0f0', borderBottom: '1.5px solid #cccccc',
      display: 'flex', alignItems: 'stretch', width: '100%',
      minHeight: 100, flexShrink: 0, overflowX: 'auto', overflowY: 'visible',
      padding: '2px 4px', boxSizing: 'border-box',
    }}>
      {/* Tools card — 9 cols × 2 rows */}
      <RibbonCard label="Tools" color="#6699bb">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9,1fr)', gap: 3 }}>
          {TOOLS.map(t => (
            <button key={t.id} title={t.label}
              onClick={() => onToolChange(activeTool === t.id ? null : t.id)}
              style={{
                width: 30, height: 28, border: `1px solid ${activeTool === t.id ? '#6699bb' : '#ddd'}`,
                borderRadius: 3, cursor: 'pointer', fontSize: 18,
                background: activeTool === t.id ? '#ddeeff' : '#f8f8f8',
                color: activeTool === t.id ? '#336699' : '#333',
                fontWeight: activeTool === t.id ? 'bold' : 'normal',
              }}
              onMouseEnter={e => { if (activeTool !== t.id) e.currentTarget.style.background = '#eef2ff' }}
              onMouseLeave={e => { if (activeTool !== t.id) e.currentTarget.style.background = '#f8f8f8' }}
            >{t.icon}</button>
          ))}
        </div>
      </RibbonCard>

      {/* W/L & SUV card */}
      <RibbonCard label="W / L · SUV" color="#77aa66">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 230 }}>
          {[
            { label:'CT',  color:'#2255aa', wl:ctWL,  setWL:setCTWL,  min:-1000,max:2000, wwMax:4000 },
            { label:'PET', color:'#226622', wl:petWL, setWL:setPETWL, min:0,    max:15000,wwMax:30000 },
            { label:'SUV', color:'#886600', isSuv:true },
          ].map(r => (
            <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 8, color: r.color, minWidth: 22, fontWeight:'bold' }}>{r.label}</span>
              {r.isSuv ? <>
                <span style={{ fontSize: 7, color: '#888', minWidth: 16 }}>min</span>
                <input type="range" min={0} max={20} step={0.1} value={suv.min}
                  onChange={e => setSUV(p => ({ ...p, min: +e.target.value }))}
                  style={{ width: 60, accentColor: '#cc9900' }} />
                <span style={{ fontSize: 8, color: '#886600', minWidth: 26 }}>{suv.min.toFixed(1)}</span>
                <span style={{ fontSize: 7, color: '#888', minWidth: 16 }}>max</span>
                <input type="range" min={0} max={30} step={0.5} value={suv.max}
                  onChange={e => setSUV(p => ({ ...p, max: +e.target.value }))}
                  style={{ width: 60, accentColor: '#cc9900' }} />
                <span style={{ fontSize: 8, color: '#886600', minWidth: 26 }}>{suv.max.toFixed(1)}</span>
              </> : <>
                <span style={{ fontSize: 7, color: '#888', minWidth: 18 }}>WW</span>
                <input type="range" min={1} max={r.wwMax} value={r.wl.ww}
                  onChange={e => r.setWL(p => ({ ...p, ww: +e.target.value }))}
                  style={{ width: 60, accentColor: r.color }} />
                <span style={{ fontSize: 8, color: r.color, minWidth: 32 }}>{r.wl.ww}</span>
                <span style={{ fontSize: 7, color: '#888', minWidth: 16 }}>WC</span>
                <input type="range" min={r.min} max={r.max} value={r.wl.wc}
                  onChange={e => r.setWL(p => ({ ...p, wc: +e.target.value }))}
                  style={{ width: 60, accentColor: r.color }} />
                <span style={{ fontSize: 8, color: r.color, minWidth: 32 }}>{r.wl.wc}</span>
              </>}
            </div>
          ))}
        </div>
      </RibbonCard>

      {/* View card */}
      <RibbonCard label="View" color="#5588aa">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {/* Sync icons only */}
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { id:'scroll', icon:'⇕', title:'Sync Scroll',  color:'#006699' },
              { id:'zoom',   icon:'⊕', title:'Sync Zoom',    color:'#336699' },
              { id:'pan',    icon:'✥', title:'Sync Pan',     color:'#226633' },
            ].map(s => (
              <button key={s.id} title={s.title} onClick={() => onSync(s.id, !sync[s.id])}
                style={{
                  width: 30, height: 28, fontSize: 16, cursor: 'pointer', borderRadius: 3,
                  border: `1px solid ${sync[s.id] ? s.color : '#ccc'}`,
                  background: sync[s.id] ? '#ddeeff' : '#f8f8f8',
                  color: sync[s.id] ? s.color : '#888',
                }}>{s.icon}</button>
            ))}
          </div>
          {/* Blend slider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 9, color: '#226633' }}>Blend</span>
            <input type="range" min={0} max={1} step={0.05} value={petOpacity}
              onChange={e => setPetOpacity(+e.target.value)}
              style={{ width: 60, accentColor: '#226633' }} />
            <span style={{ fontSize: 9, color: '#226633', minWidth: 26 }}>{Math.round(petOpacity * 100)}%</span>
          </div>
          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 4 }}>
            <RibbonBtn label="Reset" onClick={onResetAll} />
            <RibbonBtn label="Clear ROI" onClick={onClearROI} />
          </div>
        </div>
      </RibbonCard>

      {/* Cine card */}
      <RibbonCard label="Cine" color="#aa8855">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 8, color: '#664422', lineHeight: 1.5 }}>
            Slice fps &amp; MIP rpm<br/>
            <span style={{ color: '#888' }}>controlled per-viewport<br/>via cine bar below each image</span>
          </div>
        </div>
      </RibbonCard>

      {/* System card */}
      <RibbonCard label="System" color="#8866aa">
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { icon: '⌨', title: 'Keyboard Shortcuts', onClick: onShortcuts },
            { icon: '⚙', title: 'Settings',           onClick: null },
            { icon: '❓', title: 'Help',               onClick: null },
          ].map(({ icon, title, onClick }) => (
            <button key={title} title={title} onClick={onClick}
              style={{
                width: 38, height: 38, fontSize: 22, cursor: 'pointer',
                borderRadius: 4, border: '1px solid #ddd',
                background: '#f8f8f8', color: '#444',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#eef0ff'}
              onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
            >{icon}</button>
          ))}
        </div>
      </RibbonCard>
    </div>
  )
}

// ─── Patient Banner ───────────────────────────────────────────────────────────
function PatientBanner() {
  return (
    <div style={{
      background: '#f8f8f8', borderBottom: '1.5px solid #cccccc',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', gap: 20 }}>
        <span style={{ fontSize: 9, color: '#2255aa', fontWeight: 'bold', minWidth: 110 }}>ALKA JAGTAP</span>
        <span style={{ fontSize: 9, color: '#555' }}>F · 52 yrs</span>
        <span style={{ fontSize: 9, color: '#555' }}>PET-CT Whole Body</span>
        <span style={{ fontSize: 9, color: '#555' }}>28 Jan 2026</span>
        <span style={{ fontSize: 9, color: '#777' }}>Scan ID: PT-2026-00142</span>
        <span style={{ marginLeft: 'auto', fontSize: 9, color: '#888', fontStyle: 'italic' }}>
          Tata Memorial Hospital · Mumbai
        </span>
      </div>
    </div>
  )
}

// ─── Right Panel ──────────────────────────────────────────────────────────────
// Same telephone-index tab design as the left panel.
// When collapsed: only the coloured tab strips are visible (20px wide each),
// giving a visual cue of what's inside without taking space.
function RightPanel({ collapsed, onToggle }) {
  const [avatarColor,  setAvatarColor]  = useState('#0f6e56')
  const [selectedCard, setSelectedCard] = useState('Report')

  const AVATAR_SWATCHES = [
    { color: '#185fa5', label: 'Blue'   },
    { color: '#0f6e56', label: 'Teal'   },
    { color: '#534ab7', label: 'Purple' },
    { color: '#993c1d', label: 'Coral'  },
    { color: '#3b6d11', label: 'Green'  },
    { color: '#885533', label: 'Brown'  },
  ]

  return (
    <div style={{
      width: collapsed ? 22 : 200,
      minWidth: collapsed ? 22 : 200,
      background: '#f0f0f0',
      borderLeft: '1.5px solid #cccccc',
      display: 'flex', flexDirection: 'column',
      transition: 'width 0.15s ease',
      overflow: 'hidden', position: 'relative',
    }}>
      {/* Collapse/expand toggle — always visible at top */}
      <div style={{
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '5px 0',
        borderBottom: '1px solid #d0d0d0',
        background: '#e8e8e8',
        cursor: 'pointer',
      }} onClick={onToggle} title={collapsed ? 'Expand panel' : 'Collapse panel'}>
        <span style={{ fontSize: 11, color: '#555' }}>{collapsed ? '◀' : '▶'}</span>
      </div>

      {collapsed ? (
        /* Collapsed state: show tab strips only, stacked vertically */
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {[
            { label: 'Report',   color: '#185fa5' },
            { label: 'SUV',      color: '#3b6d11' },
            { label: 'History',  color: '#534ab7' },
            { label: 'Actions',  color: '#993c1d' },
          ].map(t => (
            <div key={t.label} onClick={onToggle} title={`Expand to see ${t.label}`}
              style={{
                height: 70, background: t.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderBottom: '1px solid rgba(0,0,0,0.15)', cursor: 'pointer',
              }}>
              <span style={{
                writingMode: 'vertical-rl', transform: 'rotate(180deg)',
                fontSize: 8, fontWeight: 'bold', letterSpacing: 0.9,
                textTransform: 'uppercase', color: '#fff', whiteSpace: 'nowrap',
                userSelect: 'none',
              }}>{t.label}</span>
            </div>
          ))}
        </div>
      ) : (
        /* Expanded state: full tab-card layout */
        <div style={{
          flex: 1, minHeight: 0,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* Doctor info strip — mirrors left panel */}
          <div style={{
            flexShrink: 0,
            background: avatarColor + '18',
            borderBottom: `2px solid ${avatarColor}`,
            padding: '6px 9px 5px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
              <div style={{
                width: 26, height: 26, borderRadius: '50%',
                background: avatarColor,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, color: '#fff', fontWeight: 'bold', flexShrink: 0,
              }}>DR</div>
              <div>
                <div style={{ fontSize: 9, color: '#111', fontWeight: 'bold' }}>Dr. Radiologist</div>
                <div style={{ fontSize: 8, color: '#444' }}>Reporting panel</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 7, color: '#666', marginRight: 1 }}>Theme</span>
              {AVATAR_SWATCHES.map(sw => (
                <div key={sw.color} title={sw.label} onClick={() => setAvatarColor(sw.color)}
                  style={{
                    width: 13, height: 13, borderRadius: '50%',
                    background: sw.color, cursor: 'pointer', flexShrink: 0,
                    border: avatarColor === sw.color ? '2px solid #fff' : '2px solid transparent',
                    outline: avatarColor === sw.color ? `2px solid ${sw.color}` : 'none',
                  }} />
              ))}
            </div>
          </div>

          {/* Scrollable tab-card area */}
          <div style={{
            flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
            scrollbarWidth: 'thin', scrollbarColor: '#bbb #f0f0f0',
          }}>

            {/* Structured Report */}
            <TabCard label="Report" color="#185fa5" maxHeight={320}
              selected={selectedCard === 'Report'} onSelect={setSelectedCard}>
              {['Clinical history', 'Technique', 'Findings', 'Impression', 'Recommendation'].map(s => (
                <div key={s} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 8, color: '#444', marginBottom: 2, fontWeight: 'bold' }}>{s}</div>
                  <textarea rows={s === 'Findings' ? 4 : 2}
                    placeholder={`Enter ${s.toLowerCase()}…`}
                    style={{
                      width: '100%', background: '#fafafa',
                      border: '1px solid #ccc', borderRadius: 3,
                      color: '#222', fontSize: 8, padding: '3px 5px',
                      resize: 'vertical', fontFamily: 'monospace',
                      boxSizing: 'border-box',
                    }} />
                </div>
              ))}
            </TabCard>

            {/* SUV Measurements */}
            <TabCard label="SUV" color="#3b6d11" maxHeight={180}
              selected={selectedCard === 'SUV'} onSelect={setSelectedCard}>
              <div style={{ fontSize: 8, color: '#888', fontStyle: 'italic', marginBottom: 8 }}>
                No ROIs placed yet
              </div>
              <div style={{ fontSize: 7, color: '#666', lineHeight: 1.6 }}>
                Draw a Circle ROI or Ellipse ROI on any PET-CT viewport to compute SUV max, mean, and peak automatically.
              </div>
            </TabCard>

            {/* Clinical History */}
            <TabCard label="History" color="#534ab7" maxHeight={140}
              selected={selectedCard === 'History'} onSelect={setSelectedCard}>
              {['Diagnosis', 'Prior studies', 'Medications'].map(f => (
                <div key={f} style={{ marginBottom: 5 }}>
                  <div style={{ fontSize: 8, color: '#444', fontWeight: 'bold', marginBottom: 2 }}>{f}</div>
                  <textarea rows={2} placeholder={`${f}…`} style={{
                    width: '100%', background: '#fafafa', border: '1px solid #ccc',
                    borderRadius: 3, color: '#222', fontSize: 8, padding: '3px 5px',
                    resize: 'vertical', fontFamily: 'monospace', boxSizing: 'border-box',
                  }} />
                </div>
              ))}
            </TabCard>

            {/* Actions */}
            <TabCard label="Actions" color="#993c1d" maxHeight={140}
              selected={selectedCard === 'Actions'} onSelect={setSelectedCard}>
              {[
                { icon: '↗', label: 'Open full report editor' },
                { icon: '📤', label: 'Send to referring physician' },
                { icon: '📄', label: 'Generate PDF report' },
                { icon: '💾', label: 'Save draft' },
              ].map(({ icon, label }) => (
                <div key={label} style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '4px 6px', marginBottom: 2, borderRadius: 3,
                  background: '#f8f8f8', border: '1px solid #ddd',
                  cursor: 'pointer', fontSize: 9, color: '#222',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = '#fff0ec'}
                  onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
                ><span style={{ fontSize: 13 }}>{icon}</span>{label}</div>
              ))}
            </TabCard>

          </div>
        </div>
      )}
    </div>
  )
}

// ─── Status Bar ───────────────────────────────────────────────────────────────
function StatusBar({ ctWL, petWL, suv, sync, activeTool }) {
  const tool = TOOLS.find(t => t.id === activeTool)
  return (
    <div style={{
      background: '#f0f0f0', borderTop: '1.5px solid #cccccc',
      padding: '3px 14px', display: 'flex', gap: 14,
      fontSize: 9, color: '#444', flexShrink: 0, alignItems: 'center',
    }}>
      <span style={{ color: '#2255aa', fontWeight: 'bold' }}>CT</span>
      <span>W{ctWL.ww}/L{ctWL.wc}</span>
      <span style={{ color: '#ccc' }}>·</span>
      <span style={{ color: '#226622', fontWeight: 'bold' }}>PET</span>
      <span>W{petWL.ww}/L{petWL.wc}</span>
      <span style={{ color: '#ccc' }}>·</span>
      <span style={{ color: '#886600', fontWeight: 'bold' }}>SUV</span>
      <span>{suv.min.toFixed(1)}–{suv.max.toFixed(1)}</span>
      <span style={{ color: '#ccc' }}>·</span>
      <span style={{ color: sync.scroll ? '#006699' : '#bbb' }}>⇕{sync.scroll ? ' sync' : ''}</span>
      <span style={{ color: sync.zoom ? '#336699' : '#bbb' }}>⊕{sync.zoom ? ' sync' : ''}</span>
      <span style={{ color: sync.pan ? '#226633' : '#bbb' }}>✥{sync.pan ? ' sync' : ''}</span>
      {tool && <>
        <span style={{ color: '#ccc' }}>·</span>
        <span style={{ color: '#222', fontWeight: 'bold' }}>{tool.icon} {tool.label}</span>
      </>}
      <span style={{ marginLeft: 'auto', color: '#aaa' }}>Dbl-click to expand</span>
    </div>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [layout,          setLayout]          = useState('2x3mip')
  const [boxAssignments,  setBoxAssignments]  = useState(null)
  const [ctWL,            setCTWL]            = useState(DEF_CT_WL)
  const [petWL,           setPETWL]           = useState(DEF_PET_WL)
  const [suv,             setSUV]             = useState(DEF_SUV)
  const [petOpacity,      setPetOpacity]      = useState(0.6)
  const [activeTool,      setActiveTool]      = useState(null)
  const [sync,            setSync]            = useState({ scroll: true, zoom: false, pan: false })
  const [expandedId,      setExpandedId]      = useState(null)
  const [rightCollapsed,  setRightCollapsed]  = useState(false)
  // -- Phase 4 -- manual PET-CT fusion state
  const [fusionMode,   setFusionMode]   = useState('auto')
  const [fusionOffset, setFusionOffset] = useState({ tx:0, ty:0, tz:0, rx:0, ry:0, rz:0 })
  const [fusionFixed,  setFusionFixed]  = useState(false)
  const [showFixModal, setShowFixModal] = useState(false)
  const [showShortcuts,   setShowShortcuts]   = useState(false)

  const onSync   = useCallback((key, val) => setSync(p => ({ ...p, [key]: val })), [])

  const handleLayoutChange = useCallback((id) => {
    setLayout(id);
    setBoxAssignments(null);  // reset per-slot overrides when layout changes
  }, [])

  const handleBoxAssign = useCallback((slotIdx, vpKey) => {
    setBoxAssignments(prev => {
      const layoutDef = LAYOUT_DEFS[layout] || LAYOUT_DEFS['2x3mip'];
      const base = prev ? [...prev] : layoutDef.slots.map(s => s.vpKey);
      base[slotIdx] = vpKey;
      return base;
    });
  }, [layout])
  const onFusionReset = useCallback(() => {
    setFusionOffset({ tx:0, ty:0, tz:0, rx:0, ry:0, rz:0 })
    setFusionFixed(false)
    setFusionMode('auto')
  }, [])

  const onConfirmFix = useCallback(() => {
    setFusionFixed(true)
    setShowFixModal(false)
  }, [])
  const resetAll = useCallback(() => { setCTWL(DEF_CT_WL); setPETWL(DEF_PET_WL); setSUV(DEF_SUV) }, [])
  const clearROI = useCallback(() => {
    try {
      const all = csAnnotation.state.getAllAnnotations() || []
      all.forEach(ann => {
        try { csAnnotation.state.removeAnnotation(ann.annotationUID) } catch(e) {}
      })
    } catch(e) {}
  }, [])

  return (
    <div style={{
      background: '#e8e8e8', height: '100vh',
      display: 'flex', flexDirection: 'row',
      fontFamily: 'system-ui, sans-serif', color: '#222',
      overflow: 'hidden',
    }}>
      {/* Shortcuts modal */}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}

      {/* Fix fusion confirmation modal */}
      {showFixModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.65)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1e1e1e', border: '0.5px solid #555', borderRadius: 10,
            padding: '22px 24px', width: 340, boxShadow: '0 8px 40px rgba(0,0,0,0.9)',
          }}>
            <div style={{
              width: 38, height: 38, borderRadius: '50%',
              background: '#3a2a10', border: '1px solid #aa7a20',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, marginBottom: 14, color: '#ffcc66',
            }}>&#9888;</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: '#eee', marginBottom: 8 }}>
              Fix custom fusion position?
            </div>
            <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.7, marginBottom: 18 }}>
              The PET volume has been shifted from its original acquisition alignment.
              <br /><br />
              <span style={{ color: '#ffcc66' }}>This new alignment will be applied</span> to
              all 3 PET-CT planes and all ROIs for the duration of this study session.
              <br /><br />
              The original alignment is automatically restored when the study is closed.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowFixModal(false)}
                style={{
                  padding: '7px 16px', background: 'transparent',
                  border: '0.5px solid #555', borderRadius: 5,
                  color: '#aaa', fontSize: 12, cursor: 'pointer',
                }}
              >Cancel</button>
              <button
                onClick={onConfirmFix}
                style={{
                  padding: '7px 16px', background: '#3a2a10',
                  border: '1px solid #aa7a20', borderRadius: 5,
                  color: '#ffcc66', fontSize: 12, cursor: 'pointer', fontWeight: 500,
                }}
              >&#128274; Fix alignment</button>
            </div>
          </div>
        </div>
      )}

      {/* Left panel — full height from top */}
      <LeftPanel
        layout={layout} onLayoutChange={handleLayoutChange}
        fusionMode={fusionMode}
        fusionOffset={fusionOffset}
        fusionFixed={fusionFixed}
        onFusionModeChange={setFusionMode}
        onFusionOffsetChange={setFusionOffset}
        onFixRequest={() => setShowFixModal(true)}
        onFusionReset={onFusionReset}
      />

      {/* Centre + right — column */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Ribbon — spans centre + right */}
        <Ribbon
          activeTool={activeTool} onToolChange={setActiveTool}
          sync={sync} onSync={onSync}
          ctWL={ctWL} setCTWL={setCTWL}
          petWL={petWL} setPETWL={setPETWL}
          suv={suv} setSUV={setSUV}
          petOpacity={petOpacity} setPetOpacity={setPetOpacity}
          onResetAll={resetAll} onClearROI={clearROI}
          onShortcuts={() => setShowShortcuts(true)}
        />

        {/* Patient banner + viewports + right panel */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

          {/* Centre column */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <PatientBanner />
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <ViewportGrid
                studyUID={STUDY_UID}
                ctWL={ctWL}          petWL={petWL}
                onCTWL={setCTWL}     onPETWL={setPETWL}
                suvThreshold={suv}   onSUV={setSUV}
                petOpacity={petOpacity} onOpacity={setPetOpacity}
                activeToolCT={activeTool}
                activeToolPET={activeTool}
                expandedId={expandedId} onExpand={setExpandedId}
                syncScroll={sync.scroll}
                syncZoom={sync.zoom}
                syncPan={sync.pan}
                fusionMode={fusionMode}
                fusionOffset={fusionOffset}
                fusionFixed={fusionFixed}
                layout={layout}
                boxAssignments={boxAssignments}
                onBoxAssign={handleBoxAssign}
              />
            </div>
            <StatusBar ctWL={ctWL} petWL={petWL} suv={suv} sync={sync} activeTool={activeTool} />
          </div>

          {/* Right panel — full height from ribbon */}
          <RightPanel collapsed={rightCollapsed} onToggle={() => setRightCollapsed(v => !v)} />
        </div>
      </div>
    </div>
  )
}
