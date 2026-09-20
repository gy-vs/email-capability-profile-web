// 与服务端 ast.ts 对应的客户端类型（保持结构同步）
export interface CapabilityProfile {
  version: string;
  client: string;
  css: {
    unsupportedProperties: string[];
    supportedMediaFeatures: string[];
    mediaNested: boolean;
    valueFallbacks: Array<{property: string; value: string; fallback: string}>;
  };
  images: {supportedFormats: string[]; fallbackFormat: string; picture: boolean};
  darkMode: boolean;
}

export interface TemplateSummary {id: string; name: string; revision: number; updatedAt: string}
export interface TemplateRow extends TemplateSummary {content: string}
export interface ProfileSummary {id: string; name: string; revision: number; updatedAt: string; deletedAt: string | null}
export interface ProfileDetail extends ProfileSummary {config: CapabilityProfile}

export interface Range {start: number; end: number}
export interface ViewPayload {
  html: string;
  ranges: Record<string, Range>;
  sheetRanges: Record<string, {sheetId: string; ranges: Record<string, Range>}>;
  inlineRanges: Record<string, Record<string, Range>>;
}
export interface Explanation {
  id: string;
  code: string;
  severity: 'drop' | 'fallback' | 'info' | 'warning';
  message: string;
  targetId: string;
  location: string;
  selectors: string[];
  survives: boolean;
  conflictsWith?: string;
}
export interface PreviewResponse {
  templateId: string;
  templateRevision: number;
  profile: {id: string; name: string; revision: number; deletedAt: string | null};
  configVersion: string;
  snapshot: boolean;
  original: ViewPayload;
  transformed: ViewPayload;
  explanations: Explanation[];
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), {status: r.status, body: await r.json().catch(() => null)});
  return r.json() as Promise<T>;
}

export const api = {
  templates: () => fetch('/api/templates').then(r => jsonOrThrow<TemplateSummary[]>(r)),
  template: (id: string) => fetch(`/api/templates/${id}`).then(r => jsonOrThrow<TemplateRow>(r)),
  saveTemplate: (id: string, content: string, revision: number) =>
    fetch(`/api/templates/${id}`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({content, revision})}).then(r => jsonOrThrow<TemplateRow>(r)),
  profiles: () => fetch('/api/profiles').then(r => jsonOrThrow<ProfileSummary[]>(r)),
  profile: (id: string, revision?: number) =>
    fetch(`/api/profiles/${id}${revision != null ? `?revision=${revision}` : ''}`).then(r => jsonOrThrow<ProfileDetail>(r)),
  saveProfile: (id: string, name: string, config: Omit<CapabilityProfile, 'version'>, revision: number) =>
    fetch(`/api/profiles/${id}`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({name, config, revision})}).then(r => jsonOrThrow<ProfileSummary>(r)),
  deleteProfile: (id: string) =>
    fetch(`/api/profiles/${id}`, {method: 'DELETE'}).then(r => jsonOrThrow<ProfileSummary>(r)),
  preview: (templateId: string, content: string | null, profileId: string, profileRevision: number) =>
    fetch(`/api/templates/${templateId}/preview`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({profileId, profileRevision, ...(content != null ? {content} : {})}),
    }).then(r => jsonOrThrow<PreviewResponse>(r)),
};
