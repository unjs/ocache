# `http/key.ts` — cache key + revalidation helpers

**Key = resource identity + method component.** `resolveKey` produces the method-independent resource part. By default, it uses the URL origin, path, `varies` header values, and allowlisted cookies. A caller can replace this with `getKey`. `methodKey` prefixes the method.

## Handler `name`

Call `resolveName(opts.name, handler)` **before** the `defaultHandlerOptions()` merge. This is the same rule and shared internal that `defineCachedFunction` uses. See `.agents/cache.md`. `config.ts` keeps separate defaults because only the HTTP layer has `cacheStatusHeader`. The defaults have different names so neither module can import the other's defaults.

Merging first made `opts.name` always equal `"_"`. Therefore, **every** handler used the same name. Two handlers could then collide when they shared a `storage`, as `types.ts` recommends, and could see the same path. If their source was identical, their integrity was also identical and one handler served the other handler's response. This was a cross-handler data leak. If their source differed, each read failed the other entry's integrity check and the cache had a 0% hit rate. The fix changes keys, so every handler entry became cold once. `hash(handler)` sees source only. Handlers created by one factory can share a name and integrity value. Pass an explicit `name` for each instance.

## Method component

GET is the implicit default and has no component. Every other cacheable method adds `<METHOD>:`. Currently, the only such method is `HEAD:`. `cacheableMethods` is the enumerable counterpart to the method check in `shouldBypassCache`. Adding another cacheable method requires one list change, not a key redesign.

This fixes h3#1524 audit finding #3. GET and HEAD shared an entry. A specification-compliant host `toResponse` removes the body from a HEAD response. `serialize` then stored that body-less `Response`. One anonymous `HEAD /page` could store a zero-byte body, synthesized `max-age=N`, and a weak etag for the empty body. Every GET during the TTL then received a blank 200 that browsers and CDNs cached and revalidated.

Apply the method component to **both** key branches. A custom `getKey` defines content identity, but ocache must still prevent method collisions. Escape both branches and the `name` before them. No segment may create a false `<METHOD>:` component. GET keys are byte-identical to their earlier values, so existing GET entries remain warm. Each method and resource now requires one origin request per TTL. Non-cacheable methods never call `getKey`.

## Request authority in the hashed component

`_hashedPath = ${_pathname}.${hash([authority(_url), _path])}`.

Without authority, one handler instance that serves several hostnames stores one entry per path for all hosts. This is a normal nitro/h3 virtual-host deployment. Tenant A's rendering could be served to tenant B. h3#1524 finding #2 found this cross-application body leak. Per-instance storage closed it between processes but not between hosts in one instance. An attacker-controlled `Host` could also enter an absolute URL in a rendered canonical link, `Location`, or password-reset link. The shared key then stored that URL and advertised synthesized `s-maxage` to shared CDNs. The old mitigation, `varies: ["host"]`, was disabled by default. It also did nothing on adapters that omit `Host` from `req.headers`.

Derive authority from `event.url`, which the adapter resolved. **Never** read it from the `Host` header. Narrowing closes the reverse gap by rewriting the handler-visible `Host` to this authority's host; see `.agents/http/request.md`. If an adapter builds `url` from that header, a reverse proxy must still normalize it. Put authority in the hashed component, not in the human-readable `_pathname` prefix. `_pathname` exists only for debugging. Hash authority and `_path` as a **tuple** so no code can interpret the boundary in two ways. An opaque-scheme pathname does not need to start with `/`. This was a breaking key change, so GET keys moved once.

`authority(url)` prefers `url.origin` because it canonicalizes values by lowercasing the host and removing a default port. For every **opaque** origin, `url.origin` is the literal string `"null"`. This includes non-special schemes that contain a real authority but do not expose it. For example, `new URL("x-proxy://a.example/p").origin === "null"`, as it does for `b.example`. In this case, use `${protocol}//${host}`. Otherwise, the cross-host collision returns. Authority-less schemes such as `file:`, `data:`, and `about:` use one constant per scheme. This is correct because their identity is entirely in the path, which the tuple also hashes.

## `.resolveKeys(event)` / `.invalidate(event)` / `.expire(event)`

Issue #71. These methods target a **resource, not one method variant**. They include every cacheable method variant of the event's resource, regardless of the event method. Purging `/article/hello` must not leave a HEAD entry with an obsolete etag or last-modified value for downstream revalidation. `resolveKeys` returns the same set: one key for each base prefix and method variant. It puts the event's own variant first, so `keys[0]` remains the key that the event reads and writes.

Pass each variant key to the standalone helpers through a fixed `getKey`. `variantOptions` returns that raw key next to the options, because `.invalidate()` and `.expire()` must also call the internal `fencePending(cachedFn, key)` for every variant. A standalone helper cannot reach the instance's in-flight resolutions; see `.agents/cache.md`. `resolveKey` has no method component, so this does not clone or mutate the event. `variantOptions` must call `resolveStorage(_opts)` first. It then spreads `_opts` into one new options object per variant. Without pre-resolution, a purge before the first request would make each copy resolve storage independently and call a factory once per variant.

**Storage memo asymmetry vs `cache.ts`**: `defineCachedHandler` first replaces `opts` with a merged clone and then clones it into `_opts`. Therefore, the caller's original options object never receives resolved storage. `invalidateCache({ options: myHandlerOpts })` does not reach a handler's default storage. This is deliberate. Behavior that never works is clearer than behavior that works only when purge happens before the first request. Manually rebuilding a handler key is error-prone and is the problem issue #71 addresses. Use the handler's own methods or pass an explicit `storage`.
