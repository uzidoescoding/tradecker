"use client";

import { useEffect, useRef } from "react";

/**
 * Directional light rays sweeping in from a corner.
 *
 * Written against the prop contract that was asked for. There is no public
 * component with this signature: React Bits ships `LightRays`, whose props are
 * a different set entirely (raysOrigin, raysColor, lightSpread, rayLength,
 * followMouse...), so this is an implementation of the contract rather than a
 * copy of anything. Every prop below is a real uniform and actually does
 * something; none are decorative.
 *
 * ponytail: raw WebGL, not a WebGL library. This is one fullscreen triangle and
 * one fragment shader, which is about forty lines of setup. Pulling in ogl or
 * three to draw a single quad would be the expensive way to write less code.
 */

export type Origin = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "top" | "left" | "right" | "bottom";

const ORIGINS: Record<Origin, [number, number]> = {
  "top-right": [1, 1],
  "top-left": [0, 1],
  "bottom-right": [1, 0],
  "bottom-left": [0, 0],
  top: [0.5, 1],
  bottom: [0.5, 0],
  left: [0, 0.5],
  right: [1, 0.5],
};

/** #RGB or #RRGGBB to linear-ish 0..1 triple. Falls back to white, never to NaN. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [1, 1, 1];
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

const VERT = `#version 300 es
// One oversized triangle rather than a two triangle quad: no shared edge for
// the rasteriser to seam along, and three vertices instead of six.
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = P[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uOrigin;
uniform vec3  uColor1;
uniform vec3  uColor2;
uniform float uIntensity;
uniform float uSpread;
uniform float uTilt;
uniform float uSaturation;
uniform float uBlend;
uniform float uFalloff;
uniform float uOpacity;

// Cheap value noise. Rays that are perfectly regular read as a lens flare
// artefact; a little irregularity is what makes them read as light.
float hash(float n) { return fract(sin(n) * 43758.5453123); }
float noise(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}

vec3 saturate3(vec3 c, float s) {
  // Rec. 709 luma, so desaturating does not shift perceived brightness.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l), c, s);
}

void main() {
  // Work in aspect corrected space or the fan squashes on wide viewports.
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 uv = vec2(vUv.x * aspect, vUv.y);
  vec2 origin = vec2(uOrigin.x * aspect, uOrigin.y);

  vec2 d = uv - origin;
  float dist = length(d);
  float angle = atan(d.y, d.x) + uTilt;

  // The fan: a band of rays around the angle bisector, widened by uSpread.
  float fan = angle * (6.0 / max(uSpread, 0.05));

  // Three drifting octaves at different rates, so the rays never visibly loop.
  float t = uTime;
  float rays =
      noise(fan * 1.0 + t * 0.60) * 0.55
    + noise(fan * 2.3 - t * 0.37) * 0.30
    + noise(fan * 5.1 + t * 0.23) * 0.15;

  // Sharpen into distinct shafts rather than a smear.
  rays = pow(clamp(rays, 0.0, 1.0), 2.2);

  // Distance attenuation. Higher uFalloff pulls the light back toward origin.
  float atten = 1.0 / (1.0 + pow(dist * 1.6, uFalloff * 1.6));

  // Colour travels from colour 1 at the origin to colour 2 further out, with
  // uBlend deciding how much of that journey actually happens.
  float mixT = clamp(dist * 0.9, 0.0, 1.0) * uBlend;
  vec3 col = mix(uColor1, uColor2, mixT);
  col = saturate3(col, uSaturation);

  float energy = rays * atten * uIntensity;
  // A soft core at the origin so the rays have something to emanate from.
  energy += atten * atten * 0.35 * uIntensity;

  col *= energy;
  // Tone map, or high uIntensity clips to flat white instead of getting brighter.
  col = col / (1.0 + col);

  fragColor = vec4(col, clamp(energy, 0.0, 1.0) * uOpacity);
}`;

export type SideRaysProps = {
  rayColor1?: string;
  rayColor2?: string;
  origin?: Origin;
  speed?: number;
  intensity?: number;
  spread?: number;
  tilt?: number;
  saturation?: number;
  blend?: number;
  falloff?: number;
  opacity?: number;
  className?: string;
};

export default function SideRays({
  rayColor1 = "#22C55E",
  rayColor2 = "#86EFAC",
  origin = "top-right",
  speed = 2.5,
  intensity = 2,
  spread = 2,
  tilt = 0,
  saturation = 1.5,
  blend = 0.75,
  falloff = 1.6,
  opacity = 1,
  className,
}: SideRaysProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Props live in a ref so changing one does not tear down the GL context.
  const props = useRef({ rayColor1, rayColor2, origin, speed, intensity, spread, tilt, saturation, blend, falloff, opacity });
  props.current = { rayColor1, rayColor2, origin, speed, intensity, spread, tilt, saturation, blend, falloff, opacity };

  useEffect(() => {
    const cvs = canvas.current;
    if (!cvs) return;

    const gl = cvs.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
    // No WebGL2 is not an error worth shouting about: the CSS gradient behind
    // this canvas is a perfectly good background on its own.
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("SideRays shader", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("SideRays link", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = u("uRes"), uTime = u("uTime"), uOrigin = u("uOrigin");
    const uColor1 = u("uColor1"), uColor2 = u("uColor2"), uIntensity = u("uIntensity");
    const uSpread = u("uSpread"), uTilt = u("uTilt"), uSaturation = u("uSaturation");
    const uBlend = u("uBlend"), uFalloff = u("uFalloff"), uOpacity = u("uOpacity");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Half resolution: the whole image is blurred noise, so the extra pixels of
    // a retina buffer are four times the fill rate for no visible gain.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
    const resize = () => {
      const w = Math.max(1, Math.round(cvs.clientWidth * scale));
      const h = Math.max(1, Math.round(cvs.clientHeight * scale));
      if (cvs.width !== w || cvs.height !== h) {
        cvs.width = w;
        cvs.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(cvs);
    resize();

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let raf = 0;
    let clock = 0;
    let last = performance.now();

    const frame = (now: number) => {
      // Advance our own clock rather than using wall time, so pausing and the
      // speed prop both work, and a long background stall does not jump.
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = props.current;
      // Reduced motion keeps the image, drops the movement. A slowly drifting
      // full screen field is exactly what that setting is about.
      if (!motion.matches) clock += dt * p.speed;

      resize();
      const [ox, oy] = ORIGINS[p.origin] ?? ORIGINS["top-right"];
      const c1 = hexToRgb(p.rayColor1);
      const c2 = hexToRgb(p.rayColor2);

      gl.uniform2f(uRes, cvs.width, cvs.height);
      gl.uniform1f(uTime, clock);
      gl.uniform2f(uOrigin, ox, oy);
      gl.uniform3f(uColor1, c1[0], c1[1], c1[2]);
      gl.uniform3f(uColor2, c2[0], c2[1], c2[2]);
      gl.uniform1f(uIntensity, p.intensity);
      gl.uniform1f(uSpread, p.spread);
      gl.uniform1f(uTilt, p.tilt);
      gl.uniform1f(uSaturation, p.saturation);
      gl.uniform1f(uBlend, p.blend);
      gl.uniform1f(uFalloff, p.falloff);
      gl.uniform1f(uOpacity, p.opacity);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // A hidden tab should not be burning a GPU loop.
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
    };
    cvs.addEventListener("webglcontextlost", onLost);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      cvs.removeEventListener("webglcontextlost", onLost);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return <canvas ref={canvas} className={className} aria-hidden />;
}
