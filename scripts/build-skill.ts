import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkill, SKILL_PATH } from "../src/skill.ts";

const target = fileURLToPath(new URL(`../${SKILL_PATH}`, import.meta.url));
const skill = renderSkill();

// `--check` is what CI and the test suite use: the checked-in skill is a build
// artifact, and a stale one would ship guidance the CLI no longer prints.
if (process.argv.includes("--check")) {
  const onDisk = readCurrent();
  if (onDisk === skill) {
    process.stdout.write(`${SKILL_PATH} is up to date\n`);
  } else {
    process.stdout.write(`${SKILL_PATH} is out of date — run \`pnpm run build:skill\`\n`);
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, skill);
  process.stdout.write(`wrote ${SKILL_PATH}\n`);
}

function readCurrent(): string | undefined {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}
