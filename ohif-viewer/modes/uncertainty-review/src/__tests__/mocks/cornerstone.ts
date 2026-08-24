// Lightweight mock of @cornerstonejs/core. Individual adapter tests mutate
// these jest fakes to model the Cornerstone cache/volume loader surface.
export const volumeLoader = {
  createAndCacheVolume: jest.fn(),
  createAndCacheDerivedLabelmapVolume: jest.fn(),
  createAndCacheDerivedVolume: jest.fn(),
};
export const cache = {
  getVolume: jest.fn(() => null),
  removeVolumeLoadObject: jest.fn(),
  removeVolume: jest.fn(),
};
export const eventTarget = new EventTarget();
export const Enums = {
  Events: {
    STACK_NEW_IMAGE: 'STACK_NEW_IMAGE',
    VOLUME_NEW_IMAGE: 'VOLUME_NEW_IMAGE',
    CAMERA_MODIFIED: 'CAMERA_MODIFIED',
  },
};
export default {};
