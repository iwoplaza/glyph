import * as t3 from '@typegpu/three';
import tgpu, { d } from 'typegpu';
import * as TSL from 'three/tsl';
import type { Node, Texture } from 'three/webgpu';

import {
  bitmapAtlasUv,
  bitmapPaintCoverageOpacity,
  bitmapPageTexelCoordinate,
  bitmapQuadPosition,
  snapClipAxis,
} from '../../../shaders/typegpu/bitmap-shader.js';

const modelViewProjection = TSL.modelViewProjection as Node<'vec4'>;

export interface TslBitmapInstanceNodes {
  readonly origin: Node<'vec2'>;
  readonly size: Node<'vec2'>;
  readonly uvOrigin: Node<'vec2'>;
  readonly uvSize: Node<'vec2'>;
  readonly color: Node<'vec4'>;
  readonly pageIndex: Node<'uint'>;
}

export interface TslBitmapShaderResources {
  readonly page: Texture;
}

export interface TslBitmapShaderOptions {
  readonly pixelSnapping?: boolean;
}

export interface TslBitmapShaderOutput {
  readonly position: Node<'vec3'>;
  readonly clipPosition: Node<'vec4'>;
  readonly atlasUv: Node<'vec2'>;
  readonly coverage: Node<'float'>;
  readonly color: Node<'vec3'>;
  readonly opacity: Node<'float'>;
}

const quadPosition = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec2f], d.vec3f)(bitmapQuadPosition),
);
const atlasCoordinate = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec2f], d.vec2f)(bitmapAtlasUv),
);
const pageTexelCoordinate = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f], d.vec2f)(bitmapPageTexelCoordinate),
);
const paintCoverageOpacity = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.f32, d.vec4f], d.vec2f)(bitmapPaintCoverageOpacity),
);
const snapClipPosition = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu
    .fn(
      [d.vec4f, d.vec2f],
      d.vec4f,
    )((clip, screenSize) => {
      'use gpu';
      return d.vec4f(
        snapClipAxis(clip.x, clip.w, screenSize.x),
        snapClipAxis(clip.y, clip.w, screenSize.y),
        clip.z,
        clip.w,
      );
    })
    .$name('bitmapSnapClipPosition'),
);

/** Resolve every Bitmap bridge function for one backend before its first material is built. */
export function prewarmBitmapShader(backend: 'webgpu' | 'webgl'): void {
  for (const fn of [quadPosition, atlasCoordinate, pageTexelCoordinate, paintCoverageOpacity, snapClipPosition]) {
    fn.prewarm(backend);
  }
}

/**
 * Adapt the canonical TypeGPU Bitmap functions to Three's node graph. Each function is resolved once per backend
 * and called with TSL arguments, so realizing another material costs only TSL node construction.
 */
export function bitmapShader(
  instance: TslBitmapInstanceNodes,
  resources: TslBitmapShaderResources,
  options: TslBitmapShaderOptions = {},
): TslBitmapShaderOutput {
  const position = quadPosition(instance.origin, instance.size, TSL.positionLocal.xy) as Node<'vec3'>;
  const atlasUv = atlasCoordinate(instance.uvOrigin, instance.uvSize, TSL.uv()) as Node<'vec2'>;
  // Three models textureSize as uvec2, while GLSL reports an array texture as ivec3. Converting the expression to
  // vec2 normalizes both backend shapes and discards GLSL's layer count before it crosses the TypeGPU bridge.
  const reportedDimensions = TSL.textureSize(TSL.textureLoad(resources.page), TSL.int(0)) as unknown as Node<'uvec2'>;
  const texelCoordinate = pageTexelCoordinate(TSL.vec2(reportedDimensions), atlasUv) as Node<'vec2'>;
  const texelIndex = TSL.ivec2(TSL.int(texelCoordinate.x), TSL.int(texelCoordinate.y));
  const coverage = TSL.textureLoad(resources.page, texelIndex, TSL.int(0)).depth(TSL.int(instance.pageIndex)).r;
  const coverageOpacity = paintCoverageOpacity(coverage, instance.color) as Node<'vec2'>;

  return {
    position,
    clipPosition:
      options.pixelSnapping === true
        ? (snapClipPosition(modelViewProjection, TSL.screenSize) as Node<'vec4'>)
        : modelViewProjection,
    atlasUv,
    coverage: coverageOpacity.x,
    color: instance.color.rgb,
    opacity: coverageOpacity.y,
  };
}
