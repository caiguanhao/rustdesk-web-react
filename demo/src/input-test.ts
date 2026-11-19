// Playwright mouse-input acceptance (P3-1), driven by tests/e2e/input.spec.ts.
// Renders a real VP9 frame through VideoRenderer, attaches MouseInput with a
// recording channel, and exposes the recorded wire messages for assertions.
import { VP9_FIXTURES } from '../../test-fixtures/vp9';
import { MouseInput } from '../../src/input/mouse';
import {
  bytesFromBase64,
  createCheckDecoder,
  drawVp9Frame,
  mountRenderer,
  setStatus,
} from './check-harness';

export interface RecordedMouse {
  mask: number;
  x: number;
  y: number;
  modifiers: number[];
}

export interface InputTestApi {
  ready: boolean;
  messages: RecordedMouse[];
  clear(): void;
  setStageSize(width: number, height: number): void;
  lastContextMenuPrevented?: boolean;
}

declare global {
  interface Window {
    inputTest?: InputTestApi;
  }
}

const messages: RecordedMouse[] = [];
const stageElement = document.getElementById('stage');
if (!stageElement) throw new Error('input test: #stage is missing');
const stage: HTMLElement = stageElement;
const { canvas, renderer } = mountRenderer(stage);

const api: InputTestApi = {
  ready: false,
  messages,
  clear: () => {
    messages.length = 0;
  },
  setStageSize: (width, height) => {
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    renderer.resize();
  },
};
window.inputTest = api;

const input = new MouseInput({
  element: canvas,
  mapper: renderer,
  channel: {
    sendMessage(payload) {
      const event = payload.mouse_event;
      if (!event) return;
      messages.push({
        mask: event.mask ?? 0,
        x: event.x ?? 0,
        y: event.y ?? 0,
        modifiers: [...(event.modifiers ?? [])],
      });
    },
  },
});

document.addEventListener('contextmenu', (event) => {
  api.lastContextMenuPrevented = event.defaultPrevented;
});

async function start(): Promise<void> {
  setStatus('loading decoder…');
  const decoder = await createCheckDecoder();
  const fixture = VP9_FIXTURES[0];
  if (!fixture) throw new Error('input test: no VP9 fixture');
  await drawVp9Frame(renderer, decoder, bytesFromBase64(fixture.keyframeBase64));
  decoder.dispose();

  input.attach();
  api.ready = true;
  setStatus('ready');
}

start().catch((error: unknown) => {
  setStatus(`error: ${String(error)}`);
});
