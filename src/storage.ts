export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;
}

/** Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds). */
export function createMemoryStorage(): StorageInterface {
  const map = new Map<string, { value: unknown; expires?: number }>();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        map.delete(key);
        return null;
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      map.set(key, {
        value,
        expires: opts?.ttl ? Date.now() + opts.ttl * 1000 : undefined,
      });
    },
  };
}

let _storage: StorageInterface | undefined;

/** Returns the current storage instance. If none has been set via `setStorage`, lazily initializes an in-memory storage. */
export function useStorage(): StorageInterface {
  if (!_storage) {
    _storage = createMemoryStorage();
  }
  return _storage;
}

/** Sets a custom storage implementation to be used by all cached functions. */
export function setStorage(storage: StorageInterface): void {
  _storage = storage;
}
