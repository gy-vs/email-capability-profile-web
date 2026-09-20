// Shared API/domain types for the client-capability workbench.

export const CONFIG_SCHEMA_VERSION = 1;

export type DarkMechanism =
  | 'prefers-color-scheme'
  | 'meta-color-scheme'
  | 'data-attribute';

/**
 * Versioned declaration of what an email client supports.
 * Every stored revision keeps an immutable snapshot of this object.
 */
export interface CapabilityConfig {
  schemaVersion: 1;
  css: {
    /** Properties the client drops entirely, e.g. ["gap", "text-shadow"]. */
    unsupportedProperties: string[];
    /** Property -> value substrings that mark a value unsupported, e.g. { color: ["color-mix("] }. */
    unsupportedValues: Record<string, string[]>;
    /** Profile-provided static fallbacks used when no earlier author declaration exists. */
    fallbackValues: Record<string, string>;
  };
  media: {
    supported: boolean;
    /** Allowed nesting depth of @media rules. 0 disallows them, 1 allows only top-level ones. */
    maxDepth: number;
    /** Supported media feature names besides prefers-color-scheme, e.g. width, min-width, hover. */
    supportedFeatures: string[];
  };
  images: {
    /** Supported image formats: jpeg, png, gif, webp, avif, apng ... */
    formats: string[];
  };
  darkMode: {
    supported: boolean;
    mechanisms: DarkMechanism[];
    /** Attribute hook names (without brackets) used by client-specific dark overrides. */
    attributeHooks: string[];
  };
}

// --- Parsed template tree. Every node keeps a stable nid across transforms. ---

export interface AttrNode {
  nid: string;
  name: string;
  value: string | null;
}

export interface DeclNode {
  nid: string;
  kind: 'decl';
  prop: string;
  value: string;
  important: boolean;
  /** kept (default) | removed by a rule | value replaced in place. */
  status?: 'kept' | 'removed' | 'fallback';
  /** Present when status === 'fallback'. */
  originalValue?: string;
  explanationId?: string;
}

export interface MediaTerm {
  feature: string;
  raw: string;
}

export interface RuleNode {
  nid: string;
  kind: 'rule';
  selector: string;
  decls: DeclNode[];
  status?: 'kept' | 'removed';
  explanationId?: string;
}

export interface MediaNode {
  nid: string;
  kind: 'media';
  condition: string;
  features: MediaTerm[];
  children: StyleNode[];
  /** kept (default) | removed wholesale | unwrapped so its children lift into the parent. */
  status?: 'kept' | 'removed' | 'flattened';
  explanationId?: string;
}

export type StyleNode = RuleNode | MediaNode;

export interface AttrChange {
  attrNid: string;
  name: string;
  from: string | null;
  to: string;
}

export interface ElementNode {
  nid: string;
  kind: 'element';
  tag: string;
  attrs: AttrNode[];
  children: DomNode[];
  /** Parsed <style> content, attached to <style> elements. */
  sheet?: StyleNode[];
  /** Parsed declarations of a style="..." attribute. */
  inline?: DeclNode[];
  /** removed = dropped from output; a removed <picture> with unwrap keeps its children. */
  status?: 'kept' | 'removed';
  unwrap?: boolean;
  /** Attribute nids dropped by a degradation rule. */
  removedAttrNids?: string[];
  attrChanges?: AttrChange[];
  explanationId?: string;
}

export interface TextNode {
  nid: string;
  kind: 'text';
  text: string;
}

export interface CommentNode {
  nid: string;
  kind: 'comment';
  text: string;
}

export interface DoctypeNode {
  nid: string;
  kind: 'doctype';
  text: string;
}

export interface DocumentNode {
  nid: string;
  kind: 'document';
  children: DomNode[];
}

export type DomNode =
  | ElementNode
  | TextNode
  | CommentNode
  | DoctypeNode
  | DocumentNode;

// --- Transform result ---

export type ExplanationKind =
  | 'property_unsupported'
  | 'value_unsupported'
  | 'value_fallback'
  | 'media_unsupported'
  | 'media_nested'
  | 'dark_mode_media'
  | 'dark_mode_meta'
  | 'dark_mode_attribute_hook'
  | 'image_source_skipped'
  | 'image_candidate_selected'
  | 'rule_conflict_resurge';

export type Severity = 'drop' | 'fallback' | 'note';

export interface Explanation {
  id: string;
  kind: ExplanationKind;
  severity: Severity;
  /** Primary node the degradation applies to. Stable nid from the parse tree. */
  nodeId: string;
  /** Other participating nodes (earlier fallback declaration, resurged winner, ...). */
  relatedNodeIds: string[];
  title: string;
  detail: string;
  /** Fixed pipeline phase; explanations are ordered deterministically by (phase, node). */
  phase: number;
}

export interface TransformStats {
  total: number;
  drops: number;
  fallbacks: number;
  notes: number;
}

export interface TransformResult {
  tree: DocumentNode;
  originalHtml: string;
  outputHtml: string;
  explanations: Explanation[];
  stats: TransformStats;
}

// --- API DTOs ---

export interface TemplateSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}

export interface TemplateRow extends TemplateSummary {
  content: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}

export interface ProfileDetail extends ProfileSummary {
  config: CapabilityConfig;
}

export interface ProfileSnapshot {
  profileId: string;
  revision: number;
  name: string;
  config: CapabilityConfig;
  createdAt: string;
}

export interface PreviewSummary {
  id: string;
  templateId: string;
  templateName: string;
  templateRevision: number;
  profileId: string;
  profileName: string;
  profileRevision: number;
  profileExists: boolean;
  createdAt: string;
}

export interface PreviewRecord extends PreviewSummary {
  contentSnapshot: string;
  profile: {
    profileId: string;
    revision: number;
    name: string;
    config: CapabilityConfig;
    createdAt: string;
  };
  result: TransformResult;
}
