const mock = { newInstance: () => ({
  addRGBPoint: () => {},
  addPoint: () => {},
}) };
export default mock;
export const newInstance = mock.newInstance;
