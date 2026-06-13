// Ribbon.jsx — Scrollable horizontal ribbon with uniform-height cards
// Cards: File | Tools | W/L & SUV | View | Cine | System
// Tool buttons: icon-only with hover tooltip, white icons (#cccccc), active = bright white on blue

import { useCallback } from 'react'
import { switchTool } from '../cornerstone-init'

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  { id:'wl',         icon:'ti-adjustments-horizontal', label:'Window / Level'    },
  { id:'zoom',       icon:'ti-zoom-in',                label:'Zoom'              },
  { id:'pan',        icon:'ti-hand-move',              label:'Pan'               },
  { id:'crosshair',  icon:'ti-crosshair',              label:'Crosshair'         },
  { id:'length',     icon:'ti-ruler-measure',          label:'Length'            },
  { id:'roi_oval',   icon:'ti-circle-dashed',          label:'Oval ROI'          },
  { id:'angle',      icon:'ti-angle',                  label:'Angle'             },
  { id:'text',       icon:'ti-typography',             label:'Text annotation'   },
  { id:'freehand',   icon:'ti-pencil',                 label:'Freehand ROI'      },
  { id:'curved',     icon:'ti-wave-sine',              label:'Curved line'       },
  { id:'probe',      icon:'ti-point',                  label:'SUV probe'         },
  { id:'normal',     icon:'ti-arrow-back-up',          label:'Normal cursor'     },
]

// ── Window presets (all 8 from dev log) ──────────────────────────────────────
// Used in the per-viewport preset pill — defined here as a shared constant
export const CT_PRESETS = [
  { label:'Brain',       icon:'🧠', ww:80,   wl:40,   },
  { label:'Subdural',    icon:'🧠', ww:200,  wl:75,   },
  { label:'Lungs',       icon:'🫁', ww:1500, wl:-600, },
  { label:'Mediastinum', icon:'❤️', ww:350,  wl:50,   },
  { label:'Soft tissue', icon:'🫀', ww:400,  wl:40,   },
  { label:'Liver',       icon:'🟫', ww:150,  wl:30,   },
  { label:'Abdomen',     icon:'🟠', ww:400,  wl:50,   },
  { label:'Bone',        icon:'🦴', ww:2000, wl:450,  },
  { label:'Sinuses',     icon:'💜', ww:3000, wl:500,  },
]

export default function Ribbon({
  activeTool, onToolChange,
  wl, onCTChange, onPETChange, onSUVChange,
  overlaysVisible, refLinesVisible,
  onToggleOverlays, onToggleRefLines,
  onResetAll, onClearROI,
  cineFps, onCineFpsChange,
  mipSpeed, onMipSpeedChange,
}) {
  const handleToolClick = useCallback((toolId) => {
    onToolChange(toolId)
    switchTool(toolId)
  }, [onToolChange])

  return (
    <div className="ribbon">

      {/* ── CARD 1: File ──────────────────────────────────────────────── */}
      <div className="ribbon-card">
        <div className="ribbon-card-label">File</div>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
          <RibbonFileBtn icon="ti-folder-open"  label="Open study"    />
          <RibbonFileBtn icon="ti-download"      label="Export DICOM"  />
          <RibbonFileBtn icon="ti-share"         label="Share / Send"  />
        </div>
      </div>

      {/* ── CARD 2: Tools (icon grid, 3 rows × 4 cols) ───────────────── */}
      <div className="ribbon-card">
        <div className="ribbon-card-label">Tools</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 2,
        }}>
          {TOOLS.map(tool => (
            <button
              key={tool.id}
              className={`tool-btn${activeTool === tool.id ? ' active' : ''}`}
              onClick={() => handleToolClick(tool.id)}
              title={tool.label}
              aria-label={tool.label}
            >
              {/* Icon colour: #cccccc default, #ffffff when active — hardcoded */}
              <i
                className={`ti ${tool.icon}`}
                aria-hidden="true"
                style={{ color: activeTool === tool.id ? '#ffffff' : '#cccccc' }}
              />
              <span className="tooltip">{tool.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── CARD 3: W/L & SUV (3 stacked rows) ───────────────────────── */}
      <div className="ribbon-card" style={{ minWidth: 220 }}>
        <div className="ribbon-card-label">Window / Level &amp; SUV</div>
        <div style={{ display:'flex', flexDirection:'column', gap:5 }}>

          {/* CT W/L row — blue — affects top 3 CT viewports only */}
          <div className="wl-row">
            <span className="wl-label ct">CT W/L</span>
            <span className="wl-sub">W</span>
            <input
              type="range" min={1} max={4000} step={1}
              value={wl.ct.ww}
              onChange={e => onCTChange(+e.target.value, wl.ct.wl)}
              style={{ width:46, accentColor:'#378add' }}
            />
            <span className="wl-value ct" style={{ minWidth:32 }}>{wl.ct.ww}</span>
            <span className="wl-sub">L</span>
            <input
              type="range" min={-1000} max={1000} step={1}
              value={wl.ct.wl}
              onChange={e => onCTChange(wl.ct.ww, +e.target.value)}
              style={{ width:46, accentColor:'#378add' }}
            />
            <span className="wl-value ct" style={{ minWidth:28 }}>{wl.ct.wl}</span>
          </div>

          {/* PET W/L row — green — affects bottom 3 PET-CT viewports only */}
          <div className="wl-row">
            <span className="wl-label pet">PET W/L</span>
            <span className="wl-sub">W</span>
            <input
              type="range" min={0} max={20000} step={100}
              value={wl.pet.ww}
              onChange={e => onPETChange(+e.target.value, wl.pet.wl)}
              style={{ width:46, accentColor:'#4aaa5a' }}
            />
            <span className="wl-value pet" style={{ minWidth:32 }}>
              {wl.pet.ww >= 1000 ? `${Math.round(wl.pet.ww/1000)}k` : wl.pet.ww}
            </span>
            <span className="wl-sub">L</span>
            <input
              type="range" min={0} max={10000} step={100}
              value={wl.pet.wl}
              onChange={e => onPETChange(wl.pet.ww, +e.target.value)}
              style={{ width:46, accentColor:'#4aaa5a' }}
            />
            <span className="wl-value pet" style={{ minWidth:28 }}>
              {wl.pet.wl >= 1000 ? `${Math.round(wl.pet.wl/1000)}k` : wl.pet.wl}
            </span>
          </div>

          {/* SUV threshold row — amber — affects all 3 PET-CT viewports simultaneously */}
          <div className="wl-row">
            <span className="wl-label suv">SUV</span>
            <span className="wl-sub" style={{ color:'#777', fontSize:8 }}>min</span>
            <input
              type="range" min={0} max={20} step={0.1}
              value={wl.suv.min}
              onChange={e => onSUVChange(+e.target.value, wl.suv.max)}
              style={{ width:40, accentColor:'#ccaa22' }}
            />
            <span className="wl-value suv" style={{ minWidth:26 }}>
              {wl.suv.min.toFixed(1)}
            </span>
            <span className="wl-sub" style={{ color:'#777', fontSize:8 }}>max</span>
            <input
              type="range" min={0} max={30} step={0.1}
              value={wl.suv.max}
              onChange={e => onSUVChange(wl.suv.min, +e.target.value)}
              style={{ width:40, accentColor:'#ccaa22' }}
            />
            <span className="wl-value suv" style={{ minWidth:26 }}>
              {wl.suv.max.toFixed(1)}
            </span>
          </div>

        </div>
      </div>

      {/* ── CARD 4: View ─────────────────────────────────────────────── */}
      <div className="ribbon-card">
        <div className="ribbon-card-label">View</div>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
          <button
            className={`view-btn${overlaysVisible ? ' active' : ''}`}
            onClick={onToggleOverlays}
          >
            <i className="ti ti-eye" aria-hidden="true"
               style={{ color: overlaysVisible ? '#88c4ff' : '#aaaaaa' }}/>
            Overlays
          </button>
          <button
            className={`view-btn${refLinesVisible ? ' active' : ''}`}
            onClick={onToggleRefLines}
          >
            <i className="ti ti-crosshair" aria-hidden="true"
               style={{ color: refLinesVisible ? '#88c4ff' : '#aaaaaa' }}/>
            Ref lines
          </button>
          <button className="view-btn" onClick={onResetAll}>
            <i className="ti ti-arrows-maximize" aria-hidden="true" style={{ color:'#aaaaaa' }}/>
            Reset all
          </button>
          <button className="view-btn danger" onClick={onClearROI}>
            <i className="ti ti-eraser" aria-hidden="true"/>
            Clear ROI
          </button>
        </div>
      </div>

      {/* ── CARD 5: Cine ─────────────────────────────────────────────── */}
      <div className="ribbon-card" style={{ minWidth: 140 }}>
        <div className="ribbon-card-label">Cine</div>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
            <span style={{ fontSize:9, color:'#888888', width:55, flexShrink:0 }}>
              Slice fps
            </span>
            <input
              type="range" min={1} max={24} step={1}
              value={cineFps}
              onChange={e => onCineFpsChange(+e.target.value)}
              style={{ flex:1, accentColor:'#555' }}
            />
            <span style={{ fontSize:9, fontFamily:'monospace', color:'#cccccc', minWidth:16 }}>
              {cineFps}
            </span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
            <span style={{ fontSize:9, color:'#888888', width:55, flexShrink:0 }}>
              MIP rpm
            </span>
            <input
              type="range" min={1} max={10} step={1}
              value={mipSpeed}
              onChange={e => onMipSpeedChange(+e.target.value)}
              style={{ flex:1, accentColor:'#555' }}
            />
            <span style={{ fontSize:9, fontFamily:'monospace', color:'#cccccc', minWidth:16 }}>
              {mipSpeed}
            </span>
          </div>
          <span style={{ fontSize:8, color:'#444444' }}>
            Per-viewport play/stop in each box footer
          </span>
        </div>
      </div>

      {/* ── CARD 6: System ───────────────────────────────────────────── */}
      <div className="ribbon-card">
        <div className="ribbon-card-label">System</div>
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
          <RibbonFileBtn icon="ti-keyboard"    label="Shortcuts" />
          <RibbonFileBtn icon="ti-settings"    label="Settings"  />
          <RibbonFileBtn icon="ti-help-circle" label="Help"      />
        </div>
      </div>

    </div>
  )
}

// ── Small reusable file/system button ────────────────────────────────────────
function RibbonFileBtn({ icon, label }) {
  return (
    <button
      className="btn-dark"
      style={{ fontSize:9, padding:'2px 7px', gap:4, width:'100%', justifyContent:'flex-start' }}
    >
      <i className={`ti ${icon}`} aria-hidden="true" style={{ color:'#aaaaaa', fontSize:11 }}/>
      <span style={{ color:'#cccccc' }}>{label}</span>
    </button>
  )
}
