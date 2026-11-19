import type { RemoteCoordinateMapper } from '../../src/input/mouse';
import type { RendererLayout } from '../../src/media/renderer';

// Shared geometry for P3-1 tests: a 64x64 frame shown at 2x CSS scale
// (320x180 canvas) inside a page rect at (100, 50).
export const MOUSE_LAYOUT: RendererLayout = {
  width: 640,
  height: 360,
  cssWidth: 320,
  cssHeight: 180,
  offsetX: 0,
  offsetY: 0,
  scale: 0.5,
};

export const MOUSE_RECT = {
  left: 100,
  top: 50,
  right: 420,
  bottom: 230,
  width: 320,
  height: 180,
  x: 100,
  y: 50,
  toJSON: () => ({}),
} as DOMRect;

export function remoteMapper(
  overrides: Partial<RemoteCoordinateMapper> = {},
): RemoteCoordinateMapper {
  return {
    layout: MOUSE_LAYOUT,
    toRemote(clientX, clientY) {
      if (
        clientX < MOUSE_RECT.left ||
        clientY < MOUSE_RECT.top ||
        clientX >= MOUSE_RECT.right ||
        clientY >= MOUSE_RECT.bottom
      ) {
        return null;
      }
      return {
        x: (clientX - MOUSE_RECT.left) / MOUSE_LAYOUT.scale,
        y: (clientY - MOUSE_RECT.top) / MOUSE_LAYOUT.scale,
      };
    },
    ...overrides,
  };
}
