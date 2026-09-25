import * as TSL from 'three/tsl';
import type { DataTexture, Node } from 'three/webgpu';
import * as t3 from '@typegpu/three';
import tgpu, { d, std } from 'typegpu';

import { SlugShaderGlyph, slugRenderWithOptions } from '../../../shaders/typegpu/slug/slug-render.js';
import {
  slugCurveTexelSlot,
  slugCurveWidthAccessor,
  slugHeaderTexelSlot,
  slugHeaderWidthAccessor,
  slugReferenceTexelSlot,
  slugReferenceWidthAccessor,
} from '../../../shaders/typegpu/slug/slug-texture.js';
import { prewarmSlugDilation, slugDilate, slugDilateMatrix } from './slug/slug-dilate.js';

/**
 * One glyph instance's canonical Slug fields, already resolved to nodes. The address and count fields locate the
 * glyph's band tables inside the shared page; core owns their meaning, and a program owns how it stores them.
 */
export interface TslSlugInstanceNodes {
  /** Paragraph-local glyph origin, with y measured downward. */
  readonly origin: Node<'vec2'>;
  /** Glyph quad extent in paragraph-local units. */
  readonly size: Node<'vec2'>;
  /** Upper-left em-space coordinate of the glyph quad. */
  readonly emOrigin: Node<'vec2'>;
  /** Em-space extent of the glyph quad. */
  readonly emSize: Node<'vec2'>;
  /** Layout units per em, used to carry the dilation back into em space. */
  readonly inverseScale: Node<'float'>;
  /** Resolved paint colour with alpha, unpremultiplied. */
  readonly color: Node<'vec4'>;
  /** Band grid placement as `(originX, originY, scaleX, scaleY)` in em space. */
  readonly bandTransform: Node<'vec4'>;
  readonly curveBaseTexel: Node<'uint'>;
  readonly horizontalHeaderBase: Node<'uint'>;
  readonly verticalHeaderBase: Node<'uint'>;
  readonly referenceBase: Node<'uint'>;
  readonly horizontalBandCount: Node<'uint'>;
  readonly verticalBandCount: Node<'uint'>;
}

/** The three integer textures one decoded Slug page publishes, plus the row widths that address them. */
export interface TslSlugPageResources {
  readonly curveTexture: DataTexture;
  readonly curveWidth: number;
  readonly headerTexture: DataTexture;
  readonly headerWidth: number;
  readonly referenceTexture: DataTexture;
  readonly referenceWidth: number;
}

/** Optional coverage controls. Omitted fields keep the canonical non-zero winding rule with no weight compensation. */
export interface TslSlugFillRule {
  readonly evenOdd?: Node<'bool'>;
  readonly weightBoost?: Node<'bool'>;
  readonly stemDarken?: Node<'float'>;
  readonly thicken?: Node<'float'>;
}

/**
 * The GPU resources one Slug glyph batch binds. The clip-space rows and viewport drive the analytic half-pixel
 * dilation, so they must describe the same draw the returned position node feeds.
 */
interface TslSlugShaderResourceBase {
  readonly page: TslSlugPageResources;
  /** Drawing-buffer size in device pixels. */
  readonly viewport: Node<'vec2'>;
  readonly fillRule?: TslSlugFillRule;
}

interface TslSlugShaderRowResources extends TslSlugShaderResourceBase {
  readonly modelViewProjectionRow0: Node<'vec4'>;
  readonly modelViewProjectionRow1: Node<'vec4'>;
  readonly modelViewProjectionRow3: Node<'vec4'>;
  readonly modelViewProjection?: never;
}

interface TslSlugShaderMatrixResources extends TslSlugShaderResourceBase {
  /** Exact MVP selected per glyph when a renderer batches multiple model transforms into one draw. */
  readonly modelViewProjection: Node<'mat4'>;
  readonly modelViewProjectionRow0?: never;
  readonly modelViewProjectionRow1?: never;
  readonly modelViewProjectionRow3?: never;
}

export type TslSlugShaderResources = TslSlugShaderRowResources | TslSlugShaderMatrixResources;

/**
 * Everything the canonical Slug graph produces, so a program can consume a stage or compose over its final output.
 *
 * Unlike Bitmap this output publishes no `clipPosition`: Slug integrates coverage analytically from outlines, so it is
 * correct at any subpixel placement and must keep the default projection rather than snap to the physical pixel grid.
 */
export interface TslSlugShaderOutput {
  /** Dilated glyph-quad position. Reading it from a vertex node is what publishes `renderCoordinate`. */
  readonly position: Node<'vec3'>;
  /** Interpolated em-space coordinate the coverage integral is evaluated at. */
  readonly renderCoordinate: Node<'vec2'>;
  /** Analytic fill coverage before paint alpha. */
  readonly coverage: Node<'float'>;
  readonly color: Node<'vec3'>;
  readonly opacity: Node<'float'>;
}

/**
 * Builds the canonical Slug node graph. This is the exact graph the command-buffer executor renders, so a program that composes
 * over the returned nodes inherits the technique's band walk, quadratic solve, and antialiasing footprint.
 *
 * `position` and `coverage` are two halves of one graph: the vertex half writes the varying the fragment half
 * integrates over. A program that uses `coverage` must also drive its material position from `position`.
 *
 * The graph reads `positionLocal` from the technique's unit quad, which must span `[0, 1]` with the origin at the
 * glyph's upper-left corner. A program supplying different geometry owns that correspondence.
 */
export function slugShader(instance: TslSlugInstanceNodes, resources: TslSlugShaderResources): TslSlugShaderOutput {
  const renderCoordinate = TSL.varyingProperty('vec2', 'pmndrsSlugRenderCoordinate');
  const position = TSL.Fn(() => {
    const localPosition = TSL.vec2(
      instance.origin.x.add(TSL.positionLocal.x.mul(instance.size.x)),
      instance.origin.y.add(TSL.positionLocal.y.mul(instance.size.y)).negate(),
    );
    const outwardNormal = TSL.vec2(
      TSL.positionLocal.x.sub(0.5).mul(instance.size.x),
      TSL.positionLocal.y.sub(0.5).mul(instance.size.y).negate(),
    );
    const emCoordinate = TSL.vec2(
      instance.emOrigin.x.add(TSL.positionLocal.x.mul(instance.emSize.x)),
      instance.emOrigin.y.sub(TSL.positionLocal.y.mul(instance.emSize.y)),
    );
    const dilated =
      resources.modelViewProjection === undefined
        ? slugDilate(
            localPosition,
            outwardNormal,
            emCoordinate,
            instance.inverseScale,
            resources.modelViewProjectionRow0,
            resources.modelViewProjectionRow1,
            resources.modelViewProjectionRow3,
            resources.viewport,
          )
        : slugDilateMatrix(
            localPosition,
            outwardNormal,
            emCoordinate,
            instance.inverseScale,
            resources.modelViewProjection,
            resources.viewport,
          );
    renderCoordinate.assign(dilated.textureCoordinate);
    return TSL.vec3(dilated.position.x, dilated.position.y, 0);
  })();
  const rule = renderOptions(resources.fillRule);
  const page = resources.page;
  const coverage = coverageFor(page)(
    instance.curveBaseTexel,
    instance.horizontalHeaderBase,
    instance.verticalHeaderBase,
    instance.referenceBase,
    instance.horizontalBandCount,
    instance.verticalBandCount,
    instance.bandTransform,
    renderCoordinate,
    rule.evenOdd,
    rule.weightBoost,
    rule.stemDarken,
    rule.thicken,
    TSL.texture(page.curveTexture),
    TSL.texture(page.headerTexture),
    TSL.texture(page.referenceTexture),
  ) as Node<'float'>;

  return {
    position,
    renderCoordinate,
    coverage,
    color: instance.color.rgb,
    opacity: instance.color.a.mul(coverage),
  };
}

function renderOptions(rule: TslSlugFillRule | undefined): Required<TslSlugFillRule> {
  return {
    evenOdd: rule?.evenOdd ?? TSL.bool(false),
    weightBoost: rule?.weightBoost ?? TSL.bool(false),
    stemDarken: rule?.stemDarken ?? TSL.float(0),
    thicken: rule?.thicken ?? TSL.float(0),
  };
}

/**
 * The page textures are per material, so the canonical texel slots read them through `@typegpu/three` handles that
 * every call binds to its own TSL textures. The slot and width bindings are resolved once per backend and page shape.
 */
const curveTexture = /* @__PURE__ */ t3.handle(/* @__PURE__ */ d.texture2d(d.f32));
const headerTexture = /* @__PURE__ */ t3.handle(/* @__PURE__ */ d.texture2d(d.u32));
const referenceTexture = /* @__PURE__ */ t3.handle(/* @__PURE__ */ d.texture2d(d.u32));

function loadCurve(coords: d.v2i): d.v4f {
  'use gpu';
  return std.textureLoad(curveTexture.$, coords, 0);
}

function loadHeader(coords: d.v2i): d.v4u {
  'use gpu';
  return std.textureLoad(headerTexture.$, coords, 0);
}

function loadReference(coords: d.v2i): d.v4u {
  'use gpu';
  return std.textureLoad(referenceTexture.$, coords, 0);
}

const slugCoverage = /* @__PURE__ */ tgpu.fn(
  [d.u32, d.u32, d.u32, d.u32, d.u32, d.u32, d.vec4f, d.vec2f, d.bool, d.bool, d.f32, d.f32],
  d.f32,
)((
  curveBaseTexel,
  horizontalHeaderBase,
  verticalHeaderBase,
  referenceBase,
  horizontalBandCount,
  verticalBandCount,
  bandTransform,
  renderCoordinate,
  evenOdd,
  weightBoost,
  stemDarken,
  thicken,
) => {
  'use gpu';
  return slugRenderWithOptions(
    SlugShaderGlyph({
      curveBaseTexel,
      horizontalHeaderBase,
      verticalHeaderBase,
      referenceBase,
      horizontalBandCount,
      verticalBandCount,
      bandTransform,
    }),
    renderCoordinate,
    evenOdd,
    weightBoost,
    stemDarken,
    thicken,
  );
});

type SlugCoverageCall = ReturnType<typeof specializeCoverage>;
const coverageByPageShape = new Map<string, SlugCoverageCall>();

function specializeCoverage(curveWidth: number, headerWidth: number, referenceWidth: number) {
  return t3.toTSLFn(
    slugCoverage
      .with(slugCurveWidthAccessor, d.u32(curveWidth))
      .with(slugHeaderWidthAccessor, d.u32(headerWidth))
      .with(slugReferenceWidthAccessor, d.u32(referenceWidth))
      .with(slugCurveTexelSlot, loadCurve)
      .with(slugHeaderTexelSlot, loadHeader)
      .with(slugReferenceTexelSlot, loadReference),
    [curveTexture, headerTexture, referenceTexture],
  );
}

/** Row widths are compiled into the texel addressing, so one resolved program serves every page of that shape. */
function coverageFor(
  page: Pick<TslSlugPageResources, 'curveWidth' | 'headerWidth' | 'referenceWidth'>,
): SlugCoverageCall {
  const key = `${String(page.curveWidth)}:${String(page.headerWidth)}:${String(page.referenceWidth)}`;
  let coverage = coverageByPageShape.get(key);
  if (coverage === undefined) {
    coverage = specializeCoverage(page.curveWidth, page.headerWidth, page.referenceWidth);
    coverageByPageShape.set(key, coverage);
  }
  return coverage;
}

/** The Slug baker's default row width for all three page textures. */
const DEFAULT_SLUG_PAGE_WIDTH = 4096;

/**
 * Resolve the dilation and the default-shaped coverage program for one backend before the first Slug material is
 * built. Pages of another shape still resolve on first use and reuse every width-independent helper.
 */
export function prewarmSlugShader(backend: 'webgpu' | 'webgl'): void {
  prewarmSlugDilation(backend);
  coverageFor({
    curveWidth: DEFAULT_SLUG_PAGE_WIDTH,
    headerWidth: DEFAULT_SLUG_PAGE_WIDTH,
    referenceWidth: DEFAULT_SLUG_PAGE_WIDTH,
  }).prewarm(backend);
}
