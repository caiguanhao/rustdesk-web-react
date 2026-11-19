import { describe, expect, it, vi } from 'vitest';
import {
  Message,
  PermissionInfo_Permission,
} from '../src/protocol/message';
import { RustDeskError } from '../src/session/errors';
import {
  SessionPermissions,
  applyInputPolicy,
  type InputPolicy,
  type PermissionEvent,
  type SessionPermissionsOptions,
} from '../src/session/permissions';

// P3-6 unit coverage: view-only/disable-clipboard gates, login vs post-login
// permission handling, revocation notices, binding input controllers, and
// swallowed host callbacks.

function permissionMessage(
  permission: PermissionInfo_Permission,
  enabled: boolean,
): Message {
  return Message.fromPartial({
    misc: { permission_info: { permission, enabled } },
  });
}

function setup(options: SessionPermissionsOptions = {}) {
  const events: PermissionEvent[] = [];
  const errors: RustDeskError[] = [];
  const permissions = new SessionPermissions({
    ...options,
    onChange: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });
  return { permissions, events, errors };
}

const ALL_ENABLED: InputPolicy = {
  mouse: true,
  keyboard: true,
  touch: true,
  ime: true,
  clipboardSend: true,
  clipboardReceive: true,
};

function fakeTargets() {
  return {
    mouse: { setEnabled: vi.fn() },
    keyboard: { setEnabled: vi.fn() },
    touch: { setEnabled: vi.fn() },
    ime: { setEnabled: vi.fn() },
    clipboard: {
      setEnabled: vi.fn(),
      setReceiveEnabled: vi.fn(),
    },
  };
}

describe('SessionPermissions', () => {
  it('starts with every input enabled', () => {
    const { permissions } = setup();

    expect(permissions.policy).toEqual(ALL_ENABLED);
    expect(permissions.permissions).toEqual({
      keyboard: true,
      clipboard: true,
      audio: true,
      file: true,
    });
    expect(permissions.readOnly).toBe(false);
    expect(permissions.disableClipboard).toBe(false);
  });

  it('treats a login-time keyboard snapshot as state, not an error', () => {
    const { permissions, events, errors } = setup();

    permissions.apply({ permission: 'keyboard', enabled: false });

    // The host gates mouse/touch/keys/IME on the keyboard permission.
    expect(permissions.policy).toEqual({
      mouse: false,
      keyboard: false,
      touch: false,
      ime: false,
      clipboardSend: false,
      clipboardReceive: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.change).toEqual({
      permission: 'keyboard',
      enabled: false,
    });
    expect(errors).toEqual([]);
  });

  it('treats a login-time clipboard snapshot as state, not an error', () => {
    const { permissions, errors } = setup();

    permissions.apply({ permission: 'clipboard', enabled: false });

    expect(permissions.policy).toEqual({
      ...ALL_ENABLED,
      clipboardSend: false,
    });
    expect(errors).toEqual([]);
  });

  it('tracks audio/file without changing input gates or reporting', () => {
    const { permissions, events, errors } = setup();

    permissions.apply({ permission: 'audio', enabled: false });
    permissions.apply({ permission: 'file', enabled: false });

    expect(permissions.policy).toEqual(ALL_ENABLED);
    expect(permissions.permissions.audio).toBe(false);
    expect(permissions.permissions.file).toBe(false);
    expect(events).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('deduplicates changes and re-enables on grant', () => {
    const { permissions, events } = setup();

    permissions.apply({ permission: 'keyboard', enabled: false });
    permissions.apply({ permission: 'keyboard', enabled: false });
    expect(events).toHaveLength(1);

    permissions.apply({ permission: 'keyboard', enabled: true });
    expect(events).toHaveLength(2);
    expect(permissions.policy).toEqual(ALL_ENABLED);
  });

  it('read-only blocks all input and inbound clipboard', () => {
    const { permissions, events, errors } = setup();

    permissions.setReadOnly(true);
    expect(permissions.policy).toEqual({
      mouse: false,
      keyboard: false,
      touch: false,
      ime: false,
      clipboardSend: false,
      clipboardReceive: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.change).toBeUndefined();
    expect(errors).toEqual([]);

    permissions.setReadOnly(false);
    expect(permissions.policy).toEqual(ALL_ENABLED);
  });

  it('keeps peer permission state when toggling read-only', () => {
    const { permissions } = setup();
    permissions.apply({ permission: 'keyboard', enabled: false });

    permissions.setReadOnly(true);
    permissions.setReadOnly(false);

    expect(permissions.policy.keyboard).toBe(false);
    expect(permissions.policy.mouse).toBe(false);
    expect(permissions.policy.clipboardReceive).toBe(true);
    expect(permissions.policy.clipboardSend).toBe(false);
  });

  it('disable-clipboard blocks both clipboard directions only', () => {
    const { permissions, errors } = setup();

    permissions.setDisableClipboard(true);
    expect(permissions.policy).toEqual({
      ...ALL_ENABLED,
      clipboardSend: false,
      clipboardReceive: false,
    });
    expect(errors).toEqual([]);

    permissions.setDisableClipboard(false);
    expect(permissions.policy).toEqual(ALL_ENABLED);
  });

  it('reports post-login keyboard/clipboard revocations once', () => {
    const { permissions, errors } = setup();

    permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Keyboard, false),
    );
    expect(permissions.policy.mouse).toBe(false);
    expect(errors.map((error) => error.code)).toEqual(['no-permission']);
    expect(errors[0]?.message).toContain('keyboard');

    permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Keyboard, false),
    );
    expect(errors).toHaveLength(1);

    permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Keyboard, true),
    );
    expect(permissions.policy).toEqual(ALL_ENABLED);
    expect(errors).toHaveLength(1);

    permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Clipboard, false),
    );
    expect(errors.map((error) => error.code)).toEqual([
      'no-permission',
      'no-permission',
    ]);
    expect(errors[1]?.message).toContain('clipboard');
  });

  it('suppresses revocation notices for locally disabled input', () => {
    const readOnly = setup();
    readOnly.permissions.setReadOnly(true);
    readOnly.permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Keyboard, false),
    );
    expect(readOnly.errors).toEqual([]);
    expect(readOnly.permissions.policy.keyboard).toBe(false);

    readOnly.permissions.setReadOnly(false);
    expect(readOnly.permissions.policy.mouse).toBe(false);

    const disabled = setup();
    disabled.permissions.setDisableClipboard(true);
    disabled.permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Clipboard, false),
    );
    expect(disabled.errors).toEqual([]);
  });

  it('ignores other messages and unknown permission values', () => {
    const { permissions, errors } = setup();

    permissions.handleMessage(Message.fromPartial({}));
    permissions.handleMessage(
      Message.fromPartial({ test_delay: { time: 1, from_client: false } }),
    );
    permissions.handleMessage(
      permissionMessage(99 as PermissionInfo_Permission, false),
    );

    expect(permissions.policy).toEqual(ALL_ENABLED);
    expect(errors).toEqual([]);
  });

  it('applies initial permissions and local flags', () => {
    const { permissions } = setup({
      readOnly: true,
      disableClipboard: true,
      permissions: { keyboard: false, audio: false },
    });

    expect(permissions.permissions).toEqual({
      keyboard: false,
      clipboard: true,
      audio: false,
      file: true,
    });
    expect(permissions.policy).toEqual({
      mouse: false,
      keyboard: false,
      touch: false,
      ime: false,
      clipboardSend: false,
      clipboardReceive: false,
    });
  });

  it('resets peer permissions without touching local flags', () => {
    const { permissions } = setup({
      readOnly: true,
      permissions: { keyboard: false, clipboard: false },
    });

    permissions.resetPeerPermissions();

    expect(permissions.permissions.keyboard).toBe(true);
    expect(permissions.permissions.clipboard).toBe(true);
    expect(permissions.readOnly).toBe(true);
    expect(permissions.policy.mouse).toBe(false);
    expect(permissions.policy.clipboardReceive).toBe(false);
  });

  it('binds controllers immediately and on every change', () => {
    const { permissions } = setup();
    const targets = fakeTargets();

    permissions.bind(targets);
    expect(targets.mouse.setEnabled).toHaveBeenLastCalledWith(true);
    expect(targets.clipboard.setReceiveEnabled).toHaveBeenLastCalledWith(true);

    permissions.apply({ permission: 'keyboard', enabled: false });
    expect(targets.mouse.setEnabled).toHaveBeenLastCalledWith(false);
    expect(targets.keyboard.setEnabled).toHaveBeenLastCalledWith(false);
    expect(targets.clipboard.setEnabled).toHaveBeenLastCalledWith(false);
    expect(targets.clipboard.setReceiveEnabled).toHaveBeenLastCalledWith(true);
  });

  it('ignores changes after dispose', () => {
    const { permissions, events } = setup();
    const targets = fakeTargets();
    permissions.bind(targets);
    targets.mouse.setEnabled.mockClear();
    permissions.dispose();

    permissions.handleMessage(
      permissionMessage(PermissionInfo_Permission.Clipboard, false),
    );
    permissions.apply({ permission: 'keyboard', enabled: false });
    permissions.setReadOnly(true);

    expect(events).toEqual([]);
    expect(permissions.policy).toEqual(ALL_ENABLED);
    expect(targets.mouse.setEnabled).not.toHaveBeenCalled();
  });

  it('swallows host callback errors', () => {
    const permissions = new SessionPermissions({
      onChange() {
        throw new Error('host onChange');
      },
      onError() {
        throw new Error('host onError');
      },
    });

    expect(() =>
      permissions.handleMessage(
        permissionMessage(PermissionInfo_Permission.Keyboard, false),
      ),
    ).not.toThrow();
    expect(permissions.policy.keyboard).toBe(false);
  });
});

describe('applyInputPolicy', () => {
  it('drives every controller and both clipboard gates', () => {
    const targets = fakeTargets();

    applyInputPolicy(
      {
        mouse: true,
        keyboard: false,
        touch: true,
        ime: false,
        clipboardSend: false,
        clipboardReceive: true,
      },
      targets,
    );

    expect(targets.mouse.setEnabled).toHaveBeenCalledWith(true);
    expect(targets.keyboard.setEnabled).toHaveBeenCalledWith(false);
    expect(targets.touch.setEnabled).toHaveBeenCalledWith(true);
    expect(targets.ime.setEnabled).toHaveBeenCalledWith(false);
    expect(targets.clipboard.setEnabled).toHaveBeenCalledWith(false);
    expect(targets.clipboard.setReceiveEnabled).toHaveBeenCalledWith(true);
  });
});
