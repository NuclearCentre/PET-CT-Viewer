// PresetPill.jsx — Hover-to-open CT window preset menu (bottom-left of CT viewports)
export function PresetPill({ activePreset, presets, onSelect }) {
  return (
    <div className="preset-wrap">
      <span className="preset-pill">⬡ {activePreset}</span>
      <div className="preset-menu">
        {presets.map(p => (
          <div
            key={p.label}
            className={`preset-item${p.label === activePreset ? ' active' : ''}`}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onSelect(p) }}
          >
            <span className="preset-item-icon">{p.icon}</span>
            <span className="preset-item-name">{p.label}</span>
            <span className="preset-item-vals">W:{p.ww} L:{p.wl}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default PresetPill


// ToolPicker.jsx — Hover-to-open per-viewport tool menu (top-right of each viewport)
// CT viewports: ROI shapes + length tools + angle
// PET-CT viewports: SUV ROI + length + angle

const CT_TOOL_MENU = [
  { id:'normal',  icon:'ti-arrow-back-up',    label:'Normal cursor' },
  { section: 'ROI' },
  { id:'roi_oval',  icon:'ti-circle-dashed', label:'Oval',      sub:true  },
  { id:'roi_circle',icon:'ti-circle',        label:'Circle',    sub:true  },
  { id:'roi_square',icon:'ti-square',        label:'Square',    sub:true  },
  { id:'roi_rect',  icon:'ti-rectangle',     label:'Rectangle', sub:true  },
  { id:'freehand',  icon:'ti-pentagon',      label:'Freehand',  sub:true  },
  { section: 'Length' },
  { id:'length',   icon:'ti-ruler-measure', label:'Straight',  sub:true  },
  { id:'curved',   icon:'ti-wave-sine',     label:'Curved',    sub:true  },
  { id:'freehand_line', icon:'ti-pencil',   label:'Freehand line', sub:true },
  { section: 'Other' },
  { id:'angle',    icon:'ti-angle',         label:'Angle'               },
  { id:'text',     icon:'ti-typography',    label:'Text annotation'     },
]

const PET_TOOL_MENU = [
  { id:'normal',  icon:'ti-arrow-back-up',    label:'Normal cursor' },
  { section: 'SUV ROI' },
  { id:'roi_oval',   icon:'ti-circle-dashed', label:'Oval → SUV'      },
  { id:'roi_circle', icon:'ti-circle',        label:'Circle → SUV'    },
  { id:'roi_rect',   icon:'ti-rectangle',     label:'Rectangle → SUV' },
  { id:'freehand',   icon:'ti-pentagon',      label:'Freehand → SUV'  },
  { id:'probe',      icon:'ti-point',         label:'Single voxel probe' },
  { section: 'Length' },
  { id:'length',  icon:'ti-ruler-measure',    label:'Straight'        },
  { id:'angle',   icon:'ti-angle',            label:'Angle'           },
]

export function ToolPicker({ modality, activeTool }) {
  const menu = modality === 'ct' ? CT_TOOL_MENU : PET_TOOL_MENU
  const isFused = modality === 'fused'

  return (
    <div className="tool-wrap">
      <span
        className="tool-pill"
        style={isFused ? { borderColor:'#1a3a1a', color:'#4a8a4a' } : {}}
      >
        ⊕ {isFused ? 'ROI→SUV' : 'Tools'}
      </span>
      <div className="tool-menu">
        {menu.map((item, i) => {
          if (item.section) {
            return (
              <div key={i} style={{ fontSize:8, color:'#444', textTransform:'uppercase',
                                     letterSpacing:'0.05em', padding:'3px 8px 1px' }}>
                {item.section}
              </div>
            )
          }
          return (
            <div
              key={item.id}
              className={`hover-menu-item${activeTool === item.id ? (isFused ? ' active-green' : ' active') : ''}`}
            >
              <i className={`ti ${item.icon}`} aria-hidden="true" style={{ fontSize:10, color:'#555', width:12 }}/>
              {item.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default ToolPicker
