import { featureFlags } from '../backend/config';
import type { LanguageCode } from '../text/language';

/**
 * Downloaded on-device speech models live in a dedicated Cache Storage bucket, apart
 * from the app shell, so they can be listed, measured and removed individually.
 */
export const MODEL_CACHE = 'tinigturo-speech-models';

export interface ModelInfo {
  language: LanguageCode;
  url: string;
  label: string;
  license: string;
}

export function configuredModels(): ModelInfo[] {
  if (!featureFlags.voskEnabled) return [];
  const models: ModelInfo[] = [];
  if (featureFlags.voskModelUrlEn) {
    models.push({
      language: 'en',
      url: featureFlags.voskModelUrlEn,
      label: 'English speech model (Vosk small)',
      license: 'Apache-2.0 (Vosk models from alphacephei.com)',
    });
  }
  return models;
}

function cacheKey(language: LanguageCode): string {
  return `/__speech-model__/${language}`;
}

export async function isModelDownloaded(language: LanguageCode): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(MODEL_CACHE);
    return Boolean(await cache.match(cacheKey(language)));
  } catch {
    return false;
  }
}

export async function modelSize(language: LanguageCode): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(cacheKey(language));
  if (!response) return 0;
  return Number(response.headers.get('x-tinigturo-size') ?? 0);
}

/** Downloads a model with progress reporting. Requires an internet connection. */
export async function downloadModel(model: ModelInfo, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<number> {
  const response = await fetch(model.url, { signal, cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    if (total) onProgress(Math.min(0.99, received / total));
  }
  const blob = new Blob(parts as BlobPart[], { type: 'application/octet-stream' });
  const cache = await caches.open(MODEL_CACHE);
  await cache.put(
    cacheKey(model.language),
    new Response(blob, { headers: { 'content-type': 'application/octet-stream', 'x-tinigturo-size': String(blob.size), 'x-tinigturo-source': model.url } }),
  );
  onProgress(1);
  return blob.size;
}

export async function removeModel(language: LanguageCode): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(MODEL_CACHE);
  await cache.delete(cacheKey(language));
}

/** Object URL for the cached model, for engines that load a model from a URL. */
export async function modelObjectUrl(language: LanguageCode): Promise<string | null> {
  if (typeof caches === 'undefined') return null;
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(cacheKey(language));
  if (!response) return null;
  return URL.createObjectURL(await response.blob());
}
