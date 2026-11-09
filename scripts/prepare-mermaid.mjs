#!/usr/bin/env node
/**
 * Vendors the mermaid v11 browser dist into lib/mermaid for use inside dsh.
 *
 * Why the extra processing (a plain copy of mermaid's dist does not work):
 *  - dsh's static file server has no MIME mapping for `.mjs`, so every module
 *    file is renamed to `.js` and each quoted import specifier ending in
 *    `.mjs` is rewritten to `.js` in the same pass;
 *  - source maps, type declarations and test/docs files are dropped — the
 *    runtime only needs mermaid.esm.min.js plus its chunk tree.
 *
 * Idempotent: exits early when lib/mermaid/mermaid.esm.min.js already exists.
 * Re-vendor by deleting the lib/mermaid directory first.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(packageRoot, "lib", "mermaid");
const entry = join(target, "mermaid.esm.min.js");

if (existsSync(entry)) {
	console.log("prepare-mermaid: lib/mermaid already present; delete lib/mermaid to re-vendor.");
	process.exit(0);
}

const stage = join(tmpdir(), `dsh-mermaid-boost-vendor-${process.pid}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log("prepare-mermaid: installing mermaid@11 with npm (this downloads ~15 MB) ...");
// Windows note: npm is a .cmd shim; Node ≥20 refuses to spawn .cmd without a
// shell (CVE-2024-27980 mitigation), so route through the shell there.
execFileSync(
	process.platform === "win32" ? "npm.cmd" : "npm",
	["install", "--prefix", stage, "mermaid@11", "--no-audit", "--no-fund", "--loglevel=error"],
	{ stdio: "inherit", shell: process.platform === "win32" }
);
const source = join(stage, "node_modules", "mermaid", "dist");
if (!existsSync(source)) {
	console.error(`prepare-mermaid: mermaid dist not found at ${source}; npm install failed?`);
	process.exit(1);
}

const SKIP_DIRS = new Set(["tests", "docs", "__mocks__"]);
const utf8 = { encoding: "utf8" };
let copied = 0;
let rewritten = 0;

function walk(dir) {
	for (const item of readdirSync(dir, { withFileTypes: true })) {
		if (item.isDirectory()) {
			if (SKIP_DIRS.has(item.name)) continue;
			walk(join(dir, item.name));
			continue;
		}
		const name = item.name;
		if (name.endsWith(".d.ts") || name.endsWith(".map") || name.includes(".spec.")) continue;
		const from = join(dir, name);
		const rel = from.slice(source.length + 1);
		const to = join(target, rel.endsWith(".mjs") ? rel.slice(0, -4) + ".js" : rel);
		mkdirSync(dirname(to), { recursive: true });		if (name.endsWith(".mjs") || name.endsWith(".js")) {
			let text = readFileSync(from, utf8);
			const original = text;
			text = text.replace(/\.mjs(?=["'])/g, ".js");
			text = text.replace(/\/\/# sourceMappingURL=.*(?:\r?\n)?/g, "");
			writeFileSync(to, text, utf8);
			if (text !== original) rewritten += 1;
		} else {
			writeFileSync(to, readFileSync(from));
		}
		copied += 1;
	}
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
walk(source);
rmSync(stage, { recursive: true, force: true });

console.log(`prepare-mermaid: vendored ${copied} files (${rewritten} rewritten) into lib/mermaid`);
