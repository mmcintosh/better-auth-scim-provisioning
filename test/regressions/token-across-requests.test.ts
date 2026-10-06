// Found in review (and reproduced in workerd): OAuth and Google tokens were fetched once and the
// fetch in progress was shared by everything in the isolate. In workerd, a fetch started by a
// request that has ended is cancelled, so a later request waiting on that same fetch waited for
// ever: every delivery needing a token would hang. Now only tokens that have arrived are shared
// across requests; a fetch in progress is shared only within one client (one delivery).
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("a token fetch cut short with its request doesn't stall the next request (workerd)", async () => {
  const entry = `
    import { scimClient } from ${JSON.stringify(fileURLToPath(new URL("../../src/scim-client.ts", import.meta.url)))};
    const auth = { type: "oauth2", tokenUrl: "https://login.test/token", clientId: "c", clientSecret: "s" };
    const client = () => scimClient({ url: "https://scim.test/v2", auth });
    const user = { schemas: [], userName: "a@example.com", active: true };
    export default {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // A: starts a delivery and ends before its token arrives (as one cut off by waitUntil's limit).
        if (path === "/a") { client().create(user).catch(() => {}); return new Response("started"); }
        // B: a later delivery, with its own client.
        if (path === "/b") return new Response(await client().create(user));
        return new Response("?", { status: 404 });
      },
    };`;
  const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, format: "esm", platform: "neutral", conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], logLevel: "silent" });
  let release!: () => void;
  const tokenGate = new Promise<void>((r) => (release = r));
  let tokenRequests = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-01",
      outboundService: async (request: Request) => {
        if (request.url === "https://login.test/token") {
          tokenRequests++;
          await tokenGate;
          return Response.json({ access_token: `t${tokenRequests}`, token_type: "Bearer", expires_in: 3600 });
        }
        return Response.json({ id: "u1" }, { status: 201 });
      },
    } as never),
  );
  try {
    expect(await (await mf.dispatchFetch("http://worker/a")).text()).toBe("started");
    setTimeout(release, 200);
    const b = await Promise.race([mf.dispatchFetch("http://worker/b").then((r: { text(): Promise<string> }) => r.text()), new Promise((r) => setTimeout(() => r("TIMED OUT"), 8000))]);
    expect(b).toBe("u1");
  } finally {
    await mf.dispose();
  }
}, 30_000);
