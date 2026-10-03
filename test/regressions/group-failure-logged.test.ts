// A group's failure was logged as "user <organization id>", misleading whoever reads the log.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

it("a group's failure is logged as a group", async () => {
  const h = await createHost();
  const lines: string[] = [];
  const log = { warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
  const box = outbox({ targets: [{ id: "app", url: `${h.app.url}/wrong`, token: h.app.token, fetch: h.app.fetch, groups: true }] }, h.ctx.adapter as unknown as Adapter, log);
  await h.ctx.adapter.create({ model: "organization", data: { id: "org-1", name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
  await box.enqueue("app", "org-1", { kind: "group" });
  await box.runFor("app", "org-1", "group");
  expect(lines.join("\n")).toContain("group org-1");
  expect(lines.join("\n")).not.toContain("user org-1");
});
