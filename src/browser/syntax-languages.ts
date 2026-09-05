/**
 * Which highlight.js grammar a reviewed file should be read with. Kept as data
 * because it is the one place that decides what "a .tsx file" means, and it is
 * also the list of grammars the bundle can lazy-load — see `syntax-grammars.ts`.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
};

/** Files whose name, not extension, says what they are. */
export const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/**
 * The grammar for one repository path, or undefined when nothing fits: an
 * unhighlighted file reads as it does today, a wrongly guessed one reads worse.
 */
export function languageForPath(path: string): string | undefined {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const byName = LANGUAGE_BY_FILENAME[name];
  if (byName) return byName;
  // `.gitignore` is a name, not an extension: a leading dot never starts one.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)];
}
