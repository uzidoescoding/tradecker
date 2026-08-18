"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Draggable bottom sheet.
 *
 * The rules it is built to satisfy, in the order they matter:
 *
 *   1. It tracks the pointer 1:1 from wherever it was grabbed, never snapping
 *      the sheet to the finger.
 *   2. It is interruptible. Grabbing a sheet that is mid flight picks it up
 *      from its live on screen position with its live velocity, so a dismiss
 *      can be caught and reversed without waiting for anything to finish.
 *   3. Release hands the pointer's velocity straight to the spring, so there is
 *      no seam between dragging and animating.
 *   4. Where it lands is decided by projecting the momentum forward, the same
 *      way scroll deceleration works, not by asking where the finger happened
 *      to stop. A fast short flick dismisses; a slow long drag does not.
 *   5. It rubber bands upward, because the top is a boundary, not a wall.
 *   6. It enters and exits along the same path, downward, always.
 *
 * ponytail: the drag lives on the header, not the body. Handing the body both
 * scroll and drag needs gesture disambiguation, and this sheet has a grabber
 * sitting right there doing the job for free.
 */

/** Apple's projection function from Designing Fluid Interfaces. */
function project(velocity: number, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary, rather than a hard stop. */
function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

const DAMPING = 0.86; // slight overshoot, this is a momentum interaction
const RESPONSE = 0.34; // seconds, not a duration: a spring has no fixed length
/** Fixed integration step. See the sub-stepping note in springTo. */
const STEP = 1 / 240;
/**
 * Ceiling on the velocity handed to the spring.
 *
 * A pointer that moves 280px between two events one millisecond apart reports
 * 280,000 px/s, which is not a real hand. Feeding that to the integrator makes
 * the first step jump thousands of pixels and the spring never recovers. No
 * human flick exceeds a few thousand px/s, so anything past that is noise.
 */
const MAX_VELOCITY = 5000;

const clampV = (v: number) => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));

export default function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const el = useRef<HTMLDivElement>(null);
  const y = useRef(0); // current translate, the presentation value
  const v = useRef(0); // px/s
  const target = useRef(0);
  const raf = useRef(0);
  const last = useRef(0);
  const closing = useRef(false);
  const drag = useRef<{ id: number; grabY: number; history: [number, number][] } | null>(null);

  // Held in a ref so springTo keeps a stable identity. The parent passes a fresh
  // arrow every render and re-renders on every data refresh; without this the
  // entrance effect below would re-run and replay the entrance mid-read.
  const close = useRef(onClose);
  close.current = onClose;

  const height = () => el.current?.offsetHeight ?? 400;
  const reduced = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const paint = useCallback(() => {
    if (el.current) el.current.style.transform = `translate3d(0, ${y.current}px, 0)`;
  }, []);

  const stop = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  /** Spring toward `to`, starting from wherever the sheet actually is now. */
  const springTo = useCallback(
    (to: number, velocity = v.current) => {
      target.current = to;
      v.current = clampV(velocity);
      stop();

      if (reduced()) {
        y.current = to;
        paint();
        if (to > 0 && closing.current) close.current();
        return;
      }

      const omega = (2 * Math.PI) / RESPONSE;
      last.current = performance.now();
      const step = (now: number) => {
        // Clamp the frame delta so a backgrounded tab does not resume with one
        // huge step, then integrate it in fixed sub-steps. Explicit Euler on a
        // stiff spring goes unstable once dt is large relative to the period,
        // and a 120Hz display, a 30fps stall and a fast flick all push on that
        // at once. Fixed sub-steps make the motion identical on every display.
        let dt = Math.min(0.05, (now - last.current) / 1000);
        last.current = now;
        while (dt > 0) {
          const h = Math.min(STEP, dt);
          dt -= h;
          const dx = y.current - target.current;
          v.current += (-omega * omega * dx - 2 * DAMPING * omega * v.current) * h;
          y.current += v.current * h;
        }
        paint();

        if (Math.abs(y.current - target.current) < 0.5 && Math.abs(v.current) < 12) {
          y.current = target.current;
          v.current = 0;
          paint();
          raf.current = 0;
          if (closing.current) close.current();
          return;
        }
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    },
    [paint, stop],
  );

  const requestClose = useCallback(() => {
    closing.current = true;
    springTo(height(), Math.max(v.current, 300));
  }, [springTo]);

  /* Enter from below, along the same path it will leave by. Runs once: the
     deps are all stable, and re-entering on a parent re-render would yank the
     sheet out from under whoever is reading it. */
  useLayoutEffect(() => {
    y.current = height();
    paint();
    springTo(0, 0);
    return stop;
  }, [paint, springTo, stop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  /* ------------------------------------------------------------- gesture */

  const onPointerDown = (e: React.PointerEvent) => {
    // Catch the sheet wherever it currently is, mid animation or at rest.
    stop();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      id: e.pointerId,
      grabY: e.clientY - y.current, // respect where they grabbed, not the centre
      history: [[e.clientY, performance.now()]],
    };
    closing.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const raw = e.clientY - d.grabY;
    // Downward is free travel; upward is past the boundary, so it resists.
    y.current = raw >= 0 ? raw : -rubberband(-raw, height());
    paint();
    d.history.push([e.clientY, performance.now()]);
    if (d.history.length > 6) d.history.shift();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;

    // Velocity from the recent history, not the final two points: a finger that
    // pauses for one frame before lifting would otherwise read as zero.
    const [firstY, firstT] = d.history[0];
    const [lastY, lastT] = d.history[d.history.length - 1];
    // Floor the sample window at one frame. A synthetic or very fast drag can
    // report two points a fraction of a millisecond apart, and dividing by that
    // manufactures a velocity nothing physical could produce.
    const dt = Math.max(16, lastT - firstT);
    const velocity = clampV(((lastY - firstY) / dt) * 1000);

    // Land where the throw is going, not where the finger stopped.
    const projected = y.current + project(velocity);
    if (projected > height() * 0.4) {
      closing.current = true;
      springTo(height(), velocity);
    } else {
      springTo(0, velocity);
    }
  };

  return (
    <>
      <div className="sheet-scrim" onClick={requestClose} aria-hidden />
      <div
        ref={el}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
      >
        <div
          className="flex-none cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="grabber" />
          <div className="flex items-start justify-between gap-3 px-5 pt-2 pb-3">
            <div className="min-w-0">
              <h2 className="t-title truncate">{title}</h2>
              {subtitle && <p className="t-caption mt-0.5">{subtitle}</p>}
            </div>
            <button
              onClick={requestClose}
              className="pressable t-caption flex-none rounded-full px-3 py-1"
              style={{ background: "var(--hairline)", color: "var(--text-2)" }}
            >
              Done
            </button>
          </div>
        </div>
        <div className="scroll-panel min-h-0 flex-1 px-5 pb-8">{children}</div>
      </div>
    </>
  );
}
