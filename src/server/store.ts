import type {CapabilityProfile} from './engine/ast';

export interface TemplateRow {
  id: string;
  name: string;
  revision: number;
  content: string;
  updatedAt: string;
}

export interface ProfileRevision {
  revision: number;
  config: CapabilityProfile;
  createdAt: string;
}

export interface ProfileRow {
  id: string;
  name: string;
  /** 当前 revision（= history 最后一条） */
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  history: ProfileRevision[];
}

const now = () => new Date().toISOString();
export const CONFIG_VERSION = '1.0';

export const seedTemplates: TemplateRow[] = [
  {
    id: 'alpha',
    name: '产品周报邮件',
    revision: 4,
    content: `<style>
  body { margin: 0; padding: 16px; }
  .card { display: flex; gap: 16px; padding: 20px; background: #ffffff; }
  .title { color: #111111; }
  @media (max-width: 600px) {
    .card { padding: 12px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1b1f24; }
      .title { color: #f2f2f2; }
    }
  }
  @media (hover: hover) {
    .title { text-decoration: underline; }
  }
</style>
<div class="card">
  <picture>
    <source type="image/avif" srcset="https://example.com/hero.avif">
    <source type="image/webp" srcset="https://example.com/hero.webp">
    <img src="https://example.com/hero.png" alt="本周封面" width="320">
  </picture>
  <h1 class="title" style="display: flex; gap: 8px; color: #111111;">本周动态</h1>
</div>
`,
    updatedAt: new Date(0).toISOString(),
  },
  {
    id: 'beta',
    name: '验证码通知',
    revision: 2,
    content: `<div style="font-family: sans-serif; padding: 24px;">
  <p style="display: grid; margin: 0 0 12px;">您的验证码是 <strong>482913</strong></p>
  <img src="https://example.com/badge.avif" alt="badge">
</div>
`,
    updatedAt: new Date(1000).toISOString(),
  },
];

const gmailAndroid: CapabilityProfile = {
  version: CONFIG_VERSION,
  client: 'Gmail App · Android',
  css: {
    unsupportedProperties: ['gap', 'grid-template-columns', 'border-radius'],
    supportedMediaFeatures: ['width'],
    mediaNested: false,
    valueFallbacks: [
      {property: 'display', value: 'flex', fallback: 'block'},
      {property: 'display', value: 'grid', fallback: 'block'},
    ],
  },
  images: {supportedFormats: ['jpg', 'png', 'gif'], fallbackFormat: 'jpg', picture: false},
  darkMode: false,
};

const appleMail: CapabilityProfile = {
  version: CONFIG_VERSION,
  client: 'Apple Mail · iOS 17',
  css: {
    unsupportedProperties: [],
    supportedMediaFeatures: ['width', 'hover'],
    mediaNested: true,
    valueFallbacks: [],
  },
  images: {supportedFormats: ['jpg', 'png', 'gif', 'webp', 'avif'], fallbackFormat: 'jpg', picture: true},
  darkMode: true,
};

const outlookCom: CapabilityProfile = {
  version: CONFIG_VERSION,
  client: 'Outlook.com · Web',
  css: {
    unsupportedProperties: ['gap', 'float', 'position', 'background-image', 'border-radius'],
    supportedMediaFeatures: [],
    mediaNested: false,
    valueFallbacks: [
      {property: 'display', value: 'flex', fallback: 'block'},
      {property: 'display', value: 'grid', fallback: ''},
    ],
  },
  images: {supportedFormats: ['jpg', 'png', 'gif'], fallbackFormat: '', picture: false},
  darkMode: false,
};

export const seedProfiles: ProfileRow[] = [
  {
    id: 'gmail-android',
    name: 'Gmail Android',
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    deletedAt: null,
    history: [{revision: 1, config: gmailAndroid, createdAt: new Date(0).toISOString()}],
  },
  {
    id: 'apple-mail',
    name: 'Apple Mail',
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    deletedAt: null,
    history: [{revision: 1, config: appleMail, createdAt: new Date(0).toISOString()}],
  },
  {
    id: 'outlook-com',
    name: 'Outlook.com',
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    deletedAt: null,
    history: [{revision: 1, config: outlookCom, createdAt: new Date(0).toISOString()}],
  },
];

export class Store {
  templates: TemplateRow[];
  profiles: ProfileRow[];

  constructor() {
    // 深拷贝种子，保证各 app 实例（测试）互不影响
    this.templates = seedTemplates.map(t => ({...t}));
    this.profiles = seedProfiles.map(p => ({...p, history: p.history.map(h => ({...h, config: cloneConfig(h.config)}))}));
  }

  getTemplate(id: string) { return this.templates.find(t => t.id === id); }

  saveTemplate(id: string, content: string, revision: number): {ok: true; row: TemplateRow} | {ok: false; status: number; error: string; current?: TemplateRow} {
    const row = this.getTemplate(id);
    if (!row) return {ok: false, status: 404, error: 'not_found'};
    if (revision !== row.revision) return {ok: false, status: 409, error: 'revision_conflict', current: row};
    row.content = content;
    row.revision += 1;
    row.updatedAt = now();
    return {ok: true, row};
  }

  getProfile(id: string) { return this.profiles.find(p => p.id === id); }

  /** 取历史快照；已删除的 profile 旧 revision 仍然可读 */
  getProfileRevision(id: string, revision: number): ProfileRevision | undefined {
    const row = this.getProfile(id);
    return row?.history.find(h => h.revision === revision);
  }

  saveProfile(id: string, name: string, config: CapabilityProfile, baseRevision: number) {
    let row = this.getProfile(id);
    if (row) {
      if (row.deletedAt) return {ok: false as const, status: 409, error: 'profile_deleted'};
      if (baseRevision !== row.revision) return {ok: false as const, status: 409, error: 'revision_conflict', current: row};
    } else {
      row = {id, name, revision: 0, createdAt: now(), updatedAt: now(), deletedAt: null, history: []};
      this.profiles.push(row);
    }
    const stamped: CapabilityProfile = {...cloneConfig(config), version: CONFIG_VERSION};
    row.revision += 1;
    row.name = name;
    row.history.push({revision: row.revision, config: stamped, createdAt: now()});
    row.updatedAt = now();
    return {ok: true as const, row};
  }

  deleteProfile(id: string): {ok: true; row: ProfileRow} | {ok: false; status: number; error: string} {
    const row = this.getProfile(id);
    if (!row) return {ok: false, status: 404, error: 'not_found'};
    if (row.deletedAt) return {ok: false, status: 404, error: 'already_deleted'};
    row.deletedAt = now();
    return {ok: true, row};
  }
}

export function cloneConfig(c: CapabilityProfile): CapabilityProfile {
  return {
    version: c.version,
    client: c.client,
    css: {
      unsupportedProperties: [...c.css.unsupportedProperties],
      supportedMediaFeatures: [...c.css.supportedMediaFeatures],
      mediaNested: c.css.mediaNested,
      valueFallbacks: c.css.valueFallbacks.map(f => ({...f})),
    },
    images: {
      supportedFormats: [...c.images.supportedFormats],
      fallbackFormat: c.images.fallbackFormat,
      picture: c.images.picture,
    },
    darkMode: c.darkMode,
  };
}

/** 校验来自请求体的能力配置；返回清洗后的配置或错误信息 */
export function validateConfig(input: unknown): {ok: true; config: Omit<CapabilityProfile, 'version'>} | {ok: false; error: string} {
  if (typeof input !== 'object' || input === null) return {ok: false, error: 'config_required'};
  const c = input as Record<string, unknown>;
  if (typeof c.client !== 'string' || !c.client.trim()) return {ok: false, error: 'client_required'};
  const css = c.css as Record<string, unknown> | undefined;
  const images = c.images as Record<string, unknown> | undefined;
  if (!css || !images) return {ok: false, error: 'css_images_required'};
  const strArr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : null;
  const unsupportedProperties = strArr(css.unsupportedProperties);
  const supportedMediaFeatures = strArr(css.supportedMediaFeatures);
  const supportedFormats = strArr(images.supportedFormats);
  if (!unsupportedProperties || !supportedMediaFeatures || !supportedFormats) return {ok: false, error: 'string_arrays_required'};
  if (typeof css.mediaNested !== 'boolean' || typeof c.darkMode !== 'boolean' || typeof images.picture !== 'boolean') {
    return {ok: false, error: 'booleans_required'};
  }
  if (typeof images.fallbackFormat !== 'string') return {ok:false, error:'fallback_format_required'};
  if (!Array.isArray(css.valueFallbacks)) return {ok: false, error: 'value_fallbacks_required'};
  const valueFallbacks: CapabilityProfile['css']['valueFallbacks'] = [];
  for (const f of css.valueFallbacks as unknown[]) {
    if (typeof f !== 'object' || f === null) return {ok: false, error: 'fallback_entry_invalid'};
    const e = f as Record<string, unknown>;
    if (typeof e.property !== 'string' || typeof e.value !== 'string' || typeof e.fallback !== 'string') {
      return {ok: false, error: 'fallback_entry_invalid'};
    }
    valueFallbacks.push({property: e.property, value: e.value, fallback: e.fallback});
  }
  return {
    ok: true,
    config: {
      client: c.client,
      css: {
        unsupportedProperties: unsupportedProperties.map(s => s.toLowerCase()),
        supportedMediaFeatures: supportedMediaFeatures.map(s => s.toLowerCase()),
        mediaNested: css.mediaNested,
        valueFallbacks: valueFallbacks.map(f => ({property: f.property.toLowerCase(), value: f.value, fallback: f.fallback})),
      },
      images: {
        supportedFormats: supportedFormats.map(s => s.toLowerCase().replace('jpeg', 'jpg')),
        fallbackFormat: images.fallbackFormat.toLowerCase(),
        picture: images.picture,
      },
      darkMode: c.darkMode,
    },
  };
}
