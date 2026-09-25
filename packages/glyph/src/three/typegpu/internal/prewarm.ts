import { prewarmBitmapShader } from './bitmap-shader.js';
import { prewarmDecorationShader } from './decoration-shader.js';
import { prewarmMsdfShader } from './msdf-shader.js';
import { prewarmSlugShader } from './slug-shader.js';

let scheduled = false;

/**
 * TypeGPU compiles each bridge program once per backend on first use. Doing that during idle time — typically while
 * fonts load — keeps the one-time compilation off the first frame. The renderer backend is not known yet, and a
 * WebGPU-capable browser can still fall back to WebGL2, so the likely backend is compiled first and the other after it.
 */
export function scheduleShaderPrewarm(): void {
  if (scheduled || typeof window === 'undefined') return;
  scheduled = true;
  const backends: readonly ('webgpu' | 'webgl')[] =
    typeof navigator !== 'undefined' && 'gpu' in navigator ? ['webgpu', 'webgl'] : ['webgl'];
  const shaders = [prewarmDecorationShader, prewarmBitmapShader, prewarmMsdfShader, prewarmSlugShader];
  const steps = backends.flatMap((backend) => shaders.map((prewarm) => () => prewarm(backend)));
  const run = (): void => {
    const step = steps.shift();
    if (step === undefined) return;
    step();
    schedule(run);
  };
  schedule(run);
}

function schedule(task: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(task);
  else setTimeout(task, 0);
}
