// components/index.js — barrel export for all viewer components
// Each component is in its own file; this barrel makes imports cleaner in App.jsx

export { default as LeftPanel     } from './LeftPanel'
export { default as PatientBanner } from './PatientBanner'
export { default as ViewportGrid  } from './ViewportGrid'
export { default as MIPColumn     } from './MIPColumn'
export { default as RightPanel    } from './RightPanel'
export { default as ColormapStrip } from './ColormapStrip'
export { default as PresetPill    } from './PresetPill'
export { default as ToolPicker    } from './ToolPicker'
export { default as AnnotationLayer } from './AnnotationLayer'
