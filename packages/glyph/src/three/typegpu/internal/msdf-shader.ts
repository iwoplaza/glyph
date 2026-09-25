import * as t3 from '@typegpu/three';
import tgpu, { d } from 'typegpu';
import * as TSL from 'three/tsl';
import type { Node, Texture } from 'three/webgpu';

import {
  MsdfCompositeInput,
  MsdfCoverageInput,
  msdfAtlasCoordinate,
  msdfClampedCoordinates,
  msdfComposite,
  msdfPosition,
} from '../../../shaders/typegpu/msdf-shader.js';
import { msdfCoverageFromDistances, msdfDistances } from '../../../shaders/typegpu/msdf/distance.js';
import type { TslMsdfShaderOutput } from '../../../shaders/tsl/msdf-shader.js';
import { packedPaint } from './decoration-shader.js';

export type { TslMsdfShaderOutput } from '../../../shaders/tsl/msdf-shader.js';

export interface TslMsdfInstanceNodes {
  readonly origin: Node<'vec2'>;
  readonly size: Node<'vec2'>;
  readonly uvOrigin: Node<'vec2'>;
  readonly uvSize: Node<'vec2'>;
  readonly uvBounds: Node<'vec4'>;
  readonly fillColor: Node<'vec4'>;
  /** Packed little-endian sRGB outline and shadow colors from the technique's `effectColor` buffer. */
  readonly effectColor: Node<'uvec2'>;
  readonly shadowOffset: Node<'vec2'>;
  readonly outlineWidth: Node<'float'>;
  readonly pageIndex: Node<'float'>;
}

export interface TslMsdfShaderResources {
  readonly atlas: Texture;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly pixelRange: number;
}

const quadPosition = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec3f], d.vec3f)(msdfPosition),
);
const atlasCoordinateOf = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec2f], d.vec2f)(msdfAtlasCoordinate),
);
const clampedCoordinates = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec4f, d.vec2f], d.vec4f)(msdfClampedCoordinates),
);
const distancesOf = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec4f, d.vec2f, d.vec2f, d.f32], d.vec3f)(msdfDistances),
);
const coverageOf = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu
    .fn(
      [d.vec2f, d.vec2f, d.vec4f, d.vec2f, d.f32, d.vec4f, d.vec4f, d.f32, d.vec3f],
      d.vec3f,
    )(
      (
        atlasCoordinate,
        shadowCoordinate,
        uvBounds,
        atlasSize,
        pixelRange,
        baseSample,
        shadowSample,
        outlineWidth,
        distances,
      ) => {
        'use gpu';
        return msdfCoverageFromDistances(
          MsdfCoverageInput({
            atlasCoordinate,
            shadowCoordinate,
            uvBounds,
            atlasSize,
            pixelRange,
            baseSample,
            shadowSample,
            outlineWidth,
          }),
          distances,
        );
      },
    )
    .$name('msdfBridgeCoverage'),
);
const composite = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu
    .fn(
      [d.vec3f, d.vec4f, d.vec4f, d.vec4f],
      d.vec4f,
    )((coverage, fillColor, outlineColor, shadowColor) => {
      'use gpu';
      return msdfComposite(MsdfCompositeInput({ coverage, fillColor, outlineColor, shadowColor }));
    })
    .$name('msdfBridgeComposite'),
);

/** Resolve every MTSDF bridge function for one backend before its first material is built. */
export function prewarmMsdfShader(backend: 'webgpu' | 'webgl'): void {
  for (const fn of [quadPosition, atlasCoordinateOf, clampedCoordinates, distancesOf, coverageOf, composite]) {
    fn.prewarm(backend);
  }
}

/**
 * Adapt Three texture sampling and nodes to the canonical TypeGPU MTSDF algorithm. Each function is resolved once
 * per backend and called with TSL arguments, so realizing another material costs only TSL node construction.
 */
export function msdfShader(instance: TslMsdfInstanceNodes, resources: TslMsdfShaderResources): TslMsdfShaderOutput {
  const outlineColor = packedPaint(TSL.uvec2(instance.effectColor.x, TSL.uint(0)));
  const shadowColor = packedPaint(TSL.uvec2(instance.effectColor.y, TSL.uint(0)));
  const position = quadPosition(instance.origin, instance.size, TSL.positionLocal) as Node<'vec3'>;
  const atlasUv = atlasCoordinateOf(instance.uvOrigin, instance.uvSize, TSL.uv()) as Node<'vec2'>;
  const shadowUv = TSL.sub(atlasUv, instance.shadowOffset);
  const atlasSize = TSL.vec2(resources.atlasWidth, resources.atlasHeight);
  const pixelRange = TSL.float(resources.pixelRange);
  const clamped = clampedCoordinates(atlasUv, shadowUv, instance.uvBounds, atlasSize) as Node<'vec4'>;
  const layer = TSL.int(instance.pageIndex);
  const baseSample = TSL.texture(resources.atlas, clamped.xy).depth(layer);
  const shadowSample = TSL.texture(resources.atlas, clamped.zw).depth(layer);
  const distances = distancesOf(baseSample, atlasUv, atlasSize, pixelRange) as Node<'vec3'>;
  const coverage = coverageOf(
    atlasUv,
    shadowUv,
    instance.uvBounds,
    atlasSize,
    pixelRange,
    baseSample,
    shadowSample,
    instance.outlineWidth,
    distances,
  ) as Node<'vec3'>;
  const color = composite(coverage, instance.fillColor, outlineColor, shadowColor) as Node<'vec4'>;
  return {
    position,
    atlasUv,
    fillDistance: distances.x,
    trueDistance: distances.y,
    pixelRange: distances.z,
    fillCoverage: coverage.x,
    outlineCoverage: coverage.y,
    shadowCoverage: coverage.z,
    color: color.rgb,
    opacity: color.a,
  };
}
