// 注入 Node 环境 Canvas 全局 mock 以供 Leafer 静态初始化与无头单测
if (typeof (globalThis as any).CanvasRenderingContext2D === 'undefined') {
  (globalThis as any).CanvasRenderingContext2D = class {};
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class {};
}
if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class {};
}
if (typeof (globalThis as any).HTMLElement === 'undefined') {
  (globalThis as any).HTMLElement = class {
    style: Record<string, any> = {};
    clientWidth = 800;
    clientHeight = 600;
    children: any[] = [];
    childNodes: any[] = [];
    hasChildNodes() {
      return false;
    }
    appendChild(child: any) {
      this.children.push(child);
      return child;
    }
    removeChild() {}
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    getAttribute() {
      return null;
    }
    hasAttribute() {
      return false;
    }
    focus() {}
  };
}
if (typeof (globalThis as any).HTMLCanvasElement === 'undefined') {
  (globalThis as any).HTMLCanvasElement = class extends (globalThis as any).HTMLElement {};
}
if (typeof (globalThis as any).document === 'undefined') {
  const createMockCanvas = () => {
    const canvas = Object.create((globalThis as any).HTMLCanvasElement.prototype);
    // Leafer 异步渲染循环会调用任意 2D 上下文方法，未声明的方法统一返回空操作，避免测试输出被 mock 缺口刷屏
    canvas.getContext = () =>
      new Proxy({ measureText: () => ({ width: 100 }) } as Record<string | symbol, unknown>, {
        get: (target, key) => (key in target ? target[key] : () => {})
      });
    canvas.style = {};
    canvas.width = 800;
    canvas.height = 600;
    canvas.setAttribute = () => {};
    canvas.addEventListener = () => {};
    canvas.removeEventListener = () => {};
    return canvas;
  };
  (globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') return createMockCanvas();
      const el = new (globalThis as any).HTMLElement();
      return el;
    },
    body: { appendChild: () => {}, removeChild: () => {} }
  };
}
if (typeof (globalThis as any).Image === 'undefined') {
  (globalThis as any).Image = class {};
}
if (typeof (globalThis as any).addEventListener === 'undefined') {
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
} else {
  if (typeof (globalThis as any).window.addEventListener === 'undefined') {
    (globalThis as any).window.addEventListener = () => {};
    (globalThis as any).window.removeEventListener = () => {};
  }
}
if (typeof (globalThis as any).navigator === 'undefined') {
  (globalThis as any).navigator = { userAgent: 'node' };
}
const eventClasses = [
  'PointerEvent',
  'MouseEvent',
  'WheelEvent',
  'KeyboardEvent',
  'TouchEvent',
  'DragEvent',
  'Event',
  'CustomEvent',
  'UIEvent'
];
for (const name of eventClasses) {
  if (typeof (globalThis as any)[name] === 'undefined') {
    (globalThis as any)[name] = class {};
  }
}
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 16);
}
if (typeof (globalThis as any).cancelAnimationFrame === 'undefined') {
  (globalThis as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
}
