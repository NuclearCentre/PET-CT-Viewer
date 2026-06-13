// AnnotationLayer.jsx — Interactive annotation SVG layer
// Adapted from PetCtViewer.jsx (ShapeLayer, AnnLabel, renderShape, buildAnn, computeAnn)
// Provides: oval, circle, square, rectangle, freehand ROI; straight/curved/freehand lines; angle
// Each placed annotation shows a draggable label with mean/min/max HU (CT) or SUV (PET-CT)
// All annotation shapes render in yellow (#ffff00) for visibility on both CT and PET images
//
// ⚠️  PIXEL_TO_MM must be replaced with real PixelSpacing from DICOM tag (0028,0030)
// ⚠️  sampleHU() reads canvas pixels as a proxy — replace with:
//      realHU = storedPixel × RescaleSlope + RescaleIntercept

import { useState, useRef, useCallback, useEffect } from 'react'

const PIXEL_TO_MM = 0.5  // ⚠️ REPLACE with real DICOM PixelSpacing

// ── Geometry helpers ─────────────────────────────────────────────────────────
function ellipsePts(cx, cy, rx, ry, n=64) {
  return Array.from({ length:n }, (_, i) => {
    const a = i / n * Math.PI * 2
    return { x: cx + Math.cos(a)*rx, y: cy + Math.sin(a)*ry }
  })
}

function inPoly(x, y, pts) {
  let inside = false
  for (let i=0, j=pts.length-1; i<pts.length; j=i++) {
    const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y
    if (((yi>y)!==(yj>y)) && x < (xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside
  }
  return inside
}

function sampleHU(ctx, x, y, wc, ww) {
  // ⚠️ Proxy: reads canvas pixel brightness as estimated HU
  // Replace with real DICOM pixel lookup when Cornerstone integration is complete
  try {
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
    return Math.round(wc - ww/2 + ((d[0]+d[1]+d[2])/3/255)*ww)
  } catch { return 0 }
}

function sampleROI(ctx, pts, wc, ww) {
  if (!pts || pts.length < 3) return { mean:0, min:0, max:0, area:'0.0' }
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y)
  const x0=Math.max(0,Math.floor(Math.min(...xs))), x1=Math.ceil(Math.max(...xs))
  const y0=Math.max(0,Math.floor(Math.min(...ys))), y1=Math.ceil(Math.max(...ys))
  const vals=[]
  for (let py=y0; py<=y1; py+=2)
    for (let px=x0; px<=x1; px+=2)
      if (inPoly(px, py, pts)) vals.push(sampleHU(ctx, px, py, wc, ww))
  if (!vals.length) return { mean:0, min:0, max:0, area:'0.0' }
  const mean = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length)
  let area = 0
  for (let i=0, j=pts.length-1; i<pts.length; j=i++)
    area += (pts[j].x+pts[i].x)*(pts[j].y-pts[i].y)
  return {
    mean, min:Math.min(...vals), max:Math.max(...vals),
    area: (Math.abs(area/2)*PIXEL_TO_MM*PIXEL_TO_MM).toFixed(1),
  }
}

// ── Annotation builder ───────────────────────────────────────────────────────
let _uid = 0
function buildAnn(type, p1, p2, pts, canvasRef, wc, ww) {
  const id = ++_uid
  const {x:x1,y:y1}=p1, {x:x2,y:y2}=p2
  let poly = null
  if (type==='oval')    poly = ellipsePts((x1+x2)/2,(y1+y2)/2,Math.abs(x2-x1)/2,Math.abs(y2-y1)/2)
  if (type==='circle')  { const r=Math.hypot(x2-x1,y2-y1)/2; poly=ellipsePts((x1+x2)/2,(y1+y2)/2,r,r) }
  if (type==='square'||type==='rect') poly=[{x:Math.min(x1,x2),y:Math.min(y1,y2)},{x:Math.max(x1,x2),y:Math.min(y1,y2)},{x:Math.max(x1,x2),y:Math.max(y1,y2)},{x:Math.min(x1,x2),y:Math.max(y1,y2)}]
  if (type==='freehand'||type==='freehand_line') poly=pts
  const ann = { id, type, x1, y1, x2, y2, pts:poly, vl:[], labelX:(x1+x2)/2+10, labelY:(y1+y2)/2-20 }
  return computeAnn(ann, canvasRef, wc, ww)
}

function computeAnn(ann, canvasRef, wc, ww) {
  const pts = ann.pts
  const ctx = canvasRef?.current?.getContext('2d')
  let vl = []
  const isLength = ['line','curved','freehand_line'].includes(ann.type)
  if (isLength) {
    let len = Math.hypot(ann.x2-ann.x1, ann.y2-ann.y1)
    vl = [`Length: ${(len*PIXEL_TO_MM).toFixed(1)} mm`]
  } else {
    const hu = (ctx && pts?.length>2) ? sampleROI(ctx, pts, wc, ww) : {mean:0,min:0,max:0,area:'0.0'}
    vl = [`Mean: ${hu.mean} HU`, `Min: ${hu.min} HU · Max: ${hu.max} HU`, `Area: ${hu.area} mm²`]
  }
  return { ...ann, pts, vl }
}

// ── SVG shape renderer ───────────────────────────────────────────────────────
const S = '#ffff00', SW = 1.5

function renderShape(ann) {
  if (!ann) return null
  const {x1,y1,x2,y2} = ann
  if (ann.type==='line') return <g><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={S} strokeWidth={SW}/><circle cx={x1} cy={y1} r={3} fill={S}/><circle cx={x2} cy={y2} r={3} fill={S}/></g>
  if (ann.type==='oval') return <ellipse cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2} stroke={S} strokeWidth={SW} fill="none"/>
  if (ann.type==='circle') return <circle cx={(x1+x2)/2} cy={(y1+y2)/2} r={Math.hypot(x2-x1,y2-y1)/2} stroke={S} strokeWidth={SW} fill="none"/>
  if (ann.type==='square'||ann.type==='rect') return <rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} stroke={S} strokeWidth={SW} fill="none"/>
  if ((ann.type==='freehand'||ann.type==='freehand_line')&&ann.pts?.length>1) {
    const d = 'M'+ann.pts.map(p=>p.x+','+p.y).join('L')+(ann.type==='freehand'?'Z':'')
    return <path d={d} stroke={S} strokeWidth={SW} fill={ann.type==='freehand'?'rgba(255,255,0,.05)':'none'}/>
  }
  return null
}

// ── Main AnnotationLayer component ───────────────────────────────────────────
export default function AnnotationLayer({ canvasRef, wc, ww, activeTool, clearSignal, modality }) {
  const [anns, setAnns] = useState([])
  const svgRef  = useRef(null)
  const drawing = useRef(false)
  const startPt = useRef(null)
  const fhPts   = useRef([])
  const [preview, setPreview] = useState(null)

  // Clear all annotations when clearSignal fires
  useEffect(() => {
    if (clearSignal > 0) setAnns([])
  }, [clearSignal])

  const gp = useCallback(e => {
    const r = svgRef.current?.getBoundingClientRect()
    return r ? { x:e.clientX-r.left, y:e.clientY-r.top } : {x:0,y:0}
  }, [])

  const isROI = ['roi_oval','roi_circle','roi_square','roi_rect','freehand'].includes(activeTool)
  const isLen = ['length','curved','freehand_line'].includes(activeTool)
  const canDraw = isROI || isLen

  const onDown = useCallback(e => {
    if (!canDraw || e.button!==0) return
    e.stopPropagation()
    drawing.current = true
    startPt.current = gp(e)
    if (activeTool==='freehand'||activeTool==='freehand_line') fhPts.current=[startPt.current]
  }, [canDraw, activeTool, gp])

  const onMove = useCallback(e => {
    if (!drawing.current || !canDraw) return
    const pt = gp(e)
    const type = activeTool.replace('roi_','')
    if (activeTool==='freehand'||activeTool==='freehand_line') {
      fhPts.current.push(pt)
      setPreview({ type:activeTool==='freehand'?'freehand':'freehand_line', pts:[...fhPts.current], x1:startPt.current.x, y1:startPt.current.y, x2:pt.x, y2:pt.y })
    } else {
      setPreview({ type, x1:startPt.current.x, y1:startPt.current.y, x2:pt.x, y2:pt.y })
    }
  }, [canDraw, activeTool, gp])

  const onUp = useCallback(e => {
    if (!drawing.current || !canDraw) return
    drawing.current = false
    setPreview(null)
    const pt = gp(e)
    const d = Math.hypot(pt.x-startPt.current.x, pt.y-startPt.current.y)
    if (d < 5) return
    const type = ['freehand','freehand_line'].includes(activeTool)
      ? activeTool
      : activeTool.replace('roi_','')
    const pts = (activeTool==='freehand'||activeTool==='freehand_line') ? [...fhPts.current] : null
    const ann = buildAnn(type, startPt.current, pt, pts, canvasRef, wc, ww)
    if (ann) setAnns(prev => [...prev, ann])
  }, [canDraw, activeTool, gp, canvasRef, wc, ww])

  const delAnn  = useCallback(id => setAnns(prev => prev.filter(a => a.id!==id)), [])
  const updAnn  = useCallback(u  => setAnns(prev => prev.map(a => a.id===u.id ? u : a)), [])

  return (
    <>
      {/* Invisible mouse-capture overlay */}
      <div
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp}
        style={{
          position:'absolute', inset:0, right:16, bottom:36,
          zIndex:35, pointerEvents: canDraw ? 'all' : 'none',
          cursor: canDraw ? 'crosshair' : 'default',
        }}
      />

      {/* Shape SVG layer */}
      <svg
        ref={svgRef}
        style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                 overflow:'visible', pointerEvents:'none', zIndex:40 }}
      >
        {preview && renderShape(preview)}
        {anns.map(ann => (
          <g key={ann.id}>
            {renderShape(ann)}
          </g>
        ))}
      </svg>

      {/* Draggable annotation labels */}
      {anns.map(ann => (
        <AnnLabel key={ann.id} ann={ann} onDelete={delAnn} />
      ))}
    </>
  )
}

// ── Draggable annotation label with leader line ──────────────────────────────
function AnnLabel({ ann, onDelete }) {
  const [pos, setPos] = useState({ x: ann.labelX ?? 20, y: ann.labelY ?? 20 })
  const boxRef  = useRef(null)
  const dragging = useRef(false)
  const startPos = useRef({x:0,y:0})
  const startMouse = useRef({x:0,y:0})

  const onDown = e => {
    e.stopPropagation()
    dragging.current = true
    startPos.current   = { ...pos }
    startMouse.current = { x:e.clientX, y:e.clientY }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }
  const onMove = e => {
    if (!dragging.current) return
    setPos({
      x: startPos.current.x + (e.clientX - startMouse.current.x),
      y: startPos.current.y + (e.clientY - startMouse.current.y),
    })
  }
  const onUp = () => {
    dragging.current = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup',   onUp)
  }

  const anchorX = (ann.x1 + ann.x2) / 2
  const anchorY = (ann.y1 + ann.y2) / 2

  return (
    <>
      {/* Leader line */}
      <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                    pointerEvents:'none', overflow:'visible', zIndex:41 }}>
        <line x1={anchorX} y1={anchorY}
              x2={pos.x} y2={pos.y}
              stroke="rgba(0,229,255,0.4)" strokeWidth={1} strokeDasharray="3 4"/>
        <circle cx={anchorX} cy={anchorY} r={2.5} fill="rgba(0,229,255,0.8)"/>
      </svg>

      {/* Label box */}
      <div
        ref={boxRef}
        onMouseDown={onDown}
        onDoubleClick={e => e.stopPropagation()}
        style={{
          position:'absolute', left:pos.x, top:pos.y,
          background:'rgba(0,0,0,0.90)',
          border:'0.5px solid rgba(255,255,255,0.2)',
          borderRadius:3, padding:'3px 6px',
          cursor:'move', userSelect:'none',
          zIndex:42, minWidth:90, pointerEvents:'auto',
        }}
      >
        {(ann.vl || []).map((l,i) => (
          <div key={i} style={{ fontSize:9, color:'#ffffff', whiteSpace:'nowrap', lineHeight:1.5 }}>
            {l}
          </div>
        ))}
        <div
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onDelete(ann.id) }}
          style={{ fontSize:8, color:'#ff6666', cursor:'pointer', marginTop:2, textAlign:'right' }}
        >
          ✕ delete
        </div>
      </div>
    </>
  )
}
