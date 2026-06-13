// LeftPanel.jsx — Always-visible left panel
// - Browser-style tabs at top with X to close (telephone diary style)
// - Logged-in user profile
// - Patient search, current study
// - Save & Export options
// - Print / PDF buttons
// - Layout preset picker
// - Display options
// - Sign out at bottom

import { useState } from 'react'

const INITIAL_TABS = [
  { id:'study',   label:'Study'   },
  { id:'save',    label:'Save'    },
  { id:'layout',  label:'Layout'  },
  { id:'print',   label:'Print'   },
  { id:'display', label:'Display' },
]

const LAYOUT_PRESETS = [
  {
    id:'2x3mip', label:'2×3+MIP',
    grid: { cols:3, rows:2 },
    icon: { cols:3, rows:2, mip:true },
  },
  { id:'1x1',   label:'1×1',    icon:{ cols:1, rows:1 } },
  { id:'2x2',   label:'2×2',    icon:{ cols:2, rows:2 } },
  { id:'3x3',   label:'3×3',    icon:{ cols:3, rows:3 } },
  { id:'1x3mpr',label:'MPR',    icon:{ cols:3, rows:1 } },
  { id:'1x2',   label:'1×2',    icon:{ cols:2, rows:1 } },
  { id:'custom', label:'Custom', icon:{ custom:true } },
]

export default function LeftPanel({ layout, onLayoutChange }) {
  const [tabs,       setTabs]       = useState(INITIAL_TABS)
  const [activeTab,  setActiveTab]  = useState('study')
  const [activeBtn,  setActiveBtn]  = useState('study-current')

  const closeTab = (e, tabId) => {
    e.stopPropagation()
    setTabs(ts => ts.filter(t => t.id !== tabId))
    if (activeTab === tabId) setActiveTab(tabs.find(t => t.id !== tabId)?.id ?? '')
  }

  return (
    <div className="left-panel">

      {/* ── Browser-tab cards ── */}
      <div className="lp-tabs">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`lp-tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
            <span className="lp-tab-close" onClick={e => closeTab(e, tab.id)}>✕</span>
          </div>
        ))}
      </div>

      {/* ── User profile ── */}
      <div className="lp-user">
        <div className="lp-avatar">RK</div>
        <div>
          <div className="lp-username">Dr R. Kumar</div>
          <div className="lp-role">Nuclear Medicine</div>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="lp-scroll">

        {/* Patient */}
        <div className="lp-section">Patient</div>
        <LPBtn
          icon="ti-search" label="Search / Worklist"
          id="search" active={activeBtn} onSelect={setActiveBtn}
        />
        <LPBtn
          icon="ti-folder-open" label="Current study"
          id="study-current" active={activeBtn} onSelect={setActiveBtn}
        />
        <div className="lp-divider"/>

        {/* Save & Export */}
        <div className="lp-section">Save &amp; Export</div>
        <div style={{ padding:'2px 5px', display:'flex', flexDirection:'column', gap:2 }}>
          <LPSaveOpt icon="ti-photo"  label="Save viewport (PNG)"    />
          <LPSaveOpt icon="ti-copy"   label="Save all viewports"      />
          <LPSaveOpt icon="ti-video"  label="Export MIP video (MP4)"  />
          <LPSaveOpt icon="ti-video"  label="Export cine scroll (MP4)"/>
        </div>
        <div className="lp-divider"/>

        {/* Print / PDF */}
        <div className="lp-section">Print / PDF</div>
        <LPBtn icon="ti-printer"       label="Print layout designer"
               id="print-layout" active={activeBtn} onSelect={setActiveBtn}/>
        <LPBtn icon="ti-file-type-pdf" label="Save as PDF"
               id="save-pdf"     active={activeBtn} onSelect={setActiveBtn}/>
        <div className="lp-divider"/>

        {/* Layout presets */}
        <div className="lp-section">Layout</div>
        <div className="lp-layout-grid">
          {LAYOUT_PRESETS.map(p => (
            <div
              key={p.id}
              className={`lp-preset${layout === p.id ? ' active' : ''}`}
              onClick={() => onLayoutChange(p.id)}
              title={p.label}
            >
              <LayoutIcon {...p.icon}/>
              <span className="lp-preset-label">{p.label}</span>
            </div>
          ))}
        </div>
        <div className="lp-divider"/>

        {/* Display options */}
        <div className="lp-section">Display</div>
        <LPBtn icon="ti-contrast"          label="Image settings"
               id="image-settings"  active={activeBtn} onSelect={setActiveBtn}/>
        <LPBtn icon="ti-layout-dashboard"  label="Hanging protocol"
               id="hanging"         active={activeBtn} onSelect={setActiveBtn}/>
        <LPBtn icon="ti-sun"               label="UI theme"
               id="theme"           active={activeBtn} onSelect={setActiveBtn}/>

      </div>

      {/* ── Sign out ── */}
      <div className="lp-logout">
        <i className="ti ti-logout" aria-hidden="true"/>
        <span>Sign out</span>
      </div>
    </div>
  )
}

function LPBtn({ icon, label, id, active, onSelect }) {
  return (
    <div
      className={`lp-btn${active === id ? ' active' : ''}`}
      onClick={() => onSelect(id)}
    >
      <i className={`ti ${icon}`} aria-hidden="true"/>
      <span>{label}</span>
    </div>
  )
}

function LPSaveOpt({ icon, label }) {
  return (
    <div className="lp-save-opt">
      <i className={`ti ${icon}`} aria-hidden="true"/>
      <span>{label}</span>
    </div>
  )
}

function LayoutIcon({ cols=1, rows=1, mip=false, custom=false }) {
  if (custom) {
    return (
      <div className="lp-preset-icon" style={{ display:'flex', alignItems:'center', justifyContent:'center' }}>
        <span style={{ fontSize:13, color:'#444' }}>+</span>
      </div>
    )
  }
  const cells = Array.from({ length: cols * rows })
  return (
    <div
      className="lp-preset-icon"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, 1fr)${mip ? ' 8px' : ''}`,
        gridTemplateRows:    `repeat(${rows}, 1fr)`,
        gap: 1,
        width: 22, height: 17,
      }}
    >
      {cells.map((_, i) => <div key={i} className="lp-preset-cell"/>)}
      {mip && (
        <div
          className="lp-preset-cell"
          style={{ gridRow:`1/${rows+1}`, background:'#2a5a2a' }}
        />
      )}
    </div>
  )
}
