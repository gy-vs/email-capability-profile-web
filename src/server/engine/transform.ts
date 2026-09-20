import type {
  CapabilityProfile, CssDeclaration, CssMedia, CssNode,
  HtmlDoc, HtmlElement,
} from './ast';
import {featuresToQuery, parseHtml, querySupported} from './parser';
import {serializeHtml, type SerializedHtml} from './serialize';

export type ExplanationCode =
  | 'property-removed'        // 不支持的属性：声明删除
  | 'value-fallback'         // 值级回退
  | 'value-removed'          // 值不支持且无回退：声明删除
  | 'image-source-dropped'   // picture 候选移除
  | 'image-fallback'         // img 地址改写
  | 'picture-unwrapped'      // picture 不支持/无候选：退化为 img
  | 'media-nested-flatten'   // 嵌套媒体规则合并提升
  | 'media-block-dropped'    // 媒体查询整体丢弃（未识别/无特性）
  | 'media-unsupported-feature' // 媒体特性不受支持：块丢弃
  | 'dark-block-dropped'     // dark mode 块丢弃
  | 'conflict-skipped';      // 同节点更高优先级规则已生效，本条跳过

export type Severity = 'drop' | 'fallback' | 'info' | 'warning';

export interface Explanation {
  id: string;
  code: ExplanationCode;
  severity: Severity;
  message: string;
  /** 被作用节点：声明 id / CSS 媒体 id / 元素 id */
  targetId: string;
  /** 人类可读位置 */
  location: string;
  /** 可在渲染视图高亮的选择器 */
  selectors: string[];
  /** 该节点是否仍存在于转换结果中 */
  survives: boolean;
  /** 被哪条解释对应的规则抢占 */
  conflictsWith?: string;
}

export interface TransformResult {
  original: SerializedHtml;
  transformed: SerializedHtml;
  explanations: Explanation[];
}

export interface ApplyOptions {
  /** 扰动规则注册顺序，用于验证结果只取决于优先级而非遍历顺序（仅测试） */
  shuffleSeed?: number;
}

export function applyCapabilities(html: string, profile: CapabilityProfile, opts: ApplyOptions = {}): TransformResult {
  const originalDoc = parseHtml(html);
  const doc = parseHtml(html);
  const explanations: Explanation[] = [];
  let seq = 0;
  const add = (e: Omit<Explanation, 'id'>): string => {
    const ex: Explanation & {id: string} = {...e, id: `e${++seq}`};
    explanations.push(ex);
    return ex.id;
  };

  // ============ pass 1：dark mode + 媒体查询（含嵌套） ============
  // 依赖顺序（固定，不可随遍历顺序变化）：
  //   a) 先递归处理内层媒体；dark 不支持时 dark 门控块始终丢弃
  //   b) 顶层且不支持嵌套时，把内层媒体合并查询后提升，再对提升结果做能力评估
  //   c) 最后评估媒体块自身的特性支持情况
  const processSheetMedia = (sheet: CssNode[]) => {
    const visit = (media: CssMedia, deferEval: boolean) => {
      const nested = media.children.filter((c): c is CssMedia => c.kind === 'media');
      const willFlatten = !media.parent && !profile.css.mediaNested;
      for (const child of nested) visit(child, willFlatten);
      if (media.detached) return;

      const hasDark = media.features.some(f => f.kind === 'dark');
      if (hasDark && !profile.darkMode) {
        add({
          code: 'dark-block-dropped', severity: 'drop',
          message: `客户端不支持 dark mode，丢弃 @media ${media.query}`,
          targetId: media.id, location: mediaLocation(media),
          selectors: collectSelectors(media), survives: false,
        });
        detachMedia(media);
        return;
      }

      if (!media.parent && !profile.css.mediaNested) {
        let offset = 1;
        const idx = sheet.indexOf(media);
        for (const child of nested) {
          if (child.detached) continue;
          const mergedFeatures = [...media.features, ...child.features];
          const mergedQuery = featuresToQuery(mergedFeatures);
          add({
            code: 'media-nested-flatten', severity: 'info',
            message: `不支持嵌套 @media，内层 “${child.query}” 合并提升为 “${mergedQuery}”`,
            targetId: child.id, location: mediaLocation(child),
            selectors: collectSelectors(child), survives: true,
          });
          // 身份不变：沿用 child 的 id，仅改位置/查询
          child.features = mergedFeatures;
          child.query = mergedQuery;
          child.mergedFromNested = true;
          const lifted: CssMedia = {...child, parent: null};
          for (const c of lifted.children) c.parent = lifted;
          child.detached = true; // 原嵌套位置移除（同一 id 的节点只保留提升后的一份）
          sheet.splice(idx + offset, 0, lifted);
          offset++;
          // 提升结果立即按能力评估
          if (!querySupported(lifted.features, profile)) {
            dropUnsupportedMedia(lifted);
          }
        }
      }

      if (deferEval || media.detached) return;
      if (!querySupported(media.features, profile)) dropUnsupportedMedia(media);
    };

    const dropUnsupportedMedia = (media: CssMedia) => {
      const unsupportedFeature = media.features.find(f => !featureAllowed(f, profile));
      const code = unsupportedFeature?.kind === 'dark' ? 'dark-block-dropped'
        : unsupportedFeature ? 'media-unsupported-feature'
        : 'media-block-dropped';
      add({
        code, severity: 'drop',
        message: unsupportedFeature
          ? `媒体特性 ${unsupportedFeature.name} 不被支持，丢弃 @media ${media.query}`
          : `客户端不支持该媒体查询，丢弃 @media ${media.query}`,
        targetId: media.id, location: mediaLocation(media),
        selectors: collectSelectors(media), survives: false,
      });
      detachMedia(media);
    };

    for (const node of sheet) {
      if (node.kind === 'media' && !node.detached) visit(node, false);
    }
  };

  // ============ pass 2：图片候选 ============
  // 依赖顺序：先删不受支持的 <source>；候选清空后 <picture> 退化为 <img>；
  // 最后 <img> 地址按回退格式改写。
  const processImages = () => {
    // 第一遍：删除不受支持的 source 候选
    for (const picture of [...walkElements(doc)].filter(el => el.tag === 'picture')) {
      if (picture.detached) continue;
      for (const source of picture.children.filter(
        (c): c is HtmlElement => c.kind === 'element' && c.tag === 'source',
      )) {
        const type = source.attrs.find(a => a.name === 'type')?.value ?? '';
        const srcset = source.attrs.find(a => a.name === 'srcset')?.value ?? '';
        const fmt = typeFmt(type) ?? firstSrcsetFormat(srcset);
        if (fmt && !profile.images.supportedFormats.includes(fmt)) {
          add({
            code: 'image-source-dropped', severity: 'drop',
            message: `图片候选 ${fmt} 不受支持，移除 <source${type ? ` type="${type}"` : ''}>`,
            targetId: source.id, location: elementLocation(source),
            selectors: ['picture source'], survives: false,
          });
          source.detached = true;
        }
      }
    }
    // 第二遍：picture 不支持或候选已清空 → 退化为内部 img（重新遍历，避免解包后使用过期树快照）
    for (const picture of [...walkElements(doc)].filter(el => el.tag === 'picture')) {
      if (picture.detached) continue;
      const keptSources = picture.children.some(
        c => c.kind === 'element' && c.tag === 'source' && !c.detached,
      );
      const img = picture.children.find(
        (c): c is HtmlElement => c.kind === 'element' && c.tag === 'img' && !c.detached,
      );
      if (img && (!profile.images.picture || !keptSources)) {
        add({
          code: 'picture-unwrapped', severity: 'fallback',
          message: !profile.images.picture
            ? '客户端不支持 <picture>，退化为内部 <img>'
            : '<picture> 已无受支持候选，退化为内部 <img>',
          targetId: picture.id, location: elementLocation(picture),
          selectors: ['picture img'], survives: false,
        });
        unwrapPicture(doc, picture);
      }
    }
    // 第三遍：img 地址按回退格式改写（此时 picture 已完成解包）
    for (const img of [...walkElements(doc)].filter(el => el.tag === 'img')) {
      if (img.detached) continue;
      const attr = img.attrs.find(a => a.name === 'src');
      const src = attr?.value;
      if (!src) continue;
      const fmt = imgFormat(src);
      if (!fmt || profile.images.supportedFormats.includes(fmt)) continue;
      const fallback = profile.images.fallbackFormat;
      add({
        code: 'image-fallback',
        severity: fallback ? 'fallback' : 'warning',
        message: fallback
          ? `图片格式 ${fmt} 不受支持，地址回退为 .${fallback}`
          : `图片格式 ${fmt} 不受支持，且未配置回退格式，保留原地址（可能无法显示）`,
        targetId: img.id, location: elementLocation(img),
        selectors: ['img'], survives: true,
      });
      if (fallback && attr) attr.value = swapExtension(src, fallback);
    }
  };

  // ============ pass 3：声明级规则（属性删除 / 值回退） ============
  // 规则以数据方式声明，按固定优先级排序；shuffleSeed 只扰动注册顺序，
  // 用来证明结果不会因规则遍历顺序不同而变化。
  interface DeclRule {
    priority: number;
    tag: string;
    match: (d: CssDeclaration) => boolean;
    explain: (d: CssDeclaration) => Omit<Explanation, 'id'>;
  }
  const rules: DeclRule[] = [];
  for (const prop of profile.css.unsupportedProperties) {
    const property = prop.toLowerCase();
    rules.push({
      priority: 60, tag: `property:${property}`,
      match: d => d.property === property,
      explain: d => ({
        code: 'property-removed', severity: 'drop',
        message: `属性 ${d.property} 不被支持，删除声明 “${d.property}: ${d.value}${d.important ? ' !important' : ''}”`,
        targetId: d.id, location: '', selectors: [], survives: false,
      }),
    });
  }
  for (const fb of profile.css.valueFallbacks) {
    const property = fb.property.toLowerCase();
    const value = fb.value.toLowerCase();
    rules.push({
      priority: 70, tag: `value:${property}=${value}`,
      match: d => d.property === property && d.value.toLowerCase() === value,
      explain: d => fb.fallback
        ? {
            code: 'value-fallback', severity: 'fallback',
            message: `值 ${d.value}（${d.property}）不支持，回退为 ${fb.fallback}`,
            targetId: d.id, location: '', selectors: [], survives: true,
          }
        : {
            code: 'value-removed', severity: 'drop',
            message: `值 ${d.value}（${d.property}）不支持且无回退，删除声明`,
            targetId: d.id, location: '', selectors: [], survives: false,
          },
    });
  }
  if (opts.shuffleSeed != null) seededShuffle(rules, opts.shuffleSeed);
  // 稳定排序：优先级升序，同优先级按 tag 字典序
  rules.sort((a, b) => a.priority - b.priority || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const processDecl = (d: CssDeclaration, ruleNode: CssNode | undefined, ownerEl: HtmlElement | undefined) => {
    if (d.detached) return;
    const selectors = ownerEl
      ? [`[data-nid="${ownerEl.id}"]`]
      : ruleNode && ruleNode.kind === 'rule' ? splitSelector(ruleNode.selector) : [];
    const location = ownerEl ? `inline@${ownerEl.id}`
      : ruleNode ? `<style#${d.ownerId}> ${ruleNode.kind === 'rule' ? ruleNode.selector : '@media'} → ${d.property}`
      : d.property;
    let winner: {id: string; rule: DeclRule} | null = null;
    for (const rule of rules) {
      if (!rule.match(d)) continue;
      if (!winner) {
        const partial = rule.explain(d);
        const eid = add({...partial, location, selectors});
        winner = {id: eid, rule};
        if (partial.code === 'value-fallback') {
          const fb = profile.css.valueFallbacks.find(
            f => f.property.toLowerCase() === d.property && f.value.toLowerCase() === d.value.toLowerCase(),
          )!;
          d.value = fb.fallback;
        } else {
          d.detached = true;
        }
      } else {
        const winnerId: string = winner.id;
        // 同一声明命中多条规则：固定优先级下只有先生效的执行，其余逐条记录
        add({
          code: 'conflict-skipped', severity: 'info',
          message: `“${rule.tag}” 与已生效的更高优先级规则冲突，未重复执行（节点：${d.property}）`,
          targetId: d.id, location, selectors,
          survives: !d.detached,
          conflictsWith: winnerId,
        });
      }
    }
  };

  const processAllDeclarations = () => {
    for (const el of walkElements(doc)) {
      if (el.sheet) {
        const walk = (nodes: CssNode[]) => {
          for (const n of nodes) {
            if (n.detached) continue;
            if (n.kind === 'rule') for (const d of n.declarations) processDecl(d, n, undefined);
            if (n.kind === 'media') walk(n.children);
          }
        };
        walk(el.sheet);
      }
      if (el.style) for (const d of el.style) processDecl(d, undefined, el);
    }
  };

  // 按固定顺序执行各 pass
  for (const el of walkElements(doc)) {
    if (el.sheet) processSheetMedia(el.sheet);
  }
  processImages();
  processAllDeclarations();

  return {
    original: serializeHtml(originalDoc, true),
    transformed: serializeHtml(doc, true),
    explanations,
  };
}

// ---------------- helpers ----------------

function featureAllowed(f: {name: string; kind: string}, p: CapabilityProfile): boolean {
  if (f.kind === 'dark') return p.darkMode;
  if (f.kind === 'width') return p.css.supportedMediaFeatures.includes('width');
  return p.css.supportedMediaFeatures.includes(f.name);
}

function detachMedia(media: CssMedia) {
  media.detached = true;
  const walk = (nodes: CssNode[]) => {
    for (const n of nodes) { n.detached = true; if (n.kind === 'media') walk(n.children); }
  };
  walk(media.children);
}

function unwrapPicture(doc: HtmlDoc, picture: HtmlElement) {
  const moved = picture.children.filter(c => !c.detached);
  if (picture.parent) {
    const idx = picture.parent.children.indexOf(picture);
    for (const m of moved) m.parent = picture.parent;
    picture.parent.children.splice(idx, 1, ...moved);
  } else {
    const idx = doc.nodes.indexOf(picture);
    for (const m of moved) m.parent = null;
    doc.nodes.splice(idx, 1, ...moved);
  }
  picture.detached = true;
}

function* walkElements(doc: HtmlDoc): Generator<HtmlElement> {
  function* rec(nodes: HtmlDoc['nodes']): Generator<HtmlElement> {
    for (const n of nodes) {
      if (n.kind === 'element') {
        if (!n.detached) yield n;
        yield* rec(n.children);
      }
    }
  }
  yield* rec(doc.nodes);
}

function imgFormat(src: string): string | null {
  const clean = src.split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
}
function swapExtension(src: string, fmt: string): string {
  return src.replace(/^([^?#]*\.)([a-z0-9]+)/i, `$1${fmt}`);
}
function typeFmt(type: string): string | null {
  const m = type.match(/image\/([a-z0-9.+-]+)/i);
  if (!m) return null;
  const t = m[1].toLowerCase();
  return t === 'jpeg' ? 'jpg' : t.replace('svg+xml', 'svg');
}
function firstSrcsetFormat(srcset: string): string | null {
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first ? imgFormat(first) : null;
}

function mediaLocation(m: CssMedia): string {
  return `<style#${m.ownerId}> @media ${m.query}`;
}
function elementLocation(el: HtmlElement): string {
  return `<${el.tag}> (${el.id})`;
}
function collectSelectors(media: CssMedia): string[] {
  const out: string[] = [];
  const walk = (nodes: CssNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'rule') out.push(...splitSelector(n.selector));
      if (n.kind === 'media') walk(n.children);
    }
  };
  walk(media.children);
  return out;
}
function splitSelector(selector: string): string[] {
  return selector.split(',').map(s => s.trim()).filter(Boolean);
}

// mulberry32：测试时扰动规则注册顺序
function seededShuffle<T>(arr: T[], seed: number) {
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
