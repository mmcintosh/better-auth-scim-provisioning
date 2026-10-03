// `check --auth` crashed on a file shaped as the README read it ({ "auth": { … } }), with
// "Cannot read properties of undefined" instead of a usage error.
import { expect, it } from "vitest";
import { parseAuthFile } from "../../src/doctor";

it("the --auth file may hold the auth object or { auth }, and a wrong one is a clear error", () => {
  const basic = { type: "basic", username: "u", password: "p" };
  expect(parseAuthFile(JSON.stringify(basic))).toEqual(basic);
  expect(parseAuthFile(JSON.stringify({ auth: basic }))).toEqual(basic);
  expect(() => parseAuthFile(JSON.stringify({ auth: { type: "oauth2", clientId: "x" } }))).toThrow(/tokenUrl/);
  expect(() => parseAuthFile("{")).toThrow(/JSON/);
});
