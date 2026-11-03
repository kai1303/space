import type { HighlighterCore } from "shiki/core";

const grammars = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
};
const aliases: Record<string, string> = { js: "javascript", ts: "typescript", py: "python", sh: "bash", shell: "bash" };
export const languageName = (language: string) => ({ javascript: "JavaScript", typescript: "TypeScript", json: "JSON", python: "Python", bash: "Bash", text: "Plain text", html: "HTML" })[aliases[language] ?? language] ?? language;
export type CodeToken = { content: string; role?: string };
const colors: Record<string, string> = {
  "#df847c": "comment", "#81bc69": "string", "#899bdc": "constant",
  "#cfa1de": "entity", "#9a9b9e": "punctuation",
};
let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();
export async function highlightCode(code: string, language: string): Promise<CodeToken[][]> {
  const lang = aliases[language.toLowerCase()] ?? language.toLowerCase();
  const loader = grammars[lang as keyof typeof grammars];
  if (!loader || code.length > 100000) return code.split(/\r\n|\r|\n/).map((content) => [{ content }]);
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(([core, engine]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(), langs: [],
    themes: [{ name: "space-slackbot", settings: [
      { settings: { foreground: "#f8f8f8", background: "#212428" } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#df847c" } },
      { scope: ["string", "string.regexp", "constant.other.symbol"], settings: { foreground: "#81bc69" } },
      { scope: ["constant"], settings: { foreground: "#899bdc" } },
      { scope: ["entity.name"], settings: { foreground: "#cfa1de" } },
      { scope: ["punctuation", "constant.character.escape"], settings: { foreground: "#9a9b9e" } },
    ] }],
  }));
  const engine = await highlighter;
  if (!loading.has(lang)) loading.set(lang, loader().then((grammar) => engine.loadLanguage(grammar.default)));
  await loading.get(lang);
  return engine.codeToTokens(code, { lang, theme: "space-slackbot" }).tokens.map((line) => line.map((token) => ({
    content: token.content, role: colors[token.color?.toLowerCase() ?? ""],
  })));
}
