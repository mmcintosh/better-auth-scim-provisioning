// With a custom mapUser userName (a handle, an employee id), a verified user could take over an
// unowned account made by hand at the app: the verified email proves who owns the address, not who
// the userName was made for.
import { expect, it } from "vitest";
import { defaultScimUser } from "../../src";
import { createHost } from "../support/host";

it("an unowned account is adopted only when its userName is the user's verified email", async () => {
  const h = await createHost({ targets: [{ id: "app", mapUser: (u) => ({ ...defaultScimUser(u), userName: u.name.toLowerCase() }) }] });
  await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: "admin", emails: [{ value: "real-admin@example.com" }], name: { givenName: "Real", familyName: "Admin" } }) });
  const someone = await h.ctx.internalAdapter.createUser({ email: "someone@example.com", name: "Admin", emailVerified: true }, { method: "admin" });
  await h.settle();
  expect([...h.app.users.values()]).toEqual([expect.objectContaining({ userName: "admin", emails: [{ value: "real-admin@example.com" }] })]);
  expect(await h.jobs()).toEqual([expect.objectContaining({ userId: someone.id, failed: true })]);
});
