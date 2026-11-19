/**
 * Video frame admission, bounded queueing and flow control (P2-2).
 *
 * RustDesk gates encoding on `Misc{video_received}` acks. Every `VideoFrame`
 * batch must be acked exactly once — including batches that are dropped for
 * backpressure or arrive while awaiting a keyframe — or the peer stops
 * sending. The list's first frame should normally be a keyframe; after any
 * drop or decode failure the pipeline waits for a keyframe and sends
 * `Misc{refresh_video}` (rate-limited) so the peer produces one.
 *
 * The decoder itself is serialized by P2-1. This pipeline bounds the pending
 * encoded-frame queue, drops stale deltas, and hands decoded frames to a
 * synchronous sink. The sink must draw immediately; the pipeline recycles the
 * YUV frame right after `draw` returns.
 */
import * as message from '../protocol/message.js';
import type { DeepPartial } from '../protocol/message.js';
import type { RelayConnection } from '../protocol/connection.js';
import { RustDeskError } from '../session/errors.js';
import type { Vp9Decoder, Vp9Frame } from './vp9-decoder.js';

export const DEFAULT_MAX_QUEUED_FRAMES = 8;
export const DEFAULT_REFRESH_INTERVAL_MS = 1_000;

export type VideoDecoder = Pick<Vp9Decoder, 'decode' | 'recycle'>;

export type VideoChannel = Pick<RelayConnection, 'sendMessage'>;

export interface VideoSink {
  /** Draw the frame, then call `release` exactly once (idempotent). */
  draw(frame: Vp9Frame, release: () => void): void;
}

export interface VideoPipelineOptions {
  decoder: VideoDecoder;
  channel: VideoChannel;
  sink: VideoSink;
  /** Pending encoded-frame cap, default 8. */
  maxQueuedFrames?: number;
  /** Minimum gap between refresh_video requests, default 1 s. */
  refreshIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  onError?: (error: RustDeskError) => void;
}

export class VideoPipeline {
  readonly stats = { decoded: 0, dropped: 0, acks: 0, refreshes: 0 };

  private readonly decoder: VideoDecoder;
  private readonly channel: VideoChannel;
  private readonly sink: VideoSink;
  private readonly maxQueuedFrames: number;
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly onError?: (error: RustDeskError) => void;
  private readonly queue: message.VP9[] = [];
  private readonly idleResolvers: (() => void)[] = [];
  private awaiting = true;
  private running = false;
  private disposed = false;
  private drainPromise: Promise<void> | undefined;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private lastVisible = true;
  private display = 0;

  constructor(options: VideoPipelineOptions) {
    this.decoder = options.decoder;
    this.channel = options.channel;
    this.sink = options.sink;
    this.maxQueuedFrames = Math.max(1, options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES);
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  get awaitingKeyframe(): boolean {
    return this.awaiting;
  }

  get queuedFrames(): number {
    return this.queue.length;
  }

  /** Display index of the most recent VideoFrame message. */
  get currentDisplay(): number {
    return this.display;
  }

  /**
   * Admit one `VideoFrame` message. Always acks, even when the batch is
   * dropped. Pass `acked: true` for frames already acknowledged by
   * `LoginFlow`'s pre-login queue to avoid sending a duplicate ack.
   */
  push(video: message.VideoFrame, options?: { acked?: boolean }): void {
    if (this.disposed) return;
    if (!options?.acked) this.ack();

    if (!video.vp9s) {
      this.report(
        new RustDeskError(
          'unsupported-codec',
          'The peer sent a non-VP9 video frame; reconnect so it negotiates VP9 only.',
        ),
      );
      return;
    }

    this.display = video.display;
    this.accept(video.vp9s.frames);
    this.kick();
  }

  /**
   * Call on document visibility changes. Resuming clears stale deltas and
   * requests a fresh keyframe immediately.
   */
  handleVisibilityChange(visible: boolean): void {
    if (this.disposed) return;
    const resumed = visible && !this.lastVisible;
    const hidden = !visible && this.lastVisible;
    this.lastVisible = visible;
    if (hidden) {
      // Stop decoding while hidden; the peer still gets acks for arriving batches.
      this.queue.length = 0;
      this.awaiting = true;
      return;
    }
    if (!resumed) return;
    this.queue.length = 0;
    this.awaiting = true;
    this.requestKeyframe(true);
  }

  /** Resolves when the queue is empty and no decode is in flight. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  /**
   * Stop admitting frames and wait for any in-flight decode. Dispose the
   * decoder only after this resolves (P4-1 owns the decoder).
   */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.queue.length = 0;
      this.resolveIdle();
    }
    await this.drainPromise;
  }

  private accept(frames: message.VP9[]): void {
    if (frames.length === 0) return;

    if (this.awaiting) {
      const keyIndex = frames.findIndex((frame) => frame.key);
      if (keyIndex < 0) {
        this.stats.dropped += frames.length;
        this.requestKeyframe(false);
        return;
      }
      this.queue.length = 0;
      this.awaiting = false;
      this.enqueueFrom(frames, keyIndex);
      return;
    }

    if (this.queue.length + frames.length > this.maxQueuedFrames) {
      // The dependency chain is broken; wait for a fresh keyframe, keeping one
      // if this batch already contains it.
      const keyIndex = frames.findIndex((frame) => frame.key);
      this.stats.dropped += this.queue.length;
      this.queue.length = 0;
      this.awaiting = true;
      this.requestKeyframe(false);
      if (keyIndex >= 0) {
        this.awaiting = false;
        this.enqueueFrom(frames, keyIndex);
      } else {
        this.stats.dropped += frames.length;
      }
      return;
    }

    for (const frame of frames) this.queue.push(frame);
  }

  private enqueueFrom(frames: message.VP9[], start: number): void {
    const end = Math.min(frames.length, start + this.maxQueuedFrames);
    for (let index = start; index < end; index += 1) {
      this.queue.push(frames[index]!);
    }
    this.stats.dropped += start + (frames.length - end);
  }

  private kick(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.drainPromise = this.drain();
    void this.drainPromise;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.queue.length > 0) {
        const item = this.queue.shift()!;
        if (this.awaiting && !item.key) {
          this.stats.dropped += 1;
          continue;
        }
        if (item.key) this.awaiting = false;

        let frame: Vp9Frame | null;
        try {
          frame = await this.decoder.decode(item.data);
        } catch (error) {
          if (this.disposed) break;
          this.markAwaitingKeyframe();
          this.report(
            error instanceof RustDeskError
              ? error
              : new RustDeskError('protocol-error', 'VP9 decode failed', { cause: error }),
          );
          continue;
        }

        if (this.disposed) {
          // Do not leak the worker buffer if disposal raced the decode.
          if (frame) this.decoder.recycle(frame);
          break;
        }
        if (!frame) {
          this.markAwaitingKeyframe();
          continue;
        }

        this.stats.decoded += 1;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          this.decoder.recycle(frame!);
        };
        try {
          this.sink.draw(frame, release);
        } catch (cause) {
          this.report(
            new RustDeskError('protocol-error', 'Video sink failed to draw a frame', {
              cause,
            }),
          );
        } finally {
          // Release even if the sink forgot or threw; recycling is idempotent.
          release();
        }
      }
    } finally {
      this.running = false;
      if (!this.disposed && this.queue.length > 0) {
        this.kick();
      } else if (this.queue.length === 0) {
        this.resolveIdle();
      }
    }
  }

  private markAwaitingKeyframe(): void {
    this.awaiting = true;
    this.requestKeyframe(false);
  }

  private ack(): void {
    this.stats.acks += 1;
    this.sendMisc({ video_received: true }, 'Failed to send a video ack');
  }

  private requestKeyframe(force: boolean): void {
    const now = this.now();
    if (!force && now - this.lastRefreshAt < this.refreshIntervalMs) return;
    this.lastRefreshAt = now;
    this.stats.refreshes += 1;
    this.sendMisc({ refresh_video: true }, 'Failed to request a keyframe');
  }

  private sendMisc(misc: DeepPartial<message.Misc>, failure: string): void {
    try {
      this.channel.sendMessage({ misc });
    } catch (cause) {
      this.report(new RustDeskError('connection-lost', failure, { cause }));
    }
  }

  private report(error: RustDeskError): void {
    try {
      this.onError?.(error);
    } catch {
      // Host callbacks must not break the decode loop.
    }
  }

  private resolveIdle(): void {
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}
