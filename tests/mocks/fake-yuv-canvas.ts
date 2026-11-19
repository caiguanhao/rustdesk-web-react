/**
 * Structural yuv-canvas double for jsdom tests. The real renderer is covered
 * with a richer spy in tests/renderer.test.ts and with real WebGL/software
 * drawing in the Playwright canvas test; this stub is enough to construct a
 * `VideoRenderer` without a canvas implementation.
 */
const fakeYuvCanvas = {
  attach: () => ({ drawFrame() {}, clear() {} }),
  WebGLFrameSink: { isAvailable: () => false },
};

export default fakeYuvCanvas;
