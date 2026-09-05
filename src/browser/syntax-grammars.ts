import type { HLJSApi, LanguageFn } from "highlight.js";

type GrammarModule = { default: LanguageFn };

/**
 * One dynamic import per grammar, written out rather than built from a template
 * string: the bundler can only split what it can see statically. Loading a
 * grammar therefore costs one small request for the files a review touches,
 * instead of every grammar highlight.js ships sitting in the main bundle.
 */
export const GRAMMAR_LOADERS: Record<string, () => Promise<GrammarModule>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/**
 * Grammars highlight.js hands parts of a file to. Its JavaScript and TypeScript
 * grammars mark JSX up with the `xml` grammar, so without this a `.tsx` file's
 * tags come out as plain text between the code around them.
 */
const GRAMMAR_DEPENDENCIES: Record<string, string[]> = {
  javascript: ["xml"],
  typescript: ["xml"],
};

let core: Promise<HLJSApi> | undefined;
const registered = new Map<string, Promise<void>>();

/**
 * The shared highlighter with the requested grammars registered, or undefined
 * when none of them is known — a review of files highlight.js has no grammar
 * for should not download highlight.js at all.
 *
 * Both the engine and each grammar are fetched once per page and cached as
 * promises, so concurrent callers share one request.
 */
export async function loadHighlighter(languages: Iterable<string>): Promise<HLJSApi | undefined> {
  const asked = [...new Set(languages)].filter((language) => language in GRAMMAR_LOADERS);
  if (asked.length === 0) return undefined;
  const known = [
    ...new Set(asked.flatMap((language) => [language, ...(GRAMMAR_DEPENDENCIES[language] ?? [])])),
  ];
  const hljs = await (core ??= import("highlight.js/lib/core").then((module) => module.default));
  await Promise.all(known.map((language) => register(hljs, language)));
  return hljs;
}

function register(hljs: HLJSApi, language: string): Promise<void> {
  const pending = registered.get(language);
  if (pending) return pending;
  const load = GRAMMAR_LOADERS[language]!;
  const done = load().then((module) => {
    hljs.registerLanguage(language, module.default);
  });
  registered.set(language, done);
  return done;
}
