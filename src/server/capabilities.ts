import {CONFIG_SCHEMA_VERSION, type CapabilityConfig, type DarkMechanism} from '../shared/types';

export const SUPPORTED_IMAGE_FORMATS = ['jpeg', 'png', 'gif', 'webp', 'avif', 'apng'];
const VALID_MECHANISMS: DarkMechanism[] = ['prefers-color-scheme', 'meta-color-scheme', 'data-attribute'];

/** Normalize an image format token from type attributes / file extensions. */
export function normalizeImageFormat(token: string): string {
  let value = token.trim().toLowerCase();
  if (value.startsWith('image/')) value = value.slice('image/'.length);
  if (value === 'jpg' || value === 'jpeg') return 'jpeg';
  return value;
}

export function imageFormatFromSrc(src: string): string {
  const match = src.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return match ? normalizeImageFormat(match[1]) : '';
}

/**
 * Validate a config coming from the API. Unknown/extra keys are ignored,
 * malformed values produce a deterministic list of error messages.
 */
export function validateConfig(input: unknown): {config?: CapabilityConfig; errors: string[]} {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return {errors: ['config must be an object']};
  const raw = input as Record<string, unknown>;

  const asStringArray = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return [];
    }
    return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  };

  const cssRaw = (raw.css ?? {}) as Record<string, unknown>;
  const unsupportedProperties = asStringArray(cssRaw.unsupportedProperties, 'css.unsupportedProperties');
  const fallbackValues: Record<string, string> = {};
  if (cssRaw.fallbackValues && typeof cssRaw.fallbackValues === 'object') {
    for (const [key, value] of Object.entries(cssRaw.fallbackValues as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) fallbackValues[key.toLowerCase()] = value.trim();
    }
  }
  const unsupportedValues: Record<string, string[]> = {};
  if (cssRaw.unsupportedValues && typeof cssRaw.unsupportedValues === 'object') {
    for (const [key, value] of Object.entries(cssRaw.unsupportedValues as Record<string, unknown>)) {
      unsupportedValues[key.toLowerCase()] = asStringArray(value, `css.unsupportedValues.${key}`);
    }
  }

  const mediaRaw = (raw.media ?? {}) as Record<string, unknown>;
  const mediaSupported = mediaRaw.supported !== false;
  const maxDepthRaw = Number(mediaRaw.maxDepth ?? 1);
  if (!Number.isInteger(maxDepthRaw) || maxDepthRaw < 0 || maxDepthRaw > 5) {
    errors.push('media.maxDepth must be an integer between 0 and 5');
  }
  const maxDepth = Number.isInteger(maxDepthRaw) && maxDepthRaw >= 0 ? maxDepthRaw : 1;
  const supportedFeatures = asStringArray(mediaRaw.supportedFeatures ?? ['width'], 'media.supportedFeatures');

  const imagesRaw = (raw.images ?? {}) as Record<string, unknown>;
  const formats = [...new Set(asStringArray(imagesRaw.formats ?? ['jpeg'], 'images.formats').map(normalizeImageFormat))];
  for (const format of formats) {
    if (!SUPPORTED_IMAGE_FORMATS.includes(format)) errors.push(`images.formats: unknown format "${format}"`);
  }

  const darkRaw = (raw.darkMode ?? {}) as Record<string, unknown>;
  const darkSupported = darkRaw.supported === true;
  const mechanisms = asStringArray(darkRaw.mechanisms ?? [], 'darkMode.mechanisms').filter((m) => {
    if (!VALID_MECHANISMS.includes(m as DarkMechanism)) {
      errors.push(`darkMode.mechanisms: unknown mechanism "${m}"`);
      return false;
    }
    return true;
  }) as DarkMechanism[];
  const attributeHooks = asStringArray(darkRaw.attributeHooks ?? [], 'darkMode.attributeHooks');

  if (errors.length) return {errors};
  return {
    config: {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      css: {unsupportedProperties, unsupportedValues, fallbackValues},
      media: {supported: mediaSupported, maxDepth, supportedFeatures},
      images: {formats: formats.length ? formats : ['jpeg']},
      darkMode: {supported: darkSupported, mechanisms, attributeHooks},
    },
    errors,
  };
}

// --- Preset clients ---

export const PRESET_CONFIGS: Record<string, CapabilityConfig> = {
  gmail: {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    css: {
      unsupportedProperties: ['gap', 'flex', 'grid-template-columns', 'aspect-ratio', 'mix-blend-mode', 'text-shadow'],
      unsupportedValues: {
        color: ['color-mix(', 'lab(', 'oklch(', 'oklab(', 'light-dark('],
        background: ['color-mix('],
        display: ['grid', 'subgrid'],
      },
      fallbackValues: {display: 'block'},
    },
    media: {supported: true, maxDepth: 1, supportedFeatures: ['width', 'min-width', 'max-width', 'hover']},
    images: {formats: ['jpeg', 'png', 'gif', 'webp']},
    darkMode: {
      supported: true,
      mechanisms: ['prefers-color-scheme', 'meta-color-scheme', 'data-attribute'],
      attributeHooks: ['data-ogsc', 'data-ogsb'],
    },
  },
  outlook: {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    css: {
      unsupportedProperties: ['gap', 'flex', 'display', 'float', 'margin', 'text-shadow', 'aspect-ratio', 'border-radius'],
      unsupportedValues: {
        color: ['color-mix(', 'lab(', 'oklch(', 'oklab(', 'light-dark('],
        position: ['sticky'],
      },
      fallbackValues: {},
    },
    media: {supported: false, maxDepth: 0, supportedFeatures: []},
    images: {formats: ['jpeg', 'png', 'gif']},
    darkMode: {supported: false, mechanisms: [], attributeHooks: []},
  },
  modern: {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    css: {unsupportedProperties: [], unsupportedValues: {}, fallbackValues: {}},
    media: {
      supported: true,
      maxDepth: 3,
      supportedFeatures: ['width', 'min-width', 'max-width', 'hover', 'pointer', 'orientation'],
    },
    images: {formats: ['jpeg', 'png', 'gif', 'webp', 'avif', 'apng']},
    darkMode: {
      supported: true,
      mechanisms: ['prefers-color-scheme', 'meta-color-scheme', 'data-attribute'],
      attributeHooks: ['data-theme'],
    },
  },
};
