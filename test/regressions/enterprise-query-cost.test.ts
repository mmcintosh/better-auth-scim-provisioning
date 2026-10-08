// Query cost of a delivery with the Enterprise User manager (a measurement, kept as a budget).
import { expect, it, vi } from "vitest";
import { createHost } from "../support/host";

async function count(enterprise: unknown) {
  const h = await createHost({ targets: [{ id: "app", ...(enterprise ? { enterprise } : {}) } as never], userFields: { managerId: { type: "string" } } });
  const u = await h.user("Ada Lovelace");
  const adapter = h.ctx.adapter as any;
  const calls: string[] = [];
  const spies = ["findOne", "findMany", "count", "create", "update", "updateMany", "deleteMany"].map((m) => {
    const real = adapter[m].bind(adapter);
    return vi.spyOn(adapter, m).mockImplementation(async (a: any) => {
      calls.push(`${m}:${a.model}`);
      return real(a);
    });
  });
  await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada King" });
  await h.settle();
  for (const s of spies) s.mockRestore();
  const plan = h.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM "user" WHERE "managerId" = ?').all("x") as { detail: string }[];
  return { calls, plan: plan.map((p) => p.detail).join("; ") };
}

it("queries per update delivery, and the plan of the report lookup", async () => {
  const off = await count(undefined);
  const on = await count({ manager: "managerId" });
  console.log("without:", off.calls.length, off.calls.join(", "));
  console.log("with manager:", on.calls.length, on.calls.join(", "));
  console.log("report lookup plan:", on.plan);
  expect(on.calls.length - off.calls.length).toBeGreaterThanOrEqual(2);
  expect(on.plan).toMatch(/SCAN/);
});
