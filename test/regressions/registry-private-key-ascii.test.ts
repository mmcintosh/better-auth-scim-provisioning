// A stored private key must be printable ASCII (a PEM is): limits counted characters, and a key
// of 2-byte characters sealed past MySQL's TEXT (65,535 bytes).
import { describe, expect, it } from "vitest";
import { seal, storedCredentialsSchema } from "../../src/registry";

describe("registry: private key size", () => {
  it("a private key must be printable ASCII (a PEM is), so the largest accepted seals within MySQL's TEXT", async () => {
    const wide = `-----BEGIN PRIVATE KEY-----${"é".repeat(16_384 - 54)}-----END PRIVATE KEY-----`;
    expect(storedCredentialsSchema.safeParse({ privateKey: wide }).success).toBe(false);
    const key = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(16_384 - 56)}\n-----END PRIVATE KEY-----`;
    expect(storedCredentialsSchema.safeParse({ privateKey: key }).success).toBe(true);
    const sealed = await seal("test-secret-that-is-at-least-32-characters-long", "t-00000000-0000-0000-0000-000000000000", "org", { privateKey: key }, { type: "google-workspace", google: { clientEmail: "x".repeat(200), adminEmail: "y".repeat(200) } });
    expect(new TextEncoder().encode(sealed).length).toBeLessThanOrEqual(65_535);
  });
});
