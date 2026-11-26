/*
 * Adapted from Jorge Toloza's WebGL Progressive Blur (MIT, copyright 2024).
 * https://github.com/JorgeCapillo/webgl-progressive-blur
 * Original blur inspiration: @anastadunbar, https://www.shadertoy.com/view/4tSyzy
 * Source revision: 90e712c747081f22ded2f6dcebe554d24149ae5b.
 * The paired jitter sampling is retained. The app supplies the composed canvas,
 * a pixel-based radius and blur ramp; the demo's TV grain and color subtraction
 * are omitted. See LICENSE beside this file for the complete license.
 */
const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 position = gl_VertexID == 0 ? vec2(-1.0,-1.0)
    : gl_VertexID == 1 ? vec2(3.0,-1.0) : vec2(-1.0,3.0);
  v_uv = position * 0.5 + 0.5;
  gl_Position = vec4(position,0.0,1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
uniform vec2 u_direction;
uniform float u_radius;
uniform float u_minRadius;
uniform float u_rampStart;
uniform float u_rampEnd;
uniform float u_archLift;
uniform float u_maxLod;
uniform bool u_transparentBorder;
in vec2 v_uv;
out vec4 outColor;

float rand(vec2 co) {
  return fract(sin(dot(co,vec2(12.9898,78.233))) * 43758.5453);
}
vec4 draw(vec2 uv, float lod) {
  if (u_transparentBorder && (any(lessThan(uv,vec2(0.0))) || any(greaterThan(uv,vec2(1.0))))) return vec4(0.0);
  return textureLod(u_source,uv,lod);
}
void main() {
  vec2 direction = length(u_direction) > 0.0 ? normalize(u_direction) : vec2(0.0);
  float span = abs(direction.x) + abs(direction.y);
  vec2 topLeftUV = vec2(v_uv.x,1.0-v_uv.y);
  float position = span > 0.0 ? dot(topLeftUV-vec2(0.5),direction)/span+0.5 : 0.5;
  float dx = (topLeftUV.x - 0.5) * 2.0;
  float edgeArch = u_archLift * (dx * dx);
  float ramp = abs(u_rampEnd-u_rampStart) < 0.000001
    ? (position >= u_rampStart ? 1.0 : 0.0)
    : clamp((position-u_rampStart)/(u_rampEnd-u_rampStart) + edgeArch,0.0,1.0);
  float strength = ramp*ramp*ramp*(ramp*(ramp*6.0-15.0)+10.0);
  float curve = u_archLift > 0.0 ? strength * strength : strength;
  float radius = mix(u_minRadius,u_radius,curve);
  if (radius <= 0.0001) { outColor=draw(v_uv,0.0); return; }

  const float repeats=40.0;
  float lod=clamp(log2(max(1.0,radius*0.25)),0.0,u_maxLod);
  vec2 pixelRadius=vec2(radius)/u_sourceSize;
  vec4 blurredImage=vec4(0.0);
  for (int sampleIndex=0;sampleIndex<40;sampleIndex++) {
    float i=float(sampleIndex);
    // Golden-angle spiral + Gaussian-weighted radial jitter for smooth diffusion.
    float angle=i*2.39996323;
    vec2 unitDirection=vec2(cos(angle),sin(angle));
    float r1=pow(rand(vec2(i,v_uv.x+v_uv.y)),1.35);
    blurredImage+=draw(v_uv+unitDirection*r1*pixelRadius,lod)*0.5;
    float r2=pow(rand(vec2(i+2.0,v_uv.x+v_uv.y+24.0)),1.35);
    blurredImage+=draw(v_uv+unitDirection*r2*pixelRadius,lod)*0.5;
  }
  vec4 blurred=blurredImage/repeats;
  outColor=mix(draw(v_uv,0.0),blurred,smoothstep(0.0,2.0,radius));
}`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(error || 'Unable to compile the progressive blur shader.');
  }
  return shader;
}

export class ProgressiveBlur {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true,
      antialias: false, depth: false, stencil: false
    });
    if (!gl) throw new Error('Progressive blur requires WebGL2.');
    const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(this.program);
      gl.deleteProgram(this.program);
      throw new Error(error || 'Unable to link the progressive blur shader.');
    }
    this.vertexArray = gl.createVertexArray();
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.uniforms = Object.fromEntries([
      'u_source','u_sourceSize','u_direction','u_radius','u_minRadius',
      'u_rampStart','u_rampEnd','u_archLift','u_maxLod','u_transparentBorder'
    ].map(name => [name, gl.getUniformLocation(this.program, name)]));
  }

  render(source, options = {}) {
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (!(width > 0 && height > 0) || width > this.maxTextureSize || height > this.maxTextureSize) {
      throw new RangeError('The progressive blur source has unsupported dimensions.');
    }
    const settings = { radius:24, minRadius:0, rampStart:0, rampEnd:1, archLift:0,
      directionX:0, directionY:1, transparentBorder:true, ...options };
    for (const key of ['radius','minRadius','rampStart','rampEnd','archLift','directionX','directionY']) {
      if (!Number.isFinite(settings[key])) throw new TypeError(`${key} must be finite.`);
    }
    const gl = this.gl;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.bindVertexArray(this.vertexArray);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (this.width !== width || this.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
      this.width = width; this.height = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,width,height);
    // The clone remains in the input texture, including its offscreen pixels.
    // Only skip output fragments below the wrapper's visible viewport.
    const visibleHeight = Math.min(height, Math.max(1, Math.ceil(settings.viewportHeight || height)));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0,height-visibleHeight,width,visibleHeight);
    gl.useProgram(this.program);
    const uniforms = this.uniforms;
    gl.uniform1i(uniforms.u_source,0);
    gl.uniform2f(uniforms.u_sourceSize,width,height);
    gl.uniform2f(uniforms.u_direction,settings.directionX,settings.directionY);
    gl.uniform1f(uniforms.u_radius,Math.max(0,settings.radius));
    gl.uniform1f(uniforms.u_minRadius,Math.min(Math.max(0,settings.minRadius),Math.max(0,settings.radius)));
    gl.uniform1f(uniforms.u_rampStart,settings.rampStart);
    gl.uniform1f(uniforms.u_rampEnd,settings.rampEnd);
    gl.uniform1f(uniforms.u_archLift,Math.max(0,settings.archLift));
    gl.uniform1f(uniforms.u_maxLod,Math.max(0,Math.floor(Math.log2(Math.max(width,height)))));
    gl.uniform1i(uniforms.u_transparentBorder,settings.transparentBorder ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.disable(gl.SCISSOR_TEST);
    return this.canvas;
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteVertexArray(this.vertexArray);
  }
}
