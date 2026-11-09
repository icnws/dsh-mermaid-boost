window.__ModuleLoader__.load({
	id: "dsh-mermaid-boost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/*!
		 * dsh-mermaid-boost — client half.
		 *
		 * Renders ```mermaid code blocks as diagrams in the DeepSeek Harness Web
		 * GUI (chat transcript, Markdown document preview, deliverables — every
		 * surface built on the shared MarkdownText/CodeBlock components).
		 *
		 * Contract: the chat banner does not expose the fence language, so
		 * detection is content-based (first non-empty line must open a mermaid
		 * diagram); the document-preview banner carries the infostring, which is
		 * checked first. The mermaid library is served by this plugin's node half
		 * at /plugins-local/mermaid-boost/ and lazily imported on first use.
		 *
		 * React safety: the script never removes or reorders React-managed nodes.
		 * It only (a) toggles `display` on the content div, (b) appends its own
		 * trailing nodes (render box + chip) inside the block container, and
		 * (c) hides the box itself in source mode. Unmount cleans up naturally;
		 * streaming re-renders are debounced and served from a render cache.
		 */
		(() => {
			"use strict";
			// Diagnostic markers (set even when another mermaid-boost copy won the
			// shared guard, e.g. a leftover dist patch).
			window.__DSH_MERMAID_BOOST_PLUGIN__ = (window.__DSH_MERMAID_BOOST_PLUGIN__ || 0) + 1;
			if (window.__DSH_MERMAID_BOOST__) return;
			window.__DSH_MERMAID_BOOST__ = true;
			window.__DSH_MERMAID_BOOST_SOURCE__ = "plugin";

			const TAG = "[mermaid-boost]";
			const MERMAID_URL = new URL("plugins-local/mermaid-boost/mermaid.esm.min.js", document.baseURI).href;

			/** Quiet period before a (re)render is attempted; absorbs streaming tokens. */
			const RENDER_DEBOUNCE_MS = 1200;
			/** Parse errors surface only when the text has been stable this long; also the retry delay. */
			const ERROR_QUIET_MS = 2500;
			/** Trailing debounce for DOM scans. */
			const SCAN_DEBOUNCE_MS = 150;
			/** Guard: skip absurdly large blocks (not real diagrams, protect the tab). */
			const MAX_SOURCE_CHARS = 20000;
			/** Give up silently after this many quiet failures; a text change resets the count. */
			const MAX_QUIET_RETRIES = 3;

			/**
			 * Mermaid diagram openers, matched against the first non-empty line
			 * (after optional `---` frontmatter). Kept conservative: bare `block`,
			 * `info`, `toast` and friends are intentionally excluded to avoid
			 * false positives on prose or shell snippets.
			 */
			const OPENER_RE = /^\s*(?:flowchart(?:\s+[\w-]+)?|graph\s+(?:TB|TD|BT|RL|LR|H|V)\b|sequenceDiagram\b|classDiagram(?:-v2)?\b|stateDiagram(?:-v2)?\b|erDiagram\b|journey\b|gantt\b|pie\b|quadrantChart\b|requirementDiagram\b|gitGraph\b|mindmap\b|timeline\b|zenuml\b|sankey-beta\b|xychart-beta\b|block-beta\b|architecture-beta\b|C4(?:Context|Container|Component|Dynamic|Deployment)\b)/;

			const LABEL_DIAGRAM = "图表";
			const LABEL_SOURCE = "源码";
			const RENDERING_HINT = "正在渲染图表…";

			/* ------------------------------------------------------------------ *
			 * Styles
			 * ------------------------------------------------------------------ */
			const STYLE = `
div.md-code-block:has(> [data-mermaid-render]) { position: relative; }
div.md-code-block:has(> [data-mermaid-render]) > [data-code-block-content][data-mermaid-hidden] { display: none !important; }
[data-mermaid-render] { padding: 14px 16px 18px; overflow-x: auto; }
[data-mermaid-render][data-mermaid-state="rendering"]:empty::after {
	content: "${RENDERING_HINT}";
	color: var(--dsw-alias-label-tertiary, #888);
	font: 400 12px/20px var(--ds-font-family-code, monospace);
}
[data-mermaid-render] [data-mermaid-svg] svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
[data-mermaid-error] {
	margin: 4px 0 8px;
	color: var(--dsw-alias-state-error-primary, #c62828);
	font: 400 12px/18px var(--ds-font-family-code, monospace);
	white-space: pre-wrap;
	word-break: break-word;
}
[data-mermaid-toggle] {
	position: absolute; right: 12px; bottom: 8px; z-index: 3;
	border: none; cursor: pointer;
	color: var(--dsw-alias-label-secondary, #666);
	background: var(--dsw-alias-bg-base, rgba(127,127,127,.08));
	border-radius: 6px; padding: 2px 8px;
	font: 400 11px/18px var(--ds-font-family, inherit);
	opacity: .2; transition: opacity .15s ease;
}
div.md-code-block:hover > [data-mermaid-toggle],
div.md-code-block:focus-within > [data-mermaid-toggle],
[data-mermaid-toggle]:focus-visible { opacity: 1; }
`;
			document.head.appendChild(document.createElement("style")).textContent = STYLE;

			/* ------------------------------------------------------------------ *
			 * State
			 * ------------------------------------------------------------------ */
			/** Blocks already classified at least once. */
			const seen = new WeakSet();
			/** block -> per-block mutable state. */
			const state = new WeakMap();
			/** render cache: `${theme}\u0000${text}` -> svg markup. */
			const svgCache = new Map();
			const SVG_CACHE_LIMIT = 120;
			let uid = 0;
			let scanTimer = 0;

			function stateFor(block) {
				let st = state.get(block);
				if (!st) state.set(block, st = {
					text: null,
					timer: 0,
					inflight: false,
					pendingAfter: false,
					lastChange: 0,
					retries: 0,
					force: false,
					preferSource: false,
					box: null,
					chip: null,
					errorEl: null,
				});
				return st;
			}

			/* ------------------------------------------------------------------ *
			 * Mermaid library (lazy, queued, theme-aware)
			 * ------------------------------------------------------------------ */
			let libPromise = null;
			function loadMermaid() {
				if (!libPromise) {
					libPromise = import(MERMAID_URL).then((mod) => {
						const mermaid = mod.default ?? mod;
						mermaid.initialize({
							startOnLoad: false,
							securityLevel: "strict",
							logLevel: "fatal",
							suppressErrorRendering: true,
							theme: "default",
							fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
							altFontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
						});
						return mermaid;
					}).catch((error) => {
						libPromise = null;
						throw error;
					});
				}
				return libPromise;
			}

			/** Serialize renders; mermaid.initialize is global state, so theme flips must not interleave. */
			let renderChain = Promise.resolve();
			let activeTheme = "default";
			function renderQueued(mermaid, theme, text) {
				const job = renderChain.then(async () => {
					if (theme !== activeTheme) {
						mermaid.initialize({ theme });
						activeTheme = theme;
					}
					const key = `${theme}\u0000${text}`;
					const cached = svgCache.get(key);
					if (cached !== undefined) return cached;
					const { svg } = await mermaid.render(`mermaid-boost-${++uid}`, text);
					if (svgCache.size >= SVG_CACHE_LIMIT) {
						svgCache.delete(svgCache.keys().next().value);
					}
					svgCache.set(key, svg);
					return svg;
				});
				renderChain = job.catch(() => {});
				return job;
			}

			/* ------------------------------------------------------------------ *
			 * Detection & extraction
			 * ------------------------------------------------------------------ */
			function stripFrontmatter(text) {
				if (!text.startsWith("---")) return text;
				const end = text.indexOf("\n---", 3);
				if (end === -1) return text;
				const after = text.indexOf("\n", end + 1);
				return after === -1 ? "" : text.slice(after + 1);
			}

			function looksLikeMermaid(text, lang) {
				if (lang && /^mermaid\b/i.test(lang)) return true;
				if (!text || text.length > MAX_SOURCE_CHARS) return false;
				const body = stripFrontmatter(text);
				for (const line of body.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					return OPENER_RE.test(trimmed);
				}
				return false;
			}

			function codeLang(block) {
				const banner = block.querySelector("[data-code-block-banner]");
				const first = banner && banner.firstElementChild;
				return first ? first.textContent.trim() : "";
			}

			/** Source text exactly as the copy button sees it: the `pre` textContent. */
			function extractText(block) {
				const content = block.querySelector("[data-code-block-content]");
				const pre = (content || block).querySelector("pre");
				const text = pre ? pre.textContent : (content ? content.textContent : "");
				return text.replace(/\n$/, "");
			}

			function contentOf(block) {
				return block.querySelector("[data-code-block-content]");
			}

			/* ------------------------------------------------------------------ *
			 * DOM assembly
			 * ------------------------------------------------------------------ */
			function ensureBox(block, st) {
				if (st.box && st.box.isConnected) return st.box;
				const box = document.createElement("div");
				box.setAttribute("data-mermaid-render", "");
				box.setAttribute("data-mermaid-state", "rendering");
				const svg = document.createElement("div");
				svg.setAttribute("data-mermaid-svg", "");
				box.appendChild(svg);
				block.appendChild(box);
				st.box = box;
				return box;
			}

			function ensureChip(block, st) {
				if (st.chip && st.chip.isConnected) return st.chip;
				const chip = document.createElement("button");
				chip.type = "button";
				chip.setAttribute("data-mermaid-toggle", "");
				chip.addEventListener("click", (event) => {
					event.stopPropagation();
					st.preferSource = !st.preferSource;
					applyVisibility(block, st);
				});
				block.appendChild(chip);
				st.chip = chip;
				return chip;
			}

			function applyVisibility(block, st) {
				const content = contentOf(block);
				const boxState = st.box ? st.box.getAttribute("data-mermaid-state") : null;
				const showDiagram = !st.preferSource && boxState === "ok";
				const showError = !st.preferSource && boxState === "error";
				if (content) {
					if (showDiagram) content.setAttribute("data-mermaid-hidden", "");
					else content.removeAttribute("data-mermaid-hidden");
				}
				if (st.box) st.box.hidden = !(showDiagram || showError);
				if (st.chip) {
					st.chip.textContent = showDiagram ? LABEL_SOURCE : LABEL_DIAGRAM;
					st.chip.title = showDiagram ? "显示源码" : "显示图表";
				}
			}

			function setError(block, st, message) {
				if (st.box) {
					if (st.errorEl) st.errorEl.remove();
					st.errorEl = document.createElement("div");
					st.errorEl.setAttribute("data-mermaid-error", "");
					st.errorEl.textContent = `Mermaid 渲染失败：${message}`;
					st.box.appendChild(st.errorEl);
					st.box.setAttribute("data-mermaid-state", "error");
					st.box.hidden = false;
				}
				applyVisibility(block, st);
			}

			function clearError(st) {
				if (st.errorEl) {
					st.errorEl.remove();
					st.errorEl = null;
				}
			}

			/* ------------------------------------------------------------------ *
			 * Rendering pipeline
			 * ------------------------------------------------------------------ */
			function scheduleRender(block, delay, force) {
				const st = stateFor(block);
				if (force) st.force = true;
				clearTimeout(st.timer);
				st.timer = setTimeout(() => {
					void runRender(block);
				}, delay);
			}

			async function runRender(block) {
				const st = stateFor(block);
				const text = extractText(block);
				if (!looksLikeMermaid(text, codeLang(block))) return;
				// Skip when nothing changed — this also stops loops triggered by this
				// script's own DOM insertions (box/error/chip are mutations too).
				const unchanged = text === st.text && st.box && st.box.isConnected;
				const settled = block.getAttribute("data-mermaid-state") === "ok";
				if (unchanged && (settled || !st.force)) return;
				st.force = false;
				if (text !== st.text) {
					st.text = text;
					st.lastChange = Date.now();
					st.retries = 0;
				}
				if (st.inflight) {
					st.pendingAfter = true;
					return;
				}
				st.inflight = true;
				try {
					const mermaid = await loadMermaid();
					const theme = isDarkSurface(block) ? "dark" : "default";
					const box = ensureBox(block, st);
					box.setAttribute("data-mermaid-state", "rendering");
					clearError(st);
					const svg = await renderQueued(mermaid, theme, text);
					if (st.text !== text) return; // stale render, a newer one is queued
					box.querySelector("[data-mermaid-svg]").innerHTML = svg;
					box.setAttribute("data-mermaid-state", "ok");
					block.setAttribute("data-mermaid-state", "ok");
					ensureChip(block, st);
					applyVisibility(block, st);
				} catch (error) {
					const quietFor = Date.now() - st.lastChange;
					st.retries += 1;
					if (quietFor >= ERROR_QUIET_MS) {
						ensureBox(block, st);
						setError(block, st, error && error.message ? error.message : String(error));
						block.setAttribute("data-mermaid-state", "error");
					} else if (st.retries <= MAX_QUIET_RETRIES) {
						// Streaming in progress or first failure too fresh: stay quiet
						// for now, then retry once past the quiet window.
						scheduleRender(block, ERROR_QUIET_MS, true);
					}
					console.warn(TAG, "render failed:", error);
				} finally {
					st.inflight = false;
					if (st.pendingAfter) {
						st.pendingAfter = false;
						scheduleRender(block, 0);
					}
				}
			}

			function luminanceOf(color) {
				const m = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(color);
				if (!m) return null;
				const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
				const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
				return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
			}

			function isDarkSurface(el) {
				let node = el;
				for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
					const bg = getComputedStyle(node).backgroundColor;
					const lum = luminanceOf(bg);
					if (lum !== null) return lum < 0.5;
				}
				return window.matchMedia("(prefers-color-scheme: dark)").matches;
			}

			/* ------------------------------------------------------------------ *
			 * Scanning
			 * ------------------------------------------------------------------ */
			function classify(block) {
				if (block.hasAttribute("data-mermaid-skip") || block.hasAttribute("data-mermaid-state")) return;
				const text = extractText(block);
				if (!looksLikeMermaid(text, codeLang(block))) {
					block.setAttribute("data-mermaid-skip", "");
					return;
				}
				block.setAttribute("data-mermaid-state", "pending");
				const st = stateFor(block);
				st.text = text;
				st.lastChange = Date.now();
				scheduleRender(block, RENDER_DEBOUNCE_MS);
			}

			function rescan() {
				for (const block of document.querySelectorAll("div.md-code-block")) {
					if (!seen.has(block)) {
						seen.add(block);
						classify(block);
					}
				}
				// Streaming updates mutate children of already-classified blocks.
				for (const block of document.querySelectorAll('div.md-code-block[data-mermaid-state="pending"], div.md-code-block[data-mermaid-state="ok"], div.md-code-block[data-mermaid-state="error"]')) {
					const st = stateFor(block);
					const text = extractText(block);
					if (text !== st.text) {
						st.lastChange = Date.now();
						scheduleRender(block, RENDER_DEBOUNCE_MS);
					}
				}
			}

			function scheduleScan() {
				if (scanTimer) return;
				scanTimer = setTimeout(() => {
					scanTimer = 0;
					rescan();
				}, SCAN_DEBOUNCE_MS);
			}

			const observer = new MutationObserver((mutations) => {
				// Fast path: a mutation inside a handled block means its code changed.
				for (const mutation of mutations) {
					const target = mutation.target;
					const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
					const block = el && el.closest ? el.closest("div.md-code-block") : null;
					if (block && block.hasAttribute("data-mermaid-state")) {
						const st = stateFor(block);
						st.lastChange = Date.now();
						scheduleRender(block, RENDER_DEBOUNCE_MS);
					}
				}
				scheduleScan();
			});

			function start() {
				observer.observe(document.documentElement, { childList: true, subtree: true });
				rescan();
			}

			if (document.readyState === "loading") {
				document.addEventListener("DOMContentLoaded", start, { once: true });
			} else {
				start();
			}
		})();

		// Client module face: the shell mounts every graph row as a cordis
		// client plugin, so expose the minimal valid plugin shape. The DOM
		// behavior above is the module's real work; apply is intentionally
		// empty.
		module.exports.name = "mermaid-boost";
		module.exports.inject = [];
		module.exports.apply = () => {};
		return module.exports;
	}
});
