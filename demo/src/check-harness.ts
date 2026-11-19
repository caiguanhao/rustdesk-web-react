// Shared helpers for the browser check pages (P2-1/P2-3/P2-5). These pages are
// driven by scripts/check-decoders.mjs and tests/e2e/canvas.spec.ts.
import { DEFAULT_ASSET_BASE_URL } from 'rustdesk-web-react/core';
import { VideoRenderer, type RendererLayout } from '../../src/media/renderer';
import {
  Vp9Decoder,
  frameSize,
  type FrameSize,
} from '../../src/media/vp9-decoder';

export const CHECK_TIMEOUT_MS = 20_000;

export function setStatus(text: string): void {
  const status = document.getElementById('status');
  if (status) status.textContent = text;
}

export function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** Read the top-left pixel back from the just-drawn WebGL/software canvas. */
export async function readPixel(canvas: HTMLCanvasElement): Promise<number[]> {
  const bitmap = await createImageBitmap(canvas);
  try {
    const scratch = document.createElement('canvas');
    scratch.width = 1;
    scratch.height = 1;
    const context = scratch.getContext('2d');
    if (!context) throw new Error('Canvas pixel readback failed: no 2D context');
    context.drawImage(bitmap, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  } finally {
    bitmap.close();
  }
}

export interface CanvasSnapshot {
  canvasWidth: number;
  canvasHeight: number;
  containerWidth: number;
  containerHeight: number;
  rectWidth: number;
  rectHeight: number;
  /** Canvas box relative to the container's top-left. */
  offsetX: number;
  offsetY: number;
  layout: RendererLayout | null;
}

export function snapshot(
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  renderer: VideoRenderer,
): CanvasSnapshot {
  const rect = canvas.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return {
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    containerWidth: container.clientWidth,
    containerHeight: container.clientHeight,
    rectWidth: rect.width,
    rectHeight: rect.height,
    offsetX: rect.left - containerRect.left,
    offsetY: rect.top - containerRect.top,
    layout: renderer.layout,
  };
}

export function createCheckDecoder(simd?: boolean): Promise<Vp9Decoder> {
  return Vp9Decoder.create({
    simd,
    assetBaseUrl: DEFAULT_ASSET_BASE_URL,
    timeoutMs: CHECK_TIMEOUT_MS,
  });
}

export function mountRenderer(container: HTMLElement): {
  canvas: HTMLCanvasElement;
  renderer: VideoRenderer;
} {
  const canvas = document.createElement('canvas');
  container.append(canvas);
  return { canvas, renderer: new VideoRenderer(canvas, container, { webGL: true }) };
}

export async function drawVp9Frame(
  renderer: VideoRenderer,
  decoder: Vp9Decoder,
  bytes: Uint8Array,
  onRelease?: () => void,
): Promise<FrameSize> {
  const frame = await decoder.decode(bytes);
  const size = frame ? frameSize(frame) : null;
  if (!frame || !size) throw new Error('VP9 frame did not decode');
  renderer.draw(frame, () => {
    try {
      onRelease?.();
    } finally {
      decoder.recycle(frame);
    }
  });
  return size;
}

/** Sequential decode+draw benchmark with an optional warmup. */
export async function measureFps(
  draw: () => Promise<unknown>,
  iterations: number,
  warmup = 0,
): Promise<{ fps: number; elapsedMs: number }> {
  for (let index = 0; index < warmup; index += 1) await draw();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await draw();
  const elapsedMs = performance.now() - started;
  return {
    fps: (iterations * 1000) / elapsedMs,
    elapsedMs,
  };
}
