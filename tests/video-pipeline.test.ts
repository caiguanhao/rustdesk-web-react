import { describe, expect, it } from 'vitest';
import * as message from '../src/protocol/message';
import type { DeepPartial } from '../src/protocol/message';
import {
  VideoPipeline,
  type VideoChannel,
  type VideoDecoder,
  type VideoSink,
} from '../src/media/video-pipeline';
import type { Vp9Frame } from '../src/media/vp9-decoder';
import { RustDeskError } from '../src/session/errors';

interface FrameSpec {
  key: boolean;
  id?: number;
}

function batch(specs: FrameSpec[]): message.VideoFrame {
  return message.VideoFrame.fromPartial({
    display: 0,
    timestamp: 1,
    vp9s: message.VP9s.fromPartial({
      frames: specs.map((spec, index) =>
        message.VP9.fromPartial({
          data: Uint8Array.from([spec.id ?? index + 1]),
          key: spec.key,
          pts: index,
        }),
      ),
    }),
  });
}

class TestDecoder implements VideoDecoder {
  readonly decodedData: number[] = [];
  readonly recycled: Vp9Frame[] = [];
  delayMs = 0;
  failNext = false;

  async decode(data: Uint8Array): Promise<Vp9Frame | null> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failNext) {
      this.failNext = false;
      return null;
    }
    this.decodedData.push(data[0] ?? -1);
    return { width: 1, height: 1 };
  }

  recycle(frame: Vp9Frame): void {
    this.recycled.push(frame);
  }
}

function fakeChannel(): VideoChannel & { sent: DeepPartial<message.Message>[] } {
  const sent: DeepPartial<message.Message>[] = [];
  return {
    sent,
    sendMessage(payload) {
      sent.push(payload);
    },
  };
}

function fakeSink(onDraw?: () => void): VideoSink & { drawn: Vp9Frame[] } {
  const drawn: Vp9Frame[] = [];
  return {
    drawn,
    draw(frame) {
      drawn.push(frame);
      onDraw?.();
    },
  };
}

const countMisc = (
  sent: DeepPartial<message.Message>[],
  field: 'video_received' | 'refresh_video',
): number => sent.filter((payload) => payload.misc?.[field] === true).length;

describe('VideoPipeline', () => {
  it('acks every batch and decodes frames in order', async () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const sink = fakeSink();
    const pipeline = new VideoPipeline({ decoder, channel, sink });

    pipeline.push(batch([{ key: true, id: 1 }]));
    pipeline.push(batch([{ key: false, id: 2 }]));
    await pipeline.idle();

    expect(countMisc(channel.sent, 'video_received')).toBe(2);
    expect(decoder.decodedData).toEqual([1, 2]);
    expect(sink.drawn).toHaveLength(2);
    expect(decoder.recycled).toHaveLength(2);
    expect(pipeline.awaitingKeyframe).toBe(false);
  });

  it('drops deltas until a keyframe and still acks', async () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const sink = fakeSink();
    const pipeline = new VideoPipeline({ decoder, channel, sink });

    pipeline.push(batch([{ key: false, id: 9 }]));
    expect(pipeline.awaitingKeyframe).toBe(true);
    expect(pipeline.queuedFrames).toBe(0);
    expect(countMisc(channel.sent, 'refresh_video')).toBe(1);

    pipeline.push(batch([{ key: true, id: 1 }, { key: false, id: 2 }]));
    await pipeline.idle();

    expect(decoder.decodedData).toEqual([1, 2]);
    expect(pipeline.awaitingKeyframe).toBe(false);
    expect(countMisc(channel.sent, 'video_received')).toBe(2);
  });

  it('bounds the queue and requests a keyframe when it overflows', async () => {
    const decoder = new TestDecoder();
    decoder.delayMs = 5;
    const channel = fakeChannel();
    const sink = fakeSink();
    const pipeline = new VideoPipeline({
      decoder,
      channel,
      sink,
      maxQueuedFrames: 2,
    });

    pipeline.push(batch([{ key: true, id: 1 }]));
    pipeline.push(batch([{ key: false, id: 2 }]));
    pipeline.push(batch([{ key: false, id: 3 }]));
    pipeline.push(batch([{ key: false, id: 4 }]));
    await pipeline.idle();

    expect(decoder.decodedData).toEqual([1]);
    expect(pipeline.queuedFrames).toBe(0);
    expect(pipeline.awaitingKeyframe).toBe(true);
    expect(pipeline.stats.dropped).toBeGreaterThanOrEqual(3);
    expect(countMisc(channel.sent, 'refresh_video')).toBe(1);

    pipeline.push(batch([{ key: true, id: 5 }, { key: false, id: 6 }]));
    await pipeline.idle();
    expect(decoder.decodedData).toEqual([1, 5, 6]);
    expect(pipeline.awaitingKeyframe).toBe(false);
    expect(countMisc(channel.sent, 'video_received')).toBe(5);
  });

  it('throttles refresh requests but forces one on visibility resume', () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const sink = fakeSink();
    let now = 0;
    const pipeline = new VideoPipeline({
      decoder,
      channel,
      sink,
      refreshIntervalMs: 1_000,
      now: () => now,
    });

    pipeline.push(batch([{ key: false }]));
    expect(countMisc(channel.sent, 'refresh_video')).toBe(1);
    now = 500;
    pipeline.push(batch([{ key: false }]));
    expect(countMisc(channel.sent, 'refresh_video')).toBe(1);
    now = 1_000;
    pipeline.push(batch([{ key: false }]));
    expect(countMisc(channel.sent, 'refresh_video')).toBe(2);

    pipeline.handleVisibilityChange(false);
    pipeline.handleVisibilityChange(true);
    expect(countMisc(channel.sent, 'refresh_video')).toBe(3);
    expect(pipeline.awaitingKeyframe).toBe(true);
  });

  it('reports non-VP9 frames, acks them and does not request a refresh', () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const errors: RustDeskError[] = [];
    const pipeline = new VideoPipeline({
      decoder,
      channel,
      sink: fakeSink(),
      onError: (error) => errors.push(error),
    });

    pipeline.push(message.VideoFrame.fromPartial({ rgb: message.RGB.fromPartial({}) }));
    expect(countMisc(channel.sent, 'video_received')).toBe(1);
    expect(countMisc(channel.sent, 'refresh_video')).toBe(0);
    expect(errors.map((error) => error.code)).toEqual(['unsupported-codec']);
    expect(decoder.decodedData).toEqual([]);
  });

  it('recycles a frame even when the sink throws', async () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const errors: RustDeskError[] = [];
    const pipeline = new VideoPipeline({
      decoder,
      channel,
      sink: fakeSink(() => {
        throw new Error('draw failed');
      }),
      onError: (error) => errors.push(error),
    });

    pipeline.push(batch([{ key: true }]));
    await pipeline.idle();
    expect(errors.map((error) => error.code)).toEqual(['protocol-error']);
    expect(decoder.recycled).toHaveLength(1);
  });

  it('waits for a keyframe after a decode failure', async () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const pipeline = new VideoPipeline({
      decoder,
      channel,
      sink: fakeSink(),
    });

    decoder.failNext = true;
    pipeline.push(batch([{ key: true, id: 1 }]));
    await pipeline.idle();
    expect(pipeline.awaitingKeyframe).toBe(true);
    expect(countMisc(channel.sent, 'refresh_video')).toBe(1);

    pipeline.push(batch([{ key: false, id: 2 }]));
    pipeline.push(batch([{ key: true, id: 3 }]));
    await pipeline.idle();
    expect(decoder.decodedData).toEqual([3]);
    expect(countMisc(channel.sent, 'video_received')).toBe(3);
  });

  it('clears the queue on dispose and does not draw the in-flight frame', async () => {
    const decoder = new TestDecoder();
    decoder.delayMs = 5;
    const channel = fakeChannel();
    const sink = fakeSink();
    const pipeline = new VideoPipeline({ decoder, channel, sink });

    pipeline.push(batch([{ key: true }]));
    await pipeline.dispose();

    expect(pipeline.queuedFrames).toBe(0);
    expect(sink.drawn).toHaveLength(0);
    expect(decoder.recycled).toHaveLength(1);
  });

  it('does not ack frames already acked by the pre-login queue', async () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const pipeline = new VideoPipeline({ decoder, channel, sink: fakeSink() });

    pipeline.push(batch([{ key: true, id: 1 }]), { acked: true });
    await pipeline.idle();
    expect(decoder.decodedData).toEqual([1]);
    expect(countMisc(channel.sent, 'video_received')).toBe(0);
  });

  it('lets the sink release a frame exactly once', async () => {
    const decoder = new TestDecoder();
    const channel = fakeChannel();
    const pipeline = new VideoPipeline({
      decoder,
      channel,
      sink: {
        draw(_frame, release) {
          release();
          release();
        },
      },
    });

    pipeline.push(batch([{ key: true }]));
    await pipeline.idle();
    expect(decoder.recycled).toHaveLength(1);
  });
});
