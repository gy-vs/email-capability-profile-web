// AST 节点类型。HTML 与 CSS 的每个节点在解析时即获得稳定 id，
// 转换阶段只允许打 detached 标记或移动节点，id 永不重新分配。

export interface MediaFeature {
  /** 归一化后的原文，如 (max-width: 600px) */
  raw: string;
  /** 特性名，小写，如 max-width / prefers-color-scheme / hover */
  name: string;
  /** 特性值，小写，如 600px / dark */
  value: string;
  kind: 'width' | 'dark' | 'other';
}

interface CssBase {
  id: string;
  detached: boolean;
  parent: CssMedia | null;
  /** 所属 <style> 元素 id；内联样式为所在元素 id（scope 用） */
  ownerId: string;
}

export interface CssDeclaration extends CssBase {
  kind: 'declaration';
  property: string;
  value: string;
  important: boolean;
}

export interface CssRule extends CssBase {
  kind: 'rule';
  selector: string;
  declarations: CssDeclaration[];
}

export interface CssMedia extends CssBase {
  kind: 'media';
  /** 归一化查询串 */
  query: string;
  features: MediaFeature[];
  children: CssNode[];
  /** 由嵌套媒体规则合并（flatten）而来 */
  mergedFromNested: boolean;
}

/** 其它 @ 规则（@supports / @keyframes 等），原样保留，不参与降级 */
export interface CssOtherAt extends CssBase {
  kind: 'other-at';
  name: string;
  prelude: string;
  body: string;
}

export type CssNode = CssRule | CssMedia | CssOtherAt;

export interface HtmlAttr {
  name: string;
  value: string | null;
}

export interface HtmlElement {
  kind: 'element';
  id: string;
  tag: string;
  attrs: HtmlAttr[];
  children: HtmlNode[];
  parent: HtmlElement | null;
  detached: boolean;
  void: boolean;
  rawText: boolean;
  /** 内联 style 声明，解析后与 attrs 中的 style 对应 */
  style: CssDeclaration[] | null;
  /** <style> 元素内的样式表 */
  sheet: CssNode[] | null;
}

export interface HtmlText {
  kind: 'text';
  id: string;
  value: string;
  parent: HtmlElement | null;
  detached: boolean;
}

export type HtmlNode = HtmlElement | HtmlText;

export interface HtmlDoc {
  nodes: HtmlNode[];
  /** id -> 节点（含 CSS 节点），便于解释条目反查 */
  index: Map<string, CssNode | CssDeclaration | HtmlNode>;
}

// ---- 能力配置（版本化） ----

export interface ValueFallback {
  /** 不支持的声明值，如 flex */
  value: string;
  /** 回退值，空串表示无回退（删除声明） */
  fallback: string;
}

export interface CapabilityProfile {
  /** 配置 schema 版本，由服务端戳记 */
  version: string;
  client: string;
  css: {
    unsupportedProperties: string[];
    /** 受支持的媒体特性名：width 代表 min-width/max-width/width，其余用真名如 hover */
    supportedMediaFeatures: string[];
    /** 是否支持嵌套 @media */
    mediaNested: boolean;
    /** 值级回退表，按属性匹配 */
    valueFallbacks: Array<{ property: string } & ValueFallback>;
  };
  images: {
    supportedFormats: string[];
    /** 无候选可用时，把地址后缀改写为该格式，如 jpg */
    fallbackFormat: string;
    /** 是否支持 <picture> 候选 */
    picture: boolean;
  };
  darkMode: boolean;
}
