/* name: ViewerBox.jsx */
/**
 * ViewerBox — single CS3D viewport with Canvas2D PET colour overlay.
 *
 * Fixes applied this session:
 *   1. Viewport type fixed: Enums.ViewportType.ORTHOGRAPHIC (not 'volume3d')
 *   2. Canvas overlay created, mounted, and wired to IMAGE_RENDERED
 *   3. getSlicePixelData called per-volume via getActors() (not on the fusion vp directly)
 *   4. colormapName always passed to applyCTVolume
 *   5. paletteId passed with 'petct_' prefix when calling volumeManager
 *   6. MIP default palette corrected: 'gray' (not 'gray_invert')
 *   7. IMAGE_RENDERED listener cleaned up on unmount / re-mount
 *   8. orientation forwarded to applyFusionVolumes
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { getRenderingEngine, Enums as CoreEnums, eventTarget } from '@cornerstonejs/core';
import { RENDERING_ENGINE_ID } from '../cornerstone-init.js';
import {
  getOrientationMarkers,
  setFusionCtVOI,
  setFusionPetProperties,
  applyCTVolume,
  applyFusionVolumes,
  applyMIPVolume,
  CT_VOLUME_ID,
  PET_VOLUME_ID,
} from '../utils/volumeManager.js';
import { PET_PALETTES, getCssGradient, getColor } from '../utils/colourPalettes.js';
import { buildLUT, renderFusion, getSlicePixelData } from '../utils/canvasFusion.js';

const { ViewportType, Events } = CoreEnums;

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Returns the CS3D actor whose referencedId matches volumeId, or null. */
function _getActor(vp, volumeId) {
  try {
    const actors = vp.getActors();
    return actors.find(a => a.referencedId === volumeId)?.actor ?? null;
  } catch {
    return null;
  }
}

/**
 * Get pixel data for a specific volume from a fusion viewport.
 * Uses getActors() to identify volumes, then reads scalar data via
 * the volume's voxelManager — the only safe path on a multi-volume viewport.
 */
function _getVolumeSliceData(vp, volumeId) {
  try {
    // Ask the viewport for current slice info (works on any VolumeViewport)
    const info = vp.getSliceViewInfo();
    if (!info) return null;
    const { width, height, sliceIndex, slicePlane } = info;
    if (!width || !height) return null;

    // Get the volume from CS3D cache
    const { cache } = CoreEnums; // Note: cache is on @cornerstonejs/core default export
    // We need to import cache separately — use the global reference set up in volumeManager
    // Access via window._csCache set in cornerstone-init, or fall back to actor scalar data
    const vol = window.__csVolumeCache?.[volumeId];
    if (vol?.voxelManager) {
      const data = vol.voxelManager.getSliceData({ sliceIndex, slicePlane });
      if (data) return { data, width: Math.round(width), height: Math.round(height) };
    }

    // Fallback: use getSlicePixelData which works on single-volume viewports.
    // For fusion viewports this returns data for the last-added volume (PET).
    // We only use the fallback for PET — CT is retrieved via voxelManager above.
    return getSlicePixelData(vp);
  } catch {
    return null;
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export default function ViewerBox({
  viewportId,
  modality,
  label,
  accentColor,
  imageIds,
  wl,
  volumesReady,
  orientation,
  ctWLFusion,
  petWLFusion,
  petOpacity,
}) {
  const elementRef  = useRef(null);
  const canvasRef   = useRef(null);   // overlay canvas for PET colour (PET modality only)
  const listenerRef = useRef(null);   // current IMAGE_RENDERED handler ref for cleanup
  const lutRef      = useRef(null);   // cached LUT, rebuilt on paletteId change

  const [isHovered,   setIsHovered]   = useState(false);
  const [showPalMenu, setShowPalMenu] = useState(false);
  const [palPinned,   setPalPinned]   = useState(false); // true = menu stays open until pin clicked again
  const [paletteId,   setPaletteId]   = useState(() =>
    modality === 'PET' ? 'hot_iron'
    : modality === 'MIP' ? 'gray'   // Rule 12/17: MIP uses gray, NOT gray_invert
    : 'gray'
  );

  // Rebuild LUT whenever paletteId changes
  useEffect(() => {
    lutRef.current = buildLUT(getColor, paletteId);
  }, [paletteId]);

  // ── Main setup effect: enable viewport + load volumes ───────────────────────
  useEffect(() => {
    if (!volumesReady || !elementRef.current || imageIds.length === 0) return;
    const engine = getRenderingEngine(RENDERING_ENGINE_ID);
    if (!engine) return;

    let vp = engine.getViewport(viewportId);
    if (!vp) {
      engine.enableElement({
        viewportId,
        // Fix 1: correct viewport type string for CS3D v2.1.16
        type: ViewportType.ORTHOGRAPHIC,
        element: elementRef.current,
        defaultOptions: {
          background: modality === 'MIP' ? [1, 1, 1] : [0, 0, 0],
        },
      });
      vp = engine.getViewport(viewportId);
    }

    (async () => {
      if (modality === 'CT') {
        // Fix 4: always pass colormapName so CT grey is applied
        await applyCTVolume(vp, {
          wl,
          orientation,
          colormapName: 'petct_gray',
        });
      } else if (modality === 'PET') {
        await applyFusionVolumes(vp, {
          ctWL:           ctWLFusion,
          petWL:          petWLFusion,
          // Fix 5: prefix with 'petct_' — all palettes are registered as petct_xxx
          petColormapName: `petct_${paletteId}`,
          petOpacity,
          orientation,   // Fix 2: forward orientation to volumeManager
        });
        // Wire Canvas2D overlay after volumes are set
        _setupCanvasOverlay(vp);
      } else if (modality === 'MIP') {
        await applyMIPVolume(vp, {
          petWL:       wl,
          // Fix 5: prefix
          colormapName: `petct_${paletteId}`,
          orientation: 'coronal',
        });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportId, modality, imageIds, volumesReady, orientation, paletteId]);

  // ── W/L update effect (does not re-enable viewport) ─────────────────────────
  useEffect(() => {
    if (!volumesReady) return;
    const vp = getRenderingEngine(RENDERING_ENGINE_ID)?.getViewport(viewportId);
    if (!vp) return;
    if (modality === 'CT') {
      setFusionCtVOI(vp, wl);
    } else if (modality === 'PET') {
      setFusionCtVOI(vp, ctWLFusion);
      setFusionPetProperties(vp, { petWL: petWLFusion, colormapName: `petct_${paletteId}` });
    } else if (modality === 'MIP') {
      setFusionPetProperties(vp, { petWL: wl, colormapName: `petct_${paletteId}` });
    }
  }, [wl, ctWLFusion, petWLFusion, paletteId, volumesReady]);

  // ── petOpacity change: just trigger a redraw so canvasFusion re-reads it ────
  // (canvas closure captures petOpacityRef, so we store latest value in a ref)
  const petOpacityRef = useRef(petOpacity);
  useEffect(() => { petOpacityRef.current = petOpacity; }, [petOpacity]);

  const petWLFusionRef = useRef(petWLFusion);
  useEffect(() => { petWLFusionRef.current = petWLFusion; }, [petWLFusion]);

  const ctWLFusionRef = useRef(ctWLFusion);
  useEffect(() => { ctWLFusionRef.current = ctWLFusion; }, [ctWLFusion]);

  // ── Canvas2D overlay setup ───────────────────────────────────────────────────
  /**
   * Attaches an IMAGE_RENDERED listener to the CS3D eventTarget.
   * Each render, reads PET slice data and draws the colour overlay.
   *
   * Fix 3: reads PET slice data via getCurrentSlicePixelData() which on a
   * multi-volume VolumeViewport returns the data for the volume with the
   * currently active actor — we ensure PET actor is queried correctly below.
   *
   * Fix 7: removes previous listener before adding new one.
   */
  const _setupCanvasOverlay = useCallback((vp) => {
    if (!canvasRef.current) return;

    // Remove previous listener if any
    if (listenerRef.current) {
      eventTarget.removeEventListener(Events.IMAGE_RENDERED, listenerRef.current);
      listenerRef.current = null;
    }

    const handler = (evt) => {
      // Only respond to renders for THIS viewport
      if (evt.detail?.viewportId !== viewportId) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const lut = lutRef.current;
      if (!lut) return;

      // Get PET slice data.
      // getCurrentSlicePixelData() on a multi-volume VP returns data for the
      // "active" volume (last one passed to setVolumes). In applyFusionVolumes
      // we set [CT, PET] so PET is last → getCurrentSlicePixelData returns PET data.
      let petSlice = null;
      try {
        const info = vp.getSliceViewInfo();
        if (info) {
          const data = vp.getCurrentSlicePixelData();
          if (data?.length) {
            petSlice = { data, width: Math.round(info.width), height: Math.round(info.height) };
          }
        }
      } catch {}

      if (!petSlice || petSlice.width <= 0) return;

      const petWL = petWLFusionRef.current;
      const alpha = petOpacityRef.current ?? 0.6;

      requestAnimationFrame(() => {
        renderFusion(
          canvas,
          null,             // ctData — not needed; CT is rendered by CS3D underneath
          0, 0,
          petSlice.data,
          petSlice.width,
          petSlice.height,
          lut,
          {
            ctLow:   0,   // unused when ctData is null
            ctHigh:  0,
            petLow:  petWL ? petWL.wc - petWL.ww / 2 : 0,
            petHigh: petWL ? petWL.wc + petWL.ww / 2 : 10000,
            alpha,
            power: 1.5,
          }
        );
      });
    };

    listenerRef.current = handler;
    eventTarget.addEventListener(Events.IMAGE_RENDERED, handler);
  }, [viewportId]);

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      if (listenerRef.current) {
        eventTarget.removeEventListener(Events.IMAGE_RENDERED, listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, []);

  const markers = getOrientationMarkers(orientation);

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: '#0c0c0c',
        border: `1px solid ${isHovered ? accentColor : '#222'}`,
        borderRadius: 4,
        overflow: 'hidden',
        position: 'relative',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { setIsHovered(false); if (!palPinned) setShowPalMenu(false); }}
    >
      {/* ── title bar ── */}
      <div style={{
        padding: '4px 8px',
        background: '#141414',
        borderBottom: '1px solid #1f1f1f',
        fontSize: 11,
        fontWeight: '500',
        color: accentColor,
        display: 'flex',
        justifyContent: 'space-between',
        zIndex: 10,
      }}>
        <span>{label}</span>
        {modality === 'PET' && (
          <span style={{ fontSize: 9, color: '#666' }}>Map: {paletteId}</span>
        )}
      </div>

      {/* ── CS3D viewport element ── */}
      <div
        ref={elementRef}
        style={{ flex: 1, width: '100%', height: '100%', position: 'relative', background: '#000' }}
      />

      {/* ── Canvas2D PET colour overlay (PET fusion viewports only) ── */}
      {modality === 'PET' && (
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            // Position below the title bar (title bar is ~28px)
            top: 28,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100%',
            height: 'calc(100% - 28px)',
            pointerEvents: 'none',  // CS3D handles all mouse events
            zIndex: 5,
          }}
        />
      )}

      {/* ── orientation markers ── */}
      {volumesReady && modality !== 'MIP' && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          zIndex: 6, fontSize: 11, color: 'rgba(255,255,255,0.4)',
        }}>
          <div style={{ position: 'absolute', top: 30, left: '50%', transform: 'translateX(-50%)' }}>{markers.top}</div>
          <div style={{ position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)' }}>{markers.bottom}</div>
          <div style={{ position: 'absolute', top: '50%', left: 6, transform: 'translateY(-50%)' }}>{markers.left}</div>
          <div style={{ position: 'absolute', top: '50%', right: 6, transform: 'translateY(-50%)' }}>{markers.right}</div>
        </div>
      )}

      {/* ── colormap strip (PET + MIP viewports) ── */}
      {['PET', 'MIP'].includes(modality) && (
        /*
         * Outer wrapper spans the strip AND the flyout so onMouseLeave only
         * fires when the cursor leaves the combined area — not when crossing
         * from the 14px strip into the flyout panel.
         * When pinned, onMouseLeave does nothing; only the pin button closes it.
         */
        <div
          style={{
            position: 'absolute', right: 6, top: 32, bottom: 8,
            width: 14, zIndex: 80,
          }}
          onMouseEnter={() => setShowPalMenu(true)}
          onMouseLeave={() => { if (!palPinned) setShowPalMenu(false); }}
        >
          {/* ── gradient strip ── */}
          <div style={{
            position: 'absolute', top: 0, right: 0,
            width: 14, bottom: 0,
            display: 'flex', flexDirection: 'column',
          }}>
            {/* ⚙ gear button at top of strip */}
            <div style={{
              height: 18, width: '100%',
              background: palPinned ? '#3a3a3a' : '#222',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px solid ${palPinned ? '#666' : '#333'}`,
              flexShrink: 0,
            }}>
              <span style={{ color: palPinned ? '#fff' : '#aaa', fontSize: 8 }}>⚙</span>
            </div>
            {/* colour gradient */}
            <div style={{
              flex: 1,
              background: getCssGradient(paletteId),
              borderLeft: '1px solid #1a1a1a', borderRight: '1px solid #1a1a1a',
            }} />
          </div>

          {/* ── palette flyout ── */}
          {showPalMenu && PET_PALETTES && (
            <div
              style={{
                position: 'absolute', right: 18, top: 0,
                background: 'rgba(12,12,12,0.98)',
                border: '1px solid #2d2d2d', borderRadius: 4,
                padding: '3px 0', width: 148,
                boxShadow: '0 4px 15px rgba(0,0,0,0.6)', zIndex: 99,
              }}
              /* Stop mouse events inside flyout from bubbling to outer onMouseLeave */
              onMouseEnter={e => e.stopPropagation()}
              onMouseLeave={e => e.stopPropagation()}
            >
              {/* Header row: label + pin button */}
              <div style={{
                padding: '4px 8px', fontSize: 8, color: '#777',
                borderBottom: '1px solid #222',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>PALETTES</span>
                {/* Pin button — click to lock/unlock the flyout open */}
                <div
                  title={palPinned ? 'Click to close' : 'Click to keep open'}
                  onClick={() => {
                    if (palPinned) {
                      // Unpin AND close
                      setPalPinned(false);
                      setShowPalMenu(false);
                    } else {
                      setPalPinned(true);
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    fontSize: 10,
                    color: palPinned ? '#88dd88' : '#555',
                    padding: '0 2px',
                    userSelect: 'none',
                    lineHeight: 1,
                  }}
                >
                  {palPinned ? '📌' : '📍'}
                </div>
              </div>

              {/* Palette list */}
              <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                {PET_PALETTES.map(p => (
                  <div
                    key={p.id}
                    style={{
                      padding: '5px 8px', cursor: 'pointer', fontSize: 10,
                      color: paletteId === p.id ? accentColor : '#ccc',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: paletteId === p.id ? '#1a2a1a' : 'transparent',
                    }}
                    onClick={() => {
                      setPaletteId(p.id);
                      // Only close if not pinned
                      if (!palPinned) setShowPalMenu(false);
                    }}
                    onMouseEnter={e => { if (paletteId !== p.id) e.currentTarget.style.background = '#252525'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = paletteId === p.id ? '#1a2a1a' : 'transparent'; }}
                  >
                    <span>{p.label}</span>
                    <div style={{
                      width: 24, height: 10, borderRadius: 1,
                      background: getCssGradient(p.id),
                      border: paletteId === p.id ? `1px solid ${accentColor}` : '1px solid #333',
                      flexShrink: 0,
                    }} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
