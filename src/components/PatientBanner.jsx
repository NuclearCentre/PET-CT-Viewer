// PatientBanner.jsx
import { useState } from 'react'

// DICOM-extracted patient data (populated at runtime from extractDicomMetadata())
// These defaults match the test patient in the dev log
const PATIENT = {
  name:        'Alka Jagtap',
  fullName:    'Alka Rajesh Jagtap',
  dob:         '12 Mar 1968',
  age:         '58 yr',
  sex:         'F',
  mrn:         'MCC-2026-04871',
  weight:      '58 kg',
  height:      '156 cm',
  studyDate:   '28 Jan 2026',
  studyType:   'WB PET-CT (FDG)',
  refPhysician:'Dr R. Sharma',
  institution: 'Mumbai Cancer Centre',
  series:      '6 · 2101 images',
  accession:   'ACC-2026-04871',
}

export function PatientBanner({ collapsed, onToggle }) {
  return (
    <div className="patient-banner" id="patient-banner">
      {!collapsed && (
        <>
          {/* Hoverable — shows full demographics tooltip */}
          <div className="banner-field">
            <span className="banner-label">Patient</span>
            <span className="banner-value hoverable">{PATIENT.name}
              <div className="banner-tooltip">
                <div style={{ display:'flex', justifyContent:'space-between', gap:14, marginBottom:2 }}>
                  <span style={{ fontSize:9, color:'#666' }}>Full name</span>
                  <span style={{ fontSize:9, color:'#ddd', fontWeight:500 }}>{PATIENT.fullName}</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', gap:14, marginBottom:2 }}>
                  <span style={{ fontSize:9, color:'#666' }}>DOB</span>
                  <span style={{ fontSize:9, color:'#ddd', fontWeight:500 }}>{PATIENT.dob} · {PATIENT.age}</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', gap:14, marginBottom:2 }}>
                  <span style={{ fontSize:9, color:'#666' }}>MRN</span>
                  <span style={{ fontSize:9, color:'#ddd', fontWeight:500 }}>{PATIENT.mrn}</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between', gap:14, marginBottom:2 }}>
                  <span style={{ fontSize:9, color:'#666' }}>Weight / Height</span>
                  <span style={{ fontSize:9, color:'#ddd', fontWeight:500 }}>{PATIENT.weight} · {PATIENT.height}</span>
                </div>
              </div>
            </span>
          </div>
          <BField label="Study"        value={PATIENT.studyType}    />
          <BField label="Date"         value={PATIENT.studyDate}    />
          <BField label="Ref. physician" value={PATIENT.refPhysician}/>
          <BField label="Institution"  value={PATIENT.institution}  />
          <BField label="Series"       value={PATIENT.series}       />
        </>
      )}
      <button
        onClick={onToggle}
        style={{ marginLeft:'auto', background:'transparent', border:'none', cursor:'pointer',
                 fontSize:9, color:'#aaaaaa', display:'flex', alignItems:'center', gap:3 }}
      >
        <i className={`ti ${collapsed ? 'ti-chevron-down' : 'ti-chevron-up'}`} aria-hidden="true"/>
        {collapsed ? 'Expand' : 'Collapse'}
      </button>
    </div>
  )
}

function BField({ label, value }) {
  return (
    <div className="banner-field">
      <span className="banner-label">{label}</span>
      <span className="banner-value">{value}</span>
    </div>
  )
}

export default PatientBanner
