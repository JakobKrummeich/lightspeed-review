import assert from "node:assert/strict";
import test from "node:test";
import { startCall } from "../src/start-call.ts";

test("startCall spells a start for the given target with the --intent it cannot run without", () => {
  assert.equal(
    startCall("feature main"),
    'lightspeed start feature main --intent "<why this branch exists>"',
  );
});
