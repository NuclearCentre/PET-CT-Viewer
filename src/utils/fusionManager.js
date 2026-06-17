/**
 * fusionManager.js - Manual PET-CT fusion via VTK actor user transform
 *
 * CS3D v2.1.16: Each volume in a viewport is rendered by a vtkVolume actor.
 * Calling vp.getActors() returns an array of { uid, actor } where uid is the
 * volumeId string. The actor is a vtkVolume; actor.setUserMatrix(mat) applies
 * a rigid-body transform to that actor without touching the underlying vtkImageData.
 *
 * Transform: T(centre) * Rz * Ry * Rx * T(-centre) * T(tx,ty,tz)
 *   - Rotations are around the crosshair centre (world-space intersection point)
 *   - Translations shift the PET volume in world-space mm
 *   - Applied to all 3 PET-CT viewports simultaneously
 *   - Session-scoped: fixed flag resets when the module reloads (page refresh / study change)
 *
 * No external libraries. All matrix math is plain JS 4x4 column-major arrays
 * (vtkMath convention: mat[col*4+row]).
 */

import { getRenderingEngine } from '@cornerstonejs/core';
import { RENDERING_ENGINE_ID } from '../cornerstone-init.js';
import { PET_VOLUME_ID } from './volumeManager.js';

// --- Session state ------------------------------------------------------------
const _state = {
  tx: 0, ty: 0, tz: 0,   // translation mm
  rx: 0, ry: 0, rz: 0,   // rotation degrees
  fixed: false,
};

export const PET_FUSION_VIEWPORT_IDS = ['pct-axial', 'pct-coronal', 'pct-sagittal'];

// --- Public API ---------------------------------------------------------------

export function getFusionState() {
  return { ..._state };
}

export function setFusionFixed(val) {
  _state.fixed = !!val;
}

export function isFusionFixed() {
  return _state.fixed;
}

/** Reset to identity - restores original acquisition alignment */
export function resetFusionTransform() {
  _state.tx = 0; _state.ty = 0; _state.tz = 0;
  _state.rx = 0; _state.ry = 0; _state.rz = 0;
  _state.fixed = false;
  _applyToAllViewports(_identity4());
}

/**
 * Apply 6-DOF rigid body transform to the PET actor in all 3 fusion viewports.
 * @param {number} tx - translation X (mm)
 * @param {number} ty - translation Y (mm)
 * @param {number} tz - translation Z (mm)
 * @param {number} rx - rotation around X axis (degrees)
 * @param {number} ry - rotation around Y axis (degrees)
 * @param {number} rz - rotation around Z axis (degrees)
 */
export function applyFusionTransform(tx, ty, tz, rx, ry, rz) {
  _state.tx = tx; _state.ty = ty; _state.tz = tz;
  _state.rx = rx; _state.ry = ry; _state.rz = rz;

  // Get crosshair centre from the axial PET-CT viewport camera focal point.
  // This is the world-space point rotations orbit around (Rule 12 crosshair centre).
  const centre = _getCrosshairCentre();
  const mat = _buildRigidMatrix(tx, ty, tz, rx, ry, rz, centre);
  _applyToAllViewports(mat);
}

// --- Internal helpers ---------------------------------------------------------

/** Get the focal point of the pct-axial viewport camera as rotation centre */
function _getCrosshairCentre() {
  try {
    const engine = getRenderingEngine(RENDERING_ENGINE_ID);
    const vp = engine?.getViewport('pct-axial');
    if (!vp) return [0, 0, 0];
    const cam = vp.getCamera();
    return cam?.focalPoint || [0, 0, 0];
  } catch (e) {
    return [0, 0, 0];
  }
}

/**
 * Build a 4x4 column-major matrix for T(centre)*Rz*Ry*Rx*T(-centre)*T(tx,ty,tz).
 * vtk.js uses column-major flat arrays: index = col*4 + row.
 */
function _buildRigidMatrix(tx, ty, tz, rxDeg, ryDeg, rzDeg, centre) {
  const cx = centre[0], cy = centre[1], cz = centre[2];

  // Translate to origin (T(-centre))
  const tNeg = _makeTranslation(-cx, -cy, -cz);

  // Rotation matrices
  const Rx = _makeRotX(rxDeg);
  const Ry = _makeRotY(ryDeg);
  const Rz = _makeRotZ(rzDeg);

  // Translate back (T(+centre))
  const tPos = _makeTranslation(cx, cy, cz);

  // User translation
  const tUser = _makeTranslation(tx, ty, tz);

  // Compose: tUser * tPos * Rz * Ry * Rx * tNeg
  // Read right-to-left: first move to origin, then rotate, then move back, then translate
  let m = _mul4(_mul4(tPos, Rz), _mul4(Ry, _mul4(Rx, tNeg)));
  m = _mul4(tUser, m);
  return m;
}

/** Apply a 4x4 column-major matrix to the PET actor in all fusion viewports */
function _applyToAllViewports(mat) {
  try {
    const engine = getRenderingEngine(RENDERING_ENGINE_ID);
    if (!engine) return;
    for (const vpId of PET_FUSION_VIEWPORT_IDS) {
      try {
        const vp = engine.getViewport(vpId);
        if (!vp) continue;
        const actors = vp.getActors();
        if (!actors || !actors.length) continue;
        // Find the PET actor by uid (volumeId)
        for (const actorEntry of actors) {
          if (actorEntry.uid !== PET_VOLUME_ID) continue;
          // CS3D v2.1.16: actorEntry.actor is a vtkVolume
          // vtkVolume inherits setUserMatrix from vtkProp3D
          const vtkActor = actorEntry.actor;
          if (!vtkActor || typeof vtkActor.setUserMatrix !== 'function') continue;
          vtkActor.setUserMatrix(mat);
          break;
        }
        vp.render();
      } catch (e) {
        // Log but don't crash - other viewports still get the transform
        console.warn('[fusionManager] viewport', vpId, 'actor transform failed:', e?.message);
      }
    }
  } catch (e) {
    console.warn('[fusionManager] applyToAllViewports failed:', e?.message);
  }
}

// --- 4x4 matrix math (column-major, vtk convention) -------------------------

/** Identity matrix */
function _identity4() {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/** Translation matrix */
function _makeTranslation(tx, ty, tz) {
  const m = _identity4();
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}

/** Rotation around X axis */
function _makeRotX(deg) {
  const r = deg * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const m = _identity4();
  m[5] = c;  m[9] = -s;
  m[6] = s;  m[10] = c;
  return m;
}

/** Rotation around Y axis */
function _makeRotY(deg) {
  const r = deg * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const m = _identity4();
  m[0] = c;  m[8] = s;
  m[2] = -s; m[10] = c;
  return m;
}

/** Rotation around Z axis */
function _makeRotZ(deg) {
  const r = deg * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const m = _identity4();
  m[0] = c;  m[4] = -s;
  m[1] = s;  m[5] = c;
  return m;
}

/** Multiply two 4x4 column-major matrices: result = A * B */
function _mul4(A, B) {
  const R = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += A[k * 4 + row] * B[col * 4 + k];
      }
      R[col * 4 + row] = sum;
    }
  }
  return R;
}
