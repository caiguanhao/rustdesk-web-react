// Minimal typings for the untyped yuv-canvas package (MIT, 1.2.6).
declare module 'yuv-canvas' {
  export interface YUVFrameSink {
    drawFrame(buffer: unknown): void;
    clear(): void;
  }

  export interface YUVCanvasStatic {
    attach(canvas: HTMLCanvasElement, options?: { webGL?: boolean }): YUVFrameSink;
    WebGLFrameSink: {
      isAvailable(): boolean;
    };
  }

  const YUVCanvas: YUVCanvasStatic;
  export default YUVCanvas;
}
