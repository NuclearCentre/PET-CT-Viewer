/**
 * FusionPanel.jsx - Left-panel controls for manual PET-CT fusion
 *
 * Auto fusion:   identity transform (default, acquisition alignment)
 * Manual fusion: 6 sliders (TX/TY/TZ mm, RX/RY/RZ deg) + "Fix alignment" button
 *
 * All sliders are in sync across all 3 PET-CT viewports by default (one global
 * transform applied to all). The orientation crosshair overlay is rendered inside
 * ViewerBox directly when fusionMode === 'manual'.
 */

import { useState } from 'react';

// Slider ranges
const TX_RANGE = { min: -50, max: 50, step: 0.5, unit: 'mm', label: 'TX' };
const TY_RANGE = { min: -50, max: 50, step: 0.5, unit: 'mm', label: 'TY' };
const TZ_RANGE = { min: -50, max: 50, step: 0.5, unit: 'mm', label: 'TZ' };
const RX_RANGE = { min: -15, max: 15, step: 0.5, unit: 'deg', label: 'RX' };
const RY_RANGE = { min: -15, max: 15, step: 0.5, unit: 'deg', label: 'RY' };
const RZ_RANGE = { min: -15, max: 15, step: 0.5, unit: 'deg', label: 'RZ' };

const SLIDER_DEFS = [TX_RANGE, TY_RANGE, TZ_RANGE, RX_RANGE, RY_RANGE, RZ_RANGE];
const OFFSET_KEYS = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];

export default function FusionPanel({
  fusionMode,         // 'auto' | 'manual'
  fusionOffset,       // { tx, ty, tz, rx, ry, rz }
  fusionFixed,        // boolean
  onModeChange,       // (mode) => void
  onOffsetChange,     // (offset) => void
  onFixRequest,       // () => void  -- opens the confirmation modal in App.jsx
  onReset,            // () => void  -- back to auto/identity
}) {
  const isManual = fusionMode === 'manual';
  const hasOffset = isManual && OFFSET_KEYS.some(k => fusionOffset[k] !== 0);

  function handleSlider(key, val) {
    onOffsetChange({ ...fusionOffset, [key]: parseFloat(val) });
  }

  function handleAutoClick() {
    onReset();
    onModeChange('auto');
  }

  function handleManualClick() {
    onModeChange('manual');
  }

  const btnBase = {
    width: '100%',
    padding: '5px 8px',
    marginBottom: 4,
    border: '1px solid #555',
    borderRadius: 3,
    fontSize: 10,
    cursor: 'pointer',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    userSelect: 'none',
    background: '#1a1a1a',
    color: '#bbb',
  };

  const btnActive = {
    ...btnBase,
    background: '#1a3a1a',
    borderColor: '#4a8a4a',
    color: '#88dd88',
  };

  const btnManualActive = {
    ...btnBase,
    background: '#2a2000',
    borderColor: '#aaaa20',
    color: '#ffee44',
  };

  const sectionLabel = {
    fontSize: 9,
    color: '#555',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 5,
    paddingBottom: 3,
    borderBottom: '1px solid #222',
  };

  return (
    <div style={{ padding: '8px 8px 6px' }}>
      <div style={sectionLabel}>Fusion</div>

      <button
        style={!isManual ? btnActive : btnBase}
        onClick={handleAutoClick}
        title="Reset PET to original acquisition alignment"
      >
        <span style={{ fontSize: 13 }}>&#9635;</span> Auto fusion
      </button>

      <button
        style={isManual ? btnManualActive : btnBase}
        onClick={handleManualClick}
        title="Manually align PET over CT using 6 DOF controls"
      >
        <span style={{ fontSize: 13 }}>&#9639;</span> Manual fusion
      </button>

      {isManual && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9, color: '#888', lineHeight: 1.5, marginBottom: 8, padding: '4px 2px' }}>
            Drag sliders to shift and rotate the PET volume over CT.
            Blue crosshairs on each view show the PET alignment.
          </div>

          {/* Translation sliders */}
          <div style={{ fontSize: 9, color: '#88c4ff', marginBottom: 4, letterSpacing: '0.05em' }}>
            TRANSLATION
          </div>
          {SLIDER_DEFS.slice(0, 3).map((def, i) => (
            <SliderRow
              key={def.label}
              def={def}
              value={fusionOffset[OFFSET_KEYS[i]]}
              onChange={val => handleSlider(OFFSET_KEYS[i], val)}
              color="#88c4ff"
            />
          ))}

          {/* Rotation sliders */}
          <div style={{ fontSize: 9, color: '#ffaa44', marginBottom: 4, marginTop: 8, letterSpacing: '0.05em' }}>
            ROTATION
          </div>
          {SLIDER_DEFS.slice(3).map((def, i) => (
            <SliderRow
              key={def.label}
              def={def}
              value={fusionOffset[OFFSET_KEYS[i + 3]]}
              onChange={val => handleSlider(OFFSET_KEYS[i + 3], val)}
              color="#ffaa44"
            />
          ))}

          {/* Reset offsets */}
          {hasOffset && (
            <button
              style={{ ...btnBase, marginTop: 6, fontSize: 9, color: '#888', borderColor: '#333' }}
              onClick={onReset}
            >
              <span>&#8635;</span> Reset to acquisition
            </button>
          )}

          {/* Fix alignment */}
          <div style={{ borderTop: '1px solid #222', marginTop: 8, paddingTop: 8 }}>
            {fusionFixed ? (
              <div style={{
                background: '#2a2000', border: '1px solid #aaaa20', borderRadius: 3,
                padding: '5px 8px', fontSize: 9, color: '#ffee44',
                display: 'flex', alignItems: 'center', gap: 5,
              }}>
                <span>&#128274;</span>
                <div>
                  <div>Custom fusion fixed</div>
                  <div style={{ color: '#aa9930', marginTop: 2 }}>
                    Resets on study close
                  </div>
                </div>
              </div>
            ) : (
              <button
                style={{ ...btnBase, borderColor: '#4a8a4a', color: '#88dd88', background: '#0d2010' }}
                onClick={onFixRequest}
                disabled={!hasOffset}
                title={hasOffset ? 'Lock this alignment for the session' : 'Adjust sliders first'}
              >
                <span>&#128274;</span> Fix this alignment
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Slider row ---------------------------------------------------------------
function SliderRow({ def, value, onChange, color }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
        <span style={{ fontSize: 9, color: color, fontFamily: 'monospace' }}>{def.label}</span>
        <span style={{ fontSize: 9, color: '#bbb', fontFamily: 'monospace', minWidth: 44, textAlign: 'right' }}>
          {value >= 0 ? '+' : ''}{value.toFixed(1)}{def.unit}
        </span>
      </div>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ width: '100%', accentColor: color, height: 3, cursor: 'pointer' }}
      />
    </div>
  );
}
