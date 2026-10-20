/* FluxerBB plugin store — local HTTP API for the renderer.
 * SPDX-License-Identifier: MIT
 *
 * Binds 127.0.0.1 only. The renderer (fluxer-app://app) fetches this API to
 * list/install/remove plugins; the loader owns the filesystem.
 *
 * Layout:
 *   ~/.config/fluxer-bb/plugins/<id>/plugin.js
 *   ~/.config/fluxer-bb/plugins/<id>/manifest.json
 *   ~/.config/fluxer-bb/plugins.json          { enabled: {id: bool} }
 *
 * A store index is plain JSON (the same shape BetterFluxer used):
 *   { "plugins": [ { "id": "my-plugin", "manifest": "https://…/manifest.json" } ] }
 * or items may inline the code with "code": "…".
 *
 * Built-in index ("builtin") is read from <repo>/plugins/index.json.
 */
import {createServer} from "node:http";
import {promises as fs} from "node:fs";
import os from "node:os";
import path from "node:path";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_CODE = 512 * 1024;
const MAX_BODY = 1024 * 1024;
const MAX_INDEX_ITEMS = 100;
const FETCH_TIMEOUT = 12000;
// Browsers cannot send a custom header cross-origin without a successful CORS
// preflight, which this server only grants for our own headers. This blocks a
// drive-by webpage from POSTing to the localhost install endpoint.
const REQUEST_HEADER = "x-fluxer-bb-request";

export function defaultStateDir() {
	const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(base, "fluxer-bb");
}

/**
 * Accept `builtin`, `owner/repo`, a GitHub repo URL, or a raw index URL.
 * `owner/repo` maps to plugins/index.json on the default branch via HEAD.
 */
export function normalizeIndex(value) {
	const text = String(value || "").trim();
	if (!text || text === "builtin") return "builtin";
	let m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/plugins/index.json`;
	m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/plugins/index.json`;
	m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(text);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
	return text;
}

function isTrustedUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch (_) {
		return false;
	}
	if (url.protocol === "https:") return true;
	if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
		return true;
	}
	return false;
}

async function fetchText(url, limit = MAX_CODE) {
	if (!isTrustedUrl(url)) throw new Error("only https:// (or localhost http) URLs are allowed");
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
	try {
		const res = await fetch(url, {signal: ctrl.signal, redirect: "follow"});
		if (!isTrustedUrl(res.url || url)) throw new Error("redirected to an untrusted URL");
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		if (text.length > limit) throw new Error(`response larger than ${limit} bytes`);
		return text;
	} finally {
		clearTimeout(timer);
	}
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (_) {
		return fallback;
	}
}

async function readState(dir) {
	const state = await readJson(path.join(dir, "plugins.json"), {});
	return state && typeof state === "object" ? state : {};
}

async function writeState(dir, state) {
	await fs.mkdir(dir, {recursive: true});
	const tmp = path.join(dir, `.plugins.${process.pid}.tmp`);
	await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
	await fs.rename(tmp, path.join(dir, "plugins.json"));
}

function pluginDir(dir, id) {
	return path.join(dir, "plugins", id);
}

async function listInstalled(dir) {
	const root = path.join(dir, "plugins");
	let entries = [];
	try {
		entries = await fs.readdir(root, {withFileTypes: true});
	} catch (_) {
		return [];
	}
	const state = await readState(dir);
	const enabled = state.enabled && typeof state.enabled === "object" ? state.enabled : {};
	const out = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
		const base = path.join(root, entry.name);
		let code = null;
		try {
			code = await fs.readFile(path.join(base, "plugin.js"), "utf8");
		} catch (_) {
			continue;
		}
		const manifest = await readJson(path.join(base, "manifest.json"), {});
		out.push({
			id: entry.name,
			name: String(manifest.name || entry.name),
			version: String(manifest.version || "0.0.0"),
			description: String(manifest.description || ""),
			creator: String(manifest.creator || ""),
			enabled: enabled[entry.name] !== false,
			bytes: code.length,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadBuiltin(root) {
	const index = await readJson(path.join(root, "plugins", "index.json"), {plugins: []});
	const items = Array.isArray(index) ? index : index.plugins || [];
	const out = [];
	for (const item of items.slice(0, MAX_INDEX_ITEMS)) {
		const id = String((item && item.id) || "");
		if (!ID_RE.test(id)) continue;
		const base = path.join(root, "plugins", id);
		const manifest = await readJson(path.join(base, "manifest.json"), {});
		out.push({
			id,
			name: String(manifest.name || id),
			version: String(manifest.version || "0.0.0"),
			description: String(manifest.description || ""),
			creator: String(manifest.creator || ""),
			manifest: `builtin:${id}`,
		});
	}
	return out;
}

async function loadRemoteIndex(indexUrl) {
	const payload = JSON.parse(await fetchText(indexUrl, 1024 * 1024));
	const items = Array.isArray(payload) ? payload : payload.plugins || payload.items || [];
	const out = [];
	for (const item of items.slice(0, MAX_INDEX_ITEMS)) {
		const id = String((item && item.id) || "");
		if (!ID_RE.test(id)) continue;
		let manifest = null;
		if (item.manifest) {
			try {
				manifest = JSON.parse(await fetchText(String(item.manifest)));
			} catch (_) {
				manifest = null;
			}
		}
		const merged = manifest || {};
		const inlineCode = typeof item.code === "string" && item.code.length <= MAX_CODE ? item.code : null;
		out.push({
			id,
			name: String(item.name || merged.name || id),
			version: String(item.version || merged.version || "0.0.0"),
			description: String(item.description || merged.description || ""),
			creator: String(item.creator || merged.creator || ""),
			manifest: item.manifest ? String(item.manifest) : null,
			code: inlineCode,
		});
	}
	return out;
}

function safeRelativeMain(main) {
	const value = String(main || "plugin.js");
	if (!value || value.startsWith("/") || /^[a-z]+:/i.test(value)) {
		throw new Error("manifest main must be a relative path");
	}
	if (value.split("/").some((part) => !part || part === "..")) {
		throw new Error("manifest main may not contain empty or .. segments");
	}
	return value;
}

async function installPlugin({dir, root, id, manifestUrl, inlineCode, meta}) {
	const cleanId = String(id || "");
	if (!ID_RE.test(cleanId)) throw new Error("invalid plugin id");

	let manifest = meta && typeof meta === "object" ? meta : {};
	let code = "";

	if (manifestUrl && String(manifestUrl).startsWith("builtin:")) {
		const builtinId = String(manifestUrl).slice("builtin:".length);
		if (builtinId !== cleanId) throw new Error("builtin id mismatch");
		const base = path.join(root, "plugins", cleanId);
		manifest = await readJson(path.join(base, "manifest.json"), {});
		code = await fs.readFile(path.join(base, "plugin.js"), "utf8");
	} else if (manifestUrl) {
		manifest = JSON.parse(await fetchText(String(manifestUrl)));
		const main = safeRelativeMain(manifest.main);
		code = await fetchText(new URL(main, String(manifestUrl)).toString());
	} else if (typeof inlineCode === "string" && inlineCode.length) {
		code = inlineCode;
	} else {
		throw new Error("nothing to install: missing manifest or code");
	}

	if (code.length > MAX_CODE) throw new Error(`plugin code larger than ${MAX_CODE} bytes`);
	if (!code.trim()) throw new Error("plugin code is empty");

	const dest = pluginDir(dir, cleanId);
	await fs.mkdir(dest, {recursive: true});
	const tmp = path.join(dest, `.plugin.${process.pid}.tmp`);
	await fs.writeFile(tmp, code);
	await fs.rename(tmp, path.join(dest, "plugin.js"));
	await fs.writeFile(
		path.join(dest, "manifest.json"),
		JSON.stringify(
			{
				name: String(manifest.name || cleanId),
				id: cleanId,
				version: String(manifest.version || "0.0.0"),
				creator: String(manifest.creator || ""),
				description: String(manifest.description || ""),
				main: "plugin.js",
				apiVersion: Number(manifest.apiVersion) || 1,
				source: String(manifestUrl || "inline"),
			},
			null,
			2,
		) + "\n",
	);
	const state = await readState(dir);
	state.enabled = Object.assign({}, state.enabled, {[cleanId]: true});
	await writeState(dir, state);
	return cleanId;
}

async function removePlugin(dir, id) {
	if (!ID_RE.test(id)) throw new Error("invalid plugin id");
	await fs.rm(pluginDir(dir, id), {recursive: true, force: true});
	const state = await readState(dir);
	if (state.enabled && Object.prototype.hasOwnProperty.call(state.enabled, id)) {
		delete state.enabled[id];
		await writeState(dir, state);
	}
}

async function setEnabled(dir, id, enabled) {
	if (!ID_RE.test(id)) throw new Error("invalid plugin id");
	const state = await readState(dir);
	state.enabled = Object.assign({}, state.enabled, {[id]: Boolean(enabled)});
	await writeState(dir, state);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (err) {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

function send(res, status, body, headers) {
	res.writeHead(
		status,
		Object.assign(
			{
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, X-Fluxer-BB-Request",
				"Access-Control-Allow-Private-Network": "true",
				"Cache-Control": "no-store",
			},
			headers || {},
		),
	);
	res.end(body);
}

function json(res, status, value) {
	send(res, status, JSON.stringify(value), {"Content-Type": "application/json"});
}

/**
 * Start the store API. Returns the server, or null if the port is unavailable.
 */
export function startStoreServer({port = 9224, root, log = console.log, host = "127.0.0.1"} = {}) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		log(`store API: invalid port ${port}`);
		return null;
	}
	const stateDir = defaultStateDir();
	const server = createServer(async (req, res) => {
		if (req.method === "OPTIONS") return send(res, 204, "");
		let url;
		try {
			url = new URL(req.url || "/", `http://${host}:${port}`);
		} catch (_) {
			return json(res, 400, {error: "bad url"});
		}
		try {
			if (req.method === "GET" && url.pathname === "/api/health") {
				return json(res, 200, {ok: true, root, stateDir, port});
			}
			if (req.headers[REQUEST_HEADER] !== "1") {
				return json(res, 403, {error: "missing X-Fluxer-BB-Request header"});
			}

			if (req.method === "GET" && url.pathname === "/api/plugins") {
				return json(res, 200, {plugins: await listInstalled(stateDir), stateDir});
			}

			let match = url.pathname.match(/^\/api\/plugins\/([a-z0-9._-]+)\/code$/);
			if (req.method === "GET" && match) {
				const id = match[1];
				if (!ID_RE.test(id)) return json(res, 400, {error: "invalid plugin id"});
				try {
					const code = await fs.readFile(path.join(pluginDir(stateDir, id), "plugin.js"), "utf8");
					return send(res, 200, code, {"Content-Type": "text/javascript; charset=utf-8"});
				} catch (_) {
					return json(res, 404, {error: "not installed"});
				}
			}

			if (req.method === "POST" && url.pathname === "/api/plugins/install") {
				const body = await readBody(req);
				const id = await installPlugin({
					dir: stateDir,
					root,
					id: body.id,
					manifestUrl: body.manifest,
					inlineCode: body.code,
					meta: body.name
						? {
								name: body.name,
								version: body.version,
								description: body.description,
								creator: body.creator,
							}
						: null,
				});
				log(`store: installed ${id}`);
				return json(res, 200, {ok: true, id});
			}

			match = url.pathname.match(/^\/api\/plugins\/([a-z0-9._-]+)\/enabled$/);
			if (req.method === "POST" && match) {
				const body = await readBody(req);
				await setEnabled(stateDir, match[1], Boolean(body.enabled));
				log(`store: ${match[1]} ${body.enabled ? "enabled" : "disabled"}`);
				return json(res, 200, {ok: true});
			}

			match = url.pathname.match(/^\/api\/plugins\/([a-z0-9._-]+)$/);
			if (req.method === "DELETE" && match) {
				await removePlugin(stateDir, match[1]);
				log(`store: removed ${match[1]}`);
				return json(res, 200, {ok: true});
			}

			if (req.method === "GET" && url.pathname === "/api/store") {
				const requested = url.searchParams.get("url") || "builtin";
				const source = normalizeIndex(requested);
				const items = source === "builtin" ? await loadBuiltin(root) : await loadRemoteIndex(source);
				return json(res, 200, {items, source, requested});
			}

			return json(res, 404, {error: "not found"});
		} catch (err) {
			return json(res, 500, {error: err && err.message ? err.message : String(err)});
		}
	});
	server.on("error", (err) => {
		if (err && err.code === "EADDRINUSE") {
			log(`store API: port ${port} already in use (another loader?)`);
		} else {
			log(`store API error: ${err && err.message ? err.message : err}`);
		}
	});
	server.listen(port, host, () => {
		log(`store API on http://${host}:${port} (state: ${stateDir})`);
	});
	return server;
}
