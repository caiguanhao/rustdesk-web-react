// Playwright input acceptance (P3-1/P3-2), driven by tests/e2e/input.spec.ts
// and keyboard.spec.ts. Renders a real VP9 frame through VideoRenderer,
// attaches MouseInput/KeyboardInput with recording channels, and exposes the
// recorded wire messages for assertions.
import { VP9_FIXTURES } from '../../test-fixtures/vp9';
import { ImeInput, type ViewportInfo } from '../../src/input/ime';
import { KeyboardInput } from '../../src/input/keyboard';
import { MouseInput } from '../../src/input/mouse';
import {
  TouchInput,
  type LocalZoomState,
  type TouchGesture,
} from '../../src/input/touch';
import type {
  DeepPartial,
  KeyEvent,
  Message,
} from '../../src/protocol/message';
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

export type RecordedKey = KeyEvent;

export interface InputTestApi {
  ready: boolean;
  messages: RecordedMouse[];
  keys: RecordedKey[];
  clear(): void;
  clearKeys(): void;
  setStageSize(width: number, height: number): void;
  setPlatform(platform: string): void;
  setKeyboardEnabled(enabled: boolean): void;
  sendCtrlAltDel(): void;
  sendLockScreen(): void;
  focusIme(): boolean;
  setImeEnabled(enabled: boolean): void;
  imeFocused: boolean;
  viewport?: ViewportInfo;
  gestures: TouchGesture[];
  localZoom: LocalZoomState;
  clearGestures(): void;
  setMouseEnabled(enabled: boolean): void;
  setTouchEnabled(enabled: boolean): void;
  resetTouchZoom(): void;
  lastContextMenuPrevented?: boolean;
  lastKeyDownPrevented?: boolean;
}

declare global {
  interface Window {
    inputTest?: InputTestApi;
  }
}

const messages: RecordedMouse[] = [];
const keys: RecordedKey[] = [];
const stageElement = document.getElementById('stage');
if (!stageElement) throw new Error('input test: #stage is missing');
const stage: HTMLElement = stageElement;
const { canvas, renderer } = mountRenderer(stage);

const recordKey = {
  sendMessage(payload: DeepPartial<Message>) {
    if (payload.key_event) keys.push(payload.key_event as KeyEvent);
  },
};

const recordMouse = {
  sendMessage(payload: DeepPartial<Message>) {
    const event = payload.mouse_event;
    if (!event) return;
    messages.push({
      mask: event.mask ?? 0,
      x: event.x ?? 0,
      y: event.y ?? 0,
      modifiers: [...(event.modifiers ?? [])],
    });
  },
};

const gestures: TouchGesture[] = [];
const touch = new TouchInput({
  element: canvas,
  mapper: renderer,
  channel: recordMouse,
  onGesture: (gesture) => gestures.push(gesture),
  onLocalZoom: (state) => {
    api.localZoom = state;
  },
});

const keyboard = new KeyboardInput({
  channel: recordKey,
  platform: 'Windows',
  target: document,
});

const ime = new ImeInput({
  channel: recordKey,
  onFocusChange: (focused) => {
    api.imeFocused = focused;
  },
  onViewportChange: (viewport) => {
    api.viewport = viewport;
  },
});

const api: InputTestApi = {
  ready: false,
  messages,
  keys,
  imeFocused: false,
  gestures,
  localZoom: { scale: 1, translateX: 0, translateY: 0 },
  clear: () => {
    messages.length = 0;
  },
  clearKeys: () => {
    keys.length = 0;
  },
  setStageSize: (width, height) => {
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    renderer.resize();
  },
  setPlatform: (platform) => keyboard.setPlatform(platform),
  setKeyboardEnabled: (enabled) => keyboard.setEnabled(enabled),
  sendCtrlAltDel: () => keyboard.sendCtrlAltDel(),
  sendLockScreen: () => keyboard.sendLockScreen(),
  focusIme: () => ime.focus(),
  setImeEnabled: (enabled) => ime.setEnabled(enabled),
  clearGestures: () => {
    gestures.length = 0;
  },
  setMouseEnabled: (enabled) => mouse.setEnabled(enabled),
  setTouchEnabled: (enabled) => touch.setEnabled(enabled),
  resetTouchZoom: () => touch.resetLocalZoom(),
};
window.inputTest = api;

const mouse = new MouseInput({
  element: canvas,
  mapper: renderer,
  channel: recordMouse,
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

  mouse.attach();
  keyboard.attach();
  ime.attach();
  touch.attach();
  // Registered after KeyboardInput so it observes its preventDefault call.
  document.addEventListener('keydown', (event) => {
    api.lastKeyDownPrevented = event.defaultPrevented;
  });
  api.ready = true;
  setStatus('ready');
}

start().catch((error: unknown) => {
  setStatus(`error: ${String(error)}`);
});
