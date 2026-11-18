# @skynote/renderer-leafer

> The [LeaferJS](https://www.leaferjs.com) rendering backend for [SkyNote](https://github.com/skynote-universe). It turns the kernel's renderer-neutral primitives into a Leafer scene, uses viewport culling to limit render work, and bridges browser pointer, cursor and overlay APIs to the kernel. MIT licensed.

SkyNote 的 LeaferJS 渲染后端：把内核输出的、与渲染器无关的图元绘制到 Leafer 场景，并把浏览器的指针、光标与覆盖层能力桥接给内核。

[快速开始](https://docs.skynote.top/guide/getting-started) · [API 参考](https://docs.skynote.top/api/renderer-leafer) · [演练场](https://playground.skynote.top/)

## 特性

- **帧开销与画布规模无关**：只处理视锥内的实体；离屏图元摘除后按最近最少使用 (LRU) 淘汰，回到视野时就地复用。
- **分帧合并**：同一帧内的多次提交、指针移动与滚轮合并为一次渲染。
- **自适应细节层级**：按设备性能与实测帧耗时动态降低绘制细节，负载回落后自动恢复。
- **像素对齐**：按设备像素比对齐，1px 线条在任意缩放下都清晰。
- **故障隔离**：单个节点绘制出错时降级为占位框，不影响整个画布。
- **宿主桥接**：指针事件归一化为内核的虚拟事件与世界坐标；光标取自内核光标注册表的自绘 SVG。
- **文字测量**：提供与绘制一致的字体测量器，供内核排版使用。

## 安装

首个公开版本为 `0.1.0-beta.1`。通过 npm 的 `beta` 标签安装。

```bash
npm install @skynote/renderer-leafer@beta
```

渲染器将 LeaferJS 和颜色插件的对等依赖锁定在 `2.1.4`，以避免 npm 在同一应用中装入两套 Leafer 模块。如果 TypeScript 报告 LeaferJS 声明中的 `UI.get` 与 `Leaf.get` 签名不兼容，可在 `tsconfig.json` 中设置 `compilerOptions.skipLibCheck: true`。`strict` 仍可启用，应用源码仍会接受类型检查。

## 使用

以下示例还需要安装 [@skynote/editor](https://docs.skynote.top/api/editor) 的 Beta 版本：

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
| `lod` | 内置规则 | 自适应细节规则和恢复延迟 |
| `offscreenCacheLimit` | `2000` | 离屏图元缓存上限 (节点与连线各自计数) |

需要换用其他渲染技术时，实现内核的 `RenderAdapter` 接口即可，节点与交互代码无需改动。

### 自定义渲染降级

`lod` 由宿主在初始化适配器时传入。以下配置在候选节点达到 1,500 和 5,000 时分别降到 `reduced` 和 `minimal`，并关闭仅因文档总量触发的交互降级。

```ts
const renderer = new LeaferAdapter({
  lod: {
    recoveryDelayMs: 300,
    rules: {
      viewport: { nodes: { reduced: 1_500, minimal: 5_000 } },
      document: false,
    },
  },
})
```

- `viewport` 按含视口缓冲的候选节点和连线计数，`document` 按文档总量计数，`cache` 按缓存图元计数。三组均可分别配置节点和连线。文档规则默认在指针交互期间检查，可用 `when: 'always'` 持续检查。`viewport.interactionNodesAbove` 则按实际视口内的节点计数，严格超过该值且有指针交互才触发 `reduced`。
- `lod.viewportNodesAbove` 为所有降级规则和自定义策略设置实际视口节点数门槛。节点数低于或等于门槛时立即恢复完整细节，超过门槛后按配置评估档位。
- `zoom` 可指定低于哪个缩放比例时降级，`timing` 可指定渲染耗时 P95 和样本门槛。计数与耗时达到阈值时触发，缩放低于阈值时触发。多条内置规则同时命中时取最强降级。
- 省略的规则和字段继承默认值。用 `false` 关闭对应规则组、实体类型或档位，用 `lod: false` 关闭自适应 LOD。直接指定的节点或连线阈值按实际数量比较。分帧调度通过独立的 `enableFrameScheduler` 配置。
- 复杂策略可传入 `decide(metrics, suggestedLevel)`。只读指标来自当帧已有的候选量、文档总量、缓存、缩放、交互状态和计时样本。策略应保持同步、无副作用。返回 `undefined`、非法值或抛出异常时使用内置建议。控制器统一处理恢复延迟。
## 相关包

| 包 | 说明 |
| --- | --- |
| [@skynote/core](https://docs.skynote.top/api/core) | 平台中立内核：文档模型、事务与撤销、插件协议 |
| **@skynote/renderer-leafer** | 基于 LeaferJS 的渲染器 (本包) |
| [@skynote/plugins-basic](https://docs.skynote.top/api/plugins-basic) | 基础节点与交互插件 |
| [@skynote/editor](https://docs.skynote.top/api/editor) | 开箱即用的编辑器 |
| [SkyNote Web](https://canvas.skynote.top/) | 官方示例应用 (Vue 3) |

## 场景导出

实现CanvasRenderer的通用可选`export(request)`协议，通过`exportFormats`声明`png`、`jpeg`、`webp`；请求`format`选择编码器，`quality`传给有损编码，结果返回实际MIME。格式不受Core枚举限制，由渲染器自行实现并校验；不支持的格式或浏览器静默回退PNG会明确拒绝。JPEG需要画布背景，透明背景请用PNG/WebP。SkyNoteEditor.exportPng仍是PNG便捷入口，委托通用协议并按声明的格式判断入口可用性。

导出独立构建指定世界范围内的节点和连线，不复用当前视口的LOD/分帧/覆盖层；保持容器裁剪及派生连线。等待图片及纹理后编码，取消、失败或超时释放临时资源。当前栅格编码最大单边8192像素，总计16777216像素。有私有状态的自定义原生节点暂不支持独立导出，会明确报错，避免污染当前场景。

## 许可证

[MIT](./LICENSE)
