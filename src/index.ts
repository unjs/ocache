export {
  defineCachedFunction,
  cachedFunction,
  resolveCacheKeys,
  invalidateCache,
  expireCache,
  type CachedFunction,
} from "./cache.ts";

export { defineCachedHandler } from "./http.ts";

export {
  type StorageInterface,
  type MemoryStorageOptions,
  DEFAULT_MEMORY_MAX_SIZE,
  createMemoryStorage,
  useStorage,
  setStorage,
} from "./storage.ts";

export type {
  HTTPEvent,
  ServerRequest,
  EventHandler,
  CacheEntry,
  CacheOptions,
  CachedEventHandlerOptions,
  CacheConditions,
  ResponseCacheEntry,
} from "./types.ts";
