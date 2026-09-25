import * as t3 from '@typegpu/three';
import tgpu, { d } from 'typegpu';
import * as TSL from 'three/tsl';
import type { Node } from 'three/webgpu';

import { decorationPaint, decorationPosition } from '../../../shaders/typegpu/decoration-shader.js';

export interface TslDecorationInstanceNodes {
  readonly rect: Node<'vec4'>;
  readonly packed: Node<'uvec2'>;
}

export interface TslDecorationShaderOutput {
  readonly position: Node<'vec3'>;
  readonly color: Node<'vec3'>;
  readonly opacity: Node<'float'>;
}

const position = /* @__PURE__ */ t3.toTSLFn(/* @__PURE__ */ tgpu.fn([d.vec4f, d.vec3f], d.vec3f)(decorationPosition));
const paint = /* @__PURE__ */ t3.toTSLFn(/* @__PURE__ */ tgpu.fn([d.vec2u], d.vec4f)(decorationPaint));

/** Linear RGB and alpha from one packed sRGB color record; shared with the MTSDF effect colors. */
export function packedPaint(packed: Node<'uvec2'>): Node<'vec4'> {
  return paint(packed) as Node<'vec4'>;
}

/** Resolve both decoration bridge functions for one backend before its first material is built. */
export function prewarmDecorationShader(backend: 'webgpu' | 'webgl'): void {
  position.prewarm(backend);
  paint.prewarm(backend);
}

/** Adapt Three nodes to the canonical TypeGPU decoration functions, resolved once per backend. */
export function decorationShader(instance: TslDecorationInstanceNodes): TslDecorationShaderOutput {
  const color = packedPaint(instance.packed);
  return {
    position: position(instance.rect, TSL.positionLocal) as Node<'vec3'>,
    color: color.rgb,
    opacity: color.a,
  };
}
