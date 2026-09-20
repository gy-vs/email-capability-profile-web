import type {
  CapabilityConfig,
  DeclNode,
  DocumentNode,
  ElementNode,
  Explanation,
  MediaNode,
  RuleNode,
  StyleNode,
  TransformResult,
} from '../shared/types';
import {parseDocument} from './parser';
import {
  collectSheets,
  serialize,
  walk,
  walkRules,
} from './serializer';
import {imageFormatFromSrc, normalizeImageFormat} from './capabilities';

// Fixed pipeline order. Every degradation runs in exactly one phase so the
// output does not depend on how rule sets happen to be iterated.
export const PHASES = {
  DARK_MEDIA: 10,
  MEDIA_FEATURE: 20,
  MEDIA_NESTING: 30,
  DARK_ATTRIBUTE_HOOK: 40,
  DARK_META: 50,
  PICTURE: 60,
  VALUE: 70,
  PROPERTY: 80,
  RULE_CONFLICT: 90,
} as const;

interface RuleRef {
  sheet: {el: ElementNode; nodes: StyleNode[]};
  rule: RuleNode;
  path: MediaNode[];
}

export function transform(html: string, config: CapabilityConfig): TransformResult {
  const {root} = parseDocument(html);
  const explanations: Explanation[] = [];
  const add = (e: Omit<Explanation, 'id'>): Explanation => {
    const explanation: Explanation = {id: `e${explanations.length + 1}`, ...e};
    explanations.push(explanation);
    return explanation;
  };

  const sheets = collectSheets(root);
  const rules = collectRules(sheets);

  applyDarkMedia(rules, config, add);
  applyMediaFeatures(rules, config, add);
  applyMediaNesting(sheets, config, add);
  applyDarkAttributeHooks(rules, config, add);
  applyDarkMeta(root, config, add);
  applyPictures(root, config, add);
  applyValues(rules, root, config, add);
  applyProperties(rules, root, config, add);
  applyRuleConflicts(rules, add);

  explanations.sort((a, b) => a.phase - b.phase || a.nodeId.localeCompare(b.nodeId, undefined, {numeric: true}));
  // Re-issue sequential ids after sorting so API output is stable.
  explanations.forEach((e, i) => (e.id = `e${i + 1}`));

  const outputHtml = serialize(root);
  const stats = summaries(explanations);
  return {tree: root, originalHtml: html, outputHtml, explanations, stats};
}

function collectRules(sheets: {el: ElementNode; nodes: StyleNode[]}[]): RuleRef[] {
  const refs: RuleRef[] = [];
  for (const sheet of sheets) walkRules(sheet.nodes, (rule, path) => refs.push({sheet, rule, path}));
  return refs;
}

function summaries(explanations: Explanation[]) {
  const stats = {total: explanations.length, drops: 0, fallbacks: 0, notes: 0};
  for (const e of explanations) {
    if (e.severity === 'drop') stats.drops++;
    else if (e.severity === 'fallback') stats.fallbacks++;
    else stats.notes++;
  }
  return stats;
}

function isLive(rule: RuleRef): boolean {
  return rule.rule.status !== 'removed' && rule.path.every((m) => m.status !== 'removed');
}

// Phase 10: @media (prefers-color-scheme: dark) when dark mode unsupported.
function applyDarkMedia(rules: RuleRef[], config: CapabilityConfig, add: Add) {
  if (config.darkMode.supported && config.darkMode.mechanisms.includes('prefers-color-scheme')) return;
  const removed = new Set<MediaNode>();
  for (const ref of rules) {
    for (const media of ref.path) {
      if (removed.has(media)) continue;
      if (media.features.some((f) => f.feature === 'prefers-color-scheme')) {
        media.status = 'removed';
        media.explanationId = add({
          kind: 'dark_mode_media',
          severity: 'drop',
          phase: PHASES.DARK_MEDIA,
          nodeId: media.nid,
          relatedNodeIds: [],
          title: 'Dark-mode media query unsupported',
          detail: `Client does not support @media (prefers-color-scheme); the block "${media.condition}" was removed.`,
        }).id;
        removed.add(media);
      }
    }
  }
}

// Phase 20: @media features the client does not understand.
function applyMediaFeatures(rules: RuleRef[], config: CapabilityConfig, add: Add) {
  if (!config.media.supported) {
    const removed = new Set<MediaNode>();
    for (const ref of rules) {
      for (const media of ref.path) {
        if (removed.has(media)) continue;
        if (media.status === 'removed') continue;
        media.status = 'removed';
        media.explanationId = add({
          kind: 'media_unsupported',
          severity: 'drop',
          phase: PHASES.MEDIA_FEATURE,
          nodeId: media.nid,
          relatedNodeIds: [],
          title: 'Media queries unsupported',
          detail: `Client ignores @media entirely; "${media.condition}" was removed.`,
        }).id;
        removed.add(media);
      }
    }
    return;
  }
  for (const ref of rules) {
    for (const media of ref.path) {
      if (media.status === 'removed' || media.status === 'flattened') continue;
      const unknown = media.features.filter(
        (f) => f.feature !== 'prefers-color-scheme' && !config.media.supportedFeatures.includes(f.feature),
      );
      if (unknown.length) {
        media.status = 'removed';
        media.explanationId = add({
          kind: 'media_unsupported',
          severity: 'drop',
          phase: PHASES.MEDIA_FEATURE,
          nodeId: media.nid,
          relatedNodeIds: [],
          title: 'Unsupported media feature',
          detail: `Feature ${unknown.map((f) => f.raw).join(', ')} is not supported; "${media.condition}" was removed.`,
        }).id;
      }
    }
  }
}

// Phase 30: nested @media exceeding maxDepth is flattened (inner condition dropped).
function applyMediaNesting(
  sheets: {el: ElementNode; nodes: StyleNode[]}[],
  config: CapabilityConfig,
  add: Add,
) {
  const visit = (nodes: StyleNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind !== 'media') continue;
      if (node.status === 'removed') {
        visit(node.children, depth);
        continue;
      }
      if (depth > config.media.maxDepth && node.status !== 'flattened') {
        node.status = 'flattened';
        node.explanationId = add({
          kind: 'media_nested',
          severity: 'fallback',
          phase: PHASES.MEDIA_NESTING,
          nodeId: node.nid,
          relatedNodeIds: [],
          title: 'Nested media rule flattened',
          detail: `Nested @media depth ${depth} exceeds max ${config.media.maxDepth}; condition "${node.condition}" was dropped and contents were lifted into the parent.`,
        }).id;
        visit(node.children, depth); // lifted children stay at the parent depth
      } else {
        visit(node.children, depth + 1);
      }
    }
  };
  for (const sheet of sheets) visit(sheet.nodes, 1);
}

// Phase 40: client-specific dark override selectors ([data-ogsc], [data-ogsb], ...).
function applyDarkAttributeHooks(rules: RuleRef[], config: CapabilityConfig, add: Add) {
  if (config.darkMode.supported) return;
  for (const ref of rules) {
    if (!isLive(ref)) continue;
    const hook = config.darkMode.attributeHooks.find((h) => ref.rule.selector.includes(`[${h}]`));
    if (hook) {
      ref.rule.status = 'removed';
      ref.rule.explanationId = add({
        kind: 'dark_mode_attribute_hook',
        severity: 'drop',
        phase: PHASES.DARK_ATTRIBUTE_HOOK,
        nodeId: ref.rule.nid,
        relatedNodeIds: [],
        title: 'Dark-mode attribute hook unsupported',
        detail: `Selector "${ref.rule.selector}" targets [${hook}] dark overrides, which this client does not apply; rule removed.`,
      }).id;
    }
  }
}

// Phase 50: <meta name="color-scheme" content="light dark"> mechanism.
function applyDarkMeta(root: DocumentNode, config: CapabilityConfig, add: Add) {
  if (config.darkMode.supported && config.darkMode.mechanisms.includes('meta-color-scheme')) return;
  walk(root, (node) => {
    if (node.kind !== 'element' || node.tag !== 'meta') return;
    const name = node.attrs.find((a) => a.name === 'name')?.value?.toLowerCase();
    if (name !== 'color-scheme') return;
    const content = node.attrs.find((a) => a.name === 'content');
    if (!content || !/\bdark\b/.test(content.value ?? '')) return;
    node.status = 'removed';
    node.explanationId = add({
      kind: 'dark_mode_meta',
      severity: 'drop',
      phase: PHASES.DARK_META,
      nodeId: node.nid,
      relatedNodeIds: [],
      title: 'color-scheme dark meta unsupported',
      detail: 'The <meta name="color-scheme" content="...dark"> opt-in is not honored; meta removed.',
    }).id;
  });
}

// Phase 60: <picture> / <source type> image candidates.
function applyPictures(root: DocumentNode, config: CapabilityConfig, add: Add) {
  const supported = new Set(config.images.formats);
  walk(root, (node) => {
    if (node.kind !== 'element' || node.tag !== 'picture') return;
    const sources = node.children.filter(
      (c): c is ElementNode => c.kind === 'element' && c.tag === 'source',
    );
    if (sources.length === 0) return;
    const chosen: ElementNode[] = [];
    for (const source of sources) {
      const typeAttr = source.attrs.find((a) => a.name === 'type');
      const srcset = source.attrs.find((a) => a.name === 'srcset')?.value ?? '';
      const format = typeAttr?.value
        ? normalizeImageFormat(typeAttr.value)
        : imageFormatFromSrc(srcset.split(' ')[0] ?? '');
      if (!format) {
        source.status = 'removed';
        source.explanationId = add({
          kind: 'image_source_skipped',
          severity: 'note',
          phase: PHASES.PICTURE,
          nodeId: source.nid,
          relatedNodeIds: [],
          title: 'Image candidate has unknown format',
          detail: `Candidate "${srcset}" declares no recognizable image type; skipped.`,
        }).id;
        continue;
      }
      if (supported.has(format)) {
        chosen.push(source);
        if (chosen.length === 1) {
          source.explanationId = add({
            kind: 'image_candidate_selected',
            severity: 'note',
            phase: PHASES.PICTURE,
            nodeId: source.nid,
            relatedNodeIds: [node.nid],
            title: `Image candidate selected (${format})`,
            detail: `Client supports ${format}; this <source> wins the <picture> negotiation.`,
          }).id;
        } else {
          source.status = 'removed';
          source.explanationId = add({
            kind: 'image_source_skipped',
            severity: 'note',
            phase: PHASES.PICTURE,
            nodeId: source.nid,
            relatedNodeIds: [],
            title: `Image candidate ignored (${format})`,
            detail: `This ${format} source is listed after the first supported candidate; ignored.`,
          }).id;
        }
      } else {
        source.status = 'removed';
        source.explanationId = add({
          kind: 'image_source_skipped',
          severity: 'fallback',
          phase: PHASES.PICTURE,
          nodeId: source.nid,
          relatedNodeIds: [],
          title: `Image format unsupported (${format})`,
          detail: `Client does not support ${format}; <source> removed, fallback to earlier candidates / <img>.`,
        }).id;
      }
    }
    // One or more supported sources: keep the <picture>, only the winner remains.
    // None supported: unwrap <picture> so the <img> fallback renders directly.
    if (chosen.length === 0) {
      node.unwrap = true;
    }
  });
}

function valueUnsupported(decl: DeclNode, config: CapabilityConfig): string | null {
  const patterns = config.css.unsupportedValues[decl.prop] ?? [];
  const hit = patterns.find((p) => decl.value.toLowerCase().includes(p.toLowerCase()));
  return hit ?? null;
}

function propertyUnsupported(decl: DeclNode, config: CapabilityConfig): boolean {
  return config.css.unsupportedProperties.includes(decl.prop);
}

// Phase 70: unsupported values fall back to the nearest earlier supported
// declaration of the same property (author fallback), then profile fallback.
function applyValues(rules: RuleRef[], root: DocumentNode, config: CapabilityConfig, add: Add) {
  for (const ref of rules) {
    if (!isLive(ref)) continue;
    processDecls(ref.rule.decls, (decl, previous) => handleDeclValue(decl, previous, config, add, ref.rule.selector));
  }
  walk(root, (node) => {
    if (node.kind !== 'element' || !node.inline) return;
    processDecls(node.inline, (decl, previous) =>
      handleDeclValue(decl, previous, config, add, `inline style on <${node.tag}>`),
    );
  });
}

function processDecls(decls: DeclNode[], handle: (decl: DeclNode, previous: DeclNode[]) => void) {
  for (let i = 0; i < decls.length; i++) {
    handle(decls[i], decls.slice(0, i));
  }
}

function handleDeclValue(
  decl: DeclNode,
  previous: DeclNode[],
  config: CapabilityConfig,
  add: Add,
  context: string,
) {
  if (decl.status === 'removed') return;
  const badPattern = valueUnsupported(decl, config);
  if (!badPattern) return;
  const earlier = [...previous]
    .reverse()
    .find((d) => d.status !== 'removed' && d.prop === decl.prop && !valueUnsupported(d, config) && !propertyUnsupported(d, config));
  if (earlier) {
    const original = decl.value;
    decl.originalValue = original;
    decl.value = earlier.value;
    decl.status = 'fallback';
    decl.explanationId = add({
      kind: 'value_fallback',
      severity: 'fallback',
      phase: PHASES.VALUE,
      nodeId: decl.nid,
      relatedNodeIds: [earlier.nid],
      title: `Value fallback for ${decl.prop}`,
      detail: `"${original}" contains unsupported value pattern "${badPattern}" in ${context}; reusing earlier supported value "${earlier.value}".`,
    }).id;
  } else {
    const profileFallback = config.css.fallbackValues[decl.prop];
    if (profileFallback && !profileFallback.toLowerCase().includes(badPattern.toLowerCase())) {
      const original = decl.value;
      decl.originalValue = original;
      decl.value = profileFallback;
      decl.status = 'fallback';
      decl.explanationId = add({
        kind: 'value_fallback',
        severity: 'fallback',
        phase: PHASES.VALUE,
        nodeId: decl.nid,
        relatedNodeIds: [],
        title: `Profile fallback for ${decl.prop}`,
        detail: `"${original}" is unsupported in ${context} and no earlier author value exists; using profile fallback "${profileFallback}".`,
      }).id;
    } else {
      decl.status = 'removed';
      decl.explanationId = add({
        kind: 'value_unsupported',
        severity: 'drop',
        phase: PHASES.VALUE,
        nodeId: decl.nid,
        relatedNodeIds: [],
        title: `Unsupported value for ${decl.prop}`,
        detail: `"${decl.value}" contains unsupported value pattern "${badPattern}" in ${context}; declaration removed.`,
      }).id;
    }
  }
}

// Phase 80: properties the client drops outright.
function applyProperties(rules: RuleRef[], root: DocumentNode, config: CapabilityConfig, add: Add) {
  const remove = (decl: DeclNode, context: string) => {
    if (decl.status === 'removed') return;
    decl.status = 'removed';
    decl.explanationId = add({
      kind: 'property_unsupported',
      severity: 'drop',
      phase: PHASES.PROPERTY,
      nodeId: decl.nid,
      relatedNodeIds: [],
      title: `Unsupported property ${decl.prop}`,
      detail: `Client drops the ${decl.prop} property in ${context}; declaration removed.`,
    }).id;
  };
  for (const ref of rules) {
    if (!isLive(ref)) continue;
    for (const decl of ref.rule.decls) {
      if (propertyUnsupported(decl, config)) remove(decl, `rule ${ref.rule.selector}`);
    }
  }
  walk(root, (node) => {
    if (node.kind !== 'element' || !node.inline) return;
    for (const decl of node.inline) {
      if (propertyUnsupported(decl, config)) remove(decl, `inline style on <${node.tag}>`);
    }
  });
}

// Phase 90: cascade conflict — removing the winning declaration lets an
// earlier equal-specificity value resurge. Cascade groups are assembled in
// document order, so the result never depends on map/object iteration order.
function applyRuleConflicts(rules: RuleRef[], add: Add) {
  interface Entry {
    ref: RuleRef;
    decl: DeclNode;
  }
  // Same selector + property + enclosing media conditions = one cascade group.
  // (Specificity is equal by construction: the key is the full selector text.)
  const groups = new Map<string, Entry[]>();
  for (const ref of rules) {
    if (!isLive(ref)) continue;
    const pathKey = ref.path.map((m) => m.condition).join(' @ ');
    for (const decl of ref.rule.decls) {
      const key = `${ref.rule.selector}|${decl.prop}|${pathKey}`;
      const entries = groups.get(key) ?? [];
      entries.push({ref, decl});
      groups.set(key, entries);
    }
  }
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const winner = entries[entries.length - 1];
    const survivors = entries.filter((e) => e.decl.status !== 'removed');
    if (survivors.length === 0) continue;
    const effective = survivors[survivors.length - 1];
    // Resurge only when the cascade winner itself was dropped, exposing an
    // earlier value. Fallback rewrites on the winner keep the same winner.
    if (winner.decl.status !== 'removed' || effective === winner) continue;
    const selector = winner.ref.rule.selector;
    effective.decl.explanationId = add({
      kind: 'rule_conflict_resurge',
      severity: 'note',
      phase: PHASES.RULE_CONFLICT,
      nodeId: effective.decl.nid,
      relatedNodeIds: [winner.decl.nid],
      title: `Cascade winner changed for ${effective.decl.prop}`,
      detail: `"${winner.decl.prop}: ${winner.decl.value}" in the later rule for "${selector}" was removed; the earlier value "${effective.decl.value}" now applies.`,
    }).id;
  }
}

type Add = (e: Omit<Explanation, 'id'>) => Explanation;
