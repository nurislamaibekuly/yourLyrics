const DEFAULT_OPTIONS = {
  radius: 24,
  minRadius: 0,
  rampStart: 0,
  rampEnd: 1,
  directionX: 0,
  directionY: 1,
  transparentBorder: true,
};

const VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  vec2 position = gl_VertexID == 0
    ? vec2(-1.0, -1.0)
    : (gl_VertexID == 1 ? vec2(3.0, -1.0) : vec2(-1.0, 3.0));
  v_uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const BLUR_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform vec2 u_axisStep;
uniform vec2 u_direction;
uniform vec4 u_sourceRect;
uniform float u_minKernelRadius;
uniform float u_maxKernelRadius;
uniform float u_rampStart;
uniform float u_rampEnd;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 localUV = (v_uv - u_sourceRect.xy) / u_sourceRect.zw;
  vec2 direction = length(u_direction) > 0.0 ? normalize(u_direction) : vec2(0.0);
  float projectionRange = abs(direction.x) + abs(direction.y);
  float rampPosition = 0.5;

  if (projectionRange > 0.0) {
    vec2 topLeftUV = vec2(localUV.x, 1.0 - localUV.y);
    rampPosition = dot(topLeftUV - vec2(0.5), direction) / projectionRange + 0.5;
  }

  float ramp = abs(u_rampEnd - u_rampStart) < 0.000001
    ? (rampPosition >= u_rampStart ? 1.0 : 0.0)
    : clamp((rampPosition - u_rampStart) / (u_rampEnd - u_rampStart), 0.0, 1.0);
  float radius = mix(u_minKernelRadius, u_maxKernelRadius, ramp);
  float sigma = max(radius * 0.5, 0.5);
  int loopRadius = int(u_maxKernelRadius);
  vec4 colorSum = vec4(0.0);
  float weightSum = 0.0;

  for (int i = -loopRadius; i <= loopRadius; ++i) {
    float offset = float(i);
    if (abs(offset) > radius) {
      continue;
    }

    float weight = exp(-0.5 * offset * offset / (sigma * sigma));
    colorSum += texture(u_source, v_uv + u_axisStep * offset) * weight;
    weightSum += weight;
  }

  outColor = colorSum / weightSum;
}`;

const PRESENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform vec4 u_sourceRect;

in vec2 v_uv;
out vec4 outColor;

void main() {
  outColor = texture(u_source, u_sourceRect.xy + v_uv * u_sourceRect.zw);
}`;

// Each pyramid level is Gaussian-filtered before downsampling. Interpolating
// between their variances creates a continuous blur without the repeated image
// edges produced by widely spaced taps over ordinary box-filtered mipmaps.
const REALTIME_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_direction;
uniform float u_minRadius;
uniform float u_radius;
uniform float u_rampStart;
uniform float u_rampEnd;
uniform bool u_transparentBorder;
in vec2 v_uv;
out vec4 outColor;

vec4 sampleSource(vec2 uv, float lod) {
  if (u_transparentBorder && (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))))) {
    return vec4(0.0);
  }
  return textureLod(u_source, uv, lod);
}

void main() {
  vec2 direction = length(u_direction) > 0.0 ? normalize(u_direction) : vec2(0.0);
  float projectionRange = abs(direction.x) + abs(direction.y);
  vec2 topLeftUV = vec2(v_uv.x, 1.0 - v_uv.y);
  float position = projectionRange > 0.0
    ? dot(topLeftUV - vec2(0.5), direction) / projectionRange + 0.5 : 0.5;
  float ramp = abs(u_rampEnd - u_rampStart) < 0.000001
    ? (position >= u_rampStart ? 1.0 : 0.0)
    : clamp((position - u_rampStart) / (u_rampEnd - u_rampStart), 0.0, 1.0);
  // Fine repeating artwork loses its contrast at subpixel blur radii. A
  // linear radius ramp crosses that range in one or two rows and looks like a
  // hard seam. Ease the radius in continuously, including radii below 0.5px.
  float easedRamp = ramp * ramp * ramp * (ramp * (ramp * 6.0 - 15.0) + 10.0);
  float radius = mix(u_minRadius, u_radius, easedRamp);
  if (radius <= 0.0001) {
    outColor = textureLod(u_source, v_uv, 0.0);
    return;
  }
  float variance = radius * radius * 0.25;
  float level = 0.5 * log2(4.0 * variance + 1.0);
  float lower = floor(level);
  float lowerVariance = 0.25 * (exp2(2.0 * lower) - 1.0);
  float upperVariance = 0.25 * (exp2(2.0 * (lower + 1.0)) - 1.0);
  float fraction = clamp((variance - lowerVariance) / (upperVariance - lowerVariance), 0.0, 1.0);
  outColor = sampleSource(v_uv, lower + fraction);
}`;

const PYRAMID_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_step;
uniform float u_level;
uniform bool u_transparentBorder;
in vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 color = vec4(0.0);
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec2 uv = v_uv + vec2(float(x), float(y)) * u_step;
      float weight = (x == 0 ? 0.5 : 0.25) * (y == 0 ? 0.5 : 0.25);
      bool outside = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)));
      if (!u_transparentBorder || !outside) color += textureLod(u_source, uv, u_level) * weight;
    }
  }
  outColor = color;
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Unable to create a WebGL shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(gl, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Unable to create a WebGL program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown program link error.";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

function getSourceSize(source) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError("The blur source must have positive, readable dimensions.");
  }

  return { width, height };
}

function makeTexture(gl) {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error("Unable to create a WebGL texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function resizeTexture(gl, texture, width, height) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

export class VariableBlur {
  constructor(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== "function") {
      throw new TypeError("VariableBlur requires an HTML canvas.");
    }

    this.canvas = canvas;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      // Frosted labels sample the last displayed artwork between video frames.
      preserveDrawingBuffer: options.quality === 'realtime',
    });

    if (!this.gl) {
      throw new Error("WebGL2 is not available in this browser.");
    }

    const gl = this.gl;
    this.blurProgram = createProgram(gl, BLUR_SHADER);
    this.presentProgram = createProgram(gl, PRESENT_SHADER);
    this.vertexArray = gl.createVertexArray();
    this.framebuffer = gl.createFramebuffer();
    this.sourceTexture = makeTexture(gl);
    this.horizontalTexture = makeTexture(gl);
    this.verticalTexture = makeTexture(gl);

    if (!this.vertexArray || !this.framebuffer) {
      throw new Error("Unable to create WebGL rendering resources.");
    }
  }

  render(source, options = {}) {
    if (!source) {
      throw new TypeError("A blur source is required.");
    }

    this.options = { ...this.options, ...options };
    const {
      width: sourceWidth,
      height: sourceHeight,
    } = getSourceSize(source);
    const settings = this.#validatedOptions();
    if (this.options.quality === 'realtime') {
      return this.#renderRealtime(source, sourceWidth, sourceHeight, settings);
    }
    const downsample = settings.radius > 256 ? 4 : settings.radius > 64 ? 2 : 1;
    const padding = Math.ceil(settings.radius);
    const textureWidth = Math.ceil((sourceWidth + padding * 2) / downsample);
    const textureHeight = Math.ceil((sourceHeight + padding * 2) / downsample);
    const maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);

    if (textureWidth > maxTextureSize || textureHeight > maxTextureSize) {
      throw new RangeError(`Blur texture exceeds this device's ${maxTextureSize}px limit.`);
    }

    const sourceX = padding / downsample;
    const sourceY = padding / downsample;
    const scaledSourceWidth = sourceWidth / downsample;
    const scaledSourceHeight = sourceHeight / downsample;
    this.#drawPaddedSource(
      source,
      sourceWidth,
      sourceHeight,
      textureWidth,
      textureHeight,
      sourceX,
      sourceY,
      scaledSourceWidth,
      scaledSourceHeight,
      settings.transparentBorder,
    );

    this.canvas.width = sourceWidth;
    this.canvas.height = sourceHeight;
    this.#resizeTargets(textureWidth, textureHeight);

    const gl = this.gl;
    gl.bindVertexArray(this.vertexArray);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.paddedCanvas);

    const sourceRect = [
      sourceX / textureWidth,
      (textureHeight - sourceY - scaledSourceHeight) / textureHeight,
      scaledSourceWidth / textureWidth,
      scaledSourceHeight / textureHeight,
    ];
    const kernelMin = Math.floor(settings.minRadius / downsample);
    const kernelMax = Math.max(1, Math.floor(settings.radius / downsample));
    this.#drawBlurPass(
      this.sourceTexture,
      this.horizontalTexture,
      textureWidth,
      textureHeight,
      [1 / textureWidth, 0],
      sourceRect,
      settings,
      kernelMin,
      kernelMax,
    );
    this.#drawBlurPass(
      this.horizontalTexture,
      this.verticalTexture,
      textureWidth,
      textureHeight,
      [0, 1 / textureHeight],
      sourceRect,
      settings,
      kernelMin,
      kernelMax,
    );
    this.#present(sourceRect);

    return this.canvas;
  }

  dispose() {
    const gl = this.gl;
    if (this.realtimeProgram) gl.deleteProgram(this.realtimeProgram);
    if (this.realtimeTexture) gl.deleteTexture(this.realtimeTexture);
    if (this.pyramidProgram) gl.deleteProgram(this.pyramidProgram);
    for (const target of this.pyramidTargets || []) gl.deleteTexture(target.texture);
    gl.deleteProgram(this.blurProgram);
    gl.deleteProgram(this.presentProgram);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.sourceTexture);
    gl.deleteTexture(this.horizontalTexture);
    gl.deleteTexture(this.verticalTexture);
  }

  #renderRealtime(source, width, height, settings) {
    const gl = this.gl;
    if (!this.realtimeProgram) {
      this.realtimeProgram = createProgram(gl, REALTIME_SHADER);
      this.pyramidProgram = createProgram(gl, PYRAMID_SHADER);
      this.pyramidUniforms = Object.fromEntries([
        'u_source', 'u_step', 'u_level', 'u_transparentBorder'
      ].map(name => [name, gl.getUniformLocation(this.pyramidProgram, name)]));
      this.pyramidTargets = [];
      this.realtimeTexture = makeTexture(gl);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.realtimeMaxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.realtimeUniforms = Object.fromEntries([
        'u_source', 'u_direction', 'u_minRadius', 'u_radius',
        'u_rampStart', 'u_rampEnd', 'u_transparentBorder'
      ].map(name => [name, gl.getUniformLocation(this.realtimeProgram, name)]));
    }
    if (width > this.realtimeMaxSize || height > this.realtimeMaxSize) {
      throw new RangeError(`Blur texture exceeds this device's ${this.realtimeMaxSize}px limit.`);
    }
    // Changing canvas dimensions or reallocating textures every video frame
    // discards reusable GPU storage and introduces avoidable compositor stalls.
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.bindVertexArray(this.vertexArray);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.realtimeTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (this.realtimeWidth !== width || this.realtimeHeight !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      for (const target of this.pyramidTargets) gl.deleteTexture(target.texture);
      this.pyramidTargets = [];
      let levelWidth = width;
      let levelHeight = height;
      for (let level = 1; levelWidth > 1 || levelHeight > 1; level += 1) {
        levelWidth = Math.max(1, Math.floor(levelWidth / 2));
        levelHeight = Math.max(1, Math.floor(levelHeight / 2));
        gl.bindTexture(gl.TEXTURE_2D, this.realtimeTexture);
        gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA, levelWidth, levelHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const texture = makeTexture(gl);
        resizeTexture(gl, texture, levelWidth, levelHeight);
        this.pyramidTargets.push({ texture, width: levelWidth, height: levelHeight });
      }
      this.realtimeWidth = width;
      this.realtimeHeight = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    // Render into separate targets, then copy each level into the pyramid.
    // Sampling a texture while also drawing into it is a framebuffer feedback
    // loop, even when the intended source and destination mip levels differ.
    gl.bindTexture(gl.TEXTURE_2D, this.realtimeTexture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.useProgram(this.pyramidProgram);
    const pyramid = this.pyramidUniforms;
    gl.uniform1i(pyramid.u_source, 0);
    gl.uniform1i(pyramid.u_transparentBorder, settings.transparentBorder ? 1 : 0);
    let previousWidth = width;
    let previousHeight = height;
    for (const [index, target] of this.pyramidTargets.entries()) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
      gl.viewport(0, 0, target.width, target.height);
      gl.uniform2f(pyramid.u_step, 1 / previousWidth, 1 / previousHeight);
      gl.uniform1f(pyramid.u_level, index);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, index + 1, 0, 0, 0, 0, target.width, target.height);
      previousWidth = target.width;
      previousHeight = target.height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.realtimeProgram);
    const uniforms = this.realtimeUniforms;
    gl.uniform1i(uniforms.u_source, 0);
    gl.uniform2f(uniforms.u_direction, settings.directionX, settings.directionY);
    gl.uniform1f(uniforms.u_minRadius, settings.minRadius);
    gl.uniform1f(uniforms.u_radius, settings.radius);
    gl.uniform1f(uniforms.u_rampStart, settings.rampStart);
    gl.uniform1f(uniforms.u_rampEnd, settings.rampEnd);
    gl.uniform1i(uniforms.u_transparentBorder, settings.transparentBorder ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  #validatedOptions() {
    const numericKeys = ["radius", "minRadius", "rampStart", "rampEnd", "directionX", "directionY"];
    for (const key of numericKeys) {
      if (!Number.isFinite(this.options[key])) {
        throw new TypeError(`${key} must be a finite number.`);
      }
    }

    const radius = Math.max(0, this.options.radius);
    return {
      radius,
      minRadius: Math.min(radius, Math.max(0, this.options.minRadius)),
      rampStart: this.options.rampStart,
      rampEnd: this.options.rampEnd,
      directionX: this.options.directionX,
      directionY: this.options.directionY,
      transparentBorder: Boolean(this.options.transparentBorder),
    };
  }

  #drawPaddedSource(
    source,
    sourceWidth,
    sourceHeight,
    textureWidth,
    textureHeight,
    x,
    y,
    width,
    height,
    transparentBorder,
  ) {
    if (!this.paddedCanvas) {
      this.paddedCanvas = document.createElement("canvas");
      this.paddedContext = this.paddedCanvas.getContext("2d");
    }

    if (!this.paddedContext) {
      throw new Error("Unable to create the 2D canvas used to prepare the blur source.");
    }

    this.paddedCanvas.width = textureWidth;
    this.paddedCanvas.height = textureHeight;
    const context = this.paddedContext;
    context.clearRect(0, 0, textureWidth, textureHeight);
    context.imageSmoothingEnabled = true;
    context.drawImage(source, x, y, width, height);

    if (!transparentBorder && (x > 0 || y > 0)) {
      const right = x + width;
      const bottom = y + height;
      context.drawImage(source, 0, 0, 1, sourceHeight, 0, y, x, height);
      context.drawImage(source, sourceWidth - 1, 0, 1, sourceHeight, right, y, textureWidth - right, height);
      context.drawImage(source, 0, 0, sourceWidth, 1, x, 0, width, y);
      context.drawImage(source, 0, sourceHeight - 1, sourceWidth, 1, x, bottom, width, textureHeight - bottom);
      context.drawImage(source, 0, 0, 1, 1, 0, 0, x, y);
      context.drawImage(source, sourceWidth - 1, 0, 1, 1, right, 0, textureWidth - right, y);
      context.drawImage(source, 0, sourceHeight - 1, 1, 1, 0, bottom, x, textureHeight - bottom);
      context.drawImage(
        source,
        sourceWidth - 1,
        sourceHeight - 1,
        1,
        1,
        right,
        bottom,
        textureWidth - right,
        textureHeight - bottom,
      );
    }
  }

  #resizeTargets(width, height) {
    const gl = this.gl;
    resizeTexture(gl, this.horizontalTexture, width, height);
    resizeTexture(gl, this.verticalTexture, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.horizontalTexture,
      0,
    );

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Unable to create the horizontal blur framebuffer.");
    }

    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.verticalTexture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Unable to create the vertical blur framebuffer.");
    }
  }

  #drawBlurPass(sourceTexture, targetTexture, width, height, axisStep, sourceRect, settings, kernelMin, kernelMax) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      targetTexture,
      0,
    );
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1i(gl.getUniformLocation(this.blurProgram, "u_source"), 0);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, "u_axisStep"), axisStep[0], axisStep[1]);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, "u_direction"), settings.directionX, settings.directionY);
    gl.uniform4fv(gl.getUniformLocation(this.blurProgram, "u_sourceRect"), sourceRect);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, "u_minKernelRadius"), kernelMin);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, "u_maxKernelRadius"), kernelMax);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, "u_rampStart"), settings.rampStart);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, "u_rampEnd"), settings.rampEnd);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  #present(sourceRect) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.presentProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.verticalTexture);
    gl.uniform1i(gl.getUniformLocation(this.presentProgram, "u_source"), 0);
    gl.uniform4fv(gl.getUniformLocation(this.presentProgram, "u_sourceRect"), sourceRect);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
