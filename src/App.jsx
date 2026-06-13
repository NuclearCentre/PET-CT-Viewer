// App.jsx — PET-CT Viewer
// Stack: React 18 + Vite 8, Cornerstone3D v2.1.16, Orthanc v1.12.10
// StrictMode MUST remain DISABLED in main.jsx

import { useState, useCallback, useRef } from 'react'
import ViewportGrid from './components/ViewportGrid.jsx'
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

// ─── Left Panel ───────────────────────────────────────────────────────────────
function LeftPanel({ layout, onLayoutChange }) {
  return (
    <div style={{
      width: 180, minWidth: 180,
      background: '#f0f0f0',
      borderRight: '1.5px solid #cccccc',
      display: 'flex', flexDirection: 'column',
      height: '100%', overflowY: 'auto',
      padding: '8px 6px',
    }}>
      {/* User profile */}
      <div style={{
        ...cardStyle('#aaaacc'),
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px', marginBottom: 8,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          background: '#dde8f8', border: '1.5px solid #6699cc',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, color: '#336699', fontWeight: 'bold', flexShrink: 0,
        }}>DR</div>
        <div>
          <div style={{ fontSize: 9, color: '#222', fontWeight: 'bold' }}>Dr. Radiologist</div>
          <div style={{ fontSize: 8, color: '#666' }}>Nuclear Medicine</div>
        </div>
      </div>

      {/* Current Study */}
      <Card title="Current Study" color="#6699cc">
        <div style={{ fontSize: 9, color: '#2255aa', fontWeight: 'bold', marginBottom: 3 }}>ALKA JAGTAP</div>
        <div style={{ fontSize: 8, color: '#444', marginBottom: 2 }}>PET-CT Whole Body</div>
        <div style={{ fontSize: 8, color: '#666', marginBottom: 2 }}>28 Jan 2026</div>
        <div style={{ fontSize: 8, color: '#666' }}>165 CT · 33 PT images</div>
      </Card>

      {/* Worklist */}
      <Card title="Worklist" color="#7799bb" defaultOpen={true}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <div style={{ flex: 1, padding: '4px 6px', background: '#f8f8f8', border: '1px solid #ccc', borderRadius: 3, fontSize: 8, color: '#888' }}>
            🔍 Search...
          </div>
          <button style={{ padding: '4px 7px', background: '#f0f4ff', border: '1px solid #99aacc', borderRadius: 3, fontSize: 10, cursor: 'pointer', color: '#336' }} title="Refresh worklist">⟳</button>
        </div>
        {[
          { name: 'ALKA JAGTAP',     date: '28 Jan 26', type: 'PET-CT' },
          { name: 'SURESH KUMAR',    date: '27 Jan 26', type: 'CT' },
          { name: 'PRIYA MEHTA',     date: '26 Jan 26', type: 'PET-CT' },
        ].map((p, i) => (
          <div key={i} style={{
            padding: '4px 6px', marginBottom: 2,
            background: i === 0 ? '#dde8f8' : '#f8f8f8',
            border: `1px solid ${i === 0 ? '#99aacc' : '#ddd'}`,
            borderRadius: 3, cursor: 'pointer',
          }}>
            <div style={{ fontSize: 8, color: '#222', fontWeight: i === 0 ? 'bold' : 'normal' }}>{p.name}</div>
            <div style={{ fontSize: 7, color: '#888' }}>{p.date} · {p.type}</div>
          </div>
        ))}
      </Card>

      {/* Display Layout */}
      <Card title="Display Layout" color="#9988bb">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
          {LAYOUT_PRESETS.map(p => (
            <div key={p.id} onClick={() => onLayoutChange(p.id)}
              style={{
                padding: '4px 2px', textAlign: 'center', cursor: 'pointer',
                background: layout === p.id ? '#ddeeff' : '#f8f8f8',
                border: `1.5px solid ${layout === p.id ? '#6699cc' : '#ddd'}`,
                borderRadius: 3, display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 2,
              }}
              onMouseEnter={e => { if (layout !== p.id) e.currentTarget.style.background = '#eef2ff' }}
              onMouseLeave={e => { if (layout !== p.id) e.currentTarget.style.background = '#f8f8f8' }}
            >
              <LayoutIcon id={p.id} active={layout === p.id} />
              <div style={{ fontSize: 7, color: layout === p.id ? '#336699' : '#666', lineHeight: 1 }}>{p.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Save & Export */}
      <Card title="Save & Export" color="#77aa88" defaultOpen={false}>
        {[
          { icon: '🖼', label: 'Save viewport (PNG)' },
          { icon: '📁', label: 'Save all viewports' },
          { icon: '🎬', label: 'Export MIP video' },
          { icon: '🎞', label: 'Export cine scroll' },
        ].map(({ icon, label }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 8px', marginBottom: 3,
            background: '#f8f8f8', border: '1px solid #ddd', borderRadius: 3,
            fontSize: 10, color: '#222', cursor: 'pointer',
          }}
            onMouseEnter={e => e.currentTarget.style.background = '#eef8ee'}
            onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
          ><span style={{ fontSize: 18 }}>{icon}</span><span style={{ fontSize: 10 }}>{label}</span></div>
        ))}
      </Card>

      {/* Print Layout */}
      <PrintLayoutCard />

      {/* Display */}
      <Card title="Display" color="#aa8877" defaultOpen={false}>
        {[
          { icon: '⚙', label: 'Image settings' },
          { icon: '📋', label: 'Hanging protocol' },
          { icon: '🎨', label: 'UI theme' },
        ].map(({ icon, label }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 8px', marginBottom: 3,
            background: '#f8f8f8', border: '1px solid #ddd', borderRadius: 3,
            fontSize: 10, color: '#222', cursor: 'pointer',
          }}
            onMouseEnter={e => e.currentTarget.style.background = '#fff4f0'}
            onMouseLeave={e => e.currentTarget.style.background = '#f8f8f8'}
          ><span style={{ fontSize: 18 }}>{icon}</span><span style={{ fontSize: 10 }}>{label}</span></div>
        ))}
      </Card>

      {/* Sign out */}
      <div style={{ marginTop: 'auto', paddingTop: 4 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', fontSize: 11, color: '#111',
          fontWeight: 'bold', cursor: 'pointer',
          border: '1.5px solid #999', borderRadius: 3, background: '#f0f0f0',
        }}
          onMouseEnter={e => { e.currentTarget.style.background='#ffeeee'; e.currentTarget.style.color='#cc0000' }}
          onMouseLeave={e => { e.currentTarget.style.background='#f0f0f0'; e.currentTarget.style.color='#111' }}
        >
          <span style={{ fontSize: 18 }}>⎋</span>
          <span>Sign out</span>
        </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 8, color: '#664422', minWidth: 46 }}>Slice fps</span>
            <input type="range" min={1} max={30} defaultValue={8}
              style={{ width: 60, accentColor: '#886633' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 8, color: '#664422', minWidth: 46 }}>MIP rpm</span>
            <input type="range" min={1} max={30} defaultValue={6}
              style={{ width: 60, accentColor: '#886633' }} />
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
function RightPanel({ collapsed, onToggle }) {
  return (
    <div style={{
      width: collapsed ? 18 : 195,
      minWidth: collapsed ? 18 : 195,
      background: '#f0f0f0',
      borderLeft: '1.5px solid #cccccc',
      display: 'flex', flexDirection: 'column',
      transition: 'width 0.15s ease',
      overflow: 'hidden', position: 'relative',
    }}>
      <button onClick={onToggle} style={{
        position: 'absolute', left: 0, top: '50%',
        transform: 'translateY(-50%)',
        background: '#e8e8e8', border: '1px solid #bbb', borderLeft: 'none',
        color: '#666', fontSize: 9, cursor: 'pointer',
        padding: '10px 3px', borderRadius: '0 3px 3px 0', zIndex: 10,
      }}>{collapsed ? '◀' : '▶'}</button>

      {!collapsed && (
        <div style={{ padding: '8px 8px 8px 22px', flex: 1, overflowY: 'auto' }}>
          <Card title="Structured Report" color="#7799aa">
            {['Clinical history','Technique','Findings','Impression','Recommendation'].map(s => (
              <div key={s} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 8, color: '#555', marginBottom: 2, fontWeight: 'bold' }}>{s}</div>
                <textarea rows={s === 'Findings' ? 4 : 2}
                  placeholder={`Enter ${s.toLowerCase()}...`}
                  style={{
                    width: '100%', background: '#fafafa',
                    border: '1px solid #ccc', borderRadius: 3,
                    color: '#222', fontSize: 8, padding: '3px 5px',
                    resize: 'vertical', fontFamily: 'monospace',
                    boxSizing: 'border-box',
                  }} />
              </div>
            ))}
          </Card>

          <Card title="SUV Measurements" color="#99aa77">
            <div style={{ fontSize: 8, color: '#888', fontStyle: 'italic' }}>
              No ROIs placed yet
            </div>
          </Card>

          <div style={{ marginTop: 6 }}>
            <div style={{
              padding: '6px 8px', background: '#ddeeff',
              border: '1px solid #99aacc', borderRadius: 3,
              fontSize: 8, color: '#336699', cursor: 'pointer', textAlign: 'center',
            }}>Open full report editor ↗</div>
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
  const [ctWL,            setCTWL]            = useState(DEF_CT_WL)
  const [petWL,           setPETWL]           = useState(DEF_PET_WL)
  const [suv,             setSUV]             = useState(DEF_SUV)
  const [petOpacity,      setPetOpacity]      = useState(0.6)
  const [activeTool,      setActiveTool]      = useState(null)
  const [sync,            setSync]            = useState({ scroll: true, zoom: false, pan: false })
  const [expandedId,      setExpandedId]      = useState(null)
  const [rightCollapsed,  setRightCollapsed]  = useState(false)
  const [showShortcuts,   setShowShortcuts]   = useState(false)

  const onSync   = useCallback((key, val) => setSync(p => ({ ...p, [key]: val })), [])
  const resetAll = useCallback(() => { setCTWL(DEF_CT_WL); setPETWL(DEF_PET_WL); setSUV(DEF_SUV) }, [])
  const clearROI = useCallback(() => {
    try {
      const { annotation } = window.__cs3dTools__ || {}
      annotation?.state?.removeAllAnnotations?.()
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

      {/* Left panel — full height from top */}
      <LeftPanel layout={layout} onLayoutChange={setLayout} />

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
