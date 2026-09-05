import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHeaders } from "../../src/llm/provider-headers.ts";

/** The rule both callers depend on: a merge that ignores case ships both spellings. */
test("an override replaces the base's header however either side spelled it", () => {
  const builtin = { Authorization: "from-builtin", "x-keep": "builtin" };

  const merged = mergeHeaders(builtin, { authorization: "from-config" });

  assert.deepEqual(merged, { "x-keep": "builtin", authorization: "from-config" });
});

test("a base with no such header simply gains it, and no base is just the override", () => {
  assert.deepEqual(mergeHeaders({ "x-keep": "builtin" }, { "x-corp-auth": "t" }), {
    "x-keep": "builtin",
    "x-corp-auth": "t",
  });
  assert.deepEqual(mergeHeaders(undefined, { "x-corp-auth": "t" }), { "x-corp-auth": "t" });
});

/** `null` is pi-ai's "suppress this header": an override never sends one, a base may. */
test("a base header nothing overrode survives, null included", () => {
  assert.deepEqual(mergeHeaders({ Authorization: null }, { "x-corp-auth": "t" }), {
    Authorization: null,
    "x-corp-auth": "t",
  });
});

/** Both callers hand in headers pi-ai still holds: merging must not edit them. */
test("the base is copied, not written through", () => {
  const base = { Authorization: "from-builtin" };

  mergeHeaders(base, { authorization: "from-config" });

  assert.deepEqual(base, { Authorization: "from-builtin" });
});
