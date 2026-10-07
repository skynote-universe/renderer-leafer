# @skynote/renderer-leafer

> The [LeaferJS](https://www.leaferjs.com) rendering backend for [SkyNote](https://github.com/skynote-universe). It turns the kernel's renderer-neutral primitives into a Leafer scene, keeps per-frame cost independent of canvas size, and bridges browser pointer, cursor and overlay APIs to the kernel. MIT licensed.

SkyNote 的 LeaferJS 渲染后端：把内核输出的、与渲染器无关的图元绘制到 Leafer 场景，并把浏览器的指针、光标与覆盖层能力桥接给内核。

## 特性

- **帧开销与画布规模无关**：只处理视锥内的实体；离屏图元摘除后按最近最少使用 (LRU) 淘汰，回到视野时就地复用。
- **分帧合并**：同一帧内的多次提交、指针移动与滚轮合并为一次渲染。
- **自适应细节层级**：按设备性能与实测帧耗时动态降低绘制细节，负载回落后自动恢复。
- **像素对齐**：按设备像素比对齐，1px 线条在任意缩放下都清晰。
- **故障隔离**：单个节点绘制出错时降级为占位框，不影响整个画布。
- **宿主桥接**：指针事件归一化为内核的虚拟事件与世界坐标；光标取自内核光标注册表的自绘 SVG。
- **文字测量**：提供与绘制一致的字体测量器，供内核排版使用。

## 安装

```bash
npm i @skynote/renderer-leafer
```

## 使用

通常与 [@skynote/editor](https://github.com/skynote-universe/editor) 搭配：

```ts
import { SkyNoteEditor } from '@skynote/editor';
import { LeaferAdapter } from '@skynote/renderer-leafer';

const editor = new SkyNoteEditor<HTMLElement>({
  renderer: new LeaferAdapter({ offscreenCacheLimit: 4000 })
});
editor.mount(document.getElementById('canvas')!);
```

`LeaferAdapter` 的选项：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `pixelRatio` | `window.devicePixelRatio` | 设备像素比 |
| `enableFrameScheduler` | `true` | 分帧调度 |
| `offscreenCacheLimit` | `2000` | 离屏图元缓存上限 (节点与连线各自计数) |

需要换用其他渲染技术时，实现内核的 `RenderAdapter` 接口即可，节点与交互代码无需改动。

## 相关包

| 包 | 说明 |
| --- | --- |
| [@skynote/core](https://github.com/skynote-universe/core) | 平台中立内核：文档模型、事务与撤销、插件协议 |
| **@skynote/renderer-leafer** | 基于 LeaferJS 的渲染器 (本包) |
| [@skynote/plugins-basic](https://github.com/skynote-universe/plugins-basic) | 基础节点与交互插件 |
| [@skynote/editor](https://github.com/skynote-universe/editor) | 开箱即用的编辑器 |
| [web](https://github.com/skynote-universe/web) | 官方示例应用 (Vue 3) |

## 许可证

[MIT](./LICENSE)
