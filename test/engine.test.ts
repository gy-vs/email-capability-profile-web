import {describe, expect, it} from 'vitest';
import {applyCapabilities} from '../src/server/engine/transform';
import type {CapabilityProfile} from '../src/server/engine/ast';

const profile = (p: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  version: '1.0',
  client: 'test',
  css: {
    unsupportedProperties: [],
    supportedMediaFeatures: ['width', 'hover'],
    mediaNested: true,
    valueFallbacks: [],
    ...(p.css ?? {}),
  },
  images: {
    supportedFormats: ['jpg', 'png', 'gif', 'webp'],
    fallbackFormat: 'jpg',
    picture: true,
    ...(p.images ?? {}),
  },
  darkMode: p.darkMode ?? true,
});

describe('transform engine', () => {
  it('删除不支持的属性：节点保留、声明消失、身份不变', () => {
    const html = `<style>.a { gap: 10px; color: red; }</style><div class="a" style="margin: 4px; gap: 2px;">x</div>`;
    const r = applyCapabilities(html, profile({css: {unsupportedProperties: ['gap'], supportedMediaFeatures: [], mediaNested: false, valueFallbacks: []}}));
    expect(r.transformed.html).toContain('color: red');
    expect(r.transformed.html).not.toContain('gap');
    // 节点 id 在原始与转换中一致（style=h1，样式表在闭合时才解析，div=h6）
    expect(r.original.ranges.get('h6')).toBeTruthy();
    expect(r.transformed.ranges.get('h6')).toBeTruthy();
    const ex = r.explanations.find(e => e.code === 'property-removed');
    expect(ex?.severity).toBe('drop');
    expect(ex?.targetId).toMatch(/^c/);
    // 内联样式中的同一属性也被删除
    expect(r.explanations.filter(e => e.code === 'property-removed')).toHaveLength(2);
  });

  it('值级回退：替换值；无回退时删除声明', () => {
    const html = `<style>.a{display:flex}.b{display:grid}</style>`;
    const r = applyCapabilities(html, profile({
      css: {
        unsupportedProperties: [], supportedMediaFeatures: [], mediaNested: false,
        valueFallbacks: [
          {property: 'display', value: 'flex', fallback: 'block'},
          {property: 'display', value: 'grid', fallback: ''},
        ],
      },
    }));
    expect(r.transformed.html).toContain('display: block');
    expect(r.transformed.html).not.toContain('display: grid');
    const codes = r.explanations.map(e => e.code);
    expect(codes).toContain('value-fallback');
    expect(codes).toContain('value-removed');
  });

  it('图片候选：删 source、picture 解包、img 后缀回退按依赖顺序执行', () => {
    const html = `<picture>
  <source type="image/avif" srcset="a.avif">
  <source type="image/webp" srcset="a.webp">
  <img src="a.png" alt="a">
</picture>`;
    const r = applyCapabilities(html, profile({
      images: {supportedFormats: ['jpg', 'png'], fallbackFormat: 'jpg', picture: false},
      darkMode: false,
    }));
    // webp 支持，avif 删除；但 picture 整体不支持 → 解包；png 受支持 → 不改写
    expect(r.transformed.html).not.toContain('<source');
    expect(r.transformed.html).not.toContain('<picture');
    expect(r.transformed.html).toMatch(/<img src="a\.png"/);
    expect(r.transformed.html).not.toContain('a.jpg');
    const codes = r.explanations.map(e => e.code);
    expect(codes.indexOf('image-source-dropped')).toBeLessThan(codes.indexOf('picture-unwrapped'));
  });

  it('所有候选都被移除时 picture 解包，img 后缀按回退格式改写', () => {
    const html = `<picture><source type="image/webp" srcset="a.webp"><img src="a.avif"></picture>`;
    const r = applyCapabilities(html, profile({
      images: {supportedFormats: ['jpg'], fallbackFormat: 'jpg', picture: true}, darkMode: false,
    }));
    expect(r.transformed.html).not.toContain('picture');
    expect(r.transformed.html).toContain('a.jpg');
    expect(r.explanations.some(e => e.code === 'picture-unwrapped')).toBe(true);
  });

  it('嵌套媒体规则：不支持嵌套时合并提升；提升后能力不足再丢弃', () => {
    const html = `<style>
@media (max-width: 600px) {
  .a { color: red; }
  @media (hover: hover) { .a { color: blue; } }
}
</style>`;
    // 场景 A：嵌套不支持、hover 不支持 → 提升后丢弃 hover 块
    const a = applyCapabilities(html, profile({
      css: {unsupportedProperties: [], supportedMediaFeatures: ['width'], mediaNested: false, valueFallbacks: []},
    }));
    expect(a.transformed.html).toContain('@media (max-width: 600px)');
    expect(a.transformed.html).not.toContain('color: blue');
    expect(a.transformed.html).not.toContain('hover');
    expect(a.explanations.some(e => e.code === 'media-nested-flatten')).toBe(true);
    expect(a.explanations.some(e => e.code === 'media-unsupported-feature')).toBe(true);

    // 场景 B：嵌套不支持、hover 支持 → 提升并合并查询
    const b = applyCapabilities(html, profile({
      css: {unsupportedProperties: [], supportedMediaFeatures: ['width', 'hover'], mediaNested: false, valueFallbacks: []},
    }));
    expect(b.transformed.html).toContain('(max-width: 600px) and (hover: hover)');
    expect(b.transformed.html).toContain('color: blue');
    expect(b.explanations.some(e => e.code === 'media-unsupported-feature')).toBe(false);
  });

  it('dark mode：关闭时丢弃 dark 门控块（即使嵌在支持的媒体里）', () => {
    const html = `<style>
@media (max-width: 600px) { @media (prefers-color-scheme: dark) { .a { color: #fff } } }
@media (prefers-color-scheme: dark) { .b { color: #111 } }
.a { color: red }
</style>`;
    const r = applyCapabilities(html, profile({darkMode: false, css: {unsupportedProperties: [], supportedMediaFeatures: ['width'], mediaNested: true, valueFallbacks: []}}));
    expect(r.transformed.html).not.toContain('#fff');
    expect(r.transformed.html).not.toContain('#111');
    expect(r.transformed.html).toContain('color: red');
    expect(r.explanations.filter(e => e.code === 'dark-block-dropped')).toHaveLength(2);
  });

  it('规则冲突：同一声明同时命中属性删除与值回退时，属性删除优先且记录冲突', () => {
    const html = `<style>.a{display:flex}</style>`;
    const r = applyCapabilities(html, profile({
      css: {
        unsupportedProperties: ['display'], supportedMediaFeatures: [], mediaNested: false,
        valueFallbacks: [{property: 'display', value: 'flex', fallback: 'block'}],
      },
    }));
    expect(r.transformed.html).not.toContain('display');
    const skip = r.explanations.find(e => e.code === 'conflict-skipped');
    expect(skip).toBeTruthy();
    expect(skip?.conflictsWith).toBe(r.explanations.find(e => e.code === 'property-removed')?.id);
  });

  it('提升后空掉的外层媒体块不会输出空 @media {}', () => {
    const html = `<style>
@media (max-width: 600px) {
  @media (prefers-color-scheme: dark) { .a { color: #fff } }
}
</style>`;
    const r = applyCapabilities(html, profile({
      darkMode: true,
      css: {unsupportedProperties: [], supportedMediaFeatures: ['width'], mediaNested: false, valueFallbacks: []},
    }));
    expect(r.transformed.html).not.toMatch(/@media[^{]*\{\s*\}/);
    expect(r.transformed.html).toContain('(max-width: 600px) and (prefers-color-scheme: dark)');
  });

  it('确定性：扰动规则注册顺序不改变输出 HTML', () => {
    const html = `<style>
.a{display:flex;gap:4px}.b{display:grid;margin:0}
@media (hover:hover){.a{color:red}}
</style>
<picture><source type="image/avif" srcset="x.avif"><img src="x.webp"></picture>
<div style="display:flex;gap:2px"></div>`;
    const p = profile({
      css: {
        unsupportedProperties: ['gap', 'margin'], supportedMediaFeatures: ['width'], mediaNested: false,
        valueFallbacks: [
          {property: 'display', value: 'flex', fallback: 'block'},
          {property: 'display', value: 'grid', fallback: 'block'},
        ],
      },
      images: {supportedFormats: ['jpg'], fallbackFormat: 'jpg', picture: false},
      darkMode: false,
    });
    const baseline = applyCapabilities(html, p).transformed.html;
    for (const seed of [1, 7, 42, 12345]) {
      const shuffled = applyCapabilities(html, p, {shuffleSeed: seed}).transformed.html;
      expect(shuffled).toBe(baseline);
    }
    // 二次应用幂等：对已降级结果再应用同一配置，HTML 不再变化
    const once = applyCapabilities(html, p);
    const twice = applyCapabilities(once.transformed.html.replace(/ data-nid="[^"]+"/g, ''), p).transformed.html.replace(/ data-nid="[^"]+"/g, '');
    const onceClean = once.transformed.html.replace(/ data-nid="[^"]+"/g, '');
    expect(twice).toBe(onceClean);
  });
});
