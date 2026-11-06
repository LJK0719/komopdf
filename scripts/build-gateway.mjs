import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['apps/gateway/src/cli.ts'],
  outfile: 'apps/gateway/dist/cli.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);" },
  external: ['fastify', '@clerk/backend', 'stripe'],
  logLevel: 'info',
});
