import { createElement, Suspense } from 'react';
import { create, act } from '@react-three/test-renderer/webgpu';
import { glyph } from '@pmndrs/glyph';
import { Text, TextGroup } from '@pmndrs/glyph/react';
import { adapterBehavior } from '../support/adapter-behavior.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.self ??= globalThis;
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => undefined;
await glyph.init();

adapterBehavior('React', async (initial) => {
  let object;
  let groupObject;
  let requests = 0;
  const ref = (value) => {
    if (value !== null) object = value;
  };
  const tree = ({ text, group, ...props }) => {
    const paragraph = createElement(Text, { ...props, ref }, text);
    return createElement(
      Suspense,
      { fallback: null },
      group === undefined
        ? paragraph
        : createElement(
            TextGroup,
            {
              ...group,
              ref: (value) => {
                groupObject = value;
              },
            },
            paragraph,
          ),
    );
  };
  const renderer = await create(tree(initial), {
    frameloop: 'demand',
    onCreated(state) {
      const invalidate = state.invalidate;
      state.set({
        invalidate: (...args) => {
          requests += 1;
          invalidate(...args);
        },
      });
    },
  });
  return {
    get text() {
      return object;
    },
    get group() {
      return groupObject;
    },
    get frameRequests() {
      return requests;
    },
    resetFrameRequests() {
      requests = 0;
    },
    update: (props) => renderer.update(tree(props)),
    async settle(promise) {
      await act(async () => {
        await promise;
      });
    },
    unmount: () => renderer.unmount(),
  };
});
