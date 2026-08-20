// Mock for any vtk.js submodule the renderer imports.  We don't
// instantiate real transfer functions in tests; the math is verified
// in transferFunctions.test.ts against the data structures.
const mock = { newInstance: () => ({}) };
export default mock;
export const newInstance = mock.newInstance;
