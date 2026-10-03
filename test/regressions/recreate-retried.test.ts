// With groupRename "recreate", a failed delete of the old group (a 429, say) left the new group
// made, and the retry tried to create it again: a 409, and the group job failed for good. The retry
// now finds its own new group and carries on, and the link moves only once the old one is gone.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

const quiet = { warn() {}, error() {} };
const compat = { groupUpdate: "patch", groupRename: "recreate" } as const;

async function owner(h: Host) {
  const s = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { cookie: res.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ") };
}

it("a rename whose old group's delete failed once completes on the retry, with one group", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true, compat }] });
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: await owner(h) });
  await h.settle();
  h.db.prepare('UPDATE "organization" SET "name" = ? WHERE "id" = ?').run("Acme Corp", org!.id);
  let limited = false;
  const f: typeof fetch = async (i, init) => {
    if (!limited && init?.method === "DELETE") {
      limited = true;
      return new Response(JSON.stringify({ detail: "slow down" }), { status: 429 });
    }
    return h.app.fetch(i, init);
  };
  const box = outbox({ targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: f, groups: true, compat }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, quiet);
  await box.enqueue("app", org!.id, { kind: "group" });
  expect(await box.runFor("app", org!.id, "group")).toBe("retry");
  expect(await box.runFor("app", org!.id, "group")).toBe("done");
  expect([...h.app.groups.values()].map((g) => g.displayName)).toEqual(["Acme Corp"]);
});
