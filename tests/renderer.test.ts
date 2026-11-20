// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Vp9Frame } from '../src/media/vp9-decoder';
import { RustDeskError } from '../src/session/errors';

// Unit coverage for the yuv-canvas wrapper: WebGL preference/fallback,
// letterbox geometry across aspect ratios and resizes, frame release,
// coordinate mapping, fullscreen and disposal. The real yuv-canvas drawing is
// exercised by scripts/check-decoders.mjs in headless Chrome.

const yuv = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  attach: vi.fn(),
}));

vi.mock('yuv-canvas', () => ({
  default: {
    attach: yuv.attach,
    WebGLFrameSink: { isAvailable: yuv.isAvailable },
  },
}));

import { VideoRenderer, type RendererLayout } from '../src/media/renderer';

interface FakeSink {
  drawFrame: Mock<(buffer: unknown) => void>;
  clear: Mock<() => void>;
}

interface Harness {
  renderer: VideoRenderer;
  sink: FakeSink;
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  layouts: (RendererLayout | null)[];
  releases: number;
}

interface MountOptions {
  webGL?: boolean;
  width?: number;
  height?: number;
  sink?: FakeSink;
  onLayout?: (layout: RendererLayout | null) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
}

function makeSink(): FakeSink {
  return { drawFrame: vi.fn(), clear: vi.fn() };
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, value });
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const container = document.createElement('div');
  setContainerSize(container, width, height);
  document.body.append(container);
  return container;
}

function makeCanvas(
  container: HTMLElement = makeContainer(),
): { container: HTMLElement; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  container.append(canvas);
  return { container, canvas };
}

function setContainerSize(container: HTMLElement, width: number, height: number): void {
  define(container, 'clientWidth', width);
  define(container, 'clientHeight', height);
}

function frame(width = 1920, height = 1080): Vp9Frame {
  return { width, height, format: { displayWidth: width, displayHeight: height } };
}

function mount(options: MountOptions = {}): Harness {
  const container = makeContainer(options.width, options.height);
  const { canvas } = makeCanvas(container);
  const sink = options.sink ?? makeSink();
  yuv.attach.mockReturnValue(sink);
  const layouts: (RendererLayout | null)[] = [];
  const renderer = new VideoRenderer(canvas, container, {
    webGL: options.webGL,
    onLayout: (layout) => {
      layouts.push(layout);
      options.onLayout?.(layout);
    },
    onFullscreenChange: options.onFullscreenChange,
  });
  return { renderer, sink, canvas, container, layouts, releases: 0 };
}

function draw(harness: Harness, value: Vp9Frame = frame()): void {
  harness.renderer.draw(value, () => {
    harness.releases += 1;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  yuv.isAvailable.mockReturnValue(true);
});

afterEach(() => {
  document.body.innerHTML = '';
  for (const name of [
    'fullscreenElement',
    'exitFullscreen',
    'webkitFullscreenElement',
    'webkitExitFullscreen',
  ]) {
    delete (document as unknown as Record<string, unknown>)[name];
  }
});

describe('VideoRenderer', () => {
  it('lettersboxes 16:9 into a 4:3 container and releases the frame', () => {
    const harness = mount();
    draw(harness);

    expect(harness.sink.drawFrame).toHaveBeenCalledTimes(1);
    expect(harness.sink.drawFrame).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1920, height: 1080 }),
    );
    expect(harness.releases).toBe(1);
    expect(harness.renderer.layout).toEqual({
      width: 1920,
      height: 1080,
      cssWidth: 800,
      cssHeight: 450,
      offsetX: 0,
      offsetY: 75,
      scale: 800 / 1920,
    });
    expect(harness.canvas.style.width).toBe('800px');
    expect(harness.canvas.style.height).toBe('450px');
    expect(harness.canvas.style.left).toBe('0px');
    expect(harness.canvas.style.top).toBe('75px');
    // Only the first frame produces a layout notification.
    expect(harness.layouts).toHaveLength(1);
    expect(harness.layouts[0]).toEqual(harness.renderer.layout);
  });

  it.each([
    { frameWidth: 600, frameHeight: 600, width: 800, height: 600, cssWidth: 600, cssHeight: 600, offsetX: 100, offsetY: 0 },
    { frameWidth: 400, frameHeight: 800, width: 800, height: 600, cssWidth: 300, cssHeight: 600, offsetX: 250, offsetY: 0 },
    { frameWidth: 320, frameHeight: 240, width: 500, height: 500, cssWidth: 500, cssHeight: 375, offsetX: 0, offsetY: 62.5 },
  ])(
    'preserves the aspect ratio of $frameWidth×$frameHeight in $width×$height',
    ({ frameWidth, frameHeight, width, height, cssWidth, cssHeight, offsetX, offsetY }) => {
      const harness = mount({ width, height });
      draw(harness, frame(frameWidth, frameHeight));
      expect(harness.renderer.layout).toMatchObject({
        width: frameWidth,
        height: frameHeight,
        cssWidth,
        cssHeight,
        offsetX,
        offsetY,
      });
    },
  );

  it('uses the display size for cropped frames', () => {
    const harness = mount();
    draw(harness, {
      width: 64,
      height: 64,
      format: { displayWidth: 128, displayHeight: 72 },
    });
    expect(harness.renderer.layout).toMatchObject({
      width: 128,
      height: 72,
      cssWidth: 800,
      cssHeight: 450,
      offsetY: 75,
    });
  });

  it('falls back to top-level dimensions without a format', () => {
    const harness = mount();
    draw(harness, { width: 640, height: 480 });
    expect(harness.renderer.layout).toMatchObject({
      width: 640,
      height: 480,
      cssWidth: 800,
      cssHeight: 600,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('relayouts when the frame size changes', () => {
    const harness = mount();
    draw(harness);
    draw(harness, frame(1080, 1920));
    expect(harness.renderer.layout).toMatchObject({
      width: 1080,
      height: 1920,
      cssWidth: 337.5,
      cssHeight: 600,
      offsetX: 231.25,
      offsetY: 0,
    });
    expect(harness.layouts).toHaveLength(2);
  });

  it('recomputes the layout on resize', () => {
    const harness = mount();
    draw(harness);
    setContainerSize(harness.container, 400, 800);
    harness.renderer.resize();

    expect(harness.renderer.layout).toMatchObject({
      cssWidth: 400,
      cssHeight: 225,
      offsetX: 0,
      offsetY: 287.5,
    });
    expect(harness.canvas.style.width).toBe('400px');
    expect(harness.canvas.style.top).toBe('287.5px');
  });

  it('reports a null layout for a zero-sized container', () => {
    const harness = mount();
    draw(harness);
    setContainerSize(harness.container, 0, 0);
    harness.renderer.resize();
    expect(harness.renderer.layout).toBeNull();
    expect(harness.layouts.at(-1)).toBeNull();
  });

  it('does not notify when the layout is unchanged', () => {
    const harness = mount();
    draw(harness);
    const notifications = harness.layouts.length;
    harness.renderer.resize();
    harness.renderer.resize();
    draw(harness);
    expect(harness.layouts).toHaveLength(notifications);
  });

  it('maps client coordinates to remote pixels and back', () => {
    const harness = mount();
    expect(harness.renderer.toRemote(0, 0)).toBeNull();
    expect(harness.renderer.toClient(0, 0)).toBeNull();

    draw(harness);
    harness.canvas.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 200,
        right: 900,
        bottom: 650,
        width: 800,
        height: 450,
        x: 100,
        y: 200,
        toJSON: () => ({}),
      }) as DOMRect;

    expect(harness.renderer.toRemote(100, 200)).toEqual({ x: 0, y: 0 });
    expect(harness.renderer.toRemote(500, 425)).toEqual({ x: 960, y: 540 });
    expect(harness.renderer.toRemote(899.999, 649.999)?.x).toBeCloseTo(1919.9976);
    expect(harness.renderer.toRemote(99, 425)).toBeNull();
    expect(harness.renderer.toRemote(500, 199)).toBeNull();
    expect(harness.renderer.toRemote(900, 425)).toBeNull();
    expect(harness.renderer.toRemote(500, 650)).toBeNull();
    expect(harness.renderer.toClient(960, 540)).toEqual({ x: 500, y: 425 });
    expect(harness.renderer.toClient(0, 0)).toEqual({ x: 100, y: 200 });
  });

  it('clears the sink and releases frames drawn after disposal', () => {
    const harness = mount();
    harness.renderer.dispose();
    expect(harness.sink.clear).toHaveBeenCalledTimes(1);

    draw(harness);
    expect(harness.sink.drawFrame).not.toHaveBeenCalled();
    expect(harness.releases).toBe(1);

    harness.renderer.dispose();
    expect(harness.sink.clear).toHaveBeenCalledTimes(1);
  });

  it('releases the frame when the sink throws', () => {
    const harness = mount();
    harness.sink.drawFrame.mockImplementation(() => {
      throw new Error('WebGL context lost');
    });
    expect(() => draw(harness)).toThrow('WebGL context lost');
    expect(harness.releases).toBe(1);
  });

  it('rejects frames without dimensions but still releases them', () => {
    const harness = mount();
    expect(() =>
      draw(harness, { width: 0, height: 0 }),
    ).toThrowError(RustDeskError);
    expect(harness.sink.drawFrame).not.toHaveBeenCalled();
    expect(harness.releases).toBe(1);
  });

  it('uses native fullscreen and falls back to the CSS overlay on rejection', async () => {
    const harness = mount();
    const request = vi.fn(async () => undefined);
    define(harness.container, 'requestFullscreen', request);
    await expect(harness.renderer.requestFullscreen()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(harness.container.hasAttribute('data-rustdesk-css-fullscreen')).toBe(false);

    request.mockRejectedValueOnce(new Error('denied'));
    await expect(harness.renderer.requestFullscreen()).resolves.toBe(true);
    expect(harness.container.getAttribute('data-rustdesk-css-fullscreen')).toBe('');
    expect(harness.renderer.fullscreen).toBe(true);

    await harness.renderer.exitFullscreen();
    expect(harness.container.hasAttribute('data-rustdesk-css-fullscreen')).toBe(false);
    expect(harness.renderer.fullscreen).toBe(false);
  });

  it('exposes fullscreen support/state and notifies on changes', () => {
    const changes: boolean[] = [];
    const harness = mount({
      onFullscreenChange: (fullscreen) => changes.push(fullscreen),
    });
    // The CSS fallback keeps the control usable without a native API.
    expect(harness.renderer.fullscreenSupported).toBe(true);
    expect(harness.renderer.fullscreen).toBe(false);

    define(harness.container, 'requestFullscreen', vi.fn(async () => undefined));

    define(document, 'fullscreenElement', harness.container);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(harness.renderer.fullscreen).toBe(true);
    expect(changes).toEqual([true]);

    define(document, 'fullscreenElement', null);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(harness.renderer.fullscreen).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('uses the CSS fallback when the browser has no fullscreen API', async () => {
    const changes: boolean[] = [];
    const harness = mount({
      onFullscreenChange: (fullscreen) => changes.push(fullscreen),
    });
    define(harness.container, 'requestFullscreen', undefined);
    define(harness.container, 'webkitRequestFullscreen', undefined);
    await expect(harness.renderer.requestFullscreen()).resolves.toBe(true);
    expect(harness.container.hasAttribute('data-rustdesk-css-fullscreen')).toBe(
      true,
    );
    expect(harness.renderer.fullscreen).toBe(true);
    expect(changes).toEqual([true]);
    expect(document.getElementById('rustdesk-css-fullscreen')).not.toBeNull();

    // A second call is idempotent (no duplicate change event).
    await expect(harness.renderer.requestFullscreen()).resolves.toBe(true);
    expect(changes).toEqual([true]);

    await harness.renderer.exitFullscreen();
    expect(harness.container.hasAttribute('data-rustdesk-css-fullscreen')).toBe(
      false,
    );
    expect(changes).toEqual([true, false]);
  });

  it('removes the CSS fullscreen overlay on dispose', async () => {
    const harness = mount();
    await harness.renderer.requestFullscreen();
    expect(harness.container.hasAttribute('data-rustdesk-css-fullscreen')).toBe(
      true,
    );
    harness.renderer.dispose();
    expect(harness.container.hasAttribute('data-rustdesk-css-fullscreen')).toBe(
      false,
    );
  });

  it('falls back to the prefixed fullscreen API', async () => {
    const harness = mount();
    define(harness.container, 'requestFullscreen', undefined);
    const request = vi.fn(async () => undefined);
    define(harness.container, 'webkitRequestFullscreen', request);
    await expect(harness.renderer.requestFullscreen()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    const exit = vi.fn(async () => undefined);
    define(document, 'webkitFullscreenElement', harness.container);
    define(document, 'webkitExitFullscreen', exit);
    await harness.renderer.exitFullscreen();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('only exits fullscreen when its container is fullscreen', async () => {
    const harness = mount();
    const exit = vi.fn(async () => undefined);
    define(document, 'exitFullscreen', exit);
    define(document, 'fullscreenElement', document.body);
    await harness.renderer.exitFullscreen();
    expect(exit).not.toHaveBeenCalled();

    define(document, 'fullscreenElement', harness.container);
    await harness.renderer.exitFullscreen();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('prefers WebGL and falls back to software when it is unavailable', () => {
    const webgl = mount();
    expect(yuv.isAvailable).toHaveBeenCalledTimes(1);
    expect(yuv.attach).toHaveBeenCalledWith(webgl.canvas, { webGL: true });
    expect(webgl.renderer.usingWebGL).toBe(true);

    yuv.isAvailable.mockReturnValue(false);
    const { container, canvas } = makeCanvas();
    const renderer = new VideoRenderer(canvas, container, { webGL: true });
    expect(yuv.attach).toHaveBeenLastCalledWith(canvas, { webGL: false });
    expect(renderer.usingWebGL).toBe(false);
  });

  it('skips the WebGL probe when software rendering is requested', () => {
    const harness = mount({ webGL: false });
    expect(yuv.isAvailable).not.toHaveBeenCalled();
    expect(yuv.attach).toHaveBeenCalledWith(harness.canvas, { webGL: false });
    expect(harness.renderer.usingWebGL).toBe(false);
  });

  it('falls back to software when WebGL attach fails', () => {
    const sink = makeSink();
    yuv.attach
      .mockImplementationOnce(() => {
        throw new Error('WebGL unavailable');
      })
      .mockImplementationOnce(() => sink);
    const { container, canvas } = makeCanvas();
    const renderer = new VideoRenderer(canvas, container);
    expect(yuv.attach).toHaveBeenNthCalledWith(1, canvas, { webGL: true });
    expect(yuv.attach).toHaveBeenNthCalledWith(2, canvas, { webGL: false });
    expect(renderer.usingWebGL).toBe(false);
  });

  it('throws a typed error when even software attach fails', () => {
    yuv.attach.mockImplementation(() => {
      throw new Error('no 2d context');
    });
    const { container, canvas } = makeCanvas();
    expect(() => new VideoRenderer(canvas, container, { webGL: false })).toThrowError(
      RustDeskError,
    );
  });

  it('swallows host callback and clear errors', () => {
    const sink = makeSink();
    sink.clear.mockImplementation(() => {
      throw new Error('context lost');
    });
    const harness = mount({
      sink,
      onLayout: () => {
        throw new Error('host callback failed');
      },
    });
    let released = 0;
    expect(() =>
      harness.renderer.draw(frame(), () => {
        released += 1;
      }),
    ).not.toThrow();
    expect(released).toBe(1);
    expect(() => harness.renderer.dispose()).not.toThrow();
  });
});
