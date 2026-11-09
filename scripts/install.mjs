#!/usr/bin/env node
/**
 * Mounts dsh-mermaid-boost into a dsh profile's composition.
 *
 * Intended flow for an npm install (cross-platform; Windows/macOS/Linux):
 *
 *   dsh plugin --profile web add dsh-mermaid-boost
 *   node node_modules/dsh-mermaid-boost/scripts/install.mjs --profile web
 *
 * `dsh plugin add` already installs the package into the profile workspace
 * (dependency + node_modules link). The only remaining wiring is the loader
 * entry in the profile's cordis.patch.yml, which this script appends
 * (idempotent, with a one-time .bak-mermaid-boost backup).
 *
 * Afterwards restart dsh web.
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function argValue(flag) {
	const i = process.argv.indexOf(flag);
	return i !== -1 ? process.argv[i + 1] : undefined;
}

const profileName = argValue("--profile") ?? "web";
const dshHome = argValue("--dsh-home") ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", profileName);
const patchPath = join(profileDir, "cordis.patch.yml");

if (!existsSync(patchPath)) {
	console.error(`install: cordis.patch.yml not found at ${patchPath}`);
	console.error("install: run 'dsh' once to create the profile, or pass --profile <name> / --dsh-home <path>");
	process.exit(1);
}

const content = readFileSync(patchPath, "utf8");
if (content.includes("dsh-mermaid-boost")) {
	console.log("install: cordis.patch.yml already mounts dsh-mermaid-boost — nothing to do.");
} else {
	const backup = `${patchPath}.bak-mermaid-boost`;
	if (!existsSync(backup)) copyFileSync(patchPath, backup);
	const block = [
		"",
		"# mermaid-boost: render mermaid fenced code blocks as diagrams in the Web GUI",
		"# (chat, Markdown preview, deliverables). npm package: dsh-mermaid-boost.",
		"- insert:",
		"    - id: mermaid-boost",
		"      name: dsh-mermaid-boost",
		""
	].join("\n");
	let output = content;
	if (!output.endsWith("\n")) output += "\n";
	output += block;
	writeFileSync(patchPath, output);
	console.log(`install: appended the mermaid-boost entry to ${patchPath}`);
	console.log(`install: backup written to ${backup}`);
}

console.log("install: restart dsh web (close and run 'dsh web' again), then refresh the GUI.");
