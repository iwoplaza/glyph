import { bitmap, glyph, msdf as mtsdf, slug, type FontFace } from '@pmndrs/glyph';
import * as THREE from 'three/webgpu';
import interMtsdfUrl from '../fixtures/rendering/inter-mtsdf.font.glb.gz?url';
import interSlugUrl from '../fixtures/rendering/inter-slug.font.glb.gz?url';
import mtsdfManifest from '../fixtures/rendering/showcase-mtsdf-fixtures-v0.json' with { type: 'json' };
import slugManifest from '../fixtures/rendering/showcase-slug-fixtures-v0.json' with { type: 'json' };
import { BENCHMARK_IPSUM_TEXT } from './workloads/benchmark-ipsum/scene';
import { fetchAuthenticatedGzipAsset } from './workloads/font-assets/authenticated-gzip';
import { createBenchmarkThreeRoot, disposeBenchmarkThreeRoot } from './three-root';
import type {
  ThreeShaderPerformanceResult,
  ThreeShaderPerformanceTechnique,
} from './three-shader-performance-contract';

declare global {
  interface Window {
    threeShaderPerformance: Promise<ThreeShaderPerformanceResult>;
  }
}

const SIZE = 1024;
const LAYERS = 3;
const parameters = new URLSearchParams(location.search);
const technique = readTechnique(parameters.get('technique'));
const frames = Number(parameters.get('frames') ?? '24');
const warmup = Number(parameters.get('warmup') ?? '4');

window.threeShaderPerformance = measure();

function readTechnique(value: string | null): ThreeShaderPerformanceTechnique {
  if (value === 'bitmap' || value === 'mtsdf' || value === 'mtsdf-effects' || value === 'slug') return value;
  throw new RangeError('technique must be bitmap, mtsdf, mtsdf-effects, or slug');
}

async function loadFont(): Promise<FontFace<typeof bitmap> | FontFace<typeof mtsdf> | FontFace<typeof slug>> {
  if (technique === 'bitmap') {
    const face = glyph.fontFace('/fixtures/rendering/inter-bitmap-16.font.glb', { format: bitmap({ strikes: [16] }) });
    await face.load();
    return face as unknown as FontFace<typeof bitmap>;
  }
  const isSlug = technique === 'slug';
  const manifest = (isSlug ? slugManifest : mtsdfManifest).artifacts.find((entry) => entry.fontFixture === 'inter');
  if (manifest === undefined) throw new Error('Inter fixture manifest is missing');
  const artifact = await fetchAuthenticatedGzipAsset(isSlug ? interSlugUrl : interMtsdfUrl, manifest, 'font fixture');
  const blob = new Blob([artifact], { type: 'model/gltf-binary' });
  const face = isSlug ? glyph.fontFace(blob, { format: slug }) : glyph.fontFace(blob, { format: mtsdf });
  await face.load();
  return face;
}

async function measure(): Promise<ThreeShaderPerformanceResult> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  if (canvas === null) throw new Error('shader performance canvas is missing');
  const forceWebGL = parameters.get('backend') === 'webgl2';
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL, trackTimestamp: true });
  const target = new THREE.RenderTarget(SIZE, SIZE, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
  target.texture.colorSpace = THREE.NoColorSpace;
  const root = createBenchmarkThreeRoot(`shader-performance-${technique}`);
  const texts: ReturnType<typeof root.createText>[] = [];
  let font: Awaited<ReturnType<typeof loadFont>> | undefined;
  try {
    renderer.setSize(SIZE, SIZE, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    await renderer.init();
    const builds = instrumentNodeBuilds(renderer);
    font = await loadFont();
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, SIZE, 0, -SIZE, 0.1, 10);
    camera.position.z = 1;
    const effects = technique === 'mtsdf-effects';
    const addTexts = (generation: number): void => {
      for (let layer = 0; layer < LAYERS; layer += 1) {
        const text = root.createText({
          font: font as FontFace<typeof slug>,
          text: `${BENCHMARK_IPSUM_TEXT}\n\n${BENCHMARK_IPSUM_TEXT}`,
          style: {
            fontSize: (technique === 'bitmap' ? 16 : 20) + generation,
            color: '#ffffff',
            ...(effects
              ? {
                  outline: { color: '#ff3366', width: 1.5 },
                  shadow: { color: '#2255ff', offset: [1.5, 1.5] as const },
                }
              : {}),
          },
          constraints: { width: { mode: 'exact', size: SIZE - 16 } },
          layout: { wrap: 'word' },
        } as Parameters<typeof root.createText>[0]);
        text.position.set(8 + layer * 3, -8 - layer * 5, 0);
        scene.add(text);
        texts.push(text);
      }
    };
    addTexts(0);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 1);

    const firstStart = performance.now();
    renderer.render(scene, camera);
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    const firstFrameMs = performance.now() - firstStart;

    const frameMs: number[] = [];
    const gpuMs: number[] = [];
    for (let frame = 0; frame < warmup + frames; frame += 1) {
      const start = performance.now();
      renderer.render(scene, camera);
      await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
      const elapsed = performance.now() - start;
      await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      if (frame < warmup) continue;
      frameMs.push(elapsed);
      if (renderer.info.render.timestamp > 0) gpuMs.push(renderer.info.render.timestamp);
    }

    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE);
    let litPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 0) litPixels += 1;
    }
    const glyphCount = texts.reduce((total, text) => total + text.measure().glyphCount, 0);
    const drawCount = countDraws(scene);
    const coldBuild = { ms: builds.ms, count: builds.count, bytes: builds.bytes, fragment: builds.fragment };

    // Replace every text so each draw realizes new materials while the page's JIT and module state are already warm.
    for (const text of texts.splice(0)) {
      text.removeFromParent();
      text.dispose();
    }
    builds.ms = 0;
    builds.count = 0;
    console.profile('warm-rebuild');
    addTexts(1);
    renderer.render(scene, camera);
    console.profileEnd('warm-rebuild');
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);

    return {
      backend: renderer.backend instanceof THREE.WebGLBackend ? 'webgl2' : 'webgpu',
      technique,
      glyphCount,
      drawCount,
      litPixels,
      nodeBuildMs: coldBuild.ms,
      nodeBuilds: coldBuild.count,
      warmNodeBuildMs: builds.ms,
      warmNodeBuilds: builds.count,
      firstFrameMs,
      shaderBytes: coldBuild.bytes,
      frameMs,
      gpuMs,
      fragmentShader: coldBuild.fragment,
    };
  } finally {
    for (const text of texts) {
      text.removeFromParent();
      text.dispose();
    }
    font?.dispose();
    disposeBenchmarkThreeRoot(root);
    target.dispose();
    renderer.dispose();
  }
}

interface NodeBuildTally {
  ms: number;
  count: number;
  bytes: number;
  fragment: string;
}

/** Time every NodeBuilder the renderer creates, so shader authoring cost is separated from pipeline creation. */
function instrumentNodeBuilds(renderer: THREE.WebGPURenderer): NodeBuildTally {
  const tally: NodeBuildTally = { ms: 0, count: 0, bytes: 0, fragment: '' };
  const backend = renderer.backend as unknown as {
    createNodeBuilder(object: THREE.Object3D, renderer: THREE.Renderer): THREE.NodeBuilder;
  };
  const create = backend.createNodeBuilder.bind(backend);
  backend.createNodeBuilder = (object, owner) => {
    const builder = create(object, owner) as THREE.NodeBuilder & {
      build(): unknown;
      vertexShader?: string;
      fragmentShader?: string;
    };
    const build = builder.build.bind(builder);
    builder.build = () => {
      const start = performance.now();
      const result = build();
      tally.ms += performance.now() - start;
      tally.count += 1;
      tally.bytes += (builder.vertexShader?.length ?? 0) + (builder.fragmentShader?.length ?? 0);
      if ((builder.fragmentShader?.length ?? 0) > tally.fragment.length) tally.fragment = builder.fragmentShader ?? '';
      return result;
    };
    return builder;
  };
  return tally;
}

function countDraws(scene: THREE.Scene): number {
  let draws = 0;
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) draws += 1;
  });
  return draws;
}
