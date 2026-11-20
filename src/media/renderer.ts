/**
 * yuv-canvas WebGL renderer.
 *
 * yuv-canvas owns `canvas.width/height` (it sets them from the decoded
 * frame's display size), so device-pixel ratio cannot be used for the backing
 * store here. Instead the intrinsic canvas keeps the frame's resolution and
 * CSS scales it into a letterboxed box inside the container. Input
 * coordinates are mapped back through that box (`toRemote`/`toClient`).
 *
 * WebGL is preferred, with yuv-canvas's software sink as a fallback. The
 * renderer implements P2-2's `VideoSink`: `draw(frame, release)` draws and
 * always releases the YUV frame.
 */
import YUVCanvas from 'yuv-canvas';
import { RustDeskError } from '../session/errors.js';
import { frameSize, sameSize, type Vp9Frame } from './vp9-decoder.js';
import type { VideoSink } from './video-pipeline.js';

export interface RendererLayout {
  /** Frame pixel size. */
  width: number;
  height: number;
  /** Canvas CSS size and offset inside the container. */
  cssWidth: number;
  cssHeight: number;
  offsetX: number;
  offsetY: number;
  /** CSS pixels per frame pixel. */
  scale: number;
}

/** Structural subset of yuv-canvas's frame sink (kept out of public types). */
interface FrameSink {
  drawFrame(buffer: unknown): void;
  clear(): void;
}

interface AttachedSink {
  sink: FrameSink;
  webGL: boolean;
}

export interface VideoRendererOptions {
  /** Prefer WebGL (default true) with software fallback. */
  webGL?: boolean;
  /** Called whenever the letterbox layout changes. */
  onLayout?: (layout: RendererLayout | null) => void;
  /** Called when this container enters/leaves fullscreen. */
  onFullscreenChange?: (fullscreen: boolean) => void;
}

/** Safari 15/iPadOS still uses the prefixed fullscreen API. */
interface VendorFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?(): Promise<void> | void;
}

interface VendorDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?(): Promise<void> | void;
}

/**
 * iPhone Safari has no Fullscreen API for non-video elements and some hosts
 * embed the viewer in an iframe without `allowfullscreen`. The renderer then
 * fills the visual viewport with a fixed-position CSS overlay instead. The
 * attribute lives on the viewer root (which also contains the toolbar and
 * notices), so the controls stay reachable. `!important` beats the React
 * inline `position: relative` / `aspect-ratio` from the shell style.
 */
const CSS_FULLSCREEN_ATTRIBUTE = 'data-rustdesk-css-fullscreen';
const CSS_FULLSCREEN_STYLE_ID = 'rustdesk-css-fullscreen';
const CSS_FULLSCREEN_RULES = `
[${CSS_FULLSCREEN_ATTRIBUTE}] {
  position: fixed !important;
  inset: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  height: 100dvh !important;
  max-width: none !important;
  max-height: none !important;
  aspect-ratio: auto !important;
  margin: 0 !important;
  z-index: 2147483647 !important;
  touch-action: none;
}
[${CSS_FULLSCREEN_ATTRIBUTE}] [data-rustdesk-toolbar] {
  bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
}
`;

function ensureCssFullscreenStyle(doc: Document): void {
  if (doc.getElementById(CSS_FULLSCREEN_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = CSS_FULLSCREEN_STYLE_ID;
  style.textContent = CSS_FULLSCREEN_RULES;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function defaultFrameSink(
  canvas: HTMLCanvasElement,
  preferWebGL: boolean,
): AttachedSink {
  let webGL = false;
  if (preferWebGL) {
    try {
      webGL = YUVCanvas.WebGLFrameSink.isAvailable();
    } catch {
      webGL = false;
    }
  }
  try {
    return { sink: YUVCanvas.attach(canvas, { webGL }), webGL };
  } catch (cause) {
    if (webGL) {
      // Some headless/embedded browsers claim WebGL but fail to create a context.
      try {
        return { sink: YUVCanvas.attach(canvas, { webGL: false }), webGL: false };
      } catch {
        // fall through to the typed error below
      }
    }
    throw new RustDeskError('asset-load-failed', 'Failed to attach yuv-canvas', { cause });
  }
}

export class VideoRenderer implements VideoSink {
  readonly usingWebGL: boolean;

  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly sink: FrameSink;
  private readonly onLayout?: (layout: RendererLayout | null) => void;
  private readonly onFullscreenChange?: (fullscreen: boolean) => void;
  private readonly resizeObserver?: ResizeObserver;
  private readonly windowResize?: () => void;
  private readonly fullscreenListener: () => void;
  private currentFrame: { width: number; height: number } | null = null;
  private currentLayout: RendererLayout | null = null;
  private cssFullscreen = false;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    options: VideoRendererOptions = {},
  ) {
    this.canvas = canvas;
    this.container = container;
    this.onLayout = options.onLayout;
    this.onFullscreenChange = options.onFullscreenChange;

    canvas.style.display = 'block';
    canvas.style.position = 'absolute';
    const position =
      typeof getComputedStyle === 'function'
        ? getComputedStyle(container).position
        : 'static';
    if (position === 'static' || position === '') {
      container.style.position = 'relative';
    }

    const created = defaultFrameSink(canvas, options.webGL ?? true);
    this.sink = created.sink;
    this.usingWebGL = created.webGL;

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    } else if (typeof window !== 'undefined') {
      this.windowResize = () => this.resize();
      window.addEventListener('resize', this.windowResize);
    }

    this.fullscreenListener = () => {
      this.resize();
      this.onFullscreenChange?.(this.fullscreen);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', this.fullscreenListener);
      document.addEventListener('webkitfullscreenchange', this.fullscreenListener);
    }
    this.resize();
  }

  get layout(): RendererLayout | null {
    return this.currentLayout;
  }

  /** Native fullscreen or the CSS viewport-fill fallback is always available. */
  get fullscreenSupported(): boolean {
    return !this.disposed;
  }

  /** True while native fullscreen or the CSS fallback is active. */
  get fullscreen(): boolean {
    if (this.disposed || typeof document === 'undefined') return false;
    if (this.cssFullscreen) return true;
    const doc = document as VendorDocument;
    return (
      (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) ===
      this.container
    );
  }

  /** Draw and release one decoded frame (P2-2 VideoSink). */
  draw(frame: Vp9Frame, release: () => void): void {
    try {
      if (this.disposed) return;
      const size = frameSize(frame);
      if (!size) {
        throw new RustDeskError('protocol-error', 'Decoded VP9 frame has no dimensions');
      }
      const resized = !sameSize(this.currentFrame, size);
      this.currentFrame = size;
      this.sink.drawFrame(frame);
      // Container changes arrive through ResizeObserver/window/fullscreen;
      // only a new frame size needs a relayout here.
      if (resized) this.resize();
    } finally {
      release();
    }
  }

  clear(): void {
    if (this.disposed) return;
    try {
      this.sink.clear();
    } catch {
      // A lost context must not break the session; P2-4 rebuilds the decoder.
    }
  }

  /** Recompute the letterboxed CSS box from the container size. */
  resize(): void {
    if (this.disposed) return;
    const frame = this.currentFrame;
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    if (!frame || containerWidth <= 0 || containerHeight <= 0) {
      this.updateLayout(null);
      return;
    }

    const scale = Math.min(
      containerWidth / frame.width,
      containerHeight / frame.height,
    );
    const cssWidth = frame.width * scale;
    const cssHeight = frame.height * scale;
    this.updateLayout({
      width: frame.width,
      height: frame.height,
      cssWidth,
      cssHeight,
      offsetX: (containerWidth - cssWidth) / 2,
      offsetY: (containerHeight - cssHeight) / 2,
      scale,
    });
  }

  /** Client (viewport) coordinates to remote frame pixels; null outside. */
  toRemote(clientX: number, clientY: number): { x: number; y: number } | null {
    const frame = this.currentFrame;
    const rect = this.canvasRect();
    if (!frame || !rect) return null;
    if (
      clientX < rect.left ||
      clientY < rect.top ||
      clientX >= rect.right ||
      clientY >= rect.bottom
    ) {
      return null;
    }
    return {
      x: ((clientX - rect.left) / rect.width) * frame.width,
      y: ((clientY - rect.top) / rect.height) * frame.height,
    };
  }

  /** Remote frame pixels to client (viewport) coordinates; null without a frame. */
  toClient(x: number, y: number): { x: number; y: number } | null {
    const frame = this.currentFrame;
    const rect = this.canvasRect();
    if (!frame || !rect) return null;
    return {
      x: rect.left + (x / frame.width) * rect.width,
      y: rect.top + (y / frame.height) * rect.height,
    };
  }

  /**
   * Fullscreen the container. Uses the native API when available and falls
   * back to the CSS viewport fill when it is missing or rejected (iPhone
   * Safari, iframes without `allowfullscreen`). Returns false only after
   * disposal.
   */
  async requestFullscreen(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.cssFullscreen) return true;
    const element = this.container as VendorFullscreenElement;
    const request =
      element.requestFullscreen?.bind(element) ??
      element.webkitRequestFullscreen?.bind(element);
    if (request) {
      try {
        await request();
        this.resize();
        return true;
      } catch {
        // Fall through to the CSS fallback.
      }
    }
    this.enterCssFullscreen();
    return true;
  }

  async exitFullscreen(): Promise<void> {
    if (this.cssFullscreen) {
      this.exitCssFullscreen();
      return;
    }
    if (typeof document === 'undefined') return;
    const doc = document as VendorDocument;
    const fullscreenElement =
      doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    if (fullscreenElement !== this.container) return;
    const exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
    if (!exit) return;
    try {
      await exit();
      this.resize();
    } catch {
      // Ignore; the CSS fallback still covers hosts without a working API.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    if (this.cssFullscreen) {
      this.cssFullscreen = false;
      this.container.removeAttribute(CSS_FULLSCREEN_ATTRIBUTE);
    }
    this.resizeObserver?.disconnect();
    if (this.windowResize) window.removeEventListener('resize', this.windowResize);
    if (typeof document !== 'undefined') {
      document.removeEventListener('fullscreenchange', this.fullscreenListener);
      document.removeEventListener('webkitfullscreenchange', this.fullscreenListener);
    }
    this.currentLayout = null;
    this.currentFrame = null;
  }

  private enterCssFullscreen(): void {
    if (this.disposed || this.cssFullscreen) return;
    this.cssFullscreen = true;
    ensureCssFullscreenStyle(this.container.ownerDocument);
    this.container.setAttribute(CSS_FULLSCREEN_ATTRIBUTE, '');
    this.resize();
    this.onFullscreenChange?.(true);
  }

  private exitCssFullscreen(): void {
    if (!this.cssFullscreen) return;
    this.cssFullscreen = false;
    this.container.removeAttribute(CSS_FULLSCREEN_ATTRIBUTE);
    this.resize();
    this.onFullscreenChange?.(false);
  }

  private canvasRect(): DOMRect | null {
    if (!this.currentFrame) return null;
    const rect = this.canvas.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  private updateLayout(layout: RendererLayout | null): void {
    if (layoutEquals(this.currentLayout, layout)) return;
    this.currentLayout = layout;
    if (layout) {
      this.canvas.style.width = `${layout.cssWidth}px`;
      this.canvas.style.height = `${layout.cssHeight}px`;
      this.canvas.style.left = `${layout.offsetX}px`;
      this.canvas.style.top = `${layout.offsetY}px`;
    }
    try {
      this.onLayout?.(layout);
    } catch {
      // Host callbacks must not break rendering.
    }
  }
}

function layoutEquals(
  a: RendererLayout | null,
  b: RendererLayout | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight &&
    a.offsetX === b.offsetX &&
    a.offsetY === b.offsetY &&
    a.scale === b.scale
  );
}
