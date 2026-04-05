/** Shared mutable intent so _layout can signal upload screen before/during navigation. */
let _pendingLibrary = false;

export function setLibraryIntent() {
  _pendingLibrary = true;
}

export function consumeLibraryIntent(): boolean {
  const v = _pendingLibrary;
  _pendingLibrary = false;
  return v;
}
