import './setup';
import { expect, it } from 'vitest';
import { ColorConvert } from 'leafer-ui';
import '../src/primitives/primitive-mapper';

// 回归：改为依赖 leafer-ui 本体后曾缺少颜色插件，带透明度的纯色被画成不透明色 (框选背景、半透明填充)
it('带透明度的纯色按透明度绘制，不退化为不透明', () => {
  expect(ColorConvert.string('#24B6A2', 0.08)).toBe('rgba(36,182,162,0.08)');
  expect(ColorConvert.string('#24B6A2')).toBe('#24B6A2');
});
