import './setup';
import type { Leafer } from 'leafer-ui';
import { afterEach, expect, it } from 'vitest';
import { SkyNoteEngine } from '@skynote/core';
import { LeaferRenderer } from '../src/leafer-renderer';

interface FakeQuery {
  media: string;
  listener?: () => void;
}

const original = { matchMedia: globalThis.matchMedia, devicePixelRatio: globalThis.devicePixelRatio };
afterEach(() => {
  globalThis.matchMedia = original.matchMedia;
  globalThis.devicePixelRatio = original.devicePixelRatio;
});

/** 可控的 matchMedia：记录每次按当前像素比建立的查询，测试手动触发失配 */
function fakeMatchMedia(): FakeQuery[] {
  const queries: FakeQuery[] = [];
  globalThis.matchMedia = ((media: string) => {
    const query: FakeQuery = { media };
    queries.push(query);
    return {
      media,
      addEventListener: (_type: string, listener: () => void) => (query.listener = listener),
      removeEventListener: (_type: string, listener: () => void) => {
        if (query.listener === listener) query.listener = undefined;
      }
    };
  }) as unknown as typeof globalThis.matchMedia;
  return queries;
}

const leaferOf = (renderer: LeaferRenderer): Leafer => (renderer as unknown as { leafer: Leafer }).leafer;

it('设备像素比变化 (浏览器缩放、换屏) 时画布随之更新，并按新像素比继续监听；销毁后解除监听', () => {
  const queries = fakeMatchMedia();
  globalThis.devicePixelRatio = 1;
  const renderer = new LeaferRenderer(new SkyNoteEngine(), document.createElement('div'), {
    enableFrameScheduler: false
  });
  expect(leaferOf(renderer).pixelRatio).toBe(1);
  expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)']);

  globalThis.devicePixelRatio = 2;
  queries[0].listener!();
  expect(leaferOf(renderer).pixelRatio).toBe(2);
  expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);

  renderer.destroy();
  expect(queries[1].listener).toBeUndefined();
});

it('显式固定像素比时不跟随设备像素比', () => {
  const queries = fakeMatchMedia();
  const renderer = new LeaferRenderer(new SkyNoteEngine(), document.createElement('div'), {
    enableFrameScheduler: false,
    pixelRatio: 3
  });
  expect(leaferOf(renderer).pixelRatio).toBe(3);
  expect(queries).toHaveLength(0);
  renderer.destroy();
});
