// Minimal mock for @cornerstonejs/core — present so any accidental
// import in tests doesn't blow up.  Real Cornerstone interaction goes
// through the `CornerstoneAdapter` interface in HeatmapRenderer, so
// tests provide a stub adapter and never touch this module directly.
export const volumeLoader = {};
export const cache = { getVolume: () => null };
export const Enums = {};
export default {};
