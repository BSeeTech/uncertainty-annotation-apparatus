/**
 * Ambient module declarations.
 *
 * Cornerstone3D and vtk.js are peer dependencies installed by the
 * host OHIF application.  In this thesis source tree they may not be
 * available with full types, especially when the package is being
 * type-checked in isolation (e.g. by CI before the host has been
 * built).  These shims keep `tsc --strict --noEmit` clean while
 * preserving real-runtime resolution.
 *
 * In the host app, the actual `@cornerstonejs/core` types take
 * precedence over these declarations because TypeScript prefers
 * non-ambient modules.
 */

declare module '@cornerstonejs/core' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const volumeLoader: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const cache: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Enums: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}

declare module '@cornerstonejs/tools' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;
}

declare module '@kitware/vtk.js/Rendering/Core/ColorTransferFunction' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctf: { newInstance(): any };
  export default ctf;
}

declare module '@kitware/vtk.js/Common/DataModel/PiecewiseFunction' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pw: { newInstance(): any };
  export default pw;
}

/**
 * `@ohif/core`'s own `types/index.ts` (its package.json "types" entry) does
 * not declare `hotkeys`, even though `src/index.ts` exports it at runtime
 * (Mousetrap spread with a `defaults` key added). Declared here rather than
 * edited into `platform/core` -- this thesis ships as a plug-in to an
 * unmodified host, and this file's whole purpose (see file header) is to
 * cover gaps like this without touching host packages. Mousetrap's own
 * surface is left as `unknown` rather than reproduced or widened to `any`.
 */
declare module '@ohif/core' {
  // Matches classes/Hotkey.ts, which platform/core already declares
  // correctly; repeated structurally here rather than imported to avoid a
  // self-referential import inside this module's own augmentation block.
  interface HotkeyBinding {
    commandName: string;
    commandOptions?: Record<string, unknown>;
    context?: string;
    keys: string[];
    label: string;
    isEditable?: boolean;
  }

  export const hotkeys: Record<string, unknown> & {
    defaults: { hotkeyBindings: HotkeyBinding[] };
  };
}
