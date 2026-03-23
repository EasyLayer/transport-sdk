/**
 * rollup.config.mjs — place in the root of @easylayer/transport-sdk
 *
 * Build order:
 *   yarn build:cjs                  → dist/
 *   yarn build:esm                  → dist/esm/ (including dist/esm/browser/)
 *   yarn build:browser              → rollup reads dist/esm/browser/ → dist/browser/
 *
 * transport-sdk browser source has zero npm dependencies —
 * only relative imports from its own core/.
 * The result is a fully self-contained dist/browser/index.js.
 *
 * No fix-browser-imports.mjs needed — transport-sdk is a single package
 * with no cross-subpackage relative paths to patch.
 */

import { defineConfig } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rmSync, existsSync } from 'fs';

export default defineConfig({
  input: './dist/esm/browser/index.js',

  output: {
    file: './dist/browser/index.js',
    format: 'es',
    sourcemap: false,
    inlineDynamicImports: true,
  },

  onwarn(warning, warn) {
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    warn(warning);
  },

  plugins: [
    nodeResolve({
      browser: true,
      exportConditions: ['browser', 'module', 'default'],
      preferBuiltins: false,
    }),
  ],
});
