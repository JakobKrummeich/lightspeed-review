import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewError } from "../../src/errors.ts";
import { runServe } from "../../src/commands/serve.ts";
import { runStop } from "../../src/commands/stop.ts";
import { freePort, occupyPort } from "../helpers/ports.ts";

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "lsr-serve-"));
}

test("serve listens until it is asked to stop, then reports the port it held", async () => {
  const port = await freePort();
  const serving = runServe({ stateDir: stateDir(), port, feedbackLog: "off" });

  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  await runStop({ port });
  const output = await serving;

  assert.deepEqual(output.server, { port, status: "stopped" });
  assert.ok((output.help as string[]).length > 0);
});

test("stop reports the running server as stopped", async () => {
  const port = await freePort();
  const serving = runServe({ stateDir: stateDir(), port, feedbackLog: "off" });
  await fetch(`http://127.0.0.1:${port}/health`);

  const output = await runStop({ port });

  assert.deepEqual(output.server, { port, status: "stopped" });
  await serving;
});

test("serving on a port someone else holds fails with port_unavailable", async () => {
  const port = await freePort();
  const squatter = await occupyPort(port);

  await assert.rejects(
    () => runServe({ stateDir: stateDir(), port, feedbackLog: "off" }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "port_unavailable");
      return true;
    },
  );

  await squatter.release();
});

test("serving on a port a review server already holds names it as one", async () => {
  const port = await freePort();
  const serving = runServe({ stateDir: stateDir(), port, feedbackLog: "off" });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);

  await assert.rejects(
    () => runServe({ stateDir: stateDir(), port, feedbackLog: "off" }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_already_running");
      assert.match(error.message, /a review server is already running on port/);
      return true;
    },
  );

  await runStop({ port });
  await serving;
});

test("stopping a server that is not running succeeds instead of failing", async () => {
  const port = await freePort();

  const output = await runStop({ port });

  assert.deepEqual(output.server, { port, status: "not_running" });
  assert.match(output.message as string, /no review server/i);
});
