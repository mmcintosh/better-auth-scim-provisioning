// An app that refuses to remove an attribute it doesn't have (400 noTarget) still gets the change: sent again without the removes, then each remove on its own.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const quiet = { warn() {}, error() {} };

it("a user with only a department: a rename still goes at a strict app", async () => {
  const h = await createHost({ targets: [{ id: "app", update: "patch", patch: true, enterprise: true }], userFields: { department: { type: "string" } } });
  const ed = await h.user("Ed Elric");
  await h.ctx.internalAdapter.updateUser(ed.id, { department: "Alchemy" });
  await h.settle();
  const remoteUser = [...h.app.users.values()].find((u) => u.userName === ed.email) as any;
  // The same app, but strict about removing what isn't there.
  const strict: typeof fetch = async (input, init) => {
    if (init?.method === "PATCH" && typeof init.body === "string") {
      const ops = (JSON.parse(init.body).Operations ?? []) as { op: string; path?: string }[];
      for (const op of ops) {
        if (op.op === "remove" && op.path?.startsWith(`${ENT}:`) && remoteUser[ENT]?.[op.path.slice(ENT.length + 1)] === undefined)
          return new Response(JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "400", scimType: "noTarget", detail: `${op.path} has no value` }), { status: 400, headers: { "content-type": "application/scim+json" } });
      }
    }
    return h.app.fetch(input, init);
  };
  const box = outbox({ targets: [{ id: "app", type: "scim", url: h.app.url, token: h.app.token, fetch: strict, update: "patch", enterprise: true }] }, h.ctx.adapter as unknown as Adapter, quiet);
  h.db.prepare('UPDATE "user" SET "name" = ? WHERE "id" = ?').run("Edward Elric", ed.id);
  await box.enqueue("app", ed.id);
  expect(await box.runFor("app", ed.id)).toBe("done");
});

it("the same at a strict app for the plain paths `attributes` removes (title, phoneNumbers, addresses)", async () => {
  const h = await createHost({ targets: [{ id: "app", update: "patch", patch: true, attributes: true }], userFields: { title: { type: "string" }, mobile: { type: "string" } } });
  const ed = await h.user("Ed Elric");
  await h.ctx.internalAdapter.updateUser(ed.id, { title: "Alchemist" });
  await h.settle();
  const remoteUser = [...h.app.users.values()].find((u) => u.userName === ed.email) as any;
  // Strict: a remove of an attribute the user doesn't have is a 400 noTarget.
  const strict: typeof fetch = async (input, init) => {
    if (init?.method === "PATCH" && typeof init.body === "string") {
      const ops = (JSON.parse(init.body).Operations ?? []) as { op: string; path?: string }[];
      for (const op of ops) {
        if (op.op === "remove" && op.path && !op.path.includes(":") && remoteUser[op.path] === undefined)
          return new Response(JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "400", scimType: "noTarget", detail: `${op.path} has no value` }), { status: 400, headers: { "content-type": "application/scim+json" } });
      }
    }
    return h.app.fetch(input, init);
  };
  const known = new Set(Object.keys((h.ctx as any).tables.user.fields));
  const target = { id: "app", type: "scim" as const, url: h.app.url, token: h.app.token, fetch: strict, update: "patch" as const, attributes: true as const };
  const { staticTargets } = await import("../../src/outbox");
  const box = outbox({ targets: [target] }, h.ctx.adapter as unknown as Adapter, quiet, staticTargets([target]), known);
  // A rename with no phone: the remove of phoneNumbers is refused, the change still goes, the title stays.
  h.db.prepare('UPDATE "user" SET "name" = ? WHERE "id" = ?').run("Edward Elric", ed.id);
  await box.enqueue("app", ed.id);
  expect(await box.runFor("app", ed.id)).toBe("done");
  expect(remoteUser).toMatchObject({ displayName: "Edward Elric", title: "Alchemist" });
  expect(remoteUser.phoneNumbers).toBeUndefined();
});
