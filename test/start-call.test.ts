import assert from "node:assert/strict";
import test from "node:test";
import { openCall } from "../src/start-call.ts";

test("openCall spells an open for the given target with the --intent it cannot run without", () => {
  assert.equal(
    openCall("feature main"),
    "lightspeed open feature main --intent '<why this branch exists>'",
  );
});
