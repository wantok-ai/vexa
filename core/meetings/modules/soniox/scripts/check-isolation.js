#!/usr/bin/env node
// gate:isolation (P2) — every import must stay inside the package, use a Node
// builtin, or name a declared dependency.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, "..", "src");
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const dependencies = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const builtins = new Set(builtinModules);
let files = 0;
const violations = [];

(function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) {
      files++;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const specifier = match[1] || match[2];
        if (specifier.startsWith(".")) continue;
        const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
        const root = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : bare.split("/")[0];
        if (builtins.has(bare) || builtins.has(root)) continue;
        if (dependencies.has(specifier) || dependencies.has(bare) || dependencies.has(root)) continue;
        violations.push(`${relative(sourceRoot, path)} → ${specifier}`);
      }
    }
  }
})(sourceRoot);

if (violations.length) {
  console.error("❌ ISOLATION VIOLATION:\n  " + violations.join("\n  "));
  process.exit(1);
}
console.log(`✅ ISOLATION VERIFIED — scanned ${files} files in src/; every import is intra-package, builtin, or declared.`);
