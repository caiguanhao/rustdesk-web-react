import type { RendererLayout } from '../media/renderer.js';

/** Structural subset of VideoRenderer used by the input encoders. */
export interface RemoteCoordinateMapper {
  readonly layout: RendererLayout | null;
  toRemote(clientX: number, clientY: number): { x: number; y: number } | null;
}

export interface RemotePoint {
  x: number;
  y: number;
}

const clampCoordinate = (value: number, max: number): number | null =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : null;

/**
 * Client (viewport) coordinates → rounded/clamped frame pixels. When
 * `clampToEdge` is set, points outside the element snap to its last pixel
 * using the renderer's own rect→frame mapping.
 */
export function mapClientPoint(
  mapper: RemoteCoordinateMapper,
  element: HTMLElement,
  clientX: number,
  clientY: number,
  clampToEdge = false,
): RemotePoint | null {
  const layout = mapper.layout;
  if (!layout || layout.width <= 0 || layout.height <= 0) return null;

  let remote = mapper.toRemote(clientX, clientY);
  if (!remote && clampToEdge) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    remote = mapper.toRemote(
      Math.min(Math.max(clientX, rect.left), rect.right - 0.001),
      Math.min(Math.max(clientY, rect.top), rect.bottom - 0.001),
    );
  }
  if (!remote) return null;

  const x = clampCoordinate(remote.x, layout.width - 1);
  const y = clampCoordinate(remote.y, layout.height - 1);
  return x === null || y === null ? null : { x, y };
}
