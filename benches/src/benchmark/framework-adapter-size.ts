import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import type { ProductionJavaScriptMeasurement } from './production-app-size.ts';
import { bundleJavaScriptVariants, externalizeGlyphWasmPlugin } from './vite-size-bundle.ts';

interface FrameworkAdapter {
  readonly entry: string;
  readonly id: string;
  readonly label: string;
  readonly packageEntry: string;
  readonly peers: readonly string[];
}

const reactAdapter = {
  id: 'react-runtime-js',
  label: 'React adapter JS',
  entry: 'react-runtime.ts',
  packageEntry: 'react',
  peers: ['react', '@react-three/fiber', 'three'],
} as const satisfies FrameworkAdapter;

const vueAdapter = {
  id: 'vue-runtime-js',
  label: 'Vue adapter JS',
  entry: 'vue-runtime.ts',
  packageEntry: 'vue',
  peers: ['vue', '@tresjs/core', 'three'],
} as const satisfies FrameworkAdapter;

export function measurePeerExternalizedReactAdapter(
  workspace = process.cwd(),
  entry = fileURLToPath(new URL('../../size-entries/react-runtime.ts', import.meta.url)),
): Promise<ProductionJavaScriptMeasurement> {
  return measurePeerExternalizedFrameworkAdapter(reactAdapter, workspace, entry);
}

export function measurePeerExternalizedVueAdapter(
  workspace = process.cwd(),
  entry = fileURLToPath(new URL('../../size-entries/vue-runtime.ts', import.meta.url)),
): Promise<ProductionJavaScriptMeasurement> {
  return measurePeerExternalizedFrameworkAdapter(vueAdapter, workspace, entry);
}

async function measurePeerExternalizedFrameworkAdapter(
  adapter: FrameworkAdapter,
  workspace: string,
  entry: string,
): Promise<ProductionJavaScriptMeasurement> {
  const isPeer = (id: string): boolean => adapter.peers.some((peer) => id === peer || id.startsWith(`${peer}/`));
  const { raw, minified } = await bundleJavaScriptVariants({
    aliases: [
      {
        find: `@pmndrs/glyph/${adapter.packageEntry}`,
        replacement: join(workspace, `packages/glyph/dist/${adapter.packageEntry}.js`),
      },
      { find: '@pmndrs/glyph', replacement: join(workspace, 'packages/glyph/dist/index.js') },
    ],
    entry,
    external: isPeer,
    includeDynamic: false,
    label: `${adapter.label} bundle`,
    plugins: [externalizeGlyphWasmPlugin()],
    workspace,
  });
  for (const peer of adapter.peers) {
    const bundled = [...minified.includedModules].find((id) => id.includes(`/node_modules/${peer}/`));
    if (bundled !== undefined) throw new Error(`${adapter.label} measurement bundled peer ${peer}: ${bundled}`);
  }
  if (![...minified.includedModules].some((id) => id.includes(`/packages/glyph/dist/${adapter.packageEntry}`))) {
    throw new Error(`${adapter.label} measurement did not include the built ${adapter.packageEntry} entry`);
  }

  return {
    id: adapter.id,
    label: adapter.label,
    status: 'measured',
    format: 'javascript',
    sha256: createHash('sha256').update(minified.bytes).digest('hex'),
    rawBytes: raw.bytes.byteLength,
    minifiedBytes: minified.bytes.byteLength,
    gzipBytes: gzipSync(minified.bytes, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(minified.bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}
