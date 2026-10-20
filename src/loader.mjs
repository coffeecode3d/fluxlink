/* Fluxer BroadcastBox Bridge — CDP loader / injector
 * SPDX-License-Identifier: MIT
 *
 * Fluxer desktop (V2) is Electron. Rather than repacking the root-owned
 * app.asar (which is what BetterFluxer/Reflux do, and which is why they no
 * longer work), this loader starts Fluxer with the Chrome DevTools Protocol
 * enabled and injects the plugin into the renderer's *main world*.
 *
 * Why main world matters: with contextIsolation a preload script gets its own
 * `navigator`, so patching navigator.mediaDevices from a preload has no effect
 * on the app. CDP injection reaches the same objects the app uses.
 *
 * No dependencies: uses Node's built-in fetch + WebSocket.
 *
 * Usage:
 *   node src/loader.mjs                 # attach to an already-running Fluxer
 *   node src/loader.mjs --check         # just list debuggable targets
 *   node src/loader.mjs --port 9222
 *   node src/loader.mjs --api-port 9224 # plugin-store API (default 9224)
 *
 * The companion script bin/fluxlink.js handles launching Fluxer with the right
 * flag (a running instance must be restarted for it to take effect).
 */
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {startStoreServer} from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PLUGIN_PATH = path.join(HERE, "plugin", "fluxer-bb.js");

const args = process.argv.slice(2);
function argValue(name, fallback) {
	const eq = args.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const i = args.indexOf(`--${name}`);
	if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
	return fallback;
}
const PORT = Number(argValue("port", process.env.FLUXER_DEBUG_PORT || 9222));
const API_PORT = Number(argValue("api-port", process.env.FLUXER_BB_API_PORT || 9224));
const CHECK_ONLY = args.includes("--check");
const VERBOSE = args.includes("--verbose");
// --force tears down a previously injected copy first, so plugin edits apply
// without restarting Fluxer.
const FORCE = args.includes("--force");
const DISCOVERY_URL = `http://127.0.0.1:${PORT}/json/list`;

function log(...a) {
	console.log(new Date().toISOString().slice(11, 19), "[loader]", ...a);
}

async function listTargets() {
	const res = await fetch(DISCOVERY_URL, {cache: "no-store"});
	if (!res.ok) throw new Error(`CDP discovery returned ${res.status}`);
	return res.json();
}

function isInjectable(target) {
	if (!target || target.type !== "page") return false;
	const url = String(target.url || "");
	if (!url || url.startsWith("devtools://") || url.startsWith("chrome-extension://")) return false;
	if (url.startsWith("about:blank")) return false;
	return Boolean(target.webSocketDebuggerUrl);
}

/** Minimal CDP client over the built-in WebSocket. */
class Session {
	constructor(ws, label) {
		this.ws = ws;
		this.label = label;
		this.nextId = 1;
		this.pending = new Map();
		this.onEvent = null;
		ws.addEventListener("message", (event) => this._onMessage(event.data));
		ws.addEventListener("close", () => this._failAll("socket closed"));
		ws.addEventListener("error", () => this._failAll("socket error"));
	}

	_onMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch (_) {
			return;
		}
		if (msg.id && this.pending.has(msg.id)) {
			const {resolve, reject} = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message || "CDP error"));
			else resolve(msg.result);
			return;
		}
		if (this.onEvent && msg.method) this.onEvent(msg.method, msg.params || {});
	}

	send(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {resolve, reject});
			try {
				this.ws.send(JSON.stringify({id, method, params: params || {}}));
			} catch (err) {
				this.pending.delete(id);
				reject(err);
			}
		});
	}

	_failAll(reason) {
		for (const {reject} of this.pending.values()) reject(new Error(reason));
		this.pending.clear();
	}

	close() {
		try {
			this.ws.close();
		} catch (_) {}
	}
}

function connect(url, label) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 8000);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(new Session(ws, label));
		});
		ws.addEventListener("error", (event) => {
			clearTimeout(timer);
			reject(new Error("CDP connect failed: " + (event.message || "error")));
		});
	});
}

async function injectInto(target, source) {
	const label = target.title || target.url;
	const session = await connect(target.webSocketDebuggerUrl, label);
	let navCount = 0;

	session.onEvent = async (method, params) => {
		if (method === "Runtime.consoleAPICalled") {
			if (!VERBOSE) return;
			const text = (params.args || [])
				.map((a) => (a.value !== undefined ? a.value : a.description || a.type))
				.join(" ");
			if (text.includes("[FluxerBB]")) log(`[page] ${text}`);
			return;
		}
		if (method === "Page.frameNavigated" && !(params.frame && params.frame.parentId)) {
			navCount += 1;
			log(`renderer navigated (${label}); re-arming injection`);
			await evaluate(session, source, label);
		}
	};

	await session.send("Runtime.enable");
	await session.send("Page.enable");

	// Arm for every future document load of this renderer.
	try {
		await session.send("Page.addScriptToEvaluateOnNewDocument", {source});
	} catch (err) {
		log("addScriptToEvaluateOnNewDocument unavailable:", err.message);
	}

	if (FORCE) {
		try {
			await session.send("Runtime.evaluate", {
				expression:
					"(async () => { try { if (window.__fluxerBB && window.__fluxerBB.stop) await window.__fluxerBB.stop(); } catch (e) {} delete window.__fluxerBB; return true; })()",
				awaitPromise: true,
				returnByValue: true,
			});
		} catch (err) {
			log("force teardown failed:", err.message);
		}
	}

	await evaluate(session, source, label);
	return session;
}

async function evaluate(session, source, label) {
	try {
		const result = await session.send("Runtime.evaluate", {
			expression: source,
			awaitPromise: false,
			returnByValue: true,
			allowUnsafeEvalBlockedByCSP: true,
		});
		if (result.exceptionDetails) {
			const desc =
				result.exceptionDetails.exception?.description ||
				result.exceptionDetails.text ||
				"unknown error";
			log(`inject FAILED in ${label}: ${String(desc).split("\n")[0]}`);
			return false;
		}
		const state = await session.send("Runtime.evaluate", {
			expression:
				"window.__fluxerBB ? JSON.stringify({version: window.__fluxerBB.version, state: window.__fluxerBB.state()}) : 'not-present'",
			returnByValue: true,
		});
		log(`injected into ${label} -> ${state.result?.value}`);
		return true;
	} catch (err) {
		log(`inject error in ${label}: ${err.message}`);
		return false;
	}
}

async function main() {
	let source;
	try {
		source = await readFile(PLUGIN_PATH, "utf8");
	} catch (err) {
		console.error(`Cannot read plugin at ${PLUGIN_PATH}: ${err.message}`);
		process.exitCode = 1;
		return;
	}
	// Tell the renderer where the plugin store API lives. Prepended so the
	// plugin also gets it through addScriptToEvaluateOnNewDocument.
	source = `window.__fluxerBBPluginApi = ${JSON.stringify(`http://127.0.0.1:${API_PORT}`)};\n` + source;

	let targets = [];
	try {
		targets = await listTargets();
	} catch (err) {
		if (CHECK_ONLY) {
			console.error(
				`\nNo debuggable Fluxer found on 127.0.0.1:${PORT} (${err.message}).\n` +
					`Start Fluxer with the flag first:\n` +
					`  node bin/fluxlink.js\n` +
					`or attach manually with the CDP flags:\n` +
					`  fluxer --remote-debugging-port=${PORT} --remote-allow-origins='*'\n`,
			);
			process.exitCode = 1;
			return;
		}
		// Stay alive: Fluxer may still be starting (or restarting). The watcher
		// below attaches as soon as the CDP endpoint appears.
		log(`no CDP on 127.0.0.1:${PORT} yet (${err.message}); waiting for Fluxer`);
	}

	const injectable = targets.filter(isInjectable);
	if (targets.length) {
		log(`${targets.length} target(s), ${injectable.length} injectable`);
		for (const t of targets) log(`  - ${t.type} | ${t.title || "(no title)"} | ${t.url.slice(0, 80)}`);
	}

	if (CHECK_ONLY) return;

	startStoreServer({port: API_PORT, root: ROOT, log});

	if (!injectable.length) {
		log("nothing to inject yet; waiting for a renderer window");
	}

	const sessions = new Map(); // targetId -> Session
	for (const target of injectable) {
		try {
			sessions.set(target.id, await injectInto(target, source));
		} catch (err) {
			log(`could not attach to ${target.title || target.url}: ${err.message}`);
		}
	}

	// Watch for windows that appear later (splash -> main, popouts, restarts).
	// Keep this timer ref'd: it is what keeps the loader alive across a Fluxer
	// quit/relaunch, so the plugin comes back without relaunching the wrapper.
	setInterval(async () => {
		let current;
		try {
			current = await listTargets();
		} catch (_) {
			return; // app closed or restarting
		}
		for (const target of current.filter(isInjectable)) {
			if (sessions.has(target.id)) continue;
			try {
				sessions.set(target.id, await injectInto(target, source));
			} catch (err) {
				log(`attach failed for new target: ${err.message}`);
			}
		}
		for (const [id, session] of sessions) {
			if (!current.some((t) => t.id === id)) {
				session.close();
				sessions.delete(id);
			}
		}
	}, 4000);

	log("loader running — press Ctrl-C to detach (Fluxer keeps the injected plugin)");
}

await main();
