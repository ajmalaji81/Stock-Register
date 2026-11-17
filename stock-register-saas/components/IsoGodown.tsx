import type { CSSProperties, ReactNode } from "react";

type Tone = "floor" | "wall" | "roof" | "crate" | "in" | "out" | "low";

/** One box on the isometric floor. Units are grid cells. */
function Box({
  x,
  y,
  z = 0,
  w,
  d,
  h,
  tone,
  crate = false,
  className = "",
  delay,
  children,
}: {
  x: number;
  y: number;
  z?: number;
  w: number;
  d: number;
  h: number;
  tone: Tone;
  crate?: boolean;
  className?: string;
  delay?: string;
  children?: ReactNode;
}) {
  const style = { "--x": x, "--y": y, "--z": z, "--w": w, "--d": d, "--h": h, animationDelay: delay } as CSSProperties;
  return (
    <div className={`iso-box iso-${tone} ${crate ? "iso-crate" : ""} ${className}`} style={style}>
      <div className="iso-face iso-top" />
      <div className="iso-face iso-left" />
      <div className="iso-face iso-front">{children}</div>
    </div>
  );
}

/**
 * Pure-CSS isometric godown: a warehouse with stacked crates, a green crate
 * arriving (stock IN), a red one leaving (stock OUT) and an amber low-stock stack.
 * Decorative only — hidden from assistive tech, frozen when reduced motion is on.
 */
export default function IsoGodown() {
  return (
    <div className="iso-scene" aria-hidden>
      <div className="iso-plane">
        {/* floor slab */}
        <Box x={0} y={0} z={-0.5} w={12} d={12} h={0.5} tone="floor" />

        {/* warehouse */}
        <Box x={1} y={1} w={6} d={5} h={3.4} tone="wall">
          <span className="iso-sign">GODOWN A</span>
          <span className="iso-door" />
        </Box>
        <Box x={0.6} y={0.6} z={3.4} w={6.8} d={5.8} h={0.5} tone="roof" />

        {/* stacked stock beside the godown */}
        <Box x={8.2} y={1.2} w={1.6} d={1.6} h={1.6} tone="crate" crate />
        <Box x={10} y={1.2} w={1.6} d={1.6} h={1.6} tone="crate" crate />
        <Box x={8.2} y={3} w={1.6} d={1.6} h={1.6} tone="crate" crate />
        <Box x={10} y={3} w={1.6} d={1.6} h={1.6} tone="crate" crate />
        <Box x={9.1} y={2.1} z={1.6} w={1.6} d={1.6} h={1.6} tone="crate" crate className="iso-anim-bob" />

        {/* low-stock corner */}
        <Box x={9.6} y={6.6} w={1.4} d={1.4} h={1.2} tone="low" crate />

        {/* stock IN: arrives at the dock */}
        <Box x={2.4} y={7} w={1.6} d={1.6} h={1.6} tone="in" crate className="iso-anim-in" />
        {/* stock OUT: leaves toward the viewer */}
        <Box x={5.2} y={7.4} w={1.4} d={1.4} h={1.4} tone="out" crate className="iso-anim-out" delay="-1.2s" />
      </div>
    </div>
  );
}
