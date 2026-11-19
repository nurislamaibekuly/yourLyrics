// Each glass canvas owns its program, captured backdrop and filtered pyramid.
// Independent source textures avoid framebuffer feedback while constructing
// the levels sampled by the distance-dependent blur stage.

import { resolveGlassOptics } from './glass-optics.js';
import { MAX_RECTANGLES } from './liquid-glass.js';
import { PYRAMID_SHADER, FRAGMENT_SHADER, VERTEX_SHADER } from './shaders.js';

// 16 rectangles of 4 floats each, matching the shader's uniform array.
const MAX_RECTANGLE_FLOATS = MAX_RECTANGLES * 4;

const UNIFORM_NAMES = [
  'u_resolution',
  'u_contentsScale',
  'u_touchPoint',
  'u_pressGlow',
  'u_pressProgress',
  'u_pressStretch',
  'u_pressInflate',
  'u_shapeMergeSmoothness',
  'u_cornerRadius',
  'u_cornerRoundnessExponent',
];

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown error';
    gl.deleteShader(shader);
    throw new Error(`solarium: shader compilation failed — ${log}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'unknown error';
    gl.deleteProgram(program);
    throw new Error(`solarium: program link failed — ${log}`);
  }
  return program;
}

export class LiquidGlassRenderer {
  // Probing is cached because constructing a throwaway context per control is
  // both slow and, in some browsers, rate-limited.
  static isSupported() {
    if (LiquidGlassRenderer.supported === undefined) {
      LiquidGlassRenderer.supported = Boolean(document.createElement('canvas').getContext('webgl2'));
    }
    return LiquidGlassRenderer.supported;
  }

  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      // The shader writes premultiplied colours (the edge anti-aliasing fades
      // RGB and alpha together), so the context has to agree.
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) {
      throw new Error('solarium: WebGL2 is unavailable');
    }

    this.gl = gl;
    this.canvas = canvas;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.pyramidProgram = createProgram(gl, VERTEX_SHADER, PYRAMID_SHADER);
    this.vao = gl.createVertexArray();

    this.locations = {};
    for (const name of UNIFORM_NAMES) {
      // Optional geometry inputs may be optimized out; their setters skip
      // null locations.
      this.locations[name] = gl.getUniformLocation(this.program, name);
    }
    // Array uniforms report a [0] suffix. Cache their type once so the same
    // upload path handles every optional stage without per-frame reflection.
    this.opticsLocations = [];
    for (let i = 0; i < gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS); i += 1) {
      const info = gl.getActiveUniform(this.program, i);
      if (!/^(bg_|hl_|edge_)/.test(info.name)) continue;
      this.opticsLocations.push({
        name: info.name.replace(/\[0\]$/, ''),
        type: info.type,
        location: gl.getUniformLocation(this.program, info.name),
      });
    }
    this.rectanglesLocation = gl.getUniformLocation(this.program, 'u_rectangles');
    this.rectangleParamsLocation = gl.getUniformLocation(this.program, 'u_rectangleParams');
    this.backgroundLocation = gl.getUniformLocation(this.program, 'u_background');

    this.pyramidLocations = {
      source: gl.getUniformLocation(this.pyramidProgram, 'u_source'),
      extent: gl.getUniformLocation(this.pyramidProgram, 'u_sourceExtent'),
      axis: gl.getUniformLocation(this.pyramidProgram, 'u_sampleAxis'),
    };

    this.backgroundTexture = this.createTexture();
    this.backgroundWidth = 0;
    this.backgroundHeight = 0;
    this.hasBackground = false;
    this.pyramidTargets = [];
    this.rectangles = new Float32Array(MAX_RECTANGLE_FLOATS);
    this.rectangleParams = new Float32Array(MAX_RECTANGLES * 2);

    // Uploading top row first is what the vertex shader's flipped UVs expect.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // The backdrop stage unpremultiplies samples before spectral weighting.
    // Uploading straight RGB would brighten translucent captures twice.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }

  createTexture(mipmapped = true) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  // Upload the capture and rebuild only the levels that belong to its size.
  setBackground(source) {
    const gl = this.gl;
    const width = source.width;
    const height = source.height;
    if (!width || !height) {
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    const resized = this.backgroundWidth !== width || this.backgroundHeight !== height;
    if (resized) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    this.hasBackground = true;

    if (resized) {
      this.backgroundWidth = width;
      this.backgroundHeight = height;
      this.disposeTargets();
    }
    this.updatePyramid();
  }

  resize(width, height) {
    if (this.canvas.width !== width) {
      this.canvas.width = width;
    }
    if (this.canvas.height !== height) {
      this.canvas.height = height;
    }
  }

  draw(uniforms, blurSigma) {
    if (!this.hasBackground) {
      return;
    }

    const gl = this.gl;
    // The backdrop stage chooses its LOD from distance-dependent blur stops.
    // Pre-blurring here would convolve that material a second time.
    const background = this.backgroundTexture;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    this.setUniforms(uniforms);
    const optics = resolveGlassOptics(uniforms, {
      width: this.backgroundWidth, height: this.backgroundHeight, blurRadius: blurSigma,
    });
    for (const { name, type, location } of this.opticsLocations) {
      const value = optics[name];
      if (value === undefined) throw new Error(`solarium: missing glass parameter ${name}`);
      if (type === gl.FLOAT) gl.uniform1f(location, value);
      else if (type === gl.FLOAT_VEC2) gl.uniform2fv(location, value);
      else if (type === gl.FLOAT_VEC3) gl.uniform3fv(location, value);
      else if (type === gl.FLOAT_VEC4) gl.uniform4fv(location, value);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, background);
    if (this.backgroundLocation) {
      gl.uniform1i(this.backgroundLocation, 0);
    }

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  setUniforms(uniforms) {
    const gl = this.gl;
    const locations = this.locations;
    const set = (name, upload) => {
      const location = locations[name];
      if (location) {
        upload(location);
      }
    };

    set('u_resolution', location => gl.uniform2fv(location, uniforms.resolution));
    set('u_contentsScale', location => gl.uniform1f(location, uniforms.contentsScale));
    set('u_touchPoint', location => gl.uniform2fv(location, uniforms.touchPoint));
    set('u_pressGlow', location => gl.uniform1f(location, uniforms.pressGlow ?? 0.3));
    set('u_pressProgress', location => gl.uniform1f(location, uniforms.pressProgress ?? 0));
    set('u_pressStretch', location => gl.uniform2fv(location, uniforms.pressStretch ?? [0, 0]));
    set('u_pressInflate', location => gl.uniform1f(location, uniforms.pressInflate ?? 0));
    set('u_shapeMergeSmoothness', location => gl.uniform1f(location, uniforms.shapeMergeSmoothness));
    set('u_cornerRadius', location => gl.uniform1f(location, uniforms.cornerRadius));
    set('u_cornerRoundnessExponent', location => gl.uniform1f(location, uniforms.cornerRoundnessExponent));

    // The whole array is uploaded in one call: dynamic indexing of a uniform
    // array is not portable when the elements are set individually.
    const rects = uniforms.rectangles;
    const count = Math.min(rects.length, MAX_RECTANGLES);
    this.rectangles.fill(0);
    this.rectangleParams.fill(0);
    for (let i = 0; i < count; i += 1) {
      const rect = rects[i];
      this.rectangles[i * 4] = rect.x;
      this.rectangles[i * 4 + 1] = rect.y;
      this.rectangles[i * 4 + 2] = rect.width;
      this.rectangles[i * 4 + 3] = rect.height;
      this.rectangleParams[i * 2] = rect.radius ?? -1;
      this.rectangleParams[i * 2 + 1] = rect.opacity ?? 1;
    }
    if (this.rectanglesLocation) {
      gl.uniform4fv(this.rectanglesLocation, this.rectangles);
    }
    if (this.rectangleParamsLocation) {
      gl.uniform2fv(this.rectangleParamsLocation, this.rectangleParams);
    }
    if (this.locations.u_rectangleCount === undefined) {
      this.locations.u_rectangleCount = gl.getUniformLocation(this.program, 'u_rectangleCount');
    }
    if (this.locations.u_rectangleCount) {
      gl.uniform1i(this.locations.u_rectangleCount, count);
    }
  }

  updatePyramid() {
    const gl = this.gl;
    gl.useProgram(this.pyramidProgram);
    gl.uniform1i(this.pyramidLocations.source, 0);
    gl.bindVertexArray(this.vao);
    let width = this.backgroundWidth;
    let height = this.backgroundHeight;
    let source = this.backgroundTexture;
    let level = 0;
    while (width > 1 || height > 1) {
      const nextWidth = Math.max(1, Math.floor(width / 2));
      const nextHeight = Math.max(1, Math.floor(height / 2));
      let target = this.pyramidTargets[level];
      if (!target) {
        const makeTarget = (targetWidth, targetHeight) => {
          const texture = this.createTexture(false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetWidth, targetHeight, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);
          const framebuffer = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
          return { texture, framebuffer };
        };
        const horizontal = makeTarget(nextWidth, height);
        target = { ...makeTarget(nextWidth, nextHeight), horizontal };
        this.pyramidTargets.push(target);
        gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
        gl.texImage2D(gl.TEXTURE_2D, level + 1, gl.RGBA, nextWidth, nextHeight, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      // Complete only the levels that are ready to be sampled. The horizontal
      // intermediate keeps the two resampling axes independent.
      gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.horizontal.framebuffer);
      gl.viewport(0, 0, nextWidth, height);
      gl.uniform2f(this.pyramidLocations.extent, width, height);
      gl.uniform2f(this.pyramidLocations.axis, 1, 0);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, nextWidth, nextHeight);
      gl.uniform2f(this.pyramidLocations.extent, nextWidth, height);
      gl.uniform2f(this.pyramidLocations.axis, 0, 1);
      gl.bindTexture(gl.TEXTURE_2D, target.horizontal.texture);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // Copy into the sampling pyramid only after drawing to an independent
      // texture. Sampling an attached texture would create a feedback loop.
      gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, level + 1, 0, 0, 0, 0, nextWidth, nextHeight);
      source = target.texture;
      width = nextWidth;
      height = nextHeight;
      level += 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  disposeTargets() {
    const gl = this.gl;
    for (const { texture, framebuffer, horizontal } of this.pyramidTargets) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(horizontal.framebuffer);
      gl.deleteTexture(horizontal.texture);
    }
    this.pyramidTargets = [];
  }

  dispose() {
    const gl = this.gl;
    this.disposeTargets();
    gl.deleteTexture(this.backgroundTexture);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.pyramidProgram);
    this.hasBackground = false;
  }
}
