import { defineConfig } from 'tsdown';

// One ESM bundle and one .d.ts for browsers, Bun and Node. @impz/api and
// @impz/shared are private, so their code and their types go into the bundle;
// the dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outDir: 'dist',
  dts: { tsconfig: '../tsconfig.client-dts.json' },
  deps: { alwaysBundle: ['@impz/api', '@impz/shared'] },
});
