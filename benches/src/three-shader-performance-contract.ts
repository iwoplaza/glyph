/** Result contract shared by the shader performance page and its Node runner, free of browser-only imports. */

/** One fixed-scene observation of the shader set this page was opened with (`?shaders=tsl|typegpu`). */
export interface ThreeShaderPerformanceResult {
  readonly backend: 'webgpu' | 'webgl2';
  readonly technique: ThreeShaderPerformanceTechnique;
  readonly glyphCount: number;
  readonly drawCount: number;
  readonly litPixels: number;
  /** Time spent inside Three's NodeBuilder turning every draw's node graph into shader source. */
  readonly nodeBuildMs: number;
  /** Node building for a second, fully replaced text generation once the page is warm. */
  readonly warmNodeBuildMs: number;
  readonly warmNodeBuilds: number;
  /** Complete first-frame wall time, including node building, pipeline creation, and uploads. */
  readonly firstFrameMs: number;
  /** Number of NodeBuilder builds (one per distinct render pipeline). */
  readonly nodeBuilds: number;
  /** Generated vertex plus fragment source length across every built draw. */
  readonly shaderBytes: number;
  /** Per-frame wall time from submit to completed readback of one pixel, in steady state. */
  readonly frameMs: readonly number[];
  /** Per-frame render-pass GPU time from timestamp queries, when the backend exposes them. */
  readonly gpuMs: readonly number[];
  readonly fragmentShader: string;
}

export type ThreeShaderPerformanceTechnique = 'bitmap' | 'mtsdf' | 'mtsdf-effects' | 'slug';
