// A Worker that provisions its Better Auth users to a SCIM app (and/or a signed webhook): D1 for
// the database, waitUntil for deliveries after the response, and a Cron Trigger for retries.
import { waitUntil } from "cloudflare:workers";
import { admins, createAuth, type Env } from "./auth";

// DEVELOPMENT ONLY (DEV_MAILBOX="true"): verification links by email address. Per isolate, so
// with several isolates a link may not be found; it's for `wrangler dev` and tests.
const mailbox = new Map<string, string>();

let cached: { env: Env; auth: ReturnType<typeof createAuth> } | undefined;
/**
 * Better Auth for this isolate, set up within the request that creates it. Its handler finishes
 * setting itself up on its first call, and workerd cancels whatever a request leaves unfinished:
 * if the first request only created the instance (a 404, say), every later request would wait
 * forever. So the request that creates it also calls the handler once (`/ok`, no database).
 */
const authFor = async (env: Env) => {
  if (cached?.env !== env) {
    const auth = createAuth(env, { waitUntil, mailbox });
    await auth.handler(new Request(new URL("/api/auth/ok", env.BETTER_AUTH_URL)));
    cached = { env, auth };
  }
  return cached.auth;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The signed-in user, if their email is in ADMIN_EMAILS. */
async function admin(request: Request, env: Env) {
  const session = await (await authFor(env)).api.getSession({ headers: request.headers });
  return session && admins(env).includes(session.user.email.toLowerCase()) ? session.user : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = await authFor(env);
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);

    // Development only: never on a deployed host, even if DEV_MAILBOX is switched on there.
    if (url.pathname === "/dev/mailbox" && env.DEV_MAILBOX === "true" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      const link = mailbox.get((url.searchParams.get("email") ?? "").toLowerCase());
      return link ? json({ link }) : json({ error: "no mail for that address" }, 404);
    }

    if (url.pathname.startsWith("/admin/")) {
      if (!(await admin(request, env))) return json({ error: "admins only" }, 403);
      const ctx = await auth.$context;
      if (url.pathname === "/admin/status" && request.method === "GET") {
        const count = (model: string, where: { field: string; value: string | number | boolean }[] = []) => ctx.adapter.count({ model, where });
        return json({
          queued: await count("scimProvisioningJob", [{ field: "failed", value: false }]),
          failed: await count("scimProvisioningJob", [{ field: "failed", value: true }]),
          accounts: await count("scimProvisioningLink"),
          groups: await count("scimProvisioningGroupLink"),
        });
      }
      // Deliver what's due now (the Cron Trigger does this on its schedule).
      if (url.pathname === "/admin/run" && request.method === "POST") return json(await auth.api.scimProvisioningRun({ body: {} }));
      // Queue every user and group again, page by page: after an outage, or to adopt existing users.
      if (url.pathname === "/admin/reconcile" && request.method === "POST") {
        let after: string | undefined;
        let queued = 0;
        do {
          // A page at a time: one call over every user would run past a Worker's limits.
          const page = await auth.api.scimProvisioningReconcile({ body: { limit: 200, ...(after ? { after } : {}) } });
          queued += page.queued;
          after = page.next ?? undefined;
        } while (after);
        return json({ queued });
      }
    }
    return json({ error: "not found" }, 404);
  },

  // Retries (an app that was down, rate limits) are delivered by the Cron Trigger.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(authFor(env).then((auth) => auth.api.scimProvisioningRun({ body: {} })));
  },
} satisfies ExportedHandler<Env>;
