import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import { VERSION } from '../src/core';
import { VERSION as REACT_VERSION } from '../src/index';

// P0-2 acceptance: both public entry points are importable and report the
// package version. Comparing against package.json catches a version bump that
// forgets src/version.ts.
describe('package scaffold', () => {
  it('keeps the library version in sync with package.json', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(REACT_VERSION).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });
});
