// Docs: @docs/10.api.md

export {
  defineCachedFunction,
  cachedFunction,
  resolveCacheKeys,
  invalidateCache,
  expireCache,
  type CachedFunction,
} from "./cache.ts";

export { defineCachedHandler } from "./http/index.ts";

export {
  type StorageInterface,
  type StorageOption,
  type MemoryStorageOptions,
  createMemoryStorage,
} from "./storage.ts";

export type {
  HTTPEvent,
  ServerRequest,
  EventHandler,
  CachedEventHandler,
  CacheEntry,
  CacheStatus,
  CacheOptions,
  CachedEventHandlerOptions,
  CacheConditions,
  ResponseCacheEntry,
} from "./types.ts";
