import { describe, it, expect } from 'vitest';
import { LeaferNodeRendererRegistry } from '../src/registry/leafer-node-renderer-registry';
import { LeaferConnectorRendererRegistry } from '../src/registry/leafer-connector-renderer-registry';

describe('Renderer Registries', () => {
  it('LeaferNodeRendererRegistry 注册与注销', () => {
    const registry = new LeaferNodeRendererRegistry();
    const mockRenderer = {
      nodeType: 'custom:mindmap',
      create: () => [],
      update: () => {}
    };

    const unregister = registry.register(mockRenderer);
    expect(registry.has('custom:mindmap')).toBe(true);
    expect(registry.get('custom:mindmap')).toBe(mockRenderer);

    unregister();
    expect(registry.has('custom:mindmap')).toBe(false);
  });

  it('LeaferConnectorRendererRegistry 注册与注销', () => {
    const registry = new LeaferConnectorRendererRegistry();
    const mockRenderer = {
      connectorType: 'smart:a-star',
      create: () => [],
      update: () => {}
    };

    const unregister = registry.register(mockRenderer);
    expect(registry.has('smart:a-star')).toBe(true);
    expect(registry.get('smart:a-star')).toBe(mockRenderer);

    unregister();
    expect(registry.has('smart:a-star')).toBe(false);
  });
});
