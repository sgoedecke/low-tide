const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform highp sampler2D uFields;
uniform highp sampler2D uFlow;
uniform vec2 uGrid;
uniform vec2 uResolution;
uniform float uTime;
out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * .1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

vec4 sampleGrid(sampler2D map, vec2 p) {
#ifdef FLOAT_LINEAR
  return texture(map, (p + .5) / uGrid);
#else
  p = clamp(p, vec2(0), uGrid - 1.0);
  ivec2 a = ivec2(floor(p));
  ivec2 b = min(a + 1, ivec2(uGrid) - 1);
  vec2 f = fract(p);
  return mix(mix(texelFetch(map, a, 0), texelFetch(map, ivec2(b.x, a.y), 0), f.x),
             mix(texelFetch(map, ivec2(a.x, b.y), 0), texelFetch(map, b, 0), f.x), f.y);
#endif
}

vec4 field(vec2 p) { return sampleGrid(uFields, p); }

// Cubic reconstruction rounds the low-resolution height field without changing
// physics or blurring water through the player's walls.
float heightAt(vec2 p) {
  vec2 f = fract(p), base = floor(p);
  vec2 w0 = pow(1.0 - f, vec2(3)) / 6.0;
  vec2 w1 = (3.0 * f * f * f - 6.0 * f * f + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f * f * f + 3.0 * f * f + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 a = base - 1.0 + w1 / g0;
  vec2 b = base + 1.0 + w3 / g1;
  return g0.y * (g0.x * field(a).r + g1.x * field(vec2(b.x, a.y)).r)
       + g1.y * (g0.x * field(vec2(a.x, b.y)).r + g1.x * field(b).r);
}

float shadowAt(vec2 p, float height) {
  float occlusion = 0.0;
  for (int i = 1; i <= 6; i++) {
    float distance = float(i) * 2.0;
    float blocker = heightAt(p + vec2(-.6, -.8) * distance);
    float rayHeight = height + distance * .24;
    float penumbra = .10 + distance * .035;
    occlusion = max(occlusion, smoothstep(-penumbra, penumbra, blocker - rayHeight));
  }
  return 1.0 - occlusion * .27;
}

void main() {
  vec2 uv = vec2(gl_FragCoord.x / uResolution.x, 1.0 - gl_FragCoord.y / uResolution.y);
  vec2 p = uv * uGrid - .5;
  vec4 cell = field(p);
  float depth = max(0.0, cell.g);
  vec4 flow = sampleGrid(uFlow, p);
  vec2 current = flow.xy / max(.15, depth);
  float speed = min(4.0, length(current));
  vec3 sunlight = normalize(vec3(-.45, -.6, .85));

  // Small crossing swells perturb the reflected sky, not the simulated volume.
  vec2 wavePoint = p + vec2(noise(p * .1 + uTime * .03), noise(p * .1 + 24.0)) * 5.0;
  float a = dot(wavePoint, vec2(.72, .21)) - uTime * 1.8;
  float b = dot(wavePoint, vec2(-.34, .91)) + uTime * 1.15;
  float c = dot(wavePoint, vec2(1.38, -.53)) - uTime * 2.2;
  vec2 ripple = vec2(.72, .21) * cos(a) * .14
              + vec2(-.34, .91) * cos(b) * .10
              + vec2(1.38, -.53) * cos(c) * .045;
  ripple += (vec2(noise(p * 1.5 + uTime * .25), noise(p * 1.5 + 17.0 - uTime * .2)) - .5) * .1;
  vec4 surfaceL = field(p - vec2(.7, 0)), surfaceR = field(p + vec2(.7, 0));
  vec4 surfaceU = field(p - vec2(0, .7)), surfaceD = field(p + vec2(0, .7));
  vec2 swellSlope = vec2(surfaceL.r + surfaceL.g - surfaceR.r - surfaceR.g,
                        surfaceU.r + surfaceU.g - surfaceD.r - surfaceD.g);
  ripple += clamp(swellSlope * .7, vec2(-.25), vec2(.25)) * smoothstep(.02, .25, depth);
  vec3 waterNormal = normalize(vec3(ripple, 1.0));
  vec2 floorPoint = p + ripple * min(depth, 1.5) * 1.4 * smoothstep(.015, .15, depth);
  vec4 ground = field(floorPoint);
  ground.r = heightAt(floorPoint);
  float left = heightAt(floorPoint - vec2(.6, 0));
  float right = heightAt(floorPoint + vec2(.6, 0));
  float up = heightAt(floorPoint - vec2(0, .6));
  float down = heightAt(floorPoint + vec2(0, .6));
  vec2 slope = vec2(left - right, up - down) * 2.3;
  vec2 sandBump = vec2(noise(floorPoint * 5.0), noise(floorPoint * 5.0 + 31.0)) - .5;
  vec3 normal = normalize(vec3(slope + sandBump * .12, 1.0));
  float light = .72 + .4 * max(0.0, dot(normal, sunlight));
  float cavity = max(0.0, (left + right + up + down) * .25 - ground.r);
  float ambient = 1.0 - min(.18, cavity * .36);
  float shadow = shadowAt(floorPoint, ground.r);

  float broadGrain = noise(floorPoint * .22);
  float grains = hash(floor(floorPoint * 13.0));
  float fineGrain = noise(floorPoint * 4.5);
  float wind = sin(floorPoint.y * 2.4 + noise(floorPoint * .13) * 9.0);
  float damp = clamp(ground.b, 0.0, 1.0);
  vec3 sand = mix(vec3(.92, .82, .63), vec3(.64, .57, .41), damp * .85);
  sand += (broadGrain - .5) * vec3(.05, .045, .035);
  sand += (grains - .5) * .045 + (fineGrain - .5) * .025;
  sand += wind * .009 * (1.0 - damp) * exp(-length(slope));
  sand *= light * ambient * shadow;
  // A few quartz grains catch the light; the texture stays fixed to the beach.
  sand += pow(grains, 42.0) * .055 * (1.0 - damp) * max(0.0, normal.z);
  vec3 color = sand;

  if (depth > .001) {
    vec2 causticPoint = floorPoint * .85 + vec2(uTime * .19, -uTime * .12);
    causticPoint += vec2(noise(causticPoint * .5), noise(causticPoint * .5 + 9.0)) * 2.2;
    float caustic = min(abs(sin(causticPoint.x + sin(causticPoint.y))),
                        abs(sin(causticPoint.y * 1.17 + sin(causticPoint.x * .83))));
    float focus = pow(1.0 - caustic, 16.0);
    sand += vec3(.16, .19, .12) * focus * exp(-depth * .8) * smoothstep(.02, .2, depth) * shadow;
    vec3 transmission = exp(-depth * vec3(2.8, 1.35, .95));
    vec3 scatter = mix(vec3(.055, .40, .43), vec3(.04, .25, .32), smoothstep(.3, 2.5, depth));
    color = sand * transmission + scatter * (1.0 - transmission);
    float silt = clamp(flow.z / max(.05, depth) * 1.4, 0.0, .3);
    color = mix(color, vec3(.49, .47, .29), silt);
    float cloud = noise(p * .035 + ripple * .6 + vec2(uTime * .012, 0));
    vec3 sky = mix(vec3(.38, .64, .67), vec3(.83, .88, .80), smoothstep(.3, .8, cloud));
    float fresnel = .045 + pow(1.0 - waterNormal.z, 3.0) * .5;
    color = mix(color, sky, fresnel * smoothstep(.005, .1, depth));
    vec3 halfLight = normalize(sunlight + vec3(0, 0, 1));
    float sunGlint = pow(max(0.0, dot(waterNormal, halfLight)), 180.0);
    color += vec3(1.0, .95, .77) * sunGlint * .4 * smoothstep(.025, .25, depth);
    float crestLight = flow.a * (.65 + .35 * noise(p * 1.2 + ripple));
    color = mix(color, vec3(.62, .82, .81), crestLight * .42 * smoothstep(.08, .4, depth));

    float dx = surfaceR.g - surfaceL.g;
    float dy = surfaceD.g - surfaceU.g;
    float shoreDistance = depth / max(.008, length(vec2(dx, dy)));
    float shoreFoam = (1.0 - smoothstep(.12, 1.5, shoreDistance))
                    * smoothstep(.003, .018, depth) * (1.0 - smoothstep(.15, .35, depth));
    vec2 foamPoint = p * 3.2 - current * sin(uTime * .6) * .13;
    float bubbles = noise(foamPoint) + noise(foamPoint * 3.1) * .32;
    float lace = smoothstep(.37, .8, bubbles);
    float foam = clamp(shoreFoam * .9 + cell.a * (1.2 + speed * .1), 0.0, .95) * lace;
    color = mix(color, vec3(.96, .97, .88), foam);
    color = mix(sand, color, smoothstep(.001, .014, depth));
  }
  // A restrained warm grade keeps the water and sand under the same afternoon sun.
  color *= vec3(1.015, 1.0, .97);
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

export class BeachRenderer {
  constructor(canvas, beach) {
    this.canvas = canvas;
    this.beach = beach;
    this.ready = false;
    this.fields = new Float32Array(beach.size * 4);
    this.flow = new Float32Array(beach.size * 4);
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!this.gl) {
      this.report('Detailed graphics are unavailable. Using the basic beach renderer.');
      return;
    }
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.ready = false;
      this.report('Graphics paused by your device. Using the basic beach renderer while it recovers.');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.initialize();
      if (this.ready) console.info('Detailed beach graphics restored.');
    });
    this.initialize();
  }

  report(message) {
    console.warn(message);
  }

  compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      console.error('Could not allocate a beach shader.');
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Beach shader compilation failed:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  initialize() {
    this.ready = false;
    const gl = this.gl;
    const linear = Boolean(gl.getExtension('OES_texture_float_linear'));
    const fragment = linear ? fragmentSource.replace('precision highp float;', '#define FLOAT_LINEAR\nprecision highp float;') : fragmentSource;
    const vertexShader = this.compile(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compile(gl.FRAGMENT_SHADER, fragment);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      this.report('Detailed graphics could not start. Using the basic beach renderer.');
      return;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      this.report('Graphics memory is unavailable. Using the basic beach renderer.');
      return;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Beach shader linking failed:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      this.report('Detailed graphics could not start. Using the basic beach renderer.');
      return;
    }
    this.program = program;
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(['uGrid', 'uResolution', 'uTime'].map(name => [name, gl.getUniformLocation(program, name)]));
    this.textures = [];
    const samplers = ['uFields', 'uFlow'];
    for (let unit = 0; unit < samplers.length; unit++) {
      const texture = gl.createTexture();
      if (!texture) {
        for (const allocated of this.textures) gl.deleteTexture(allocated);
        gl.deleteProgram(program);
        this.report('Graphics memory is unavailable. Using the basic beach renderer.');
        return;
      }
      this.textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.beach.width, this.beach.height, 0, gl.RGBA, gl.FLOAT, null);
      gl.uniform1i(gl.getUniformLocation(program, samplers[unit]), unit);
    }
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      console.error('Beach texture initialization failed:', error);
      for (const texture of this.textures) gl.deleteTexture(texture);
      gl.deleteProgram(program);
      this.report('Detailed graphics could not start. Using the basic beach renderer.');
      return;
    }
    gl.uniform2f(this.uniforms.uGrid, this.beach.width, this.beach.height);
    this.ready = true;
  }

  resize(width, height) {
    const scale = Math.min(1, Math.sqrt(1800000 / Math.max(1, width * height)));
    this.canvas.width = Math.max(1, Math.round(width * scale));
    this.canvas.height = Math.max(1, Math.round(height * scale));
  }

  render() {
    const gl = this.gl, beach = this.beach;
    for (let i = 0; i < beach.size; i++) {
      const j = i * 4;
      this.fields[j] = beach.bed[i];
      this.fields[j + 1] = beach.water[i];
      this.fields[j + 2] = beach.wet[i];
      this.fields[j + 3] = beach.foam[i];
      this.flow[j] = beach.flowX[i];
      this.flow[j + 1] = beach.flowY[i];
      this.flow[j + 2] = beach.sediment[i];
      const x = i % beach.width, y = Math.floor(i / beach.width);
      let crest = 0;
      if (y < beach.offshore[x]) {
        // Pick out the tops of the same travelling pulses that drive the
        // reservoir. Fade to purely simulated surface shading near the shore.
        for (const wave of beach.waves) {
          const phase = beach.wavePhaseAt(wave, x, y);
          crest += Math.max(0, 1 - Math.abs(phase - .5) / .065) ** 3;
        }
      }
      this.flow[j + 3] = Math.min(1, crest) * Math.min(1, Math.max(0, (beach.offshore[x] - y) / 8));
    }
    gl.useProgram(this.program);
    for (let unit = 0; unit < 2; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, beach.width, beach.height, gl.RGBA, gl.FLOAT, unit === 0 ? this.fields : this.flow);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.uTime, beach.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
