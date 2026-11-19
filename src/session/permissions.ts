/**
 * Session permission state and input gates (P3-6).
 *
 * The host app can force view-only with `readOnly` (the public name for the
 * task's `viewOnly`) and can disable clipboard sync with `disableClipboard`.
 * The controlled peer reports keyboard/clipboard/audio/file permission through
 * `Misc.permission_info`; `SessionPermissions` turns both sources into a
 * single `InputPolicy` that P4-1/P4-3 apply to the input controllers.
 *
 * Verified RustDesk semantics:
 *   - View-only blocks mouse, keyboard, touch, IME and clipboard both ways.
 *   - Peer keyboard permission gates mouse/touch/pointer events, keyboard,
 *     IME and — together with clipboard permission — clipboard sends
 *     (`peer_keyboard_enabled`, `is_text_clipboard_required`).
 *   - Peer clipboard permission does not gate applying inbound clipboard;
 *     the host stops sending when it revokes clipboard. Local view-only or
 *     disable-clipboard does block inbound.
 *
 * `apply` handles the login-time permission snapshot (not an error).
 * A post-login keyboard/clipboard revocation delivered through
 * `handleMessage` reports `no-permission` unless that input is already
 * locally disabled, so P4-3 can show a notice. P4-1 creates this state before
 * login and passes `apply` as `LoginFlow`'s `onPermission` (login-time
 * permission messages are not replayed), then routes post-login
 * `permission_info` messages through `handleMessage`.
 */
import {
  PermissionInfo_Permission,
  type Message,
} from '../protocol/message.js';
import { RustDeskError } from './errors.js';

export type PermissionName = 'keyboard' | 'clipboard' | 'audio' | 'file';

export interface PermissionChange {
  permission: PermissionName;
  enabled: boolean;
}

export type PermissionSnapshot = Readonly<Record<PermissionName, boolean>>;

/** Effective local gates for the input controllers. */
export interface InputPolicy {
  mouse: boolean;
  keyboard: boolean;
  touch: boolean;
  ime: boolean;
  clipboardSend: boolean;
  clipboardReceive: boolean;
}

export interface PermissionEvent {
  policy: InputPolicy;
  permissions: PermissionSnapshot;
  /** Present when a peer `permission_info` caused the event. */
  change?: PermissionChange;
}

export interface SessionPermissionsOptions {
  /** View-only: blocks all outbound input and inbound clipboard. */
  readOnly?: boolean;
  /** Local clipboard sync off in both directions (keyboard/mouse stay on). */
  disableClipboard?: boolean;
  /** Initial peer permissions; all default to true. */
  permissions?: Partial<Record<PermissionName, boolean>>;
  onChange?: (event: PermissionEvent) => void;
  onError?: (error: RustDeskError) => void;
}

export interface InputTarget {
  setEnabled(enabled: boolean): void;
}

export interface ClipboardTarget extends InputTarget {
  setReceiveEnabled(enabled: boolean): void;
}

export interface InputPolicyTargets {
  mouse?: InputTarget;
  keyboard?: InputTarget;
  touch?: InputTarget;
  ime?: InputTarget;
  clipboard?: ClipboardTarget;
}

const PERMISSION_NAMES_LIST = [
  'keyboard',
  'clipboard',
  'audio',
  'file',
] as const satisfies readonly PermissionName[];

const PERMISSION_NAMES: Partial<
  Record<PermissionInfo_Permission, PermissionName>
> = {
  [PermissionInfo_Permission.Keyboard]: 'keyboard',
  [PermissionInfo_Permission.Clipboard]: 'clipboard',
  [PermissionInfo_Permission.Audio]: 'audio',
  [PermissionInfo_Permission.File]: 'file',
};

export function permissionNameFromWire(
  permission: number,
): PermissionName | undefined {
  return PERMISSION_NAMES[permission as PermissionInfo_Permission];
}

/** Apply an input policy to whichever controllers the viewer owns. */
export function applyInputPolicy(
  policy: InputPolicy,
  targets: InputPolicyTargets,
): void {
  targets.mouse?.setEnabled(policy.mouse);
  targets.keyboard?.setEnabled(policy.keyboard);
  targets.touch?.setEnabled(policy.touch);
  targets.ime?.setEnabled(policy.ime);
  targets.clipboard?.setEnabled(policy.clipboardSend);
  targets.clipboard?.setReceiveEnabled(policy.clipboardReceive);
}

export class SessionPermissions {
  private readonly onChange?: (event: PermissionEvent) => void;
  private readonly onError?: (error: RustDeskError) => void;
  private readOnlyValue: boolean;
  private disableClipboardValue: boolean;
  private permissionsValue: Record<PermissionName, boolean>;
  private targets?: InputPolicyTargets;
  private disposed = false;

  constructor(options: SessionPermissionsOptions = {}) {
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.readOnlyValue = options.readOnly ?? false;
    this.disableClipboardValue = options.disableClipboard ?? false;
    const initial = options.permissions;
    this.permissionsValue = {
      keyboard: initial?.keyboard ?? true,
      clipboard: initial?.clipboard ?? true,
      audio: initial?.audio ?? true,
      file: initial?.file ?? true,
    };
  }

  get readOnly(): boolean {
    return this.readOnlyValue;
  }

  get disableClipboard(): boolean {
    return this.disableClipboardValue;
  }

  get permissions(): PermissionSnapshot {
    return { ...this.permissionsValue };
  }

  get policy(): InputPolicy {
    return this.computePolicy();
  }

  /**
   * Bind the viewer's input controllers. Applies the current policy
   * immediately and again on every change, so hosts cannot forget the
   * initial gating. Call again after recreating controllers.
   */
  bind(targets: InputPolicyTargets): void {
    if (this.disposed) return;
    this.targets = targets;
    applyInputPolicy(this.computePolicy(), targets);
  }

  setReadOnly(enabled: boolean): void {
    if (this.disposed || enabled === this.readOnlyValue) return;
    this.readOnlyValue = enabled;
    this.update();
  }

  setDisableClipboard(enabled: boolean): void {
    if (this.disposed || enabled === this.disableClipboardValue) return;
    this.disableClipboardValue = enabled;
    this.update();
  }

  /** Restore peer-granted permissions to enabled; local flags are unchanged. */
  resetPeerPermissions(): void {
    if (this.disposed) return;
    for (const permission of PERMISSION_NAMES_LIST) {
      this.apply({ permission, enabled: true });
    }
  }

  /**
   * Apply one login-time peer permission change (LoginFlow's `onPermission`).
   * Initial host state is not an error; post-login revocations go through
   * `handleMessage` instead.
   */
  apply(change: PermissionChange): void {
    if (this.disposed) return;
    if (this.permissionsValue[change.permission] === change.enabled) return;
    this.permissionsValue = {
      ...this.permissionsValue,
      [change.permission]: change.enabled,
    };
    this.update(change);
  }

  /**
   * Consume one post-login protocol message. Only `Misc.permission_info` is
   * used; unknown enum values are ignored. A keyboard/clipboard revocation
   * reports `no-permission` unless the affected input is already locally
   * disabled (view-only/disable-clipboard).
   */
  handleMessage(message: Message): void {
    if (this.disposed) return;
    const info = message.misc?.permission_info;
    if (!info) return;
    const permission = permissionNameFromWire(info.permission);
    if (!permission) return;

    const wasEnabled = this.permissionsValue[permission];
    this.apply({ permission, enabled: info.enabled });
    if (!wasEnabled || info.enabled) return;
    if (this.readOnlyValue) return;
    if (permission === 'clipboard' && this.disableClipboardValue) return;
    if (permission === 'keyboard' || permission === 'clipboard') {
      this.report(
        new RustDeskError(
          'no-permission',
          `The remote device disabled the ${permission} permission`,
        ),
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    this.targets = undefined;
  }

  private update(change?: PermissionChange): void {
    const policy = this.computePolicy();
    if (this.targets) applyInputPolicy(policy, this.targets);
    try {
      this.onChange?.({
        policy,
        permissions: this.permissions,
        change,
      });
    } catch {
      // Host callbacks must not break permission handling.
    }
  }

  private computePolicy(): InputPolicy {
    const readOnly = this.readOnlyValue;
    const localClipboard = !readOnly && !this.disableClipboardValue;
    // The host gates mouse, touch, keys and IME on the keyboard permission
    // (`peer_keyboard_enabled`), so disable all of them locally as well.
    const keyboard = !readOnly && this.permissionsValue.keyboard;
    return {
      mouse: keyboard,
      keyboard,
      touch: keyboard,
      ime: keyboard,
      // RustDesk requires both keyboard and clipboard permission for sending;
      // inbound application is gated only by the local view-only/disable flags.
      clipboardSend:
        localClipboard && this.permissionsValue.clipboard && keyboard,
      clipboardReceive: localClipboard,
    };
  }

  private report(error: RustDeskError): void {
    try {
      this.onError?.(error);
    } catch {
      // Host callbacks must not break permission handling.
    }
  }
}
