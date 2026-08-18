"use client";

import dynamic from "next/dynamic";

// Touches WebGL and `window` on mount, so it must never render on the server.
const SideRays = dynamic(() => import("./SideRays"), { ssr: false });

/**
 * Full viewport backdrop.
 *
 * Green rays from the top right over a still gradient. The gradient is not a
 * placeholder: it is what the page looks like when WebGL is unavailable, when
 * the context is lost, and for the first frame before the canvas paints, so it
 * has to stand on its own.
 *
 * The `.scrim` on top is what keeps small tabular numbers readable. Card
 * legibility itself comes from --surface-alpha, so the rays stay visible rather
 * than being darkened into nothing.
 */
export default function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="veil-still absolute inset-0" />
      <SideRays
        className="absolute inset-0 h-full w-full"
        rayColor1="#22C55E"
        rayColor2="#86EFAC"
        origin="top-right"
        speed={2.5}
        intensity={2}
        spread={2}
        tilt={0}
        saturation={1.5}
        blend={0.75}
        falloff={1.6}
        opacity={1}
      />
      <div className="scrim absolute inset-0" />
    </div>
  );
}
