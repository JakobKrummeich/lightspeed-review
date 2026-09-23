import type { DiffFile } from "./diff-extract.ts";
import { unchangedRelocationOf } from "./file-relocation.ts";

/**
 * `guardrail` always wins: a deploy script whose whole change is re-indentation
 * is still a deploy script, and a lockfile is generated bulk a reviewer must see
 * anyway, so a guardrail file is never marked mechanical.
 *
 * The anti-overfit contract every default below is held to: a rule keys on a
 * git-derivable fact or a language-agnostic extension/filename class, never on
 * a path from this repository (`src/browser/`, `src/llm/`, …), and a rule that
 * cannot be justified for a Rails app and a Go service does not ship. A
 * repository's own paths belong in the user's `classify` globs, which add to
 * these defaults and never replace them.
 */

export interface Classification {
  mechanical: boolean;
  guardrail: boolean;
}

export interface ClassifyConfig {
  mechanical: string[];
  guardrail: string[];
}

export interface PathRule {
  name: string;
  pattern: RegExp;
  /** Paths this rule must claim. Every filename and extension the rule names gets one. */
  examples: readonly string[];
  /** Paths no rule in the same table may claim. The reason each pattern is anchored. */
  counterexamples: readonly string[];
}

/**
 * No example paths: what these claim is a property of the diff body, so
 * `test/classify.test.ts` pins them against whole realistic patches instead.
 */
export interface DiffRule {
  name: string;
  applies: (file: DiffFile) => boolean;
}

/**
 * All case-insensitive: filename conventions whose casing varies by platform and
 * by generator (`Dockerfile` and `dockerfile` are one file to docker), and every
 * pattern is anchored on a whole segment or a whole extension, so no lowercase
 * spelling of any of them is plausibly something else.
 */
export const GUARDRAIL_PATH_RULES: readonly PathRule[] = [
  {
    name: "shell and other scripts: they run on someone's machine, and a one-line diff can be the whole risk",
    pattern: /\.(sh|bash|zsh|ps1)$/i,
    examples: ["install.sh", "scripts/deploy.bash", "bin/setup.zsh", "tools/Build.ps1"],
    counterexamples: ["src/shellwords.ts", "docs/bash-setup.md", "app/models/dish.rb"],
  },
  {
    name: "CI configuration: GitHub, CircleCI, GitLab, Jenkins and Azure Pipelines — the code that runs with the project's credentials",
    pattern:
      /(^|\/)\.(github|circleci)\/|(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml)$/i,
    examples: [
      ".github/workflows/ci.yml",
      ".circleci/config.yml",
      ".gitlab-ci.yml",
      "Jenkinsfile",
      "azure-pipelines.yml",
      "packages/api/.github/workflows/publish.yml",
    ],
    counterexamples: ["docs/github-actions.md", "src/jenkins-client.rb", "config/pipelines.yml"],
  },
  {
    name: "git hooks: they run on every commit of everyone who checks the repository out",
    pattern: /(^|\/)\.(husky|githooks)\//i,
    examples: [".husky/pre-commit", ".githooks/commit-msg", "tools/.husky/pre-push"],
    counterexamples: ["docs/husky.md", "src/hooks/use-session.ts"],
  },
  {
    name: "dependency manifests and their lockfiles: a line here pulls somebody else's code into the build",
    pattern:
      /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|composer\.(json|lock)|build\.gradle(\.[^/]+)?|pom\.xml)$/i,
    examples: [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Gemfile",
      "Gemfile.lock",
      "go.mod",
      "go.sum",
      "Cargo.toml",
      "Cargo.lock",
      "requirements.txt",
      "requirements-dev.txt",
      "pyproject.toml",
      "poetry.lock",
      "uv.lock",
      "composer.json",
      "composer.lock",
      "build.gradle",
      "build.gradle.kts",
      "pom.xml",
      "packages/api/package.json",
    ],
    counterexamples: [
      "docs/package.md",
      "src/gemfile-parser.rb",
      "config/cargo-loading.toml",
      "tools/gradle-notes.txt",
    ],
  },
  {
    name: "deployment and infrastructure: what is built, what it is built into, and what it is deployed onto",
    // `Dockerfile*` as a dotted suffix and not as any suffix: `dockerfile-notes.md`
    // is prose about a Dockerfile, and `Dockerfile.production` is one.
    pattern: /(^|\/)(Dockerfile(\.[^/]+)?|docker-compose[^/]*\.ya?ml|Makefile)$|\.tf$/i,
    examples: [
      "Dockerfile",
      "Dockerfile.production",
      "docker-compose.yml",
      "docker-compose.override.yaml",
      "Makefile",
      "infra/main.tf",
      "services/api/Dockerfile",
    ],
    counterexamples: ["docs/dockerfile-notes.md", "src/make.ts", "config/terraform.md"],
  },
];

/**
 * Nothing that carries logic is in here, however boring it usually is: a `.yml`,
 * a `.json` or a `.sql` decides behaviour, and a mark saying otherwise is how a
 * config change gets waved through. Case-insensitive: `README.MD` is prose too.
 */
export const MECHANICAL_PATH_RULES: readonly PathRule[] = [
  {
    name: "documentation: prose, read for its claims rather than reviewed line by line",
    pattern: /\.(md|mdx|txt|rst|adoc)$/i,
    examples: ["README.md", "docs/setup.mdx", "NOTICE.txt", "docs/index.rst", "docs/guide.adoc"],
    counterexamples: ["src/markdown.ts", "docs/index.html", "LICENSE"],
  },
  {
    name: "styling: how it looks, judged in a browser and not in a diff",
    pattern: /\.(css|scss|sass|less)$/i,
    examples: ["app/assets/main.css", "web/styles/theme.scss", "web/a.sass", "web/legacy.less"],
    counterexamples: ["src/style-loader.ts", "web/theme.css.ts"],
  },
  {
    name: "translation catalogues: the same sentences again in another language",
    pattern: /\.(po|pot|arb|strings|resx)$/i,
    examples: [
      "locale/de.po",
      "locale/messages.pot",
      "lib/l10n/app_de.arb",
      "de.lproj/Localizable.strings",
      "Resources/Strings.resx",
    ],
    counterexamples: ["src/gettext.ts", "config/locales/de.yml"],
  },
];

/**
 * In the order the README lists them; any one of them is enough, so the order
 * is how they are explained and not a procedure.
 */
export const MECHANICAL_DIFF_RULES: readonly DiffRule[] = [
  {
    name: "a rename git scored 100% identical, with no line changed on top of it",
    applies: (file) => unchangedRelocationOf(file) !== undefined,
  },
  { name: "a change no line survived except as whitespace", applies: isWhitespaceOnly },
  { name: "a file whose own banner says a generator wrote it", applies: isGenerated },
];

/**
 * Pure and total: the same file classifies the same way wherever it is asked,
 * which is what lets the answer be handed to a model as a fact about the file
 * instead of a suggestion about it.
 */
export function classifyFile(file: DiffFile, extra?: ClassifyConfig): Classification {
  const guardrail = isGuardrail(file, extra?.guardrail ?? []);
  return { mechanical: !guardrail && isMechanical(file, extra?.mechanical ?? []), guardrail };
}

/**
 * Both names a rename carries, because a file moved out of `.github/` is a CI
 * change on the way out and the post-image path alone would report it as an
 * ordinary file appearing somewhere harmless.
 */
function isGuardrail(file: DiffFile, globs: string[]): boolean {
  const paths = file.previousPath === undefined ? [file.path] : [file.path, file.previousPath];
  return paths.some(
    (path) =>
      GUARDRAIL_PATH_RULES.some((rule) => rule.pattern.test(path)) || matchesAny(path, globs),
  );
}

/** The post-image path only: what a file was is no reason to skim what it now is. */
function isMechanical(file: DiffFile, globs: string[]): boolean {
  return (
    MECHANICAL_DIFF_RULES.some((rule) => rule.applies(file)) ||
    MECHANICAL_PATH_RULES.some((rule) => rule.pattern.test(file.path)) ||
    matchesAny(file.path, globs)
  );
}

/**
 * Compared as multisets rather than as sets: a patch that removes one
 * `log(order)` and adds two is a duplicated line, which is a change however
 * identical the copies look, and set comparison would call it bulk. A patch
 * with no added line at all is not whitespace-only either — a mode-only change
 * (`chmod +x` on a script) has nothing in common with a reformat, and the empty
 * case would swallow it.
 */
function isWhitespaceOnly(file: DiffFile): boolean {
  const added = changedContent(file.diff, "+");
  const removed = changedContent(file.diff, "-");
  return added.length > 0 && added.length === removed.length && sameLines(added, removed);
}

function sameLines(added: string[], removed: string[]): boolean {
  const sortedRemoved = [...removed].sort();
  return [...added].sort().every((line, index) => line === sortedRemoved[index]);
}

/**
 * `---`/`+++` are excluded the way `countChangedLines` excludes them, so the
 * file header is never read as content.
 */
function changedContent(diff: string, marker: "+" | "-"): string[] {
  const header = marker.repeat(3);
  return diff
    .split("\n")
    .filter((line) => line.startsWith(marker) && !line.startsWith(header))
    .map((line) => collapseWhitespace(line.slice(1)));
}

/**
 * Runs of whitespace to a single space, ends trimmed — a reformat that reindents,
 * rewraps or drops trailing blanks comes back identical, and `a+b` against
 * `a + b` does not. Deleting whitespace outright would claim more reformats and
 * also claim that `foo bar` and `foobar` are the same line, and the trade is
 * one-sided: a mechanical file missed costs the reviewer one file of attention,
 * while a real edit called mechanical is the change nobody looked at.
 *
 * Exported because the browser's logic badge cancels a reindented line against
 * the line it replaced by this same reading (`src/browser/hunk-complexity.ts`):
 * two definitions of "the same line, differently spaced" would let a file this
 * module calls a reformat still be named the densest logic in the review.
 */
export function collapseWhitespace(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/**
 * Go's `Code generated by … DO NOT EDIT.`, and `@generated` for everyone else.
 * Read from added and context lines only, because a patch that *removes* the
 * banner is a generated file becoming a hand-written one — the opposite of
 * bulk. Read near the top only, because `DO NOT EDIT` further down is as likely
 * to be a string the program prints as a claim about the file holding it.
 * Case-sensitive for the same reason: the conventions are shouted, and prose
 * asking politely not to edit something is prose.
 *
 * A modified generated file whose first hunk starts past its banner is missed.
 * That is the honest answer — the marker is not in the diff — and the
 * alternative, guessing from the extension, is how a hand-written `types.go`
 * gets waved through.
 */
function isGenerated(file: DiffFile): boolean {
  return file.diff
    .split("\n")
    .slice(0, GENERATED_BANNER_LINES)
    .filter((line) => line.startsWith(" ") || (line.startsWith("+") && !line.startsWith("+++")))
    .some((line) => GENERATED_MARKER.test(line));
}

const GENERATED_MARKER = /@generated|DO NOT EDIT/;

/** A patch spends five of these on its own header, leaving the file's first lines. */
const GENERATED_BANNER_LINES = 20;

/**
 * `*` stops at a separator, a `**` segment crosses them, everything else is
 * literal — no character classes, no braces, and no dependency for a matcher
 * this size. Compiled per call and never cached: a config holds globs in single
 * digits, and the cost next to the patches this module already reads is invisible.
 */
function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (token) => WILDCARDS[token] ?? token);
  return new RegExp(`^${source}$`);
}

/**
 * A `**` followed by a separator swallows that separator, so `app` then `**`
 * then `secrets.rb` still matches `app/secrets.rb` — a glob naming a directory
 * tree means the tree's own root as well, and every other glob syntax agrees.
 */
const WILDCARDS: Record<string, string> = {
  "**/": "(?:.*/)?",
  "**": ".*",
  "*": "[^/]*",
};
