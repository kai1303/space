import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
for (const file of ["tokens.css", "styles.css", "workplace.css", "work-items.css"])
  copyFileSync(`src/${file}`, `dist/${file}`);

const shared = {},
  light = {},
  dark = {};
for (const [, selector, body] of readFileSync(
  "src/tokens.css",
  "utf8",
).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const target = selector.includes('[data-theme="dark"]')
    ? dark
    : selector.includes('[data-theme="light"]')
      ? light
      : selector.trim().endsWith(":root")
        ? shared
        : null;
  if (!target) continue;
  for (const [, name, value] of body.matchAll(/(--sp-[\w-]+):\s*([^;]+);/g))
    if (/^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|var\(--sp-[\w-]+\))$/i.test(value.trim()))
      target[name] = value.trim();
}
function resolve(values) {
  const result = { ...shared, ...values };
  for (const name of Object.keys(result))
    for (let depth = 0; result[name]?.startsWith("var(") && depth < 10; depth++)
      result[name] = result[result[name].slice(4, -1)];
  if (Object.values(result).some((value) => !value || value.startsWith("var(")))
    throw new Error("Unresolved color token");
  return result;
}
writeFileSync(
  "dist/tokens.json",
  JSON.stringify({ light: resolve(light), dark: resolve(dark) }, null, 2) +
    "\n",
);
