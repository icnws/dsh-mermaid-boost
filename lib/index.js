/**
 * dsh-mermaid-boost — node half.
 *
 * A minimal cordis plugin: injects the web server and registers one prefix
 * route that serves the bundled mermaid library (lib/mermaid/) to the browser
 * with correct JavaScript MIME. The client half (lib/client.js, mounted by the
 * dsh client module system through the `dsh.client` manifest) imports the
 * library from this route, so the whole plugin lives inside the profile
 * workspace and survives frontend rebuilds and dsh upgrades.
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Stable cordis plugin name. */
const name = "mermaid-boost";
/** Services required before the library route can mount. */
const inject = ["webServer"];

/** Absolute route prefix serving the mermaid library. */
const PREFIX = "/plugins-local/mermaid-boost";
const LIB_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "mermaid"));
const MIME = {
	".js": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml"
};

/**
 * Serve one GET/HEAD request from the library root. Unknown paths return 404
 * and traversal outside the library root returns 403, mirroring the
 * frontend-static contract.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function serve(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	const url = new URL(req.url ?? "/", "http://x");
	let rel;
	try {
		rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
	} catch {
		res.writeHead(400);
		res.end();
		return;
	}
	if (rel === "" || rel === "/") rel = "/mermaid.esm.min.js";
	const target = resolve(normalize(join(LIB_ROOT, rel)));
	if (target !== LIB_ROOT && !target.startsWith(LIB_ROOT + sep)) {
		res.writeHead(403);
		res.end();
		return;
	}
	try {
		const body = await readFile(target);
		res.writeHead(200, {
			"content-type": MIME[extname(target)] ?? "application/octet-stream",
			"cache-control": "public, max-age=3600"
		});
		res.end(req.method === "HEAD" ? undefined : body);
	} catch {
		res.writeHead(404);
		res.end();
	}
}

/**
 * Mount the library route.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context carrying the webServer service.
 */
function apply(ctx) {
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: PREFIX,
			handler: serve
		}), "mermaid-boost: mermaid library route");
	});
}

export { apply, inject, name };
