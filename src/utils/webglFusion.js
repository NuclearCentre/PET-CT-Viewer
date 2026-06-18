/**
 * webglFusion.js — WebGL2 PET-CT fusion overlay renderer
 * Session 8 — confirmed from actual CS3D v2.1.16 source files.
 *
 * CS3D renders CT grey in the bottom row viewports normally.
 * This adds a WebGL2 canvas overlay (pointer-events:none) on top,
 * blending CT + PET pixel data using a GLSL fragment shader + LUT.
 *
 * Data flow (confirmed from VolumeViewport.js + VoxelManager.js source):
 *   vp.getSliceViewInfo() → { sliceIndex, width, height, slicePlane }
 *     width/height are voxel-space slice dimensions (IJK dot product)
 *   vp.getCurrentSlicePixelData() → typed array, size = width × height
 *     type = Float32Array for pre-scaled PET, Int16Array for CT
 *   We convert both to Float32Array for R32F texture upload.
 *
 * The WebGL canvas uses alpha:true so it is fully transparent until
 * render() is called. GL clear colour is (0,0,0,0) — transparent.
 * CS3D canvas shows through underneath at all times.
 */

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_ct;
uniform sampler2D u_pet;
uniform sampler2D u_lut;

uniform float u_ctLow;
uniform float u_ctHigh;
uniform float u_petLow;
uniform float u_petHigh;
uniform float u_alpha;
uniform float u_power;
uniform int   u_mode;

float win(float v, float lo, float hi) {
  return clamp((v - lo) / max(hi - lo, 1.0), 0.0, 1.0);
}

void main() {
  float ct  = texture(u_ct,  v_uv).r;
  float pet = texture(u_pet, v_uv).r;

  float ctN  = win(ct,  u_ctLow,  u_ctHigh);
  float petN = win(pet, u_petLow, u_petHigh);

  vec3 cCT  = vec3(ctN);
  vec3 cPET = texture(u_lut, vec2(petN, 0.5)).rgb;

  vec3 rgb;
  if (u_mode == 0) {
    rgb = mix(cCT, cPET, u_alpha);
  } else if (u_mode == 1) {
    float a = pow(max(petN, 0.0), u_power) * u_alpha;
    rgb = mix(cCT, cPET, a);
  } else {
    rgb = clamp(cCT + cPET * u_alpha, 0.0, 1.0);
  }
  fragColor = vec4(rgb, 1.0);
}`;

function _shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[webglFusion] shader:', gl.getShaderInfoLog(s));
    gl.deleteShader(s); return null;
  }
  return s;
}

function _program(gl) {
  const p = gl.createProgram();
  gl.attachShader(p, _shader(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, _shader(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[webglFusion] link:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function _tex(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function createFusionRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false });
  if (!gl) { console.error('[webglFusion] WebGL2 unavailable'); return null; }
  gl.clearColor(0, 0, 0, 0);

  const prog = _program(gl);
  if (!prog) return null;

  // Full-screen quad
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const ctTex  = _tex(gl);
  const petTex = _tex(gl);
  const lutTex = _tex(gl);

  gl.useProgram(prog);
  const U = {
    ct:     gl.getUniformLocation(prog, 'u_ct'),
    pet:    gl.getUniformLocation(prog, 'u_pet'),
    lut:    gl.getUniformLocation(prog, 'u_lut'),
    ctLow:  gl.getUniformLocation(prog, 'u_ctLow'),
    ctHigh: gl.getUniformLocation(prog, 'u_ctHigh'),
    petLow: gl.getUniformLocation(prog, 'u_petLow'),
    petHigh:gl.getUniformLocation(prog, 'u_petHigh'),
    alpha:  gl.getUniformLocation(prog, 'u_alpha'),
    power:  gl.getUniformLocation(prog, 'u_power'),
    mode:   gl.getUniformLocation(prog, 'u_mode'),
  };
  gl.uniform1i(U.ct, 0);
  gl.uniform1i(U.pet, 1);
  gl.uniform1i(U.lut, 2);

  let _ctW = 0, _ctH = 0, _petW = 0, _petH = 0;

  return {
    uploadLUT(getColorFn, paletteId) {
      const lut = new Uint8Array(256 * 3);
      for (let i = 0; i < 256; i++) {
        const [r,g,b] = getColorFn(paletteId, i / 255);
        lut[i*3] = r; lut[i*3+1] = g; lut[i*3+2] = b;
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, lut);
    },

    render(ctData, ctW, ctH, petData, petW, petH, cfg) {
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(canvas.clientWidth * dpr);
      const ch = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw; canvas.height = ch;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Upload CT — convert to Float32 if needed
      const ctF = ctData instanceof Float32Array ? ctData : new Float32Array(ctData);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, ctTex);
      if (ctW !== _ctW || ctH !== _ctH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, ctW, ctH, 0, gl.RED, gl.FLOAT, ctF);
        _ctW = ctW; _ctH = ctH;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ctW, ctH, gl.RED, gl.FLOAT, ctF);
      }

      // Upload PET — convert to Float32 if needed
      const petF = petData instanceof Float32Array ? petData : new Float32Array(petData);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, petTex);
      if (petW !== _petW || petH !== _petH) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, petW, petH, 0, gl.RED, gl.FLOAT, petF);
        _petW = petW; _petH = petH;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, petW, petH, gl.RED, gl.FLOAT, petF);
      }

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1f(U.ctLow,   cfg.ctLow);
      gl.uniform1f(U.ctHigh,  cfg.ctHigh);
      gl.uniform1f(U.petLow,  cfg.petLow);
      gl.uniform1f(U.petHigh, cfg.petHigh);
      gl.uniform1f(U.alpha,   cfg.alpha);
      gl.uniform1f(U.power,   cfg.power ?? 1.5);
      gl.uniform1i(U.mode,    cfg.mode  ?? 1);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ctTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, petTex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutTex);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    destroy() {
      try {
        gl.deleteTexture(ctTex); gl.deleteTexture(petTex); gl.deleteTexture(lutTex);
        gl.deleteProgram(prog);  gl.deleteBuffer(buf);     gl.deleteVertexArray(vao);
      } catch(e) {}
    },
  };
}

/**
 * Get current slice pixel data from a CS3D VolumeViewport.
 *
 * Confirmed from VolumeViewport.js + VoxelManager.js source:
 *   getSliceViewInfo() → { sliceIndex, width, height, slicePlane, ... }
 *     width/height are voxel-space dimensions of the slice
 *   getCurrentSlicePixelData() → typed array, length = width × height
 *
 * Returns { data, width, height } or null.
 */
export function getSlicePixelData(vp) {
  try {
    const info = vp.getSliceViewInfo();
    const data = vp.getCurrentSlicePixelData();
    if (!data || !data.length) return null;
    const w = Math.round(info.width);
    const h = Math.round(info.height);
    if (w <= 0 || h <= 0) return null;
    return { data, width: w, height: h };
  } catch(e) {
    return null;
  }
}
