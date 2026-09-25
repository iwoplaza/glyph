import * as t3 from '@typegpu/three';
import tgpu, { d } from 'typegpu';
import type { Node } from 'three/webgpu';

import {
  slugDilate as dilate,
  slugDilateMatrix as dilateMatrix,
} from '../../../../shaders/typegpu/slug/core/dilate.js';

export interface SlugDilationNodes {
  readonly position: Node<'vec2'>;
  readonly textureCoordinate: Node<'vec2'>;
}

const dilateRows = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec2f, d.f32, d.vec4f, d.vec4f, d.vec4f, d.vec2f], d.vec4f)(dilate),
);
const dilateWithMatrix = /* @__PURE__ */ t3.toTSLFn(
  /* @__PURE__ */ tgpu.fn([d.vec2f, d.vec2f, d.vec2f, d.f32, d.mat4x4f, d.vec2f], d.vec4f)(dilateMatrix),
);

/** Resolve both dilation bridge functions for one backend before its first material is built. */
export function prewarmSlugDilation(backend: 'webgpu' | 'webgl'): void {
  dilateRows.prewarm(backend);
  dilateWithMatrix.prewarm(backend);
}

export function slugDilate(
  position: Node<'vec2'>,
  outwardNormal: Node<'vec2'>,
  textureCoordinate: Node<'vec2'>,
  inverseScale: Node<'float'>,
  mvpRow0: Node<'vec4'>,
  mvpRow1: Node<'vec4'>,
  mvpRow3: Node<'vec4'>,
  viewport: Node<'vec2'>,
): SlugDilationNodes {
  return splitDilation(
    dilateRows(
      position,
      outwardNormal,
      textureCoordinate,
      inverseScale,
      mvpRow0,
      mvpRow1,
      mvpRow3,
      viewport,
    ) as Node<'vec4'>,
  );
}

export function slugDilateMatrix(
  position: Node<'vec2'>,
  outwardNormal: Node<'vec2'>,
  textureCoordinate: Node<'vec2'>,
  inverseScale: Node<'float'>,
  modelViewProjection: Node<'mat4'>,
  viewport: Node<'vec2'>,
): SlugDilationNodes {
  return splitDilation(
    dilateWithMatrix(
      position,
      outwardNormal,
      textureCoordinate,
      inverseScale,
      modelViewProjection,
      viewport,
    ) as Node<'vec4'>,
  );
}

function splitDilation(dilated: Node<'vec4'>): SlugDilationNodes {
  return { position: dilated.xy, textureCoordinate: dilated.zw };
}
