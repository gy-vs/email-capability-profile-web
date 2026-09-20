import type {
  CapabilityConfig,
  PreviewRecord,
  PreviewSummary,
  ProfileDetail,
  ProfileSnapshot,
  ProfileSummary,
  TemplateRow,
  TemplateSummary,
} from '../shared/types';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<{ok: boolean; status: number; body: T}> {
  const response = await fetch(url, {
    headers: init?.body ? {'content-type': 'application/json'} : undefined,
    ...init,
  });
  const body = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return {ok: response.ok, status: response.status, body};
}

export const api = {
  listTemplates: () => jsonFetch<TemplateSummary[]>('/api/templates').then((r) => r.body),
  getTemplate: (id: string) => jsonFetch<TemplateRow>(`/api/templates/${id}`).then((r) => r.body),
  saveTemplate: (id: string, content: string, revision: number) =>
    jsonFetch<TemplateRow>(`/api/templates/${id}`, {method: 'PUT', body: JSON.stringify({content, revision})}),

  listProfiles: () => jsonFetch<ProfileSummary[]>('/api/profiles').then((r) => r.body),
  getProfile: (id: string) => jsonFetch<ProfileDetail>(`/api/profiles/${id}`),
  createProfile: (id: string, name: string, config: CapabilityConfig) =>
    jsonFetch<ProfileDetail>('/api/profiles', {method: 'POST', body: JSON.stringify({id, name, config})}),
  saveProfile: (id: string, name: string, config: CapabilityConfig, revision: number) =>
    jsonFetch<ProfileDetail>(`/api/profiles/${id}`, {method: 'PUT', body: JSON.stringify({name, config, revision})}),
  deleteProfile: (id: string) => jsonFetch<void>(`/api/profiles/${id}`, {method: 'DELETE'}),
  listRevisions: (id: string) => jsonFetch<Omit<ProfileSnapshot, 'config'>[]>(`/api/profiles/${id}/revisions`).then((r) => r.body),

  runTransform: (payload: {
    templateId: string;
    profileId: string;
    profileRevision: number;
    useDraft?: boolean;
    content?: string;
  }) => jsonFetch<PreviewRecord>('/api/transform', {method: 'POST', body: JSON.stringify(payload)}),
  listPreviews: () => jsonFetch<PreviewSummary[]>('/api/previews').then((r) => r.body),
  getPreview: (id: string) => jsonFetch<PreviewRecord>(`/api/previews/${id}`).then((r) => r.body),
};
