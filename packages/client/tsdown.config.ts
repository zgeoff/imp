import { defineConfig } from 'tsdown';

// One ESM bundle and one .d.ts for browsers, Bun and Node. @imp/api is
// private, so its code and its types go into the bundle; the dependencies stay
// external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outDir: 'dist',
  dts: { tsconfig: '../tsconfig.client-dts.json' },
  deps: { alwaysBundle: ['@imp/api'] },
});
