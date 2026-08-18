---
title: Hono
icon: simple-icons:hono
---

# Hono

[Hono](https://hono.dev) exposes the incoming standard `Request` as `context.req.raw` and accepts a standard `Response` from route handlers. Adapt the Hono context into ocache's `{ req, url }` event to cache a route.

## Install

```bash
pnpm add hono ocache
```

## Cache a route

Define the cached handler once, then call it from the Hono route:

```ts
import { Hono, type Context } from "hono";
import { defineCachedHandler, type CachedEventHandlerOptions, type HTTPEvent } from "ocache";

type HonoCacheEvent = HTTPEvent & {
  context: Context;
};

function defineHonoCachedHandler(
  handler: (event: HonoCacheEvent) => unknown | Promise<unknown>,
  options: CachedEventHandlerOptions<HonoCacheEvent>,
) {
  const cached = defineCachedHandler<HonoCacheEvent>(handler, options);

  return (context: Context) =>
    cached({
      req: context.req.raw,
      url: new URL(context.req.url),
      context,
    });
}

const app = new Hono();

const product = defineHonoCachedHandler(
  async (event) => {
    const id = event.context.req.param("id");
    const value = await db.products.find(id);
    return event.context.json(value);
  },
  {
    name: "product",
    maxAge: 60,
    swr: true,
    staleMaxAge: 300,
  },
);

app.get("/products/:id", product);

export default app;
```

The first request stores the response. Later requests receive the cached status, headers, and body, with generated `etag`, `cache-control`, and `x-cache` headers when the response does not override them.

The extra `context` member remains available for route parameters, bindings, and application services. ocache only requires `req` and `url`.

> [!IMPORTANT]
> Read request headers from `event.req` and query parameters from `event.url` inside the cached handler—not from `event.context.req`. ocache narrows its event to inputs covered by the cache key, while the original Hono context still exposes the complete request. Query parameters require `allowQuery`; without it, `event.url` has no query. Rendering an unkeyed value from the original context could store one caller's response for other callers.

## Request headers and query parameters

Declare every request header and query parameter that affects the response — neither is covered by default:

```ts
const localized = defineHonoCachedHandler(
  async (event) => {
    const language = event.req.headers.get("accept-language") ?? "en";
    const page = event.url?.searchParams.get("page") ?? "1";
    return event.context.json(await loadProducts({ language, page }));
  },
  {
    name: "localized-products",
    maxAge: 300,
    varies: ["accept-language"],
    allowQuery: ["page"],
  },
);

app.get("/products", localized);
```

`accept-language` reaches the handler, varies the cache key, and appears in `Vary`. `allowQuery` is required for query-dependent responses: here, only `page` reaches the handler's URL and generated key. See [Query Parameters](/docs/query-params), [Cookies](/docs/cookies), and [Caching HTTP Handlers](/docs/handler#headers-the-handler-cant-see) for the complete rules.

Hono middleware runs before the route and still sees the original request. Put request-only values such as trace IDs in Hono variables for logging, but do not render them into a cached response unless the corresponding request input is keyed.

Use `shouldBypassCache` when authenticated or private requests must reach the route unchanged and must never be stored:

```ts
const account = defineHonoCachedHandler(renderAccount, {
  name: "account",
  maxAge: 60,
  shouldBypassCache: (event) => event.req.headers.has("authorization"),
});
```

## Persistent storage

Pass a shared storage adapter to routes that should use the same backend:

```ts
import { cacheStorage } from "./cache-storage";

const page = defineHonoCachedHandler(renderPage, {
  name: "page",
  maxAge: 60,
  storage: cacheStorage,
});

app.get("/pages/:slug", page);
```

See the [unstorage integration](/integrations/unstorage) for JSON and raw-byte adapters. Create the storage at module or application scope, not inside the route callback.

## Serverless background work

SWR refreshes and asynchronous storage operations should be registered with the runtime on serverless platforms. ocache automatically uses a srvx-compatible `event.req.waitUntil` when the Hono adapter provides one. Otherwise, connect the runtime through ocache's `waitUntil` option only when your host supplies a request-safe registration function.

The hook must register work with the current request. Do not capture one request's execution context in a module-scoped cached handler and reuse it for later requests. If a Hono adapter exposes `waitUntil` only on each `Context`, add a runtime-specific bridge that tracks the active request rather than closing over the first context.

## Invalidation

Keep a reference to the underlying cached handler when you need its `.invalidate()` or `.expire()` methods. A small adapter can expose both the Hono callback and the cached handler:

```ts
const cachedPage = defineCachedHandler<HonoCacheEvent>(renderPage, {
  name: "page",
  maxAge: 60,
  swr: true,
});

app.get("/pages/:slug", (context) =>
  cachedPage({
    req: context.req.raw,
    url: new URL(context.req.url),
    context,
  }),
);

app.post("/admin/pages/:slug/publish", async (context) => {
  const slug = context.req.param("slug");
  await publishPage(slug);

  const url = new URL(`/pages/${slug}`, context.req.url);
  await cachedPage.invalidate({ req: new Request(url), url, context });
  return context.json({ ok: true });
});
```

Use `.expire()` instead when the next request may receive stale content while the page regenerates in the background. The invalidation event must resolve to the same public URL and varying inputs as the cached route.

## See also

- [Caching HTTP Handlers](/docs/handler) — cache keys, response eligibility, and conditional requests
- [unstorage integration](/integrations/unstorage) — persistent storage adapters
- [Incremental Static Regeneration](/docs/isr) — stale-while-revalidate patterns
