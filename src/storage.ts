export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;
}

export interface MemoryStorageOptions {
  /**
   * Maximum number of entries to keep. When exceeded, the least-recently-used
   * entries are evicted. Unset (or `0`) means unbounded (the previous default).
   */
  maxSize?: number;
}

/** Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds) and optional LRU eviction. */
export function createMemoryStorage(opts: MemoryStorageOptions = {}): StorageInterface {
  const maxSize = opts.maxSize && opts.maxSize > 0 ? opts.maxSize : undefined;
  const map = new Map<string, { value: unknown; expires?: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function _delete(key: string) {
    map.delete(key);
    _clearTimer(timers, key);
  }

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        _delete(key);
        return null;
      }
      // Mark as most-recently-used by reinserting (Map preserves insertion order).
      if (maxSize) {
        map.delete(key);
        map.set(key, entry);
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      _clearTimer(timers, key);
      if (value === null || value === undefined) {
        map.delete(key);
        return;
      }
      // Delete first so reinsertion moves the key to the most-recent position.
      map.delete(key);
      const ttlMs = opts?.ttl ? opts.ttl * 1000 : undefined;
      map.set(key, {
        value,
        expires: ttlMs ? Date.now() + ttlMs : undefined,
      });
      if (ttlMs) {
        const timer = setTimeout(() => {
          map.delete(key);
          timers.delete(key);
        }, ttlMs);
        // Allow the process to exit even if timers are pending
        if (timer && typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
        timers.set(key, timer);
      }
      // Evict least-recently-used entries once over the ceiling.
      if (maxSize) {
        while (map.size > maxSize) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          _delete(oldest);
        }
      }
    },
  };
}

function _clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, key: string) {
  const existing = timers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(key);
  }
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
