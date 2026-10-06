// The Workers example's types, for this repository's (Node) TypeScript project: D1Database is a
// Workers global, declared by @cloudflare/workers-types in the example's own project.
declare global {
  type D1Database = import("miniflare").D1Database;
}
export {};
