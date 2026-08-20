import { EXTENSION_ID } from './types';

/**
 * Re-export of the canonical extension ID so the OHIF host can import
 * it as `import { id } from '@thesis/extension-uncertainty'`, which
 * matches the convention used by the `@ohif/extension-*` packages.
 */
export const id = EXTENSION_ID;
