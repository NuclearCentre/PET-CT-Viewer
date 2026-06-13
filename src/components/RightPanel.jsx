// RightPanel.jsx — Collapsible right panel (dual-screen use)
// Contains: structured report text areas, SUV measurement table, measurements log
// Will link to full structured reporting software in future (separate module)
// Collapses/expands via arrow button on left edge

export default function RightPanel({ collapsed, onToggle }) {
  return (
    <div className={`right-panel${collapsed ? ' collapsed' : ''}`}>

      {/* ── Collapse/expand arrow button on left edge ── */}
      <button className="rp-toggle-btn" onClick={onToggle} title={collapsed ? 'Expand panel' : 'Collapse panel'}>
        <i className={`ti ${collapsed ? 'ti-chevron-left' : 'ti-chevron-right'}`} aria-hidden="true"/>
      </button>

      {/* ── Structured report ── */}
      <div className="rp-section">Structured report</div>
      <div className="rp-report">
        <RPField label="Clinical history"  rows={2} placeholder="Known case of…"           />
        <RPField label="Technique"         rows={2} placeholder="WB PET-CT performed…"     />
        <RPField label="Findings"          rows={4} placeholder="Brain: No abnormal uptake…"/>
        <RPField label="Impression"        rows={2} placeholder="1. Metabolically active…"  />
        <RPField label="Recommendation"    rows={1} placeholder="Follow-up PET-CT…"        />
      </div>

      {/* ── SUV measurements table ── */}
      <div className="rp-section">SUV measurements</div>
      <div style={{ padding:'3px 8px', overflowX:'auto', flexShrink:0 }}>
        <table className="rp-suv-table">
          <thead>
            <tr>
              <th>Region</th>
              <th>SUVmax</th>
              <th>SUVmean</th>
              <th>Vol</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Liver (ROI-1)</td>
              <td className="suv-normal">2.8</td>
              <td>2.1</td>
              <td>—</td>
            </tr>
            <tr>
              <td>Lesion (ROI-2)</td>
              <td className="suv-high">8.7</td>
              <td>6.2</td>
              <td>4.3 ml</td>
            </tr>
            <tr>
              <td>Mediastinum</td>
              <td className="suv-normal">1.9</td>
              <td>1.6</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Measurements log ── */}
      <div className="rp-section">Measurements log</div>
      <div style={{ padding:'3px 8px', fontSize:9, color:'#888888', lineHeight:1.6, flexShrink:0 }}>
        <div style={{ color:'#cccccc' }}>• ROI-1: 124.3 mm² · Mean 42 HU</div>
        <div>• Line-1: 34.2 mm (CT Axial)</div>
        <div>• Angle-1: 47.3° (CT Coronal)</div>
      </div>

      {/* ── Open full report editor ── */}
      <div className="rp-footer">
        {/* Future: links to structured reporting software module */}
        <button className="rp-open-report-btn">
          <i className="ti ti-file-text" aria-hidden="true" style={{ fontSize:11 }}/>
          Open full report editor ↗
        </button>
      </div>

    </div>
  )
}

function RPField({ label, rows, placeholder }) {
  return (
    <div className="rp-field">
      <span className="rp-field-label">{label}</span>
      <textarea
        className="rp-textarea"
        rows={rows}
        placeholder={placeholder}
      />
    </div>
  )
}
