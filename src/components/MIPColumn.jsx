// MIPColumn.jsx — Whole-body MIP display column (right side of viewport grid)
// - Displays MIP in Inverse Greyscale (FIXED — user cannot change this)
// - Auto-plays on load (rotation speed = mipSpeed rpm)
// - A/P/RL/LL buttons jump directly to that view angle (no slow rotation)
// - Play/Pause/Stop + speed slider in footer
// - Rotation is distinct from the per-viewport cine (slice scroll)
// - Clicking on MIP updates slicePosition → syncs all 6 viewports to that z-level
// - Slice cursor: yellow horizontal line showing current z-position within body
//
// Note: In this mock, MIP body is a placeholder canvas.
//       In Phase 3 (fusion), this will use Cornerstone3D VolumeViewport with
//       a projected MIP rendering of the PET volume.

import { useRef, useEffect, useCallback } from 'react'

// MIP view angles — clicking jumps directly, no slow rotation
const MIP_VIEWS = [
  { id:'A',  label:'A',  angle:0   },  // Anterior
  { id:'P',  label:'P',  angle:180 },  // Posterior
  { id:'RL', label:'RL', angle:90  },  // Right lateral
  { id:'LL', label:'LL', angle:270 },  // Left lateral
]

export default function MIPColumn({
  view, onViewChange,
  playing, onPlayingChange,
  speed, onSpeedChange,
  slicePosition, onSlicePositionChange,
  overlaysVisible,
}) {
  const intervalRef = useRef(null)
  const angleRef    = useRef(0)
  const canvasRef   = useRef(null)

  // ── Rotation cine ─────────────────────────────────────────────────────────
  // Restarts from current angle when view button is clicked or play is resumed
  useEffect(() => {
    clearInterval(intervalRef.current)
    if (!playing) return

    const msPerFrame = Math.round(1000 / (speed * 6))  // 6 frames per revolution step
    intervalRef.current = setInterval(() => {
      angleRef.current = (angleRef.current + 1) % 360
      drawMIP(angleRef.current)
    }, msPerFrame)

    return () => clearInterval(intervalRef.current)
  }, [playing, speed])

  // ── Jump to specific view angle ─────────────────────────────────────────
  const jumpToView = useCallback((viewId) => {
    const v = MIP_VIEWS.find(m => m.id === viewId)
    if (!v) return
    onViewChange(viewId)
    // Stop rotation, snap to angle
    onPlayingChange(false)
    clearInterval(intervalRef.current)
    angleRef.current = v.angle
    drawMIP(v.angle)
  }, [onViewChange, onPlayingChange])

  // ── MIP canvas draw (placeholder — shows angle indicator) ──────────────
  const drawMIP = (angle) => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#070707'
    ctx.fillRect(0, 0, c.width, c.height)
    // Placeholder body silhouette (inv. greyscale tones)
    ctx.fillStyle = `rgba(40,40,40,${0.5 + 0.5*Math.abs(Math.cos(angle*Math.PI/180))})`
    ctx.beginPath()
    ctx.ellipse(c.width/2, c.height/2, c.width*0.3, c.height*0.42, 0, 0, Math.PI*2)
    ctx.fill()
    // Angle label
    ctx.fillStyle = '#1a1a1a'
    ctx.font = '9px monospace'
    ctx.fillText(`${angle}°`, 4, 14)
  }

  // ── Click on MIP → update z-position → sync all viewports ──────────────
  const handleMIPClick = useCallback(e => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const yFrac = (e.clientY - rect.top) / rect.height
    // Map y-fraction to z-position in mm (body extends ~-500 to +500 mm typically)
    const z = Math.round(500 - yFrac * 1000)
    onSlicePositionChange(prev => ({ ...prev, z }))
  }, [onSlicePositionChange])

  // ── Canvas init ──────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ro = new ResizeObserver(() => {
      c.width  = c.offsetWidth  || 130
      c.height = c.offsetHeight || 300
      drawMIP(angleRef.current)
    })
    ro.observe(c)
    // Auto-play on load
    angleRef.current = 0
    drawMIP(0)
    return () => ro.disconnect()
  }, [])

  const sliceFrac = Math.max(0, Math.min(1, (500 - slicePosition.z) / 1000))

  return (
    <div className="mip-column">

      {/* ── Header ── */}
      <div className="mip-header">
        <span className="mip-title">MIP · Whole body</span>
        <button className="vp-header-btn" title="Toggle overlay" style={{ color: overlaysVisible ? '#888' : '#444' }}>
          <i className="ti ti-eye" aria-hidden="true"/>
        </button>
        <button className="vp-header-btn" title="Full screen (double-click)">
          <i className="ti ti-maximize" aria-hidden="true" style={{ color:'#666' }}/>
        </button>
      </div>

      {/* ── A / P / RL / LL view buttons ── */}
      <div className="mip-view-btns">
        {MIP_VIEWS.map(v => (
          <button
            key={v.id}
            className={`mip-view-btn${view === v.id ? ' active' : ''}`}
            onClick={() => jumpToView(v.id)}
            title={`Jump to ${v.id === 'A' ? 'Anterior' : v.id === 'P' ? 'Posterior' : v.id === 'RL' ? 'Right lateral' : 'Left lateral'} view`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* ── MIP body (canvas + slice cursor) ── */}
      <div className="mip-body">
        <canvas
          ref={canvasRef}
          onClick={handleMIPClick}
          style={{ width:'100%', height:'100%', display:'block', cursor:'crosshair' }}
          title="Click to sync all viewports to this z-level"
        />
        {/* Slice cursor — yellow horizontal line */}
        <div
          className="mip-slice-cursor"
          style={{ top: `${sliceFrac * 100}%` }}
          title={`z: ${slicePosition.z} mm`}
        />
        {/* Overlay text */}
        {overlaysVisible && (
          <>
            <div style={{ position:'absolute', top:4, left:4, zIndex:7, pointerEvents:'none' }}>
              <span className="ov-text" style={{ fontSize:8 }}>{angleRef.current}°</span>
            </div>
            <div style={{ position:'absolute', top:4, right:4, zIndex:7, pointerEvents:'none', textAlign:'right' }}>
              <span className="ov-text" style={{ fontSize:8 }}>Inv. grey</span>
            </div>
          </>
        )}
      </div>

      {/* ── MIP footer ── */}
      <div className="mip-footer">

        {/* Play / Pause / Stop + label */}
        <div className="mip-ctrl">
          <button className="mip-btn" title="Previous frame"
                  onClick={() => { angleRef.current=(angleRef.current-1+360)%360; drawMIP(angleRef.current) }}>
            <i className="ti ti-player-skip-back" aria-hidden="true"/>
          </button>
          <button
            className={`mip-btn${playing ? ' play' : ''}`}
            title={playing ? 'Pause rotation' : 'Resume rotation'}
            onClick={() => onPlayingChange(!playing)}
          >
            <i
              className={`ti ${playing ? 'ti-player-pause' : 'ti-player-play'}`}
              aria-hidden="true"
              style={{ color: playing ? '#88dd88' : '#aaaaaa' }}
            />
          </button>
          <button
            className="mip-btn stop"
            title="Stop rotation"
            onClick={() => {
              onPlayingChange(false)
              clearInterval(intervalRef.current)
              angleRef.current = 0
              drawMIP(0)
              onViewChange('A')
            }}
          >
            <i className="ti ti-player-stop" aria-hidden="true" style={{ color:'#dd8888' }}/>
          </button>
          <span style={{ fontSize:8, color:'#444', marginLeft:2 }}>Rotation</span>
        </div>

        {/* Speed slider */}
        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:3 }}>
          <span style={{ fontSize:8, color:'#555', whiteSpace:'nowrap' }}>Speed:</span>
          <input
            type="range" min={1} max={10} step={1}
            value={speed}
            onChange={e => onSpeedChange(+e.target.value)}
            style={{ flex:1, accentColor:'#555' }}
          />
          <span style={{ fontSize:8, fontFamily:'monospace', color:'#777' }}>{speed}rpm</span>
        </div>

        {/* Angle progress bar */}
        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:3 }}>
          <span style={{ fontSize:7, color:'#444', whiteSpace:'nowrap' }}>Angle:</span>
          <div className="mip-pos-bar">
            <div
              className="mip-pos-cur"
              style={{ left:`${(angleRef.current/360)*100}%`, background:'#555' }}
            />
          </div>
          <span style={{ fontSize:7, fontFamily:'monospace', color:'#555' }}>{angleRef.current}°</span>
        </div>

        {/* Slice cursor position */}
        <div style={{ borderTop:'0.5px solid #1a1a1a', paddingTop:3 }}>
          <div style={{ fontSize:7, color:'#2a2a2a', marginBottom:2 }}>
            Click MIP → sync all views
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <span style={{ fontSize:7, color:'#333' }}>z:</span>
            <div className="mip-pos-bar">
              <div
                className="mip-pos-cur"
                style={{ left:`${sliceFrac*100}%`, background:'#cc9900' }}
              />
            </div>
            <span style={{ fontSize:7, fontFamily:'monospace', color:'#555' }}>
              {slicePosition.z > 0 ? '+' : ''}{slicePosition.z}mm
            </span>
          </div>
        </div>

      </div>
    </div>
  )
}
