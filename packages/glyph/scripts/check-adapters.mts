/* @workflow {
  "name": "glyph:adapters-check",
  "summary": "Check matching React and Vue component behavior and lifecycle tests.",
  "requirements": "Workspace dependencies and built Glyph distribution; rebuild after source changes.",
  "writes": "TypeScript build metadata; --format writes adapter source and test formatting."
} */
import { runNode, runNodeTests, runPnpm } from './support/command.mts';

const files = [
  'src/react.ts',
  'src/vue.ts',
  'src/internal/desired-text.ts',
  'src/three/text.ts',
  'tests/integration/react-*.test.mjs',
  'tests/integration/vue-*.test.mjs',
  'tests/support/adapter-behavior.mjs',
  'tests/types/r3f-v1-api.test.ts',
  'scripts/check-adapters.mts',
];
if (process.argv.includes('--format')) {
  await runPnpm(['exec', 'oxfmt', '--write', ...files]);
} else {
  await runPnpm(['exec', 'oxfmt', '--check', ...files]);
  await runPnpm(['exec', 'oxlint', '--deny-warnings', ...files]);
  await runNode('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.types.json']);
  await runNodeTests([
    'tests/integration/react-*.test.mjs',
    'tests/integration/vue-*.test.mjs',
    'tests/package/desired-text.test.mjs',
    'tests/package/vue-flatten-slots.test.mjs',
  ]);
}
