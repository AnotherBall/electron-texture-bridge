// Raymarching VJ Visual - Fragment Shader
// Inspired by Shadertoy / demoscene aesthetics

precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
uniform float u_beat;

varying vec2 v_uv;

#define PI 3.14159265359
#define TAU 6.28318530718
#define MAX_STEPS 50
#define MAX_DIST 50.0
#define SURF_DIST 0.001

mat2 rot2D(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdOctahedron(vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

vec3 opRep(vec3 p, vec3 c) {
  return mod(p + 0.5 * c, c) - 0.5 * c;
}

float map(vec3 p) {
  float t = u_time;
  float beat = u_beat;
  float bass = u_bass;

  p.xy *= rot2D(t * 0.3);
  p.yz *= rot2D(t * 0.2);

  float spacing = 3.0 + bass * 0.5;
  vec3 q = opRep(p, vec3(spacing));

  float morph = sin(t * 0.5) * 0.5 + 0.5;
  float sphere = sdSphere(q, 0.5 + beat * 0.3);
  float box = sdBox(q, vec3(0.4 + bass * 0.1));
  float octa = sdOctahedron(q, 0.7);

  float d1 = mix(sphere, box, morph);
  d1 = mix(d1, octa, sin(t * 0.3) * 0.5 + 0.5);

  vec3 torusP = p;
  torusP.xz *= rot2D(t);
  float torus1 = sdTorus(torusP, vec2(2.0 + u_mid, 0.1 + u_high * 0.05));

  torusP = p;
  torusP.xy *= rot2D(t * 0.7);
  float torus2 = sdTorus(torusP, vec2(2.5 + u_bass * 0.3, 0.08));

  torusP = p;
  torusP.yz *= rot2D(t * 0.5);
  float torus3 = sdTorus(torusP, vec2(3.0, 0.06 + beat * 0.1));

  float d = smin(d1, torus1, 0.3);
  d = smin(d, torus2, 0.3);
  d = smin(d, torus3, 0.3);

  float wave = sin(p.x * 2.0 + t) * sin(p.z * 2.0 + t * 0.7) * 0.2;
  float ground = p.y + 4.0 + wave + bass;

  d = smin(d, ground, 1.0);

  return d;
}

vec3 calcNormal(vec3 p) {
  const float h = 0.0001;
  const vec2 k = vec2(1, -1);
  return normalize(
    k.xyy * map(p + k.xyy * h) +
    k.yyx * map(p + k.yyx * h) +
    k.yxy * map(p + k.yxy * h) +
    k.xxx * map(p + k.xxx * h)
  );
}

float rayMarch(vec3 ro, vec3 rd) {
  float d = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * d;
    float ds = map(p);
    d += ds;
    if (d > MAX_DIST || ds < SURF_DIST) break;
  }
  return d;
}


vec3 palette(float t) {
  vec3 a = vec3(0.5, 0.5, 0.5);
  vec3 b = vec3(0.5, 0.5, 0.5);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.263, 0.416, 0.557);
  d += vec3(u_bass * 0.2, u_mid * 0.1, u_high * 0.3);
  return a + b * cos(TAU * (c * t + d));
}

vec3 getGlow(vec3 rd, vec3 lightPos, vec3 color) {
  vec3 lightDir = normalize(lightPos);
  float glow = pow(max(dot(rd, lightDir), 0.0), 32.0);
  return color * glow * 2.0;
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  float t = u_time;
  float beat = u_beat;

  vec3 ro = vec3(
    sin(t * 0.3) * 6.0,
    2.0 + sin(t * 0.5) * 2.0 + beat,
    cos(t * 0.3) * 6.0
  );

  vec3 lookAt = vec3(0.0, 0.0, 0.0);
  vec3 forward = normalize(lookAt - ro);
  vec3 right = normalize(cross(vec3(0, 1, 0), forward));
  vec3 up = cross(forward, right);

  float fov = 1.0 - beat * 0.1;
  vec3 rd = normalize(forward * fov + uv.x * right + uv.y * up);

  float d = rayMarch(ro, rd);

  vec3 col = vec3(0.02, 0.02, 0.05);
  col += getGlow(rd, vec3(sin(t), cos(t * 0.7), sin(t * 0.5)) * 5.0, palette(t * 0.1));
  col += getGlow(rd, vec3(-sin(t * 0.8), sin(t), cos(t * 0.6)) * 5.0, palette(t * 0.1 + 0.33));

  if (d < MAX_DIST) {
    vec3 p = ro + rd * d;
    vec3 n = calcNormal(p);

    vec3 lightPos1 = vec3(sin(t) * 5.0, 3.0, cos(t) * 5.0);
    vec3 lightPos2 = vec3(-sin(t * 0.7) * 4.0, 2.0, -cos(t * 0.7) * 4.0);

    vec3 lightDir1 = normalize(lightPos1 - p);
    vec3 lightDir2 = normalize(lightPos2 - p);

    float diff1 = max(dot(n, lightDir1), 0.0);
    float diff2 = max(dot(n, lightDir2), 0.0);

    vec3 viewDir = normalize(ro - p);
    vec3 halfDir1 = normalize(lightDir1 + viewDir);
    vec3 halfDir2 = normalize(lightDir2 + viewDir);
    float spec1 = pow(max(dot(n, halfDir1), 0.0), 32.0);
    float spec2 = pow(max(dot(n, halfDir2), 0.0), 32.0);

    vec3 matCol = palette(length(p) * 0.1 + t * 0.1);

    float fresnel = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 rimCol = palette(t * 0.2 + 0.5) * fresnel * (1.0 + beat);

    vec3 light1Col = palette(t * 0.1) * (1.0 + u_bass);
    vec3 light2Col = palette(t * 0.1 + 0.5) * (1.0 + u_mid);

    col = matCol * 0.1;
    col += matCol * diff1 * light1Col;
    col += matCol * diff2 * light2Col;
    col += spec1 * light1Col * 0.5;
    col += spec2 * light2Col * 0.5;
    col += rimCol;

    float fog = exp(-d * 0.08);
    vec3 fogCol = palette(t * 0.05) * 0.2;
    col = mix(fogCol, col, fog);
  }

  float vignette = 1.0 - length(v_uv - 0.5) * 0.8;
  col *= vignette;

  if (beat > 0.1) {
    col.r *= 1.0 + beat * 0.1;
    col.b *= 1.0 - beat * 0.05;
  }

  float scanline = sin(v_uv.y * u_resolution.y * 2.0) * 0.02 + 1.0;
  col *= scanline;

  col = pow(col, vec3(0.4545));
  col = clamp(col, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
