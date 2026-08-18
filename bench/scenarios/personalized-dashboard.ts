// 3. Per-user dashboard.
//
// The case where caching mostly cannot help, kept in the set on purpose. Keys are
// per user, so the working set is as large as the active user base and the head is only
// the users who reload often. `allowCookies: ["tier"]` emits `Vary: Cookie`; each user's
// stable tier is keyed while the unkeyed session cookie is stripped.
//
// A share of requests is for a user this process has never seen. Without that churn the
// scenario is a lie: prewarm would cover the whole user base once and report a hit ratio
// no per-user endpoint ever reaches, because real sessions keep arriving.
//
// The number to read here is not the speedup. It is what a low hit ratio costs.

import { defineCachedHandler } from "../../src/index.ts";
import { createZipf } from "../harness/random.ts";
import { filler, makeEvent } from "../harness/scenario.ts";

import type { HTTPEvent } from "../../src/types.ts";
import type { Scenario } from "../harness/scenario.ts";

const BODY = filler(15 * 1024);
const USERS = 2000;
/** Share of requests for a user id that has never been requested before. */
const CHURN = 0.15;

const scenario: Scenario = {
  id: "personalized-dashboard",
  title: "Personalized dashboard",
  kind: "handler",
  summary:
    "15 KiB per-user page, 2k returning users plus 15% first-time sessions, tier cookie keyed",
  expect:
    "Session churn caps the hit ratio no matter how long the cache runs. Watch what the misses cost: a slow storage profile pays for a read it does not get to use.",
  origin: { ioMs: 45, cpuMs: 3, concurrency: 20 },
  payloadBytes: 15 * 1024,
  keyspace: USERS,
  storageProfiles: ["memory", "redis-az"],
  load: {
    steady: { rps: 220, durationMs: 10_000, warmupMs: 3000 },
    ramp: [150, 300, 600, 1200, 2400],
  },

  create(ctx) {
    const pick = createZipf(ctx.rng, USERS, 1.4);
    let nextUser = USERS;
    const handler = (event: HTTPEvent) =>
      ctx.origin.run(
        () =>
          new Response(`{"user":"${event.url!.pathname}","widgets":"${BODY}"}`, {
            headers: { "content-type": "application/json" },
          }),
      );

    const cached = defineCachedHandler(handler, {
      name: "dashboard",
      maxAge: 15,
      swr: true,
      staleMaxAge: 60,
      allowCookies: ["tier"],
      base: ctx.base,
      storage: ctx.storage,
    });

    const serve = ctx.mode === "cached" ? cached : handler;
    return async () => {
      const user = ctx.rng() < CHURN ? nextUser++ : pick();
      const event = makeEvent(
        `https://app.example/dashboard/${user}`,
        {
          headers: {
            cookie: `sid=s${user}-${Math.floor(ctx.rng() * 1e9)}; tier=${user % 2 ? "pro" : "free"}`,
          },
        },
        ctx.waitUntil,
      );
      const res = (await serve(event)) as Response;
      await res.arrayBuffer();
      return res.headers.get("x-cache");
    };
  },
};

export default scenario;
