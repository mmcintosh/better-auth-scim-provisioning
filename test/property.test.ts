// Property tests (fast-check) for the code that reads what other parties send: a target app's
// responses (scimKeys, Retry-After), the `--auth` file, and the addresses the private-network
// guard refuses. Each property holds for any input fast-check generates, not only the cases we
// thought of; the IP ranges are checked against IANA's special-purpose registries, written out
// here independently of src/registry.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAuthFile } from "../src/doctor";
import { privateAddress } from "../src/registry";
import {
	retryAfterMs,
	scimKeys,
	scimString,
	trimSlashes,
} from "../src/scim-client";

const DAY_MS = 86_400_000;

describe("scimKeys", () => {
	it("never throws, and never gives a copy a prototype key", () => {
		// JSON.parse keeps "__proto__" as a plain key; copying it must not set a prototype.
		const out = scimKeys(
			JSON.parse('{"__proto__":{"polluted":1},"a":[{"__proto__":{"b":2}}]}'),
		) as { a: object[] };
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(out.a[0])).toBe(Object.prototype);
		expect(({} as { polluted?: number }).polluted).toBeUndefined();
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const json = JSON.parse(
					JSON.stringify(value).replace(/"(\w+)":/, '"__proto__":'),
				);
				const out = scimKeys(json);
				const walk = (v: unknown): void => {
					if (v === null || typeof v !== "object") return;
					expect(Object.getPrototypeOf(v)).toBe(
						Array.isArray(v) ? Array.prototype : Object.prototype,
					);
					expect(Object.hasOwn(v, "__proto__")).toBe(false);
					for (const x of Object.values(v)) walk(x);
				};
				walk(out);
			}),
		);
	});

	it("is idempotent, and spells the names we read as RFC 7643 does, in any case", () => {
		const names = ["Resources", "totalResults", "nextCursor", "userName", "id"];
		fc.assert(
			fc.property(
				fc.constantFrom(...names),
				fc.constantFrom("lower", "upper", "same"),
				fc.jsonValue(),
				(name, how, value) => {
					const key =
						how === "lower"
							? name.toLowerCase()
							: how === "upper"
								? name.toUpperCase()
								: name;
					const once = scimKeys({ [key]: value }) as Record<string, unknown>;
					expect(Object.keys(once)).toEqual([name]);
					expect(scimKeys(once)).toEqual(once);
				},
			),
		);
	});

	it("keeps the exact spelling's value when a name comes both ways", () => {
		fc.assert(
			fc.property(fc.integer(), fc.integer(), (exact, other) => {
				expect(scimKeys({ totalresults: other, totalResults: exact })).toEqual({
					totalResults: exact,
				});
				expect(scimKeys({ totalResults: exact, TOTALRESULTS: other })).toEqual({
					totalResults: exact,
				});
			}),
		);
	});
});

describe("retryAfterMs", () => {
	it("is undefined or a delay from 0 to a day, whatever the header says", () => {
		fc.assert(
			fc.property(fc.string(), fc.integer({ min: 0, max: 4e12 }), (h, now) => {
				const ms = retryAfterMs(h, now);
				if (ms !== undefined) {
					expect(Number.isFinite(ms)).toBe(true);
					expect(ms).toBeGreaterThanOrEqual(0);
					expect(ms).toBeLessThanOrEqual(DAY_MS);
				}
			}),
		);
	});

	it("reads delay-seconds, capped at a day", () => {
		fc.assert(
			fc.property(fc.nat(), (s) => {
				expect(retryAfterMs(String(s))).toBe(Math.min(DAY_MS, s * 1000));
				expect(retryAfterMs(` ${s} `)).toBe(Math.min(DAY_MS, s * 1000));
			}),
		);
	});

	it("reads an HTTP date as the time until it, never negative", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1e12, max: 3e12 }),
				fc.integer({ min: -DAY_MS * 2, max: DAY_MS * 2 }),
				(now, offset) => {
					const at = Math.floor((now + offset) / 1000) * 1000;
					expect(retryAfterMs(new Date(at).toUTCString(), now)).toBe(
						Math.min(DAY_MS, Math.max(0, at - now)),
					);
				},
			),
		);
	});
});

describe("parseAuthFile", () => {
	it("returns an auth object or throws a clear --auth error, never anything else", () => {
		const field = fc.oneof(fc.string(), fc.integer(), fc.constant(null));
		const auth = fc.record(
			{
				type: fc.oneof(
					fc.constantFrom("bearer", "basic", "header", "oauth2"),
					// Names every object inherits: not types.
					fc.constantFrom("toString", "constructor", "__proto__", "valueOf"),
					fc.string(),
					fc.integer(),
				),
				token: field,
				username: field,
				password: field,
				name: field,
				value: field,
				tokenUrl: field,
				clientId: field,
				clientSecret: field,
			},
			{ requiredKeys: [] },
		);
		const text = fc.oneof(
			fc.string(),
			fc.jsonValue().map((v) => JSON.stringify(v)),
			auth.map((a) => JSON.stringify(a)),
			auth.map((a) => JSON.stringify({ auth: a })),
		);
		fc.assert(
			fc.property(text, (t) => {
				try {
					const parsed = parseAuthFile(t);
					expect(["bearer", "basic", "header", "oauth2"]).toContain(
						parsed.type,
					);
				} catch (e) {
					expect(e).toBeInstanceOf(Error);
					expect((e as Error).message).toMatch(/^--auth: /);
				}
			}),
		);
	});
});

it("refuses a type that's a name every object inherits, clearly (found by the property above)", () => {
	for (const type of ["toString", "constructor", "__proto__", "hasOwnProperty"])
		expect(() => parseAuthFile(JSON.stringify({ type }))).toThrow(
			/^--auth: "type" must be one of bearer, basic, header, oauth2$/,
		);
});

describe("scimString and trimSlashes", () => {
	it("scimString is a string literal that reads back as the value", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), (s) => {
				expect(JSON.parse(scimString(s))).toBe(s);
			}),
		);
	});

	it("trimSlashes removes the trailing slashes and nothing else", () => {
		fc.assert(
			fc.property(fc.string(), fc.nat(20), (s, n) => {
				const out = trimSlashes(s + "/".repeat(n));
				expect(out.endsWith("/")).toBe(false);
				expect(s.startsWith(out)).toBe(true);
				expect(s.slice(out.length)).toMatch(/^\/*$/);
			}),
		);
	});
});

// IANA IPv4 Special-Purpose Address Registry (RFC 6890 and updates), plus multicast and the
// reserved 240/4. 192.88.99.0/24 (6to4 relay anycast) is deprecated by RFC 7526 and left out,
// as src/registry.ts leaves it out.
const SPECIAL_V4: [string, number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];
const v4int = (a: string) =>
	a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const special = (n: number) =>
	SPECIAL_V4.some(([base, bits]) => {
		const size = 2 ** (32 - bits);
		return Math.floor(n / size) === Math.floor(v4int(base) / size);
	});
const dotted = (n: number) =>
	[24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
const hex = (n: number) => n.toString(16);

describe("privateAddress", () => {
	// Addresses near every range's edges, where an off-by-one would show, and anywhere at all.
	const edges = SPECIAL_V4.flatMap(([base, bits]) => {
		const lo = v4int(base);
		const hi = lo + 2 ** (32 - bits) - 1;
		return [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1].filter(
			(n) => n >= 0 && n <= 0xffffffff,
		);
	});
	const v4 = fc.oneof(
		fc.constantFrom(...edges),
		fc.integer({ min: 0, max: 0xffffffff }),
	);

	it("refuses exactly IANA's special-purpose IPv4 ranges", () => {
		for (const n of edges) expect(privateAddress(dotted(n))).toBe(special(n));
		fc.assert(
			fc.property(v4, (n) => {
				expect(privateAddress(dotted(n))).toBe(special(n));
			}),
		);
	});

	it("judges an IPv4 address the same inside IPv6: mapped, SIIT and compatible", () => {
		fc.assert(
			fc.property(v4, (n) => {
				const hi = hex(Math.floor(n / 65536));
				const lo = hex(n % 65536);
				expect(privateAddress(`::ffff:${dotted(n)}`)).toBe(special(n));
				expect(privateAddress(`::ffff:${hi}:${lo}`)).toBe(special(n));
				expect(privateAddress(`::ffff:0:${dotted(n)}`)).toBe(special(n));
				// Compatible (::a.b.c.d) is deprecated; refused at least where the IPv4 address is.
				if (special(n)) expect(privateAddress(`::${dotted(n)}`)).toBe(true);
			}),
		);
	});

	it("refuses every address that reaches IPv4 or a local network, whatever follows the prefix", () => {
		const word = fc.integer({ min: 0, max: 0xffff });
		const rest = (n: number) => fc.array(word, { minLength: n, maxLength: n });
		const cases: [string, fc.Arbitrary<string>][] = [
			[
				"NAT64 64:ff9b::/96",
				rest(6).map((w) => ["64", "ff9b", ...w.map(hex)].join(":")),
			],
			["6to4 2002::/16", rest(7).map((w) => ["2002", ...w.map(hex)].join(":"))],
			[
				"Teredo 2001::/32",
				rest(6).map((w) => ["2001", "0", ...w.map(hex)].join(":")),
			],
			[
				"documentation 2001:db8::/32",
				rest(6).map((w) => ["2001", "db8", ...w.map(hex)].join(":")),
			],
			[
				"unique local fc00::/7",
				fc
					.tuple(fc.integer({ min: 0xfc00, max: 0xfdff }), rest(7))
					.map(([a, w]) => [hex(a), ...w.map(hex)].join(":")),
			],
			[
				"link-local fe80::/10",
				fc
					.tuple(fc.integer({ min: 0xfe80, max: 0xfebf }), rest(7))
					.map(([a, w]) => [hex(a), ...w.map(hex)].join(":")),
			],
			[
				"multicast ff00::/8",
				fc
					.tuple(fc.integer({ min: 0xff00, max: 0xffff }), rest(7))
					.map(([a, w]) => [hex(a), ...w.map(hex)].join(":")),
			],
		];
		for (const [, arb] of cases)
			fc.assert(
				fc.property(arb, (a) => {
					expect(privateAddress(a)).toBe(true);
				}),
			);
	});

	it("gives the same answer for an address written in full or with ::, and never throws", () => {
		const words = fc.array(fc.integer({ min: 0, max: 0xffff }), {
			minLength: 8,
			maxLength: 8,
		});
		fc.assert(
			fc.property(words, fc.nat(7), fc.nat(8), (w, at, len) => {
				const full = w.map(hex).join(":");
				// Zero a run, then write it as "::".
				const run = Math.min(len, 8 - at);
				const z = w.map((x, i) => (i >= at && i < at + run ? 0 : x));
				const zFull = z.map(hex).join(":");
				const short =
					run < 2
						? zFull
						: `${z.slice(0, at).map(hex).join(":")}::${z
								.slice(at + run)
								.map(hex)
								.join(":")}`;
				expect(privateAddress(short)).toBe(privateAddress(zFull));
				expect(typeof privateAddress(full)).toBe("boolean");
			}),
		);
		fc.assert(
			fc.property(fc.string(), (s) => {
				expect(typeof privateAddress(s)).toBe("boolean");
			}),
		);
	});
});
