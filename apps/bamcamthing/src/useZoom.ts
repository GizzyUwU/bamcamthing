import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export type Zoom = { scale: number; x: number; y: number };

export const identityZoom: Zoom = { scale: 1, x: 0, y: 0 };

const maxScale = 4;
const tapMs = 260;
const doubleTapMs = 320;
const tapSlopPx = 14;
const minPinchPx = 8;

type Vec = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
type Frame = { mid: Vec; dist: number };

const fallbackBox: Box = { left: 0, top: 0, width: 800, height: 480 };

const clamp = (value: number, lo: number, hi: number) => (value < lo ? lo : value > hi ? hi : value);

export function zoomStyle(zoom: Zoom, quarter: number): string {
  return `translate(${zoom.x.toFixed(2)}px, ${zoom.y.toFixed(2)}px) scale(${zoom.scale.toFixed(4)}) rotate(${quarter}deg)`;
}

export function isZoomed(zoom: Zoom): boolean {
  return zoom.scale > 1.02;
}

function quarterSwapsAxes(quarter: number): boolean {
  return (((Math.round(quarter / 90) % 2) + 2) % 2) === 1;
}

// the feed is object-cover, so the frame only has slack along the axes the scale grew
function limit(scale: number, x: number, y: number, quarter: number, box: Box): Zoom {
  const swapped = quarterSwapsAxes(quarter);
  const slackX = Math.max(0, ((swapped ? box.height : box.width) * scale - box.width) / 2);
  const slackY = Math.max(0, ((swapped ? box.width : box.height) * scale - box.height) / 2);
  return { scale, x: clamp(x, -slackX, slackX), y: clamp(y, -slackY, slackY) };
}

// keeps the point that was under the fingers under the fingers while the spacing changes
function pinch(from: Zoom, prior: Frame, now: Frame, quarter: number, box: Box): Zoom {
  const scale = clamp(from.scale * (now.dist / prior.dist), 1, maxScale);
  const ratio = scale / from.scale;
  return limit(
    scale,
    now.mid.x - ratio * (prior.mid.x - from.x),
    now.mid.y - ratio * (prior.mid.y - from.y),
    quarter,
    box,
  );
}

function drag(from: Zoom, prior: Frame, now: Frame, quarter: number, box: Box): Zoom {
  return limit(from.scale, from.x + (now.mid.x - prior.mid.x), from.y + (now.mid.y - prior.mid.y), quarter, box);
}

export function useZoom(enabled: boolean, root: RefObject<HTMLElement | null>, quarter: number) {
  const [zoom, setZoom] = useState<Zoom>(identityZoom);
  const latest = useRef<Zoom>(identityZoom);
  const angle = useRef(quarter);
  angle.current = quarter;

  const pointers = useRef(new Map<number, Vec>());
  const box = useRef<Box>(fallbackBox);
  const prev = useRef<Frame | null>(null);
  const fresh = useRef(true);
  const moved = useRef(false);
  const pinched = useRef(false);
  const downAt = useRef(0);
  const downAtPos = useRef<Vec>({ x: 0, y: 0 });
  const lastTapAt = useRef(0);
  const frame = useRef(0);

  const commit = useCallback((next: Zoom) => {
    const prev = latest.current;
    if (prev.scale === next.scale && prev.x === next.x && prev.y === next.y) return;
    latest.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setZoom(latest.current);
    });
  }, []);

  const reset = useCallback(() => {
    pointers.current.clear();
    prev.current = null;
    commit(identityZoom);
  }, [commit]);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const measure = () => {
    const rect = root.current?.getBoundingClientRect();
    box.current = rect && rect.width > 0 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : fallbackBox;
  };

  const sample = (): Frame => {
    const points = [...pointers.current.values()];
    const rect = box.current;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (points.length === 0) return { mid: { x: 0, y: 0 }, dist: 0 };
    let x = 0;
    let y = 0;
    for (const point of points) {
      x += point.x / points.length;
      y += point.y / points.length;
    }
    const dist = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    return { mid: { x: x - cx, y: y - cy }, dist };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || pointers.current.size >= 2) return;
    if (event.pointerType === 'mouse' && event.button > 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    measure();
    if (pointers.current.size === 1) {
      downAt.current = performance.now();
      downAtPos.current = { x: event.clientX, y: event.clientY };
      moved.current = false;
      pinched.current = false;
    }
    prev.current = sample();
    fresh.current = true;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (Math.hypot(event.clientX - downAtPos.current.x, event.clientY - downAtPos.current.y) > tapSlopPx) moved.current = true;
    if (pointers.current.size > 1) pinched.current = true;
    const now = sample();
    const prior = prev.current;
    if (!prior) return;
    // re-baseline on the first frame after the pointer set changes, so nothing jumps
    if (fresh.current || (pointers.current.size > 1 && prior.dist < minPinchPx)) {
      prev.current = now;
      fresh.current = false;
      return;
    }
    const anchor = box.current;
    commit(
      pointers.current.size > 1
        ? pinch(latest.current, prior, now, angle.current, anchor)
        : drag(latest.current, prior, now, angle.current, anchor),
    );
    prev.current = now;
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>, allowTap: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) {
      prev.current = sample();
      fresh.current = true;
      return;
    }
    prev.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!allowTap || !enabled) return;
    if (performance.now() - downAt.current > tapMs || moved.current || pinched.current) return;
    const now = performance.now();
    if (now - lastTapAt.current < doubleTapMs) {
      lastTapAt.current = 0;
      reset();
    } else {
      lastTapAt.current = now;
    }
  };

  return {
    zoom,
    reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, true),
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, false),
    },
  };
}
