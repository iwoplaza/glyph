/* @workflow { "name": "benchmark:three-shader-performance", "summary": "Compare stable /three TSL shaders with experimental /three/typegpu on one fixed dense text scene.", "requirements": "Playwright Chromium with WebGPU and baked Inter fixtures. Pass --technique, --backend, --rounds, --frames, --dump-shaders <dir>, or --cpu-profile <dir>.", "writes": "Standard output, plus generated fragment shaders or Chrome CPU profiles when --dump-shaders or --cpu-profile names a directory." } */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

import type {
  ThreeShaderPerformanceResult,
  ThreeShaderPerformanceTechnique,
} from '../src/three-shader-performance-contract.ts';
import { launchProjectChromium } from './support/project-chromium.mts';

const shaderSets = ['tsl', 'typegpu'] as const;
type ShaderSet = (typeof shaderSets)[number];
const allTechniques = ['bitmap', 'mtsdf', 'mtsdf-effects', 'slug'] as const satisfies ThreeShaderPerformanceTechnique[];
const allBackends = ['webgpu', 'webgl2'] as const;

const techniques = selected('--technique', allTechniques) ?? allTechniques;
const backends = selected('--backend', allBackends) ?? allBackends;
const rounds = integerArgument('--rounds', 3);
const frames = integerArgument('--frames', 24);
const dumpShaders = stringArgument('--dump-shaders');
const cpuProfiles = stringArgument('--cpu-profile');

interface CellSummary {
  readonly nodeBuildMs: number;
  readonly warmNodeBuildMs: number;
  readonly firstFrameMs: number;
  readonly frameMs: number;
  readonly gpuMs: number | undefined;
  readonly shaderBytes: number;
  readonly nodeBuilds: number;
  readonly litPixels: number;
  readonly glyphCount: number;
}

const root = fileURLToPath(new URL('..', import.meta.url));
let server: ViteDevServer | undefined;
let browser: Awaited<ReturnType<typeof launchProjectChromium>> | undefined;
try {
  server = await createServer({
    root,
    logLevel: 'warn',
    optimizeDeps: { force: true },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('Vite did not publish its loopback TCP address');
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  browser = await launchProjectChromium({
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader'],
  });
  const openedBrowser = browser;

  async function run(shaders: ShaderSet, technique: string, backend: string): Promise<ThreeShaderPerformanceResult> {
    const page = await openedBrowser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    const pendingProfiles: Promise<void>[] = [];
    const profiler = cpuProfiles === undefined ? undefined : await page.context().newCDPSession(page);
    if (profiler !== undefined) {
      await profiler.send('Profiler.enable');
      await profiler.send('Profiler.setSamplingInterval', { interval: 100 });
      profiler.on('Profiler.consoleProfileFinished', ({ profile, title }) => {
        if (cpuProfiles === undefined) return;
        const name = `${technique}.${backend}.${shaders}.${title ?? 'console'}.cpuprofile`;
        pendingProfiles.push(
          mkdir(cpuProfiles, { recursive: true }).then(() =>
            writeFile(join(cpuProfiles, name), JSON.stringify(profile)),
          ),
        );
      });
      await profiler.send('Profiler.start');
    }
    try {
      await page.goto(
        `${origin}/three-shader-performance.html?shaders=${shaders}&technique=${technique}&backend=${backend}&frames=${String(frames)}`,
        { waitUntil: 'domcontentloaded' },
      );
      await page.waitForFunction(() => 'threeShaderPerformance' in window, undefined, { timeout: 120_000 });
      const result = await page.evaluate(
        () =>
          (window as unknown as { threeShaderPerformance: Promise<ThreeShaderPerformanceResult> })
            .threeShaderPerformance,
      );
      if (profiler !== undefined && cpuProfiles !== undefined) {
        const { profile } = await profiler.send('Profiler.stop');
        await mkdir(cpuProfiles, { recursive: true });
        await writeFile(join(cpuProfiles, `${technique}.${backend}.${shaders}.cpuprofile`), JSON.stringify(profile));
        await Promise.all(pendingProfiles);
      }
      if (errors.length > 0) {
        if (dumpShaders !== undefined) {
          await mkdir(dumpShaders, { recursive: true });
          await writeFile(
            join(dumpShaders, `${technique}.${backend}.${shaders}.failed.fragment`),
            result.fragmentShader,
          );
        }
        throw new Error(`${shaders} ${technique} ${backend}: ${errors.join(' | ')}`);
      }
      if (result.backend !== backend) throw new Error(`expected ${backend}, received ${result.backend}`);
      return result;
    } finally {
      await page.close();
    }
  }

  // Warm Vite's dependency optimizer and module graph once so the first measured page is not a cold transform.
  await run('tsl', techniques[0]!, backends[0]!);
  await run('typegpu', techniques[0]!, backends[0]!);

  const rows: string[][] = [];
  for (const backend of backends) {
    for (const technique of techniques) {
      const samples: Record<ShaderSet, ThreeShaderPerformanceResult[]> = { tsl: [], typegpu: [] };
      for (let round = 0; round < rounds; round += 1) {
        const order = round % 2 === 0 ? shaderSets : ([...shaderSets].reverse() as ShaderSet[]);
        for (const shaders of order) samples[shaders].push(await run(shaders, technique, backend));
      }
      const tsl = summarize(samples.tsl);
      const typegpu = summarize(samples.typegpu);
      process.stdout.write(`three-shader-cell ${JSON.stringify({ backend, technique, tsl, typegpu })}\n`);
      if (dumpShaders !== undefined) {
        await mkdir(dumpShaders, { recursive: true });
        for (const shaders of shaderSets) {
          const extension = backend === 'webgpu' ? 'wgsl' : 'glsl';
          await writeFile(
            join(dumpShaders, `${technique}.${backend}.${shaders}.fragment.${extension}`),
            samples[shaders][0]!.fragmentShader,
          );
        }
      }
      rows.push([
        `${backend}/${technique}`,
        ...metric(tsl.frameMs, typegpu.frameMs),
        ...metric(tsl.gpuMs, typegpu.gpuMs),
        ...metric(tsl.nodeBuildMs, typegpu.nodeBuildMs),
        ...metric(tsl.warmNodeBuildMs, typegpu.warmNodeBuildMs),
        ...metric(tsl.firstFrameMs, typegpu.firstFrameMs),
        `${String(tsl.shaderBytes)} / ${String(typegpu.shaderBytes)}`,
        `${String(tsl.litPixels)} / ${String(typegpu.litPixels)}`,
      ]);
    }
  }
  const header = [
    'cell',
    'frame tsl',
    'frame tgpu',
    'ratio',
    'gpu tsl',
    'gpu tgpu',
    'ratio',
    'build tsl',
    'build tgpu',
    'ratio',
    'warm build tsl',
    'warm build tgpu',
    'ratio',
    'first tsl',
    'first tgpu',
    'ratio',
    'shader bytes',
    'lit pixels',
  ];
  process.stdout.write(
    `\nmedian ms over ${String(rounds)} fresh pages x ${String(frames)} frames; ratio = typegpu / tsl\n`,
  );
  for (const row of [header, ...rows]) process.stdout.write(`${row.join(' | ')}\n`);
} finally {
  await browser?.close();
  await server?.close();
}

function summarize(results: readonly ThreeShaderPerformanceResult[]): CellSummary {
  const gpu = results.flatMap((result) => result.gpuMs);
  return {
    nodeBuildMs: median(results.map((result) => result.nodeBuildMs)),
    warmNodeBuildMs: median(results.map((result) => result.warmNodeBuildMs)),
    firstFrameMs: median(results.map((result) => result.firstFrameMs)),
    frameMs: median(results.flatMap((result) => result.frameMs)),
    gpuMs: gpu.length === 0 ? undefined : median(gpu),
    shaderBytes: results[0]!.shaderBytes,
    nodeBuilds: results[0]!.nodeBuilds,
    litPixels: results[0]!.litPixels,
    glyphCount: results[0]!.glyphCount,
  };
}

function metric(tsl: number | undefined, typegpu: number | undefined): string[] {
  if (tsl === undefined || typegpu === undefined) return ['-', '-', '-'];
  return [tsl.toFixed(2), typegpu.toFixed(2), (typegpu / tsl).toFixed(2)];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function selected<const Values extends readonly string[]>(name: string, values: Values): Values[number][] | undefined {
  const value = stringArgument(name);
  if (value === undefined) return undefined;
  const choice = values.find((candidate) => candidate === value);
  if (choice === undefined) throw new RangeError(`${name} must be one of ${values.join(', ')}`);
  return [choice];
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`${name} must be a positive integer`);
  return parsed;
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
