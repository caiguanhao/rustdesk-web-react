import { vi } from 'vitest';

// Minimal EventTarget-based DOM for Node integration tests. jsdom's realm
// makes protobuf Buffers fail libsodium's `instanceof Uint8Array` check, so
// the encrypted relay tests use these stubs instead.

export class FakeElement extends EventTarget {
  readonly style: Record<string, string> = {};

  constructor(private readonly rect: DOMRect) {
    super();
  }

  getBoundingClientRect(): DOMRect {
    return this.rect;
  }
}

export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

export interface FakeDom {
  window: EventTarget;
  document: FakeDocument;
  restore(): void;
}

export function installFakeDom(): FakeDom {
  const windowTarget = new EventTarget();
  const documentTarget = new FakeDocument();
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  return {
    window: windowTarget,
    document: documentTarget,
    restore: () => vi.unstubAllGlobals(),
  };
}

export function dispatchDom(
  target: EventTarget,
  type: string,
  init: object = {},
): Event {
  const event = Object.assign(
    new Event(type, { bubbles: true, cancelable: true }),
    init,
  );
  target.dispatchEvent(event);
  return event;
}
