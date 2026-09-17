import { describe, expect, it } from 'vitest';

import type { WorkloadText } from '../../../workloads/shared/scene-entry';
import { applyRetainedTextRasterPixelRatio } from './comparison-workload';

function text(rasterPixelRatio: number): WorkloadText {
  return { rasterPixelRatio } as WorkloadText;
}

describe('comparison workload retained text', () => {
  it('updates primary and companion text when the renderer DPR changes', () => {
    const primary = text(2);
    const label = text(2);

    applyRetainedTextRasterPixelRatio([{ text: primary }, { labelText: label, text: primary }], 1);

    expect(primary.rasterPixelRatio).toBe(1);
    expect(label.rasterPixelRatio).toBe(1);
  });
});
