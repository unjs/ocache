export interface StorageInterface {
  get<T = unknown>(key: string): T | null | Promise<T | null>;
  set<T = unknown>(key: string, value: T, opts?: { ttl?: number }): void | Promise<void>;
}

/** Creates an in-memory storage backed by a `Map` with optional TTL support (in seconds). */
export function createMemoryStorage(): StorageInterface {
  const map = new Map<string, { value: unknown; expires?: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expires && Date.now() > entry.expires) {
        map.delete(key);
        _clearTimer(timers, key);
        return null;
      }
      return entry.value as any;
    },
    set(key, value, opts) {
      _clearTimer(timers, key);
      if (value === null || value === undefined) {
        map.delete(key);
        return;
      }
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
