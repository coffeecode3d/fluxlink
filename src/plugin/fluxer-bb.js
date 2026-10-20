/* Fluxer BroadcastBox Bridge — injected plugin (main world)
 * SPDX-License-Identifier: MIT
 *
 * Makes a self-hosted Broadcast Box instance act as the transport for Fluxer's
 * *native* screen share.
 *
 *   Publisher (mode "bb"):
 *     Fluxer asks for the screen -> we capture it at native resolution / high fps
 *     -> publish it to Broadcast Box over WHIP -> hand Fluxer a small placeholder
 *     stream so the normal Go Live state, tile, preview and audio still work.
 *
 *   Viewer:
 *     For every screen-share tile, derive the broadcaster's stream key from the
 *     LiveKit participant identity (user_<id>_<connection>) and, if that stream is
 *     live on Broadcast Box, subscribe with WHEP and swap the MediaStream into
 *     Fluxer's existing <video>. The native tile / focus view / controls stay, the
 *     video bytes come from the Broadcast Box server.
 *
 *   Mode "uncapped":
 *     No Broadcast Box. Capture at full resolution/fps and raise the LiveKit
 *     sender's bitrate/framerate caps, so unmodified viewers still see a good
 *     stream through Fluxer's own SFU.
 *
 *   Mirror:
 *     Attach to an existing Broadcast Box broadcast (for example an OBS scene
 *     already publishing to the same instance), subscribe to it over WHEP, and
 *     use that stream as Fluxer's screen-share source. No second encode to
 *     Broadcast Box; Fluxer publishes the mirrored feed to LiveKit and the
 *     normal Go Live state/tile/audio work.
 *
 * Everything is wrapped in try/catch: Fluxer's own screen share must never break
 * because of this plugin.
 *
 * Verified against Fluxer 2026.1015.145325 and Broadcast Box d4d186a:
 *   - capture: navigator.mediaDevices.getDisplayMedia (DisplayMediaCapture.ts)
 *   - viewer tile: [data-source="screen_share"] > video[data-flx=...video-track]
 *   - track ref reachable via the React fiber on the tile element
 *   - WHIP: POST /api/whip (Bearer <key>) -> 201 + Location + answer SDP
 *   - WHEP: POST /api/whep (Bearer <key>) -> answer SDP
 *   - status: GET /api/status?key=<key> (404 = offline on this build)
 */
(function () {
	"use strict";

	const VERSION = "0.7.0";
	const TAG = "[FluxerBB]";

	if (window.__fluxerBB && window.__fluxerBB.version) {
		console.log(TAG, "already injected (v" + window.__fluxerBB.version + ")");
		return;
	}

	/* ------------------------------------------------------------------ config */

	const DEFAULTS = {
		// Empty on purpose: the mod ships without a default instance. Paste your
		// own Broadcast Box URL in the panel; it is saved as soon as it changes.
		host: "",
		// "bb"       = native Fluxer screenshare backed by Broadcast Box (needs the
		//              viewer plugin on the other end to see the full-quality video)
		// "uncapped" = no Broadcast Box, just lift Fluxer's capture/encode caps
		mode: "bb",
		// "h264" = hardware-encodable on AMD/Intel (VAAPI) and passthrough-safe
		//          through Broadcast Box. "vp9" is a software-only fallback (no
		//          AMD hardware encoder exists for VP9). "auto" lets Chrome pick.
		codec: "h264",
		// 0 = capture at native resolution. Otherwise cap the capture height
		// (Fluxer's own resolution presets are paywalled; this bypasses the gate).
		maxHeight: 1080,
		// Reorder SPS/PPS ahead of the IDR slice. Required for hardware H264 on
		// Mesa/radeonsi (Chromium issue 574768145); harmless elsewhere.
		h264NalFix: true,
		fps: 60,
		maxBitrateMbps: 20,
		placeholderWidth: 640,
		placeholderFps: 2,
		keyPrefix: "fluxer-",
		// Last stream key/URL used by the "mirror an existing broadcast" box.
		// Stored locally so the panel remembers what you were mirroring.
		mirrorKey: "",
		autoSwap: true,
		// Plugin store index. "builtin" uses the index shipped in this repo;
		// any https:// URL (GitHub raw, gist, your own host) works too.
		storeIndex: "builtin",
	};
	const STORE_KEY = "fluxerBB.config.v2";

	function log(...a) {
		try {
			console.log(TAG, ...a);
		} catch (_) {}
	}
	function warn(...a) {
		try {
			console.warn(TAG, ...a);
		} catch (_) {}
	}

	function sanitizeConfig(cfg) {
		cfg.host = String(cfg.host || "").replace(/\/+$/, "");
		cfg.codec = ["h264", "vp9", "auto"].includes(cfg.codec) ? cfg.codec : "h264";
		cfg.maxHeight = [0, 720, 1080, 1440, 2160].includes(Number(cfg.maxHeight))
			? Number(cfg.maxHeight)
			: 1080;
		cfg.h264NalFix = cfg.h264NalFix !== false;
		cfg.fps = Math.max(15, Math.min(120, Number(cfg.fps) || 60));
		cfg.maxBitrateMbps = Math.max(1, Math.min(80, Number(cfg.maxBitrateMbps) || 20));
		cfg.placeholderWidth = Math.max(160, Math.min(1920, Number(cfg.placeholderWidth) || 640));
		cfg.placeholderFps = Math.max(1, Math.min(30, Number(cfg.placeholderFps) || 2));
		cfg.mirrorKey = String(cfg.mirrorKey || "").trim();
		cfg.storeIndex = String(cfg.storeIndex || "builtin");
		return cfg;
	}

	function loadConfig() {
		let stored = {};
		try {
			stored = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
		} catch (_) {
			stored = {};
		}
		return sanitizeConfig(Object.assign({}, DEFAULTS, stored));
	}
	const config = loadConfig();
	const store = { dirty: false };

	// This Fluxer build exposes no localStorage/sessionStorage/IndexedDB on
	// fluxer-app://, but its preload ships a scoped desktop KV store. Fall back
	// to it so panel settings survive a reload.
	function desktopStore() {
		const api = window.electron && window.electron.desktopStorage;
		return api && typeof api.get === "function" && typeof api.set === "function" ? api : null;
	}

	function saveConfig() {
		store.dirty = true;
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(config));
		} catch (_) {}
		try {
			const api = desktopStore();
			if (!api) return;
			const pending = api.set("fluxer-bb", "config", JSON.stringify(config));
			if (pending && typeof pending.catch === "function") pending.catch(() => {});
		} catch (_) {}
	}

	function hydrateConfig() {
		try {
			const api = desktopStore();
			if (!api) return;
			Promise.resolve(api.get("fluxer-bb", "config"))
				.then((entry) => {
					if (store.dirty || !entry || !entry.value) return;
					let saved = null;
					try {
						saved = JSON.parse(entry.value);
					} catch (_) {
						return;
					}
					if (!saved || typeof saved !== "object") return;
					sanitizeConfig(Object.assign(config, saved));
					const logged = Object.assign({}, config);
					if (logged.mirrorKey) logged.mirrorKey = "<set>";
					log("restored saved config", JSON.stringify(logged));
					try {
						render();
					} catch (_) {}
				})
				.catch(() => {});
		} catch (_) {}
	}

	/* --------------------------------------------------------- plugin runtime */

	function pluginApiBase() {
		return String(window.__fluxerBBPluginApi || "http://127.0.0.1:9224").replace(/\/+$/, "");
	}

	async function pluginFetch(path, options) {
		const opts = Object.assign({ cache: "no-store" }, options || {});
		opts.headers = Object.assign({ "X-Fluxer-BB-Request": "1" }, (options && options.headers) || {});
		const res = await fetch(pluginApiBase() + path, opts);
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.json()).error || "";
			} catch (_) {}
			throw new Error(detail || "HTTP " + res.status);
		}
		return res;
	}

	async function apiPost(path, body, method) {
		return pluginFetch(path, {
			method: method || "POST",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	}

	const pluginHost = { entries: new Map(), available: null, error: null, loaded: false };

	function makePluginContext(id, manifest) {
		const disposers = [];
		return {
			id,
			manifest,
			config,
			bb: window.__fluxerBB,
			log: (...a) => log("[plugin:" + id + "]", ...a),
			warn: (...a) => warn("[plugin:" + id + "]", ...a),
			state: () => window.__fluxerBB.state(),
			kv: {
				async get(key) {
					const api = desktopStore();
					if (!api) return undefined;
					try {
						const entry = await api.get("fluxer-bb-plugins", id + ":" + key);
						return entry ? entry.value : undefined;
					} catch (_) {
						return undefined;
					}
				},
				async set(key, value) {
					const api = desktopStore();
					if (!api) return;
					try {
						await api.set("fluxer-bb-plugins", id + ":" + key, String(value));
					} catch (_) {}
				},
			},
			setInterval(fn, ms) {
				const timer = setInterval(fn, ms);
				disposers.push(() => clearInterval(timer));
				return timer;
			},
			setTimeout(fn, ms) {
				const timer = setTimeout(fn, ms);
				disposers.push(() => clearTimeout(timer));
				return timer;
			},
			onDispose(fn) {
				if (typeof fn === "function") disposers.push(fn);
			},
			disposers,
		};
	}

	async function createPluginEntry(id, meta, code) {
		const entry = { id, meta, def: null, ctx: null, running: false };
		entry.ctx = makePluginContext(id, meta);
		let defineError = null;
		const define = (def) => {
			try {
				if (!def || typeof def !== "object") throw new Error("define() expects an object");
				if (typeof def.start !== "function" && typeof def.stop !== "function") {
					throw new Error("plugin has neither start nor stop");
				}
				entry.def = def;
			} catch (err) {
				defineError = err;
			}
		};
		// The app ships a CSP without 'unsafe-eval', so new Function() is refused.
		// blob: is allowed, so run the plugin as an external script instead.
		const source = `(function(define, ctx){\n${code}\n})(window.__fluxerBBPluginDefine, window.__fluxerBBPluginCtx);`;
		const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
		window.__fluxerBBPluginDefine = define;
		window.__fluxerBBPluginCtx = entry.ctx;
		try {
			await new Promise((resolve, reject) => {
				const script = document.createElement("script");
				script.src = url;
				script.onload = () => resolve();
				script.onerror = () => reject(new Error("plugin script was blocked (CSP?)"));
				(document.head || document.documentElement).appendChild(script);
			});
		} finally {
			URL.revokeObjectURL(url);
			try {
				delete window.__fluxerBBPluginDefine;
				delete window.__fluxerBBPluginCtx;
			} catch (_) {}
		}
		if (defineError) throw defineError;
		if (!entry.def) throw new Error("plugin did not call define()");
		return entry;
	}

	async function startPlugin(entry) {
		if (!entry || entry.running) return;
		entry.running = true;
		try {
			if (typeof entry.def.start === "function") await entry.def.start(entry.ctx);
			log("plugin started:", entry.id);
		} catch (err) {
			warn("plugin " + entry.id + " start failed:", err);
		}
	}

	function stopPlugin(entry) {
		if (!entry) return;
		try {
			if (typeof entry.def.stop === "function") entry.def.stop(entry.ctx);
		} catch (err) {
			warn("plugin " + entry.id + " stop failed:", err);
		}
		for (const fn of entry.ctx.disposers.splice(0)) {
			try {
				fn();
			} catch (_) {}
		}
		if (entry.running) log("plugin stopped:", entry.id);
		entry.running = false;
	}

	async function refreshPlugins() {
		let data;
		try {
			data = await (await pluginFetch("/api/plugins")).json();
			pluginHost.error = null;
			pluginHost.available = data.plugins || [];
			pluginHost.loaded = true;
		} catch (err) {
			pluginHost.error = err && err.message ? err.message : String(err);
			renderPluginSection();
			return false;
		}

		const seen = new Set();
		for (const meta of pluginHost.available) {
			seen.add(meta.id);
			const existing = pluginHost.entries.get(meta.id);
			if (!meta.enabled) {
				if (existing) stopPlugin(existing);
				continue;
			}
			if (existing) {
				if (!existing.running) await startPlugin(existing);
				continue;
			}
			try {
				const code = await (await pluginFetch("/api/plugins/" + encodeURIComponent(meta.id) + "/code")).text();
				const entry = await createPluginEntry(meta.id, meta, code);
				pluginHost.entries.set(meta.id, entry);
				await startPlugin(entry);
			} catch (err) {
				warn("plugin " + meta.id + " could not load:", err);
			}
		}
		for (const [id, entry] of Array.from(pluginHost.entries.entries())) {
			if (!seen.has(id)) {
				stopPlugin(entry);
				pluginHost.entries.delete(id);
			}
		}
		renderPluginSection();
		return true;
	}

	async function setPluginEnabled(id, enabled) {
		try {
			await apiPost("/api/plugins/" + encodeURIComponent(id) + "/enabled", { enabled });
			await refreshPlugins();
		} catch (err) {
			pluginHost.error = err && err.message ? err.message : String(err);
			renderPluginSection();
		}
	}

	async function removePlugin(meta) {
		try {
			await apiPost("/api/plugins/" + encodeURIComponent(meta.id), null, "DELETE");
			await refreshPlugins();
		} catch (err) {
			pluginHost.error = err && err.message ? err.message : String(err);
			renderPluginSection();
		}
	}

	function showStore(show) {
		if (!ui.els.storeView) return;
		ui.els.storeView.style.display = show ? "block" : "none";
		ui.els.pluginList.style.display = show ? "none" : "flex";
		ui.els.storeBtn.textContent = show ? "Back" : "Store";
		if (show) {
			ui.els.indexInput.value = config.storeIndex || "builtin";
			loadStore();
		}
		positionPanel();
	}

	async function loadStore() {
		if (!ui.els.storeList) return;
		const list = ui.els.storeList;
		list.textContent = "";
		ui.els.storeStatus.textContent = "Loading…";
		try {
			const src = String(ui.els.indexInput.value || "builtin").trim() || "builtin";
			if (config.storeIndex !== src) {
				config.storeIndex = src;
				saveConfig();
			}
			const data = await (await pluginFetch("/api/store?url=" + encodeURIComponent(src))).json();
			const items = data.items || [];
			if (!items.length) {
				ui.els.storeStatus.textContent = "Index is empty (" + src + ").";
				return;
			}
			const installed = new Set((pluginHost.available || []).map((p) => p.id));
			for (const item of items) {
				const row = el("div", { className: "plugin-row" });
				const main = el("div", { className: "plugin-main" });
				main.appendChild(
					el("div", {
						className: "plugin-name",
						textContent: item.name + (item.version ? " · v" + item.version : ""),
					}),
				);
				const desc = item.description || item.creator || "";
				if (desc) main.appendChild(el("div", { className: "plugin-desc", textContent: desc }));
				row.appendChild(main);
				const isInstalled = installed.has(item.id);
				const available = Boolean(item.manifest || item.code);
				const btn = el("button", {
					className: "mini",
					textContent: isInstalled ? "Installed" : available ? "Install" : "Unavailable",
				});
				btn.disabled = isInstalled || !available;
				btn.addEventListener("click", () => installFromStore(item, btn));
				row.appendChild(btn);
				list.appendChild(row);
			}
			ui.els.storeStatus.textContent = items.length + " item(s) · " + src;
		} catch (err) {
			ui.els.storeStatus.textContent = "Store error: " + (err && err.message ? err.message : err);
		} finally {
			positionPanel();
		}
	}

	async function installPluginItem(item) {
		await apiPost("/api/plugins/install", {
			id: item.id,
			manifest: item.manifest,
			code: item.code,
			name: item.name,
			version: item.version,
			description: item.description,
			creator: item.creator,
		});
		await refreshPlugins();
	}

	async function installFromStore(item, btn) {
		if (btn) {
			btn.disabled = true;
			btn.textContent = "Installing…";
		}
		try {
			await installPluginItem(item);
			await loadStore();
		} catch (err) {
			ui.els.storeStatus.textContent = "Install failed: " + (err && err.message ? err.message : err);
			if (btn) {
				btn.disabled = false;
				btn.textContent = "Install";
			}
		}
	}

	function renderPluginSection() {
		if (!ui.els.pluginList) return;
		const list = ui.els.pluginList;
		list.textContent = "";
		if (pluginHost.error) {
			list.appendChild(el("div", { className: "hint err", textContent: "Plugin API: " + pluginHost.error }));
			return;
		}
		if (!pluginHost.loaded) {
			list.appendChild(el("div", { className: "hint", textContent: "Loading plugins…" }));
			return;
		}
		const items = pluginHost.available || [];
		if (!items.length) {
			list.appendChild(el("div", { className: "hint", textContent: "No plugins installed — open the store." }));
			return;
		}
		for (const meta of items) {
			const row = el("div", { className: "plugin-row" });
			const main = el("div", { className: "plugin-main" });
			main.appendChild(
				el("div", {
					className: "plugin-name",
					textContent: meta.name + (meta.version ? " · v" + meta.version : ""),
				}),
			);
			if (meta.description) {
				main.appendChild(el("div", { className: "plugin-desc", textContent: meta.description }));
			}
			row.appendChild(main);
			const toggle = el("button", { className: "mini", textContent: meta.enabled ? "Disable" : "Enable" });
			toggle.addEventListener("click", () => setPluginEnabled(meta.id, !meta.enabled));
			const remove = el("button", { className: "mini danger", textContent: "Remove" });
			let armed = false;
			let resetTimer = null;
			remove.addEventListener("click", () => {
				if (!armed) {
					armed = true;
					remove.textContent = "Confirm";
					resetTimer = setTimeout(() => {
						armed = false;
						remove.textContent = "Remove";
					}, 3000);
					return;
				}
				clearTimeout(resetTimer);
				removePlugin(meta);
			});
			remove.addEventListener("blur", () => {
				if (!armed) return;
				clearTimeout(resetTimer);
				armed = false;
				remove.textContent = "Remove";
			});
			row.appendChild(toggle);
			row.appendChild(remove);
			list.appendChild(row);
		}
	}

	/* --------------------------------------------- Fluxer settings plugin page */

	/*
	 * Fluxer's settings modal is React-owned. We keep its header (so the
	 * close/back affordances still work), hide the current page body, and
	 * append our own scrollable page into the same content card. Clicking any
	 * native sidebar item restores the body before React handles the click.
	 */
	const settingsPageState = {
		page: null,
		card: null,
		body: null,
		bodyDisplay: "",
		title: null,
		titleText: "",
		link: null,
		linkDisplay: "",
		guards: false,
		guardHandler: null,
	};

	function settingsPad() {
		return (
			document.querySelector(
				'[data-flx="app.settings-modal-layout.settings-modal-desktop-content-component.desktop-content-pad"]',
			) || document.querySelector('[class*="desktopContentPad"]')
		);
	}

	function settingsCard() {
		const pad = settingsPad();
		if (!pad) return null;
		return (
			pad.querySelector(
				'[data-flx="app.settings-modal-layout.settings-modal-desktop-content-component.desktop-content-card"]',
			) || pad.querySelector('[class*="desktopContentCard"]')
		);
	}

	function mountSettingsPageStyles() {
		if (document.getElementById("fluxer-bb-settings-style")) return;
		const style = document.createElement("style");
		style.id = "fluxer-bb-settings-style";
		style.textContent = `
#fluxer-bb-settings-page {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; box-sizing: border-box;
  padding: 26px 32px 44px; color: var(--text-primary, #f4f4f6);
  font-family: var(--font-sans, "Fluxer Sans", system-ui, sans-serif);
  font-size: 13px; line-height: 1.5;
}
#fluxer-bb-settings-page *, #fluxer-bb-settings-page *::before, #fluxer-bb-settings-page *::after { box-sizing: border-box; }
#fluxer-bb-settings-page .bs-wrap { width: 100%; max-width: 720px; margin: 0 auto; }
#fluxer-bb-settings-page h1 { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -.01em; }
#fluxer-bb-settings-page h2 { margin: 0; font-size: 15px; font-weight: 600; }
#fluxer-bb-settings-page .bs-sub { margin: 0 0 20px; color: var(--text-tertiary, #b5bac1); font-size: 13px; }
#fluxer-bb-settings-page .bs-card { background: color-mix(in srgb, var(--text-primary, #fff) 4%, transparent); border: 1px solid color-mix(in srgb, var(--text-primary, #fff) 8%, transparent); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
#fluxer-bb-settings-page .bs-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
#fluxer-bb-settings-page .bs-help { margin: 6px 0 12px; color: var(--text-tertiary, #b5bac1); font-size: 12px; line-height: 1.55; }
#fluxer-bb-settings-page code { background: color-mix(in srgb, var(--text-primary, #fff) 8%, transparent); border-radius: 4px; padding: 1px 5px; font: 11px ui-monospace, "Cascadia Code", Consolas, monospace; }
#fluxer-bb-settings-page .bs-row { display: flex; align-items: center; gap: 8px; }
#fluxer-bb-settings-page input[type="text"] { flex: 1 1 auto; min-width: 0; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--text-primary, #fff) 13%, transparent); background: color-mix(in srgb, var(--text-primary, #fff) 6%, transparent); color: inherit; padding: 9px 11px; font: inherit; font-size: 12px; }
#fluxer-bb-settings-page input[type="text"]::placeholder { color: color-mix(in srgb, var(--text-primary, #fff) 45%, transparent); }
#fluxer-bb-settings-page input[type="text"]:focus { outline: none; border-color: var(--brand-primary, #7a6cff); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-primary, #7a6cff) 25%, transparent); }
#fluxer-bb-settings-page button { flex: none; cursor: pointer; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--text-primary, #fff) 13%, transparent); background: var(--button-secondary-fill, rgba(255,255,255,.06)); color: var(--text-primary, #ececf0); padding: 8px 12px; font: inherit; font-size: 12px; white-space: nowrap; }
#fluxer-bb-settings-page button:hover:not(:disabled) { background: var(--button-secondary-active-fill, rgba(255,255,255,.11)); }
#fluxer-bb-settings-page button:disabled { opacity: .5; cursor: default; }
#fluxer-bb-settings-page button.bs-primary { background: var(--brand-primary, #5865f2); border-color: var(--brand-primary, #5865f2); color: #fff; }
#fluxer-bb-settings-page button.bs-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--brand-primary, #5865f2) 82%, #000); }
#fluxer-bb-settings-page button.bs-danger { color: var(--control-button-danger-text, #ff9a9a); border-color: color-mix(in srgb, var(--button-danger-fill, #e5484d) 45%, transparent); }
#fluxer-bb-settings-page .bs-status { min-height: 15px; margin-top: 9px; color: var(--text-tertiary, #8f949c); font-size: 11px; }
#fluxer-bb-settings-page .bs-status.err { color: var(--status-danger, #ff9a9a); }
#fluxer-bb-settings-page .bs-muted { color: var(--text-tertiary, #8f949c); font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#fluxer-bb-settings-page .bs-rowitem { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid color-mix(in srgb, var(--text-primary, #fff) 7%, transparent); }
#fluxer-bb-settings-page .bs-rowitem:first-child { border-top: 0; padding-top: 0; }
#fluxer-bb-settings-page .bs-main { flex: 1 1 auto; min-width: 0; }
#fluxer-bb-settings-page .bs-name { font-size: 13px; }
#fluxer-bb-settings-page .bs-desc { margin-top: 2px; color: var(--text-tertiary, #b5bac1); font-size: 11.5px; line-height: 1.45; }
#fluxer-bb-settings-page .bs-empty { color: var(--text-tertiary, #8f949c); font-size: 12px; padding: 4px 0 2px; }
#fluxer-bb-settings-page .bs-warn { margin: 16px 0 0; color: var(--text-tertiary, #8f949c); font-size: 11px; line-height: 1.5; }
#fluxer-bb-settings-page .bs-switch { position: relative; flex: none; display: inline-block; width: 36px; height: 20px; }
#fluxer-bb-settings-page .bs-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
#fluxer-bb-settings-page .bs-slider { position: absolute; inset: 0; border-radius: 20px; background: color-mix(in srgb, var(--text-primary, #fff) 28%, transparent); transition: background .15s; }
#fluxer-bb-settings-page .bs-slider::before { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
#fluxer-bb-settings-page .bs-switch input:checked + .bs-slider { background: var(--accent-success, #3ba55c); }
#fluxer-bb-settings-page .bs-switch input:checked + .bs-slider::before { transform: translateX(16px); }
#fluxer-bb-settings-page .bs-switch input:disabled + .bs-slider { opacity: .5; }
#fluxer-bb-settings-page .bs-switch input:focus-visible + .bs-slider { outline: 2px solid var(--brand-primary, #7aa2ff); outline-offset: 2px; }
.fluxer-bb-settings-open [role="treeitem"]:not(#fluxer-bb-settings-entry)[class*="sidebarItemSelected"],
.fluxer-bb-settings-open [role="treeitem"]:not(#fluxer-bb-settings-entry)[class*="sidebarSubItemActive"] {
  background-color: transparent !important;
  background-image: none !important;
}
.fluxer-bb-settings-open [role="treeitem"]:not(#fluxer-bb-settings-entry)[class*="sidebarItemSelected"] [class*="sidebarItemLabel"],
.fluxer-bb-settings-open [role="treeitem"]:not(#fluxer-bb-settings-entry)[class*="sidebarSubItemActive"] [class*="sidebarSubItemLabel"] {
  color: var(--text-tertiary, #b1acbb) !important;
  font-weight: 500 !important;
}
.fluxer-bb-settings-open [class*="sidebarSubItems"]::before { display: none !important; }
#fluxer-bb-settings-entry[aria-selected="true"] { background-color: var(--surface-interactive-selected-bg, rgba(255,255,255,.1)) !important; }
`;
		(document.head || document.documentElement).appendChild(style);
	}

	function settingsStatus(message, isError) {
		const page = settingsPageState.page;
		const node = page && page.querySelector("#bs-index-status");
		if (!node) return;
		node.textContent = message || "";
		node.classList.toggle("err", Boolean(isError));
	}

	function prettyIndexSource(source) {
		if (!source || source === "builtin") return "Built-in index";
		try {
			const url = new URL(source);
			if (url.hostname === "raw.githubusercontent.com") {
				const parts = url.pathname.split("/").filter(Boolean);
				if (parts.length >= 2) return parts[0] + "/" + parts[1];
			}
			return url.host + url.pathname;
		} catch (_) {
			return String(source);
		}
	}

	function makeSettingsRow(name, version, description) {
		const row = el("div", { className: "bs-rowitem" });
		const main = el("div", { className: "bs-main" });
		main.appendChild(
			el("div", {
				className: "bs-name",
				textContent: name + (version ? " · v" + version : ""),
			}),
		);
		if (description) main.appendChild(el("div", { className: "bs-desc", textContent: description }));
		row.appendChild(main);
		return {row, main};
	}

	function renderSettingsInstalled(page) {
		if (!page || !page.isConnected) return;
		const box = page.querySelector("#bs-installed");
		if (!box) return;
		box.textContent = "";
		if (pluginHost.error) {
			box.appendChild(el("div", { className: "bs-empty", textContent: "Plugin API: " + pluginHost.error }));
			return;
		}
		if (!pluginHost.loaded) {
			box.appendChild(el("div", { className: "bs-empty", textContent: "Loading plugins…" }));
			return;
		}
		const items = pluginHost.available || [];
		if (!items.length) {
			box.appendChild(
				el("div", {
					className: "bs-empty",
					textContent: "No plugins installed yet — install one from the list below.",
				}),
			);
			return;
		}
		for (const meta of items) {
			const {row} = makeSettingsRow(meta.name, meta.version, meta.description);
			const toggle = el("label", { className: "bs-switch" });
			const checkbox = el("input", { type: "checkbox" });
			checkbox.checked = Boolean(meta.enabled);
			checkbox.setAttribute("aria-label", (meta.enabled ? "Disable " : "Enable ") + meta.name);
			const slider = el("span", { className: "bs-slider" });
			toggle.append(checkbox, slider);
			checkbox.addEventListener("change", async () => {
				checkbox.disabled = true;
				await setPluginEnabled(meta.id, checkbox.checked);
				if (pluginHost.error) {
					settingsStatus("Could not update " + meta.name + ": " + pluginHost.error, true);
				}
				renderSettingsInstalled(page);
			});
			const remove = el("button", { className: "bs-danger", textContent: "Remove" });
			let armed = false;
			let resetTimer = null;
			remove.addEventListener("click", async () => {
				if (!armed) {
					armed = true;
					remove.textContent = "Confirm";
					resetTimer = setTimeout(() => {
						armed = false;
						remove.textContent = "Remove";
					}, 3000);
					return;
				}
				clearTimeout(resetTimer);
				remove.disabled = true;
				await removePlugin(meta);
				if (pluginHost.error) {
					settingsStatus("Could not remove " + meta.name + ": " + pluginHost.error, true);
				}
				renderSettingsInstalled(page);
				await loadSettingsIndex({quiet: true});
			});
			remove.addEventListener("blur", () => {
				if (!armed) return;
				clearTimeout(resetTimer);
				armed = false;
				remove.textContent = "Remove";
			});
			row.append(toggle, remove);
			box.appendChild(row);
		}
	}

	function renderSettingsAvailable(page, items) {
		if (!page || !page.isConnected) return;
		const box = page.querySelector("#bs-available");
		if (!box) return;
		box.textContent = "";
		if (!items.length) {
			box.appendChild(el("div", { className: "bs-empty", textContent: "No plugins in this index." }));
			return;
		}
		const installed = new Set((pluginHost.available || []).map((plugin) => plugin.id));
		for (const item of items) {
			const installedAlready = installed.has(item.id);
			const canInstall = Boolean(item.manifest || item.code);
			const {row} = makeSettingsRow(
				item.name || item.id,
				item.version,
				item.description || item.creator || "",
			);
			const btn = el("button", {
				textContent: installedAlready ? "Installed" : canInstall ? "Install" : "Unavailable",
			});
			btn.disabled = installedAlready || !canInstall;
			btn.addEventListener("click", async () => {
				btn.disabled = true;
				btn.textContent = "Installing…";
				try {
					await installPluginItem(item);
					renderSettingsInstalled(page);
					await loadSettingsIndex({quiet: true});
				} catch (err) {
					settingsStatus(
						"Install failed: " + (err && err.message ? err.message : String(err)),
						true,
					);
					btn.disabled = false;
					btn.textContent = "Install";
				}
			});
			row.appendChild(btn);
			box.appendChild(row);
		}
	}

	async function loadSettingsIndex(opts) {
		const page = settingsPageState.page;
		if (!page || !page.isConnected) return;
		const input = page.querySelector("#bs-index");
		const src = String((input && input.value) || "builtin").trim() || "builtin";
		if (!(opts && opts.quiet)) settingsStatus("Loading " + src + "…");
		try {
			const res = await pluginFetch("/api/store?url=" + encodeURIComponent(src));
			const data = await res.json();
			if (config.storeIndex !== src) {
				config.storeIndex = src;
				saveConfig();
			}
			const label = prettyIndexSource(data.source);
			const source = page.querySelector("#bs-source");
			if (source) {
				source.textContent = label;
				source.title = data.source || "";
			}
			const items = data.items || [];
			renderSettingsAvailable(page, items);
			settingsStatus(items.length + " plugin(s) · " + label);
		} catch (err) {
			const label = prettyIndexSource(src);
			settingsStatus("Could not load " + label + ": " + (err && err.message ? err.message : String(err)), true);
			renderSettingsAvailable(page, []);
			const source = page.querySelector("#bs-source");
			if (source) {
				source.textContent = "";
				source.title = "";
			}
		}
	}

	function wireSettingsPage(page) {
		const input = page.querySelector("#bs-index");
		page.querySelector("#bs-load").addEventListener("click", () => loadSettingsIndex());
		page.querySelector("#bs-builtin").addEventListener("click", () => {
			input.value = "builtin";
			loadSettingsIndex();
		});
		input.addEventListener("keydown", (ev) => {
			if (ev.key !== "Enter") return;
			ev.preventDefault();
			loadSettingsIndex();
		});
		input.addEventListener("change", () => {
			config.storeIndex = String(input.value || "builtin").trim() || "builtin";
			saveConfig();
		});
		page.querySelector("#bs-refresh").addEventListener("click", async (ev) => {
			const btn = ev.currentTarget;
			btn.disabled = true;
			try {
				await refreshPlugins();
				renderSettingsInstalled(page);
				await loadSettingsIndex({quiet: true});
			} finally {
				btn.disabled = false;
			}
		});
	}

	function buildSettingsPage() {
		const page = document.createElement("div");
		page.id = "fluxer-bb-settings-page";
		const wrap = el("div", { className: "bs-wrap" });

		wrap.appendChild(
			el("p", {
				className: "bs-sub",
				textContent:
					"Install plugins from a repository index and choose what runs in this client.",
			}),
		);

		const sourceCard = el("section", { className: "bs-card" });
		sourceCard.appendChild(el("h2", { textContent: "Plugin source" }));
		sourceCard.appendChild(
			el("p", {
				className: "bs-help",
				innerHTML:
					'<span>Use the built-in index, or a GitHub repository. Paste <code>owner/repo</code> to load ' +
					'<code>plugins/index.json</code> from its default branch, or paste a full index URL.</span>',
			}),
		);
		const sourceRow = el("div", { className: "bs-row" });
		const indexInput = el("input", {
			type: "text",
			placeholder: "builtin  ·  owner/repo  ·  https://…/index.json",
		});
		indexInput.id = "bs-index";
		indexInput.value = config.storeIndex || "builtin";
		indexInput.spellcheck = false;
		indexInput.setAttribute("aria-label", "Plugin index URL or GitHub repository");
		const loadBtn = el("button", { className: "bs-primary", textContent: "Load" });
		loadBtn.id = "bs-load";
		const builtinBtn = el("button", { textContent: "Built-in" });
		builtinBtn.id = "bs-builtin";
		sourceRow.append(indexInput, loadBtn, builtinBtn);
		sourceCard.appendChild(sourceRow);
		const status = el("div", { className: "bs-status" });
		status.id = "bs-index-status";
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		sourceCard.appendChild(status);
		wrap.appendChild(sourceCard);

		const installedCard = el("section", { className: "bs-card" });
		const installedHead = el("div", { className: "bs-card-head" });
		installedHead.appendChild(el("h2", { textContent: "Installed" }));
		const refreshBtn = el("button", { textContent: "Refresh" });
		refreshBtn.id = "bs-refresh";
		installedHead.appendChild(refreshBtn);
		installedCard.appendChild(installedHead);
		const installed = el("div");
		installed.id = "bs-installed";
		installedCard.appendChild(installed);
		wrap.appendChild(installedCard);

		const availableCard = el("section", { className: "bs-card" });
		const availableHead = el("div", { className: "bs-card-head" });
		availableHead.appendChild(el("h2", { textContent: "Available" }));
		const sourceLabel = el("span", { className: "bs-muted" });
		sourceLabel.id = "bs-source";
		availableHead.appendChild(sourceLabel);
		availableCard.appendChild(availableHead);
		const available = el("div");
		available.id = "bs-available";
		availableCard.appendChild(available);
		wrap.appendChild(availableCard);

		wrap.appendChild(
			el("p", {
				className: "bs-warn",
				textContent:
					"Plugins run in this window with access to Fluxer's page. Only install plugins you trust.",
			}),
		);

		page.appendChild(wrap);
		return page;
	}

	const SELECTED_CLASS_RE = /Selected|Active/i;

	function clearSettingsEntrySelection() {
		const entry = document.getElementById(SETTINGS_ENTRY_ID);
		if (!entry) return;
		entry.setAttribute("aria-selected", "false");
		for (const name of Array.from(entry.classList)) {
			if (SELECTED_CLASS_RE.test(name)) entry.classList.remove(name);
		}
	}

	function markSettingsSelected() {
		const tree = document.querySelector('[role="tree"][aria-label="Settings sections"]');
		const entry = document.getElementById(SETTINGS_ENTRY_ID);
		if (!tree || !entry) return;
		// Hide the native highlight with CSS instead of mutating React's
		// classes/aria. That keeps the real selection intact for navigation.
		tree.classList.add("fluxer-bb-settings-open");
		entry.setAttribute("aria-selected", "true");
		const current = tree.querySelector(
			'[class*="sidebarItemSelected"]:not(#' + SETTINGS_ENTRY_ID + ")",
		);
		if (current) {
			for (const name of Array.from(current.classList)) {
				if (/sidebarItemSelected/i.test(name)) entry.classList.add(name);
			}
		}
		try {
			entry.scrollIntoView({block: "nearest"});
		} catch (_) {}
	}

	function enforceSettingsSelection() {
		if (!settingsPageState.page || !settingsPageState.page.isConnected) return;
		const tree = document.querySelector('[role="tree"][aria-label="Settings sections"]');
		const entry = document.getElementById(SETTINGS_ENTRY_ID);
		if (!tree || !entry) return;
		tree.classList.add("fluxer-bb-settings-open");
		entry.setAttribute("aria-selected", "true");
		// React can re-render the header/body while our page is open. Re-assert
		// the title and keep the native body hidden. Never re-append the page
		// from here: fighting React from a MutationObserver can spin.
		const card = settingsCard();
		if (!card) return;
		const body = card.children[1];
		if (body && body !== settingsPageState.page) {
			settingsPageState.body = body;
			body.style.display = "none";
		}
		if (settingsPageState.title && settingsPageState.title.isConnected) {
			if (settingsPageState.title.textContent !== "Plugins") settingsPageState.title.textContent = "Plugins";
		}
		if (settingsPageState.link && settingsPageState.link.isConnected) {
			settingsPageState.link.style.display = "none";
		}
	}

	function ensureSettingsPageGuards() {
		if (settingsPageState.guards) return;
		settingsPageState.guards = true;
		const handler = (ev) => {
			if (!settingsPageState.page || !settingsPageState.page.isConnected) return;
			const target = ev.target instanceof Element ? ev.target : null;
			if (!target) return;
			const item = target.closest('[role="treeitem"]');
			if (item && item.id !== SETTINGS_ENTRY_ID) {
				closeSettingsPage();
				return;
			}
			if (target.closest('[data-flx="app.settings-modal-header.button.close"]')) {
				closeSettingsPage();
			}
		};
		settingsPageState.guardHandler = handler;
		document.addEventListener("click", handler, true);
	}

	async function openSettingsPage() {
		if (settingsPageState.page && settingsPageState.page.isConnected) {
			markSettingsSelected();
			return;
		}
		const pad = settingsPad();
		if (!pad) {
			openStorePanel();
			return;
		}
		ensureSettingsPageGuards();
		mountSettingsPageStyles();
		let page = settingsPageState.page;
		if (!page || !page.isConnected) {
			const card = settingsCard();
			if (!card) {
				openStorePanel();
				return;
			}
			const body = card.children[1] || null;
			const title = card.querySelector('[data-flx="app.settings-modal-header.title"]');
			const link = card.querySelector('[data-flx="app.settings-heading-link-button.button.copy"]');
			settingsPageState.card = card;
			settingsPageState.body = body;
			settingsPageState.bodyDisplay = body ? body.style.display : "";
			if (body) body.style.display = "none";
			settingsPageState.title = title;
			settingsPageState.titleText = title ? title.textContent : "";
			if (title) title.textContent = "Plugins";
			settingsPageState.link = link;
			settingsPageState.linkDisplay = link ? link.style.display : "";
			if (link) link.style.display = "none";
			page = buildSettingsPage();
			wireSettingsPage(page);
			card.appendChild(page);
			settingsPageState.page = page;
		}
		markSettingsSelected();
		await refreshPlugins();
		if (!settingsPageState.page || !settingsPageState.page.isConnected) return;
		renderSettingsInstalled(settingsPageState.page);
		const input = settingsPageState.page.querySelector("#bs-index");
		if (input) input.value = config.storeIndex || "builtin";
		await loadSettingsIndex();
	}

	function closeSettingsPage() {
		const page = settingsPageState.page;
		if (page && page.isConnected) page.remove();
		if (settingsPageState.body && settingsPageState.body.isConnected) {
			settingsPageState.body.style.display = settingsPageState.bodyDisplay || "";
		}
		if (settingsPageState.title && settingsPageState.title.isConnected) {
			settingsPageState.title.textContent = settingsPageState.titleText;
		}
		if (settingsPageState.link && settingsPageState.link.isConnected) {
			settingsPageState.link.style.display = settingsPageState.linkDisplay || "";
		}
		settingsPageState.page = null;
		settingsPageState.card = null;
		settingsPageState.body = null;
		settingsPageState.title = null;
		settingsPageState.link = null;
		const tree = document.querySelector('[role="tree"][aria-label="Settings sections"]');
		if (tree) tree.classList.remove("fluxer-bb-settings-open");
		clearSettingsEntrySelection();
	}

	/* -------------------------------------------------- react fiber + dom utils */

	function fiberOf(el) {
		if (!el) return null;
		for (const key in el) {
			if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) return el[key];
		}
		return null;
	}

	/** Walk up from a DOM node looking for a prop bag that carries a LiveKit TrackReference. */
	function trackRefFromElement(el) {
		let fiber = fiberOf(el);
		for (let depth = 0; fiber && depth < 60; depth += 1, fiber = fiber.return) {
			const props = fiber.memoizedProps;
			if (!props || typeof props !== "object") continue;
			const ref = props.trackRef;
			if (ref && ref.participant && ref.participant.identity) return ref;
			const participant = props.participant;
			if (participant && participant.identity && props.source) {
				return {participant, source: props.source, publication: props.publication};
			}
		}
		return null;
	}

	function parseIdentity(identity) {
		const m = /^user_(\d+)_(.+)$/.exec(String(identity || ""));
		if (!m) return null;
		return {userId: m[1], connectionId: m[2], identity};
	}

	function sanitizeKey(raw) {
		return String(raw).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 200);
	}

	function keyForIdentity(identity) {
		return sanitizeKey(config.keyPrefix + String(identity || "unknown").replace(/^user_/, "user-"));
	}

	/** Find the local participant identity from any rendered tile (self tile exists while in voice). */
	function findLocalIdentity() {
		const nodes = document.querySelectorAll("[data-flx]");
		for (const node of nodes) {
			const ref = trackRefFromElement(node);
			const participant = ref && ref.participant;
			if (participant && participant.isLocal && parseIdentity(participant.identity)) {
				return participant.identity;
			}
		}
		return null;
	}

	async function waitForLocalIdentity(timeoutMs) {
		const deadline = Date.now() + (timeoutMs || 6000);
		for (;;) {
			const identity = findLocalIdentity();
			if (identity) return identity;
			if (Date.now() >= deadline) return null;
			await new Promise((r) => setTimeout(r, 250));
		}
	}

	/* ------------------------------------------------------------- net helpers */

	function authHeaders(key) {
		return {
			Authorization: "Bearer " + key,
			"Content-Type": "application/sdp",
		};
	}

	function absolute(location) {
		if (!location) return null;
		if (/^https?:\/\//i.test(location)) return location;
		if (!config.host) return null;
		return config.host + location;
	}

	function waitForIceComplete(pc, timeoutMs) {
		return new Promise((resolve) => {
			if (pc.iceGatheringState === "complete") return resolve();
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				pc.removeEventListener("icegatheringstatechange", onChange);
				resolve();
			};
			const onChange = () => {
				if (pc.iceGatheringState === "complete") finish();
			};
			const timer = setTimeout(finish, timeoutMs || 3000);
			pc.addEventListener("icegatheringstatechange", onChange);
		});
	}

	function rtcConfig() {
		return { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
	}

	/* ------------------------------------------------------------ WHIP publish */

	const publisher = {
		realStream: null,
		localDisplayStream: null,
		placeholder: null, // {stream, canvas, video, timer, videoTrack}
		active: null, // {key, pc, sessionUrl, tracks}
		lastError: null,
		localIdentity: null,
	};

	/* --------------------------------------------------- existing-stream mirror */

	const mirror = {
		active: false,
		starting: false,
		stopping: false,
		key: "",
		session: null,
		stream: null,
		pending: null,
		displayStream: null,
		startedAt: 0,
		lastError: null,
	};

	/** The voice engine facade that owns the LiveKit room on this build. */
	function mediaFacade() {
		for (const candidate of [window._mediaEngineFacade, window._mediaEngine]) {
			if (candidate && candidate.room && typeof candidate.setScreenShareEnabled === "function") {
				return candidate;
			}
		}
		return null;
	}

	/** Accept a bare key, a WHIP URL, or a Broadcast Box watch URL. */
	function extractMirrorKey(raw) {
		let value = String(raw || "").trim();
		if (!value) return null;
		let origin = "";
		try {
			if (/^https?:\/\//i.test(value)) {
				const url = new URL(value);
				origin = url.origin;
				const queryKey = url.searchParams.get("key") || url.searchParams.get("stream");
				if (queryKey) {
					value = queryKey;
				} else {
					const parts = url.pathname.split("/").filter(Boolean);
					value = parts.length ? parts[parts.length - 1] : "";
				}
			}
		} catch (_) {}
		try {
			value = decodeURIComponent(value);
		} catch (_) {}
		value = value.trim().replace(/^\/+|\/+$/g, "");
		if (!value) return null;
		return { key: value, origin };
	}

	async function waitForMirrorVideo(session, timeoutMs) {
		const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
		const stream = await Promise.race([session.firstVideo, timeout]);
		if (!stream) return null;
		// Audio usually arrives with or just after the first video frame. Give
		// it a short moment so OBS audio is included in the native publication.
		if (!stream.getAudioTracks().length) {
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		return stream;
	}

	function watchMirrorEnd(session) {
		const video = session.stream.getVideoTracks()[0];
		if (!video) return;
		video.addEventListener(
			"ended",
			() => {
				if (mirror.session === session) {
					void stopMirror({ native: false, reason: "mirror track ended" });
				}
			},
			{ once: true },
		);
	}

	async function startMirror(raw) {
		if (mirror.starting || mirror.stopping) return false;
		mirror.starting = true;
		try {
			return await startMirrorInner(raw);
		} finally {
			mirror.starting = false;
			render();
		}
	}

	async function startMirrorInner(raw) {
		if (mirror.active) await stopMirror();
		mirror.lastError = null;

		const parsed = extractMirrorKey(raw);
		if (!parsed) {
			mirror.lastError = "Paste a Broadcast Box stream key or URL first.";
			render();
			return false;
		}
		if (parsed.origin && parsed.origin.replace(/\/+$/, "") !== config.host) {
			config.host = parsed.origin.replace(/\/+$/, "");
			saveConfig();
		}
		if (!config.host) {
			mirror.lastError = "Set a Broadcast Box host first.";
			render();
			return false;
		}

		const facade = mediaFacade();
		if (!facade || !facade.room || facade.room.state !== "connected") {
			mirror.lastError = "Join a voice channel before mirroring a stream.";
			render();
			return false;
		}
		if (facade.room.localParticipant && facade.room.localParticipant.isScreenShareEnabled) {
			mirror.lastError = "Stop your current screen share before starting a mirror.";
			render();
			return false;
		}

		config.mirrorKey = parsed.key;
		saveConfig();

		const session = watchWhep(parsed.key, null, { includeAudio: true, anyCodec: true });
		mirror.session = session;
		mirror.key = parsed.key;
		mirror.stream = null;
		mirror.pending = null;
		mirror.displayStream = null;
		mirror.active = false;
		render();

		try {
			await session.ready;
			if (mirror.session !== session) {
				session.stop();
				return false;
			}
			const stream = await waitForMirrorVideo(session, 12000);
			if (mirror.session !== session) {
				session.stop();
				return false;
			}
			if (!stream) {
				throw new Error("No video from Broadcast Box. Check that the stream is live and the key is correct.");
			}
			const video = stream.getVideoTracks()[0];
			if (!video) throw new Error("Broadcast Box returned no video track.");
			screenTracks.add(video);
			const settings = video.getSettings ? video.getSettings() : {};
			mirror.stream = stream;
			mirror.pending = stream;
			publisher.realStream = stream;
			mirror.displayStream = new MediaStream([video]);
			publisher.localDisplayStream = mirror.displayStream;

			const captureOptions = {
				video: true,
				audio: stream.getAudioTracks().length > 0,
				resolution: {
					width: Math.max(1, Number(settings.width) || 1920),
					height: Math.max(1, Number(settings.height) || 1080),
					frameRate: config.fps,
				},
				contentHint: "detail",
			};
			const publishOptions = {};
			if (config.codec !== "auto") publishOptions.videoCodec = config.codec;
			if (mirror.session !== session) {
				session.stop();
				return false;
			}

			mirror.active = true;
			mirror.startedAt = Date.now();
			await facade.setScreenShareEnabled(true, captureOptions, publishOptions);
			if (mirror.session !== session) {
				try {
					await facade.setScreenShareEnabled(false);
				} catch (_) {}
				session.stop();
				return false;
			}
			mirror.active = true;
			mirror.startedAt = Date.now();
			watchMirrorEnd(session);
			log("mirror: publishing existing Broadcast Box stream through LiveKit");
			render();
			return true;
		} catch (err) {
			mirror.lastError = "Mirror failed: " + ((err && err.message) || err);
			warn(mirror.lastError);
			await stopMirror({ native: true, reason: "mirror start failed" });
			return false;
		}
	}

	async function stopMirror(options) {
		const opts = options || {};
		if (mirror.stopping) return;
		mirror.stopping = true;
		const wasActive = mirror.active || Boolean(mirror.pending);
		const session = mirror.session;
		const stream = mirror.stream;
		const displayStream = mirror.displayStream;
		mirror.active = false;
		mirror.pending = null;
		mirror.session = null;
		mirror.stream = null;
		mirror.displayStream = null;
		mirror.startedAt = 0;
		try {
			if (opts.native !== false && wasActive) {
				const facade = mediaFacade();
				if (facade) {
					try {
						await facade.setScreenShareEnabled(false);
					} catch (_) {}
				}
			}
			if (session) session.stop();
			if (publisher.realStream === stream) publisher.realStream = null;
			if (publisher.localDisplayStream === displayStream) publisher.localDisplayStream = null;
			if (opts.reason) log("mirror stopped:", opts.reason);
		} finally {
			mirror.stopping = false;
			render();
		}
	}

	function checkMirror() {
		if (!mirror.active || mirror.stopping) return;
		const session = mirror.session;
		if (session && session.pc) {
			const state = session.pc.connectionState;
			if (state === "failed" || state === "closed") {
				mirror.lastError = "Broadcast Box mirror connection closed.";
				void stopMirror({ native: true, reason: "WHEP connection closed" });
				return;
			}
		}
		const facade = mediaFacade();
		const enabled =
			facade && facade.room && facade.room.localParticipant
				? facade.room.localParticipant.isScreenShareEnabled
				: null;
		if (enabled === false && Date.now() - mirror.startedAt > 5000) {
			void stopMirror({ native: false, reason: "native screen share ended" });
		}
	}

	/* ---------------------------------------------- H264 VAAPI keyframe fix */
	//
	// Chromium's VAAPI H264 encoder (Mesa radeonsi) submits the packed slice
	// header before the packed SPS/PPS, so every key frame comes out as
	// "IDR SPS PPS" instead of "SPS PPS IDR". Receivers discard all of them and
	// framesDecoded stays 0 forever. Reordering the parameter sets in an
	// encoded transform makes the stream decodable again.
	// https://issues.chromium.org/issues/574768145

	function splitNals(bytes) {
		const nals = [];
		let i = 0;
		while (i + 3 < bytes.length) {
			let start = -1;
			let len = 0;
			if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
				start = i;
				len = 3;
			} else if (
				i + 4 < bytes.length &&
				bytes[i] === 0 &&
				bytes[i + 1] === 0 &&
				bytes[i + 2] === 0 &&
				bytes[i + 3] === 1
			) {
				start = i;
				len = 4;
			}
			if (start < 0) {
				i += 1;
				continue;
			}
			nals.push({ start, type: bytes[start + len] & 31 });
			i = start + len + 1;
		}
		return nals;
	}

	function reorderNalFrame(frame) {
		const bytes = new Uint8Array(frame.data);
		const nals = splitNals(bytes);
		if (!nals.length) return;
		let firstSlice = -1;
		const params = [];
		for (let i = 0; i < nals.length; i += 1) {
			const type = nals[i].type;
			if (type >= 1 && type <= 5 && firstSlice < 0) firstSlice = i;
			if (type === 7 || type === 8) params.push(i);
		}
		if (!params.length || firstSlice < 0) return;
		let misplaced = false;
		for (const index of params) if (index > firstSlice) misplaced = true;
		if (!misplaced) return;
		const order = params.slice();
		for (let i = 0; i < nals.length; i += 1) if (params.indexOf(i) < 0) order.push(i);
		const parts = [];
		if (nals[0].start > 0) parts.push(bytes.subarray(0, nals[0].start));
		for (const index of order) {
			const end = index + 1 < nals.length ? nals[index + 1].start : bytes.length;
			parts.push(bytes.subarray(nals[index].start, end));
		}
		let total = 0;
		for (const part of parts) total += part.length;
		const out = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		frame.data = out.buffer;
	}

	const NAL_FIX_WORKER =
		splitNals.toString() +
		"\n" +
		reorderNalFrame.toString() +
		"\n" +
		"self.onrtctransform = function (event) {\n" +
		"  var transformer = event.transformer;\n" +
		"  transformer.readable.pipeThrough(new TransformStream({\n" +
		"    transform: function (frame, controller) {\n" +
		"      try { if (frame.type === 'key') reorderNalFrame(frame); } catch (err) {}\n" +
		"      controller.enqueue(frame);\n" +
		"    }\n" +
		"  })).pipeTo(transformer.writable);\n" +
		"};\n";

	function installNalFix(sender, workers) {
		if (!config.h264NalFix) return;
		try {
			if (typeof RTCRtpScriptTransform === "function" && typeof Worker === "function") {
				const url = URL.createObjectURL(new Blob([NAL_FIX_WORKER], { type: "text/javascript" }));
				const worker = new Worker(url);
				try {
					URL.revokeObjectURL(url);
				} catch (_) {}
				sender.transform = new RTCRtpScriptTransform(worker, { operation: "h264-nal-reorder" });
				workers.push(worker);
				return;
			}
		} catch (err) {
			warn("RTCRtpScriptTransform unavailable:", err);
		}
		// Older builds: deprecated main-thread encoded streams.
		try {
			if (typeof sender.createEncodedStreams !== "function") return;
			const pair = sender.createEncodedStreams();
			pair.readable
				.pipeThrough(
					new TransformStream({
						transform(frame, controller) {
							try {
								if (frame.type === "key") reorderNalFrame(frame);
							} catch (_) {}
							controller.enqueue(frame);
						},
					}),
				)
				.pipeTo(pair.writable)
				.catch(() => {});
			workers.push({ terminate() {} });
		} catch (err) {
			warn("could not install H264 NAL fix:", err);
		}
	}

	/**
	 * Video codec capabilities to pin on a transceiver.
	 *
	 * H264: pin exactly one packetization-mode=1 payload. Offering every H264
	 * profile makes Broadcast Box negotiate one payload type while forwarding
	 * the stream under another (its multi-codec binding is map-ordered), and a
	 * packetization-mode=0 answer cannot carry FU-A packets.
	 *
	 * VP9: software-only on AMD/Intel (no VAAPI encode entrypoint exists), kept
	 * as a fallback for machines where H264 misbehaves.
	 */
	function codecPreferences() {
		const caps =
			typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities
				? RTCRtpSender.getCapabilities("video")
				: null;
		const all = (caps && caps.codecs) || [];
		if (config.codec === "vp9") return all.filter((c) => /video\/VP9/i.test(c.mimeType));
		if (config.codec === "h264") {
			const h264 = all.filter((c) => /video\/H264/i.test(c.mimeType));
			const pm1 = h264.filter((c) => /packetization-mode=1/i.test(c.sdpFmtpLine || ""));
			return (pm1.length ? pm1 : h264).slice(0, 1);
		}
		return [];
	}

	async function publishToBB(stream, key) {
		if (!stream) throw new Error("no stream");
		await stopPublish();

		const pc = new RTCPeerConnection(rtcConfig());
		const sendTracks = [];
		// Publish the captured tracks directly. Cloning canvas/getDisplayMedia
		// tracks produces a clone that negotiates but never yields decodable
		// frames on this Chromium build (verified: bytesReceived > 0,
		// framesDecoded = 0). In "bb" mode these tracks belong to the plugin, so
		// stopping them on teardown is correct.
		const prefs = codecPreferences();
		const nalWorkers = [];
		for (const track of stream.getTracks()) {
			sendTracks.push(track);
			if (track.kind === "video" && prefs.length && typeof pc.addTransceiver === "function") {
				const transceiver = pc.addTransceiver(track, {
					direction: "sendonly",
					streams: [new MediaStream([track])],
				});
				try {
					transceiver.setCodecPreferences(prefs);
				} catch (err) {
					warn("could not pin video codec:", err);
				}
				if (config.codec === "h264") installNalFix(transceiver.sender, nalWorkers);
			} else {
				pc.addTrack(track, new MediaStream([track]));
			}
		}

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		await waitForIceComplete(pc);

		const res = await fetch(config.host + "/api/whip", {
			method: "POST",
			headers: authHeaders(key),
			body: pc.localDescription.sdp,
		});
		const answer = await res.text();
		if (!res.ok) {
			pc.close();
			sendTracks.forEach((t) => t.stop());
			throw new Error("WHIP " + res.status + ": " + answer.slice(0, 200));
		}
		await pc.setRemoteDescription({ type: "answer", sdp: answer });

		// Ask the encoder for the quality Fluxer would not give us. This has to
		// happen after negotiation: calling setParameters before the SDP
		// exchange leaves the encoder unable to emit keyframes.
		const bps = Math.round(config.maxBitrateMbps * 1_000_000);
		for (const sender of pc.getSenders()) {
			if (!sender.track || sender.track.kind !== "video") continue;
			try {
				const params = sender.getParameters();
				if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
				for (const encoding of params.encodings) {
					encoding.maxBitrate = bps;
					encoding.maxFramerate = config.fps;
				}
				params.degradationPreference = "maintain-resolution";
				await sender.setParameters(params);
			} catch (err) {
				warn("sender tuning failed:", err);
			}
		}

		publisher.active = {
			key,
			pc,
			tracks: sendTracks,
			transforms: nalWorkers,
			sessionUrl: absolute(res.headers.get("Location")),
		};
		pc.addEventListener("connectionstatechange", () => {
			if (pc.connectionState === "failed") {
				warn("publish connection failed");
				stopPublish().catch(() => {});
			}
		});
		log("publishing to Broadcast Box as", key, "at", config.maxBitrateMbps + " Mbps /", config.fps + "fps");
		return key;
	}

	async function stopPublish() {
		const active = publisher.active;
		if (!active) return;
		publisher.active = null;
		try {
			if (active.sessionUrl) {
				await fetch(active.sessionUrl, { method: "DELETE", headers: authHeaders(active.key) });
			}
		} catch (_) {}
		try {
			active.pc.close();
		} catch (_) {}
		active.tracks.forEach((t) => {
			try {
				t.stop();
			} catch (_) {}
		});
		(active.transforms || []).forEach((w) => {
			try {
				w.terminate();
			} catch (_) {}
		});
		log("publish stopped");
	}

	/* ------------------------------------------------------- placeholder stream */

	/**
	 * Fluxer gets this tiny canvas stream (plus the real audio) instead of the real
	 * screen, so the Go Live state/tile/preview work while the real video goes to BB.
	 * It draws the real screen at a low fps, so previews and unmodified viewers still
	 * see a usable (if choppy) picture.
	 */
	function buildPlaceholder(realStream) {
		const sourceVideo = realStream.getVideoTracks()[0] || null;
		const width = config.placeholderWidth;
		const height = Math.round((width * 9) / 16);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d", { alpha: false });

		const sink = document.createElement("video");
		sink.muted = true;
		sink.autoplay = true;
		sink.playsInline = true;
		sink.setAttribute("aria-hidden", "true");
		sink.setAttribute("data-flx", "fluxer-bb.placeholder-sink");
		Object.assign(sink.style, {
			position: "fixed",
			left: "0",
			top: "0",
			width: "2px",
			height: "2px",
			opacity: "0.001",
			pointerEvents: "none",
			zIndex: "0",
		});
		if (sourceVideo) sink.srcObject = new MediaStream([sourceVideo]);
		(document.body || document.documentElement).appendChild(sink);
		sink.play().catch(() => {});

		const draw = () => {
			try {
				if (sink.readyState < 2 || !sink.videoWidth) {
					ctx.fillStyle = "#0b0f14";
					ctx.fillRect(0, 0, width, height);
					ctx.fillStyle = "#8fa0b8";
					ctx.font = Math.round(width / 26) + "px system-ui, sans-serif";
					ctx.textAlign = "center";
					ctx.fillText("Broadcast Box — waiting for frames", width / 2, height / 2);
					return;
				}
				const scale = Math.min(width / sink.videoWidth, height / sink.videoHeight);
				const dw = sink.videoWidth * scale;
				const dh = sink.videoHeight * scale;
				ctx.fillStyle = "#000";
				ctx.fillRect(0, 0, width, height);
				ctx.drawImage(sink, (width - dw) / 2, (height - dh) / 2, dw, dh);
				// Corner badge so unmodified viewers know where the real feed is.
				const pad = Math.round(width / 64);
				const label = "LIVE • BROADCAST BOX";
				ctx.font = "600 " + Math.round(width / 40) + "px system-ui, sans-serif";
				const tw = ctx.measureText(label).width;
				ctx.fillStyle = "rgba(10,12,16,.72)";
				ctx.fillRect(pad, height - pad - Math.round(width / 24), tw + pad * 2, Math.round(width / 24));
				ctx.fillStyle = "#ff6b6b";
				ctx.fillRect(pad * 2, height - pad - Math.round(width / 24) + Math.round(width / 60), Math.round(width / 90), Math.round(width / 90));
				ctx.fillStyle = "#e8eef7";
				ctx.textAlign = "left";
				ctx.textBaseline = "middle";
				ctx.fillText(label, pad * 2 + Math.round(width / 55), height - pad - Math.round(width / 60));
			} catch (err) {
				warn("placeholder draw failed:", err);
			}
		};
		draw();
		const timer = setInterval(draw, Math.max(50, Math.round(1000 / config.placeholderFps)));

		const canvasStream = canvas.captureStream(config.placeholderFps);
		const videoTrack = canvasStream.getVideoTracks()[0];
		const audioTracks = realStream.getAudioTracks();
		const stream = new MediaStream([videoTrack, ...audioTracks]);

		return {
			stream,
			canvas,
			videoTrack,
			sink,
			stop() {
				clearInterval(timer);
				try {
					videoTrack.stop();
				} catch (_) {}
				try {
					sink.srcObject = null;
				} catch (_) {}
				try {
					sink.remove();
				} catch (_) {}
			},
		};
	}

	/* --------------------------------------------------------- capture wrapping */

	const hook = { installed: false, originals: null, busy: false };

	function rewriteConstraints(constraints) {
		const next = Object.assign({}, constraints || {});
		const video = next.video && typeof next.video === "object" ? Object.assign({}, next.video) : {};
		// Fluxer sends {width: {ideal: preset}, height: {ideal: preset}, frameRate: {ideal, max}}
		// and gates its resolution presets behind the premium plan. Drop its hints
		// (so the paywall cannot influence the capture) and apply our own cap; a
		// height-only max preserves the monitor's aspect ratio.
		delete video.width;
		delete video.height;
		if (config.maxHeight > 0) video.height = { max: config.maxHeight };
		video.frameRate = { ideal: config.fps, max: config.fps };
		next.video = video;
		return next;
	}

	function startBBShare(real) {
		const realVideo = real.getVideoTracks()[0];
		publisher.realStream = real;
		publisher.localDisplayStream = new MediaStream(real.getVideoTracks());
		if (realVideo) screenTracks.add(realVideo);

		// Hand Fluxer the placeholder immediately so the native share starts
		// without waiting for the WHIP round-trip; publish to BB in the
		// background.
		const placeholder = buildPlaceholder(real);
		publisher.placeholder = placeholder;
		startCaptureWatch(real, placeholder);
		render();

		void (async () => {
			const identity = (await waitForLocalIdentity(4000)) || publisher.localIdentity;
			if (identity) publisher.localIdentity = identity;
			const key = keyForIdentity(identity || "local-" + Math.random().toString(36).slice(2, 8));
			if (!realVideo || realVideo.readyState !== "live") return;
			try {
				await publishToBB(real, key);
				log("native BB share online — stream key", key, "identity", identity || "(unresolved)");
			} catch (err) {
				publisher.lastError = "Broadcast Box publish failed: " + ((err && err.message) || err);
				warn(publisher.lastError);
			}
			render();
		})();

		return placeholder.stream;
	}

	async function handleCapture(args) {
		// Mirror mode supplies the stream itself (WHEP receiver). Do not open
		// the system picker and do not republish it to Broadcast Box.
		if (mirror.pending || (mirror.active && mirror.stream)) {
			const stream = mirror.pending || mirror.stream;
			mirror.pending = null;
			mirror.active = true;
			mirror.startedAt = Date.now();
			const video = stream && stream.getVideoTracks()[0];
			if (video) screenTracks.add(video);
			if (stream) {
				publisher.realStream = stream;
				if (video) {
					mirror.displayStream = new MediaStream([video]);
					publisher.localDisplayStream = mirror.displayStream;
				}
			}
			log("mirror: handoff to Fluxer screen share");
			render();
			return stream;
		}

		const original = hook.originals.instance;
		const real = await original.apply(navigator.mediaDevices, [rewriteConstraints(args[0])]);
		if (!real || real.getVideoTracks().length === 0) return real;

		const realVideo = real.getVideoTracks()[0];
		if (config.mode !== "bb" || !config.host) {
			// Uncapped LiveKit, or Broadcast Box mode without a configured host:
			// give Fluxer the real track; the sender hook raises its caps.
			publisher.realStream = real;
			publisher.localDisplayStream = new MediaStream(real.getVideoTracks());
			if (realVideo) screenTracks.add(realVideo);
			log(
				config.mode === "bb"
					? "no Broadcast Box host configured; sharing via LiveKit"
					: "uncapped mode: capture",
				realVideo && realVideo.getSettings(),
			);
			return real;
		}

		return startBBShare(real);
	}

	function startCaptureWatch(realStream, placeholder) {
		const timer = setInterval(() => {
			const realVideo = realStream.getVideoTracks()[0];
			const ended = !realVideo || realVideo.readyState === "ended" || placeholder.videoTrack.readyState === "ended";
			if (!ended) return;
			clearInterval(timer);
			try {
				placeholder.stop();
			} catch (_) {}
			realStream.getTracks().forEach((t) => {
				try {
					t.stop();
				} catch (_) {}
			});
			publisher.realStream = null;
			publisher.placeholder = null;
			stopPublish().catch(() => {});
			render();
		}, 500);
	}

	function installCaptureHook() {
		if (hook.installed) return;
		const md = navigator.mediaDevices;
		if (!md || typeof md.getDisplayMedia !== "function") {
			warn("getDisplayMedia unavailable; capture hook not installed");
			return;
		}
		const original = md.getDisplayMedia;
		const wrapper = function (...args) {
			// The mirror source is already in hand; a concurrent/preview call
			// must not fall through to the system picker.
			if (mirror.pending || (mirror.active && mirror.stream)) {
				return handleCapture(args);
			}
			if (hook.busy) return original.apply(md, args);
			hook.busy = true;
			return handleCapture(args).finally(() => {
				hook.busy = false;
			});
		};
		try {
			md.getDisplayMedia = wrapper;
			const proto = typeof MediaDevices !== "undefined" ? MediaDevices.prototype : null;
			const protoOriginal = proto ? proto.getDisplayMedia : null;
			if (proto && typeof protoOriginal === "function") proto.getDisplayMedia = wrapper;
			hook.originals = { instance: original, proto: protoOriginal, protoTarget: proto };
			hook.installed = true;
			log("capture hook installed (mode:", config.mode + ")");
		} catch (err) {
			warn("could not install capture hook:", err);
		}
	}

	function uninstallCaptureHook() {
		if (!hook.installed || !hook.originals) return;
		try {
			navigator.mediaDevices.getDisplayMedia = hook.originals.instance;
			if (hook.originals.protoTarget && hook.originals.proto) {
				hook.originals.protoTarget.getDisplayMedia = hook.originals.proto;
			}
		} catch (_) {}
		hook.installed = false;
	}

	/* --------------------------------------------- uncapped LiveKit sender hook */

	const screenTracks = new WeakSet();

	function installSenderHook() {
		if (typeof RTCRtpSender === "undefined" || RTCRtpSender.prototype.__fluxerBBPatched) return;
		const original = RTCRtpSender.prototype.setParameters;
		if (typeof original !== "function") return;
		const patched = function (params) {
			try {
				if ((config.mode === "uncapped" || mirror.active) && this.track && screenTracks.has(this.track) && params) {
					const next = Object.assign({}, params);
					const encodings = Array.isArray(next.encodings) && next.encodings.length ? next.encodings : [{}];
					next.encodings = encodings.map((encoding) =>
						Object.assign({}, encoding, {
							maxBitrate: Math.max(Number(encoding.maxBitrate) || 0, Math.round(config.maxBitrateMbps * 1_000_000)),
							maxFramerate: Math.max(Number(encoding.maxFramerate) || 0, config.fps),
						}),
					);
					next.degradationPreference = "maintain-resolution";
					return original.call(this, next);
				}
			} catch (err) {
				warn("sender param override failed:", err);
			}
			return original.call(this, params);
		};
		patched.__fluxerBBPatched = true;
		RTCRtpSender.prototype.setParameters = patched;
		log("sender cap hook installed");
	}

	/* --------------------------------------------------------- WHEP / streaming */

	function watchWhep(key, onTrack, options) {
		const opts = options || {};
		const session = {
			pc: null,
			sessionUrl: null,
			key,
			stopped: false,
			stream: new MediaStream(),
			hasVideo: false,
		};
		let resolveVideo = null;
		// Resolves with the receiver MediaStream once the first video track
		// arrives. Resolves with null if the session is stopped first.
		session.firstVideo = new Promise((resolve) => {
			resolveVideo = resolve;
		});
		const pc = new RTCPeerConnection(rtcConfig());
		session.pc = pc;
		// Broadcast Box creates an audio track object for every WHEP session
		// even when the offer has no audio m-line; that object is never bound,
		// and the first audio RTP packet from the publisher then crashes the
		// server (nil writeStream -> SIGSEGV in TrackMultiCodec.WriteRTP). So
		// every WHEP offer must carry an audio m-line, even though audio keeps
		// flowing through Fluxer/LiveKit and we only consume the video here.
		pc.addTransceiver("audio", { direction: "recvonly" });
		const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
		// Offer the same single codec the publisher pins. A payload-type or
		// packetization-mode mismatch makes Broadcast Box forward the stream
		// under a codec the receiver cannot depacketise.
		try {
			if (!opts.anyCodec) {
				const prefs = codecPreferences();
				if (prefs.length) transceiver.setCodecPreferences(prefs);
			}
		} catch (err) {
			warn("could not pin codec on WHEP offer:", err);
		}
		pc.ontrack = (event) => {
			if (event.track.kind === "audio") {
				// Normal tile swaps are video-only so Fluxer's own audio path
				// is not doubled. Mirror mode wants the broadcast audio too.
				if (opts.includeAudio) session.stream.addTrack(event.track);
				return;
			}
			if (event.track.kind !== "video") return;
			session.stream.addTrack(event.track);
			if (!session.hasVideo) {
				session.hasVideo = true;
				if (typeof onTrack === "function") onTrack(session.stream);
				if (resolveVideo) resolveVideo(session.stream);
			}
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === "failed" || pc.connectionState === "closed") session.stop();
		};
		session.ready = (async () => {
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			await waitForIceComplete(pc);
			const res = await fetch(config.host + "/api/whep", {
				method: "POST",
				headers: authHeaders(key),
				body: pc.localDescription.sdp,
			});
			const answer = await res.text();
			if (!res.ok) throw new Error("WHEP " + res.status + ": " + answer.slice(0, 160));
			session.sessionUrl = absolute(res.headers.get("Location"));
			await pc.setRemoteDescription({ type: "answer", sdp: answer });
			return session;
		})();
		session.stop = () => {
			if (session.stopped) return;
			session.stopped = true;
			try {
				pc.close();
			} catch (_) {}
			try {
				session.stream.getTracks().forEach((t) => t.stop());
			} catch (_) {}
			if (session.sessionUrl) {
				fetch(session.sessionUrl, { method: "DELETE", headers: authHeaders(key) }).catch(() => {});
			}
			if (resolveVideo) resolveVideo(null);
		};
		return session;
	}

	/* ------------------------------------------------------------ viewer swap */

	const viewer = {
		swaps: new Map(), // HTMLVideoElement -> {key, session, stream, original, missed}
		statusCache: new Map(), // key -> {at, live}
		pending: new WeakSet(),
		tiles: 0,
		lastError: null,
	};

	async function isLive(key) {
		if (!config.host) return false;
		const cached = viewer.statusCache.get(key);
		const now = Date.now();
		if (cached && now - cached.at < 3000) return cached.live;
		try {
			const res = await fetch(config.host + "/api/status?key=" + encodeURIComponent(key), { cache: "no-store" });
			const text = (await res.text()).trim();
			const live = res.ok && text.length > 0 && text !== "null" && !/^no active stream/i.test(text);
			viewer.statusCache.set(key, { at: now, live });
			return live;
		} catch (_) {
			viewer.statusCache.set(key, { at: now, live: false });
			return false;
		}
	}

	function attachStream(video, stream, key, session) {
		const existing = viewer.swaps.get(video);
		const original = existing ? existing.original : video.srcObject;
		viewer.swaps.set(video, {
			key,
			session,
			stream,
			original,
			missed: 0,
			checkedAt: Date.now(),
			// Frame-progress watchdog: Broadcast Box keeps a session alive
			// while a WHEP viewer is attached, so /api/status can stay "live"
			// after the broadcaster stops. If the picture stops advancing we
			// restore Fluxer's own element instead.
			lastTime: video.currentTime || 0,
			lastProgressAt: Date.now(),
		});
		if (video.srcObject !== stream) {
			video.muted = true; // audio stays on Fluxer's own audio pipeline
			video.srcObject = stream;
			video.play().catch(() => {});
		}
	}

	function restoreVideo(video) {
		const entry = viewer.swaps.get(video);
		viewer.pending.delete(video);
		if (!entry) return;
		viewer.swaps.delete(video);
		try {
			entry.session && entry.session.stop();
		} catch (_) {}
		try {
			video.srcObject = entry.original || null;
		} catch (_) {}
	}

	function scanViewer() {
		if (!config.autoSwap) return;
		const tiles = document.querySelectorAll('[data-source="screen_share"]');
		viewer.tiles = tiles.length;
		const seen = new Set();

		for (const tile of tiles) {
			const ref = trackRefFromElement(tile);
			if (!ref || !ref.participant) continue;

			// Our own tile: show the real capture locally (the LiveKit copy is the placeholder).
			if (ref.participant.isLocal) {
				const localStream = publisher.localDisplayStream;
				if (!localStream) continue;
				for (const video of tile.querySelectorAll("video")) {
					seen.add(video);
					if (video.srcObject !== localStream) {
						video.muted = true;
						video.srcObject = localStream;
						video.play().catch(() => {});
					}
				}
				continue;
			}

			const parsed = parseIdentity(ref.participant.identity);
			if (!parsed) continue;
			const key = keyForIdentity(ref.participant.identity);

			for (const video of tile.querySelectorAll("video")) {
				seen.add(video);
				const entry = viewer.swaps.get(video);
				if (entry && entry.key === key) {
					// Fluxer may re-attach its own track; keep ours in place.
					if (video.srcObject !== entry.stream) {
						video.muted = true;
						video.srcObject = entry.stream;
						video.play().catch(() => {});
					}
					continue;
				}
				if (viewer.swaps.has(video) || viewer.pending.has(video)) continue;
				viewer.pending.add(video);
				isLive(key).then((live) => {
					if (!live) {
						viewer.pending.delete(video);
						if (viewer.swaps.has(video)) restoreVideo(video);
						return;
					}
					if (viewer.swaps.has(video)) {
						viewer.pending.delete(video);
						return;
					}
					let gotTrack = false;
					const session = watchWhep(key, (stream) => {
						if (gotTrack) return;
						gotTrack = true;
						viewer.pending.delete(video);
						attachStream(video, stream, key, session);
						log("swapped tile to Broadcast Box:", key);
					});
					session.ready.catch((err) => {
						viewer.pending.delete(video);
						viewer.lastError = String((err && err.message) || err);
						warn("WHEP subscribe failed:", viewer.lastError);
						session.stop();
					});
				});
			}
		}

		// Clean up swaps whose element or tile disappeared, and periodically
		// re-check that the stream is still live on Broadcast Box.
		const now = Date.now();
		for (const [video, entry] of viewer.swaps) {
			if (!seen.has(video) || !video.isConnected) {
				restoreVideo(video);
				continue;
			}
			if (entry.session && entry.session.stopped) {
				restoreVideo(video);
				continue;
			}
			// The picture must keep advancing, otherwise the broadcast has
			// ended even if Broadcast Box still answers "live".
			const currentTime = video.currentTime || 0;
			if (currentTime > entry.lastTime + 0.01) {
				entry.lastTime = currentTime;
				entry.lastProgressAt = now;
			} else if (entry.lastProgressAt && now - entry.lastProgressAt > 8000) {
				warn("Broadcast Box video stalled; restoring tile", entry.key);
				restoreVideo(video);
				continue;
			}
			if (!entry.checkedAt || now - entry.checkedAt > 10000) {
				entry.checkedAt = now;
				isLive(entry.key).then((live) => {
					if (!live && viewer.swaps.get(video) === entry) restoreVideo(video);
				});
			}
		}
	}

	let scanTimer = null;
	let observer = null;
	function startViewer() {
		if (scanTimer) return;
		scanTimer = setInterval(() => {
			try {
				scanViewer();
			} catch (err) {
				warn("viewer scan failed:", err);
			}
			try {
				mountToolbar();
			} catch (_) {}
			try {
				mountSettingsEntry();
			} catch (_) {}
			try {
				checkMirror();
			} catch (_) {}
		}, 1200);
		try {
			observer = new MutationObserver(() => {
				try {
					scanViewer();
				} catch (_) {}
				try {
					mountToolbar();
				} catch (_) {}
				try {
					mountSettingsEntry();
				} catch (_) {}
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
		} catch (_) {}
	}

	/* --------------------------------------------------------------------- UI */

	const ui = { host: null, shadow: null, els: {}, timer: null, anchor: null };
	const TOOLBAR_FLX = "fluxer-bb.toolbar-button";
	const TOOLBAR_WRAP_FLX = "fluxer-bb.toolbar-container";
	const TOOLBAR_STYLE_ID = "fluxer-bb-toolbar-style";
	const SETTINGS_ENTRY_ID = "fluxer-bb-settings-entry";
	const TOOLBAR_BAR_SELECTOR = '[data-flx="voice.voice-control-bar.voice-control-bar-inner.container"]';
	const TOOLBAR_SHARE_CONTAINER =
		'[data-flx="voice.voice-control-bar.voice-control-bar-inner.button-container.screen-share-settings"]';
	// Phosphor "broadcast" (256 viewBox) to match Fluxer's icon set.
	const BROADCAST_PATH =
		"M128,88a40,40,0,1,0,40,40A40,40,0,0,0,128,88Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,128,152Zm73.71,7.14a80,80,0,0,1-14.08,22.2,8,8,0,0,1-11.92-10.67,63.95,63.95,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67,80.08,80.08,0,0,1,14.08,84.47ZM69,103.09a64,64,0,0,0,11.26,67.58,8,8,0,0,1-11.92,10.67,79.93,79.93,0,0,1,0-106.67A8,8,0,1,1,80.29,85.34,63.77,63.77,0,0,0,69,103.09ZM248,128a119.58,119.58,0,0,1-34.29,84,8,8,0,1,1-11.42-11.2,103.9,103.9,0,0,0,0-145.56A8,8,0,1,1,213.71,44,119.58,119.58,0,0,1,248,128ZM53.71,200.78A8,8,0,1,1,42.29,212a119.87,119.87,0,0,1,0-168,8,8,0,1,1,11.42,11.2,103.9,103.9,0,0,0,0,145.56Z";
	// Material "extension" (24 viewBox) for the Settings → Plugins entry.
	const PLUGIN_PATH =
		"M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z";
	let toolbarEl = null;
	let toolbarWrap = null;
	const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
.fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  width: 44px; height: 44px; border-radius: 50%; border: 1px solid #2f3b4d;
  background: #1b2432; color: #e8eef7; font-weight: 700; font-size: 12px;
  cursor: pointer; box-shadow: 0 10px 28px rgba(0,0,0,.45);
}
.fab[data-live="1"] { border-color: #e5484d; box-shadow: 0 0 0 3px rgba(229,72,77,.25), 0 10px 28px rgba(0,0,0,.45); }
.panel {
  position: fixed; right: 18px; bottom: 72px; z-index: 2147483000;
  width: 330px; background: #12171d; color: #e8eef7; border: 1px solid #2b3441;
  border-radius: 12px; box-shadow: 0 28px 80px rgba(0,0,0,.55); padding: 12px; display: none;
  max-height: calc(100vh - 24px); overflow: auto;
}
.panel[data-open="1"] { display: block; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h3 { margin: 0 0 8px; font-size: 13px; }
.close { all: unset; cursor: pointer; color: #8fa0b8; font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
.close:hover { background: #1a222d; color: #e8eef7; }
.close:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 1px; }
label { font-size: 11px; color: #aebcd0; display: block; margin: 8px 0 4px; }
input, select {
  width: 100%; background: #1a222d; color: #fff; border: 1px solid #303d4f;
  border-radius: 8px; padding: 7px 9px; font-size: 12px;
}
.row { display: flex; gap: 8px; }
.row > * { flex: 1; min-width: 0; }
.status { font-size: 11px; color: #8fa0b8; margin-top: 10px; line-height: 1.5; word-break: break-word; }
.status b { color: #e8eef7; font-weight: 600; }
.ok { color: #7ee787; }
.err { color: #ff9a9a; }
.pill { font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid #3f4d61; }
.pill.live { border-color: #e5484d; color: #ff9a9a; }
.hint { font-size: 10px; color: #7c8ba1; margin-top: 8px; line-height: 1.45; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; }
.section-head span { font-size: 11px; color: #aebcd0; }
.mini {
  cursor: pointer; font: inherit; font-size: 10px; line-height: 1.2; padding: 4px 8px;
  border-radius: 7px; border: 1px solid #303d4f; color: #c7d3e4; background: #1a222d;
}
.mini:hover:not(:disabled) { background: #222d3b; color: #fff; }
.mini:disabled { opacity: .55; cursor: default; }
.mini.danger { border-color: #5a2b2f; color: #ff9a9a; }
.plugin-list { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.plugin-row {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border: 1px solid #263140; border-radius: 8px; background: #161d26;
}
.plugin-main { flex: 1; min-width: 0; }
.plugin-name { font-size: 11px; color: #e8eef7; }
.plugin-desc { font-size: 10px; color: #7c8ba1; margin-top: 2px; line-height: 1.35; }
.store-view { margin-top: 6px; }
.store-view .row { margin-bottom: 6px; }
`;

	function el(tag, props, children) {
		const node = document.createElement(tag);
		if (props) Object.assign(node, props);
		if (children) children.forEach((c) => node.appendChild(c));
		return node;
	}

	function buildUI() {
		if (ui.host) return;
		const host = document.createElement("div");
		host.id = "fluxer-bb-host";
		host.style.cssText = "all: initial;";
		const shadow = host.attachShadow({ mode: "open" });
		shadow.appendChild(el("style", { textContent: CSS }));

		const fab = el("button", { className: "fab", title: "Broadcast Box screenshare" });
		fab.textContent = "BB";
		fab.setAttribute("aria-label", "Broadcast Box screenshare settings");
		fab.setAttribute("aria-expanded", "false");
		fab.addEventListener("click", () => togglePanel(fab));

		const panel = el("div", { className: "panel" });
		const head = el("div", { className: "head" });
		head.appendChild(el("h3", { textContent: "Broadcast Box screenshare" }));
		const closeBtn = el("button", { className: "close", textContent: "\u2715", title: "Close" });
		closeBtn.setAttribute("aria-label", "Close Broadcast Box panel");
		closeBtn.addEventListener("click", () => setPanelOpen(false));
		head.appendChild(closeBtn);
		panel.appendChild(head);

		const modeLabel = el("label", { textContent: "Mode" });
		const modeSel = el("select");
		[
			["bb", "Native screenshare via Broadcast Box"],
			["uncapped", "Uncapped LiveKit (no Broadcast Box)"],
		].forEach(([value, text]) => modeSel.appendChild(el("option", { value, textContent: text })));
		modeSel.value = config.mode;
		modeSel.addEventListener("change", () => {
			config.mode = modeSel.value;
			saveConfig();
			render();
		});
		panel.appendChild(modeLabel);
		panel.appendChild(modeSel);

		const fpsLabel = el("label", { textContent: "Capture frame rate" });
		const fpsInput = el("input", { type: "number", min: "15", max: "120", step: "1" });
		fpsInput.value = String(config.fps);
		fpsInput.addEventListener("change", () => {
			config.fps = Math.max(15, Math.min(120, Number(fpsInput.value) || 60));
			fpsInput.value = String(config.fps);
			saveConfig();
		});
		panel.appendChild(fpsLabel);
		panel.appendChild(fpsInput);

		const codecLabel = el("label", { textContent: "Video codec" });
		const codecSel = el("select", {});
		[
			["h264", "H264 — GPU (VAAPI) when available"],
			["vp9", "VP9 — software fallback"],
			["auto", "Auto — let Chrome choose"],
		].forEach(([value, textContent]) => codecSel.appendChild(el("option", { value, textContent })));
		codecSel.value = config.codec;
		codecSel.addEventListener("change", () => {
			config.codec = codecSel.value;
			saveConfig();
			render();
		});
		panel.appendChild(codecLabel);
		panel.appendChild(codecSel);

		const resLabel = el("label", { textContent: "Capture resolution" });
		const resSel = el("select", {});
		[
			["0", "Native (no cap)"],
			["2160", "2160p (4K)"],
			["1440", "1440p"],
			["1080", "1080p"],
			["720", "720p"],
		].forEach(([value, textContent]) => resSel.appendChild(el("option", { value, textContent })));
		resSel.value = String(config.maxHeight);
		resSel.addEventListener("change", () => {
			config.maxHeight = Number(resSel.value) || 0;
			saveConfig();
			render();
		});
		panel.appendChild(resLabel);
		panel.appendChild(resSel);

		const bitrateLabel = el("label", { textContent: "Broadcast Box bitrate (Mbps)" });
		const bitrateInput = el("input", { type: "number", min: "1", max: "80", step: "1" });
		bitrateInput.value = String(config.maxBitrateMbps);
		bitrateInput.addEventListener("change", () => {
			config.maxBitrateMbps = Math.max(1, Math.min(80, Number(bitrateInput.value) || 20));
			bitrateInput.value = String(config.maxBitrateMbps);
			saveConfig();
		});
		panel.appendChild(bitrateLabel);
		panel.appendChild(bitrateInput);

		const hostLabel = el("label", { textContent: "Broadcast Box host" });
		const hostInput = el("input", {
			type: "text",
			placeholder: "https://your-broadcast-box.example",
		});
		hostInput.value = config.host;
		let hostSaveTimer = null;
		const applyHost = () => {
			config.host = String(hostInput.value || "").trim().replace(/\/+$/, "");
		};
		hostInput.addEventListener("input", () => {
			applyHost();
			clearTimeout(hostSaveTimer);
			hostSaveTimer = setTimeout(() => {
				saveConfig();
				render();
			}, 450);
		});
		hostInput.addEventListener("change", () => {
			applyHost();
			hostInput.value = config.host;
			clearTimeout(hostSaveTimer);
			saveConfig();
			render();
		});
		panel.appendChild(hostLabel);
		panel.appendChild(hostInput);
		panel.appendChild(
			el("div", {
				className: "hint",
				textContent:
					"No default instance: paste your own Broadcast Box URL. It saves automatically.",
			}),
		);

		const mirrorLabel = el("label", { textContent: "Mirror an existing Broadcast Box stream" });
		const mirrorRow = el("div", { className: "row" });
		const mirrorInput = el("input", {
			type: "text",
			placeholder: "stream key or https://…/api/whip/…",
			spellcheck: false,
		});
		mirrorInput.value = config.mirrorKey || "";
		mirrorInput.setAttribute("aria-label", "Existing Broadcast Box stream key or URL");
		let mirrorSaveTimer = null;
		mirrorInput.addEventListener("input", () => {
			config.mirrorKey = String(mirrorInput.value || "").trim();
			clearTimeout(mirrorSaveTimer);
			mirrorSaveTimer = setTimeout(saveConfig, 450);
		});
		mirrorInput.addEventListener("change", () => {
			config.mirrorKey = String(mirrorInput.value || "").trim();
			clearTimeout(mirrorSaveTimer);
			saveConfig();
			render();
		});
		const mirrorBtn = el("button", { className: "mini", textContent: "Mirror stream" });
		mirrorBtn.addEventListener("click", () => {
			if (mirror.active) {
				void stopMirror();
				return;
			}
			config.mirrorKey = String(mirrorInput.value || "").trim();
			saveConfig();
			void startMirror(mirrorInput.value);
		});
		mirrorRow.appendChild(mirrorInput);
		mirrorRow.appendChild(mirrorBtn);
		panel.appendChild(mirrorLabel);
		panel.appendChild(mirrorRow);
		panel.appendChild(
			el("div", {
				className: "hint",
				textContent:
					"OBS already streaming to Broadcast Box? Paste the last part of its URL here and hit Mirror. The plugin subscribes over WHEP and starts a normal Fluxer screen share from that feed.",
			}),
		);

		const pluginHead = el("div", { className: "section-head" });
		pluginHead.appendChild(el("span", { textContent: "Plugins" }));
		const storeBtn = el("button", { className: "mini", textContent: "Store" });
		storeBtn.addEventListener("click", () => showStore(ui.els.storeView.style.display !== "block"));
		pluginHead.appendChild(storeBtn);
		panel.appendChild(pluginHead);

		const pluginList = el("div", { className: "plugin-list" });
		panel.appendChild(pluginList);

		const storeView = el("div", { className: "store-view" });
		storeView.style.display = "none";
		const storeRow = el("div", { className: "row" });
		const indexInput = el("input", { type: "text", placeholder: "builtin or https://…/index.json" });
		indexInput.value = config.storeIndex || "builtin";
		indexInput.addEventListener("change", () => {
			config.storeIndex = String(indexInput.value || "builtin").trim() || "builtin";
			saveConfig();
		});
		const loadBtn = el("button", { className: "mini", textContent: "Load" });
		loadBtn.addEventListener("click", () => {
			config.storeIndex = String(indexInput.value || "builtin").trim() || "builtin";
			saveConfig();
			loadStore();
		});
		storeRow.appendChild(indexInput);
		storeRow.appendChild(loadBtn);
		storeView.appendChild(storeRow);
		const storeList = el("div", { className: "plugin-list" });
		storeView.appendChild(storeList);
		const storeStatus = el("div", { className: "hint" });
		storeView.appendChild(storeStatus);
		storeView.appendChild(
			el("div", {
				className: "hint",
				textContent: "Plugins run with full access to this window. Only install code you trust.",
			}),
		);
		panel.appendChild(storeView);

		const status = el("div", { className: "status" });
		panel.appendChild(status);

		panel.appendChild(
			el("div", {
				className: "hint",
				textContent:
					"BB mode: your screen goes to Broadcast Box at the settings above; Fluxer gets a low-fps placeholder plus the native tile. Viewers need this plugin to see the full-quality feed. Uncapped mode keeps everything on LiveKit.",
			}),
		);

		shadow.appendChild(fab);
		shadow.appendChild(panel);
		ui.host = host;
		ui.shadow = shadow;
		ui.els = {
			fab,
			panel,
			modeSel,
			fpsInput,
			codecSel,
			resSel,
			bitrateInput,
			hostInput,
			mirrorInput,
			mirrorBtn,
			status,
			storeBtn,
			pluginList,
			storeView,
			indexInput,
			loadBtn,
			storeList,
			storeStatus,
		};
		document.addEventListener(
			"keydown",
			(ev) => {
				if (ev.key !== "Escape") return;
				if (ui.els.panel.getAttribute("data-open") !== "1") return;
				setPanelOpen(false);
				ev.stopPropagation();
			},
			true,
		);
		window.addEventListener("resize", () => positionPanel());
		document.addEventListener("scroll", () => positionPanel(), true);
		(document.body || document.documentElement).appendChild(host);
		if (pluginHost.loaded || pluginHost.error) renderPluginSection();
	}

	/* ------------------------------------------------------- native toolbar UI */

	function ensureToolbarStyle() {
		if (document.getElementById(TOOLBAR_STYLE_ID)) return;
		const style = document.createElement("style");
		style.id = TOOLBAR_STYLE_ID;
		style.textContent = `
[data-flx="${TOOLBAR_FLX}"] { position: relative; }
[data-flx="${TOOLBAR_FLX}"][data-live="1"] { color: #e5484d; }
[data-flx="${TOOLBAR_FLX}"][data-live="1"]::after {
  content: ""; position: absolute; top: 8px; right: 8px; width: 7px; height: 7px;
  border-radius: 50%; background: #e5484d; box-shadow: 0 0 0 2px rgba(0,0,0,.35);
}
[data-flx="${TOOLBAR_FLX}"]:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
`;
		(document.head || document.documentElement).appendChild(style);
	}

	function findShareButton() {
		const container = document.querySelector(TOOLBAR_SHARE_CONTAINER);
		if (container) {
			const btn = container.querySelector("button");
			if (btn) return btn;
		}
		const buttons = document.querySelectorAll('button[aria-label="Share your screen"]');
		for (const btn of buttons) {
			if (btn.closest(TOOLBAR_BAR_SELECTOR)) return btn;
		}
		return null;
	}

	function openStorePanel() {
		buildUI();
		setPanelOpen(true, null);
		showStore(true);
	}

	/** Add "Plugins & store" to Fluxer's own settings sidebar. */
	function mountSettingsEntry() {
		try {
			if (!document.body) return;
			const existing = document.getElementById(SETTINGS_ENTRY_ID);
			if (existing && existing.isConnected) {
				enforceSettingsSelection();
				return;
			}
			const tree = document.querySelector('[role="tree"][aria-label="Settings sections"]');
			if (!tree) return;
			const items = Array.from(tree.querySelectorAll('[role="treeitem"]'));
			const template =
				items.find((el) => el.textContent.trim().replace(/Opens in your browser$/, "") === "Applications") ||
				items.find((el) => el.textContent.trim() === "Account") ||
				items[0];
			if (!template || !template.parentElement) return;
			const entry = template.cloneNode(true);
			entry.id = SETTINGS_ENTRY_ID;
			entry.setAttribute("data-flx", "fluxer-bb.settings-modal-item");
			entry.setAttribute("data-section-id", "fluxer-bb-plugins");
			entry.setAttribute("aria-selected", "false");
			entry.removeAttribute("aria-expanded");
			entry.removeAttribute("aria-current");
			entry.removeAttribute("aria-controls");
			const label = entry.querySelector('[class*="sidebarItemLabel"] span') || entry.querySelector("span span");
			if (label) label.textContent = "Plugins";
			else entry.textContent = "Plugins";
			const svg = entry.querySelector("svg");
			if (svg) {
				svg.setAttribute("viewBox", "0 0 24 24");
				svg.setAttribute("fill", "currentColor");
				const paths = svg.querySelectorAll("path");
				for (let i = 1; i < paths.length; i += 1) paths[i].remove();
				if (paths[0]) paths[0].setAttribute("d", PLUGIN_PATH);
			}
			entry.title = "Install and manage FluxerBB plugins";
			entry.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				void openSettingsPage();
			});
			template.insertAdjacentElement("afterend", entry);
			enforceSettingsSelection();
		} catch (err) {
			warn("settings entry mount failed:", err);
		}
	}

	function mountToolbar() {
		try {
			if (!document.body) return;
			if (toolbarEl && toolbarEl.isConnected) return;
			const share = findShareButton();
			const bar = share && share.closest(TOOLBAR_BAR_SELECTOR);
			if (!share || !bar) {
				toolbarEl = null;
				toolbarWrap = null;
				if (ui.els.fab) ui.els.fab.style.display = "";
				return;
			}
			ensureToolbarStyle();
			const wrap = document.createElement("div");
			wrap.className = share.parentElement.className;
			wrap.setAttribute("data-flx", TOOLBAR_WRAP_FLX);
			const btn = document.createElement("button");
			btn.type = "button";
			btn.setAttribute("data-flx", TOOLBAR_FLX);
			btn.setAttribute("aria-haspopup", "dialog");
			btn.setAttribute("aria-expanded", "false");
			btn.setAttribute("aria-label", "Broadcast Box screenshare settings");
			btn.title = "Broadcast Box screenshare settings";
			const classes = Array.from(share.classList).filter((c) => /module__button___/.test(c));
			if (classes.length) btn.className = classes.join(" ");
			const stockSvg = share.querySelector("svg");
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
			svg.setAttribute("viewBox", "0 0 256 256");
			svg.setAttribute("fill", "currentColor");
			if (stockSvg && stockSvg.getAttribute("class")) {
				svg.setAttribute("class", stockSvg.getAttribute("class"));
			}
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", BROADCAST_PATH);
			svg.appendChild(path);
			btn.appendChild(svg);
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				togglePanel(btn);
			});
			wrap.appendChild(btn);
			share.parentElement.insertAdjacentElement("afterend", wrap);
			toolbarEl = btn;
			toolbarWrap = wrap;
			if (ui.els.fab) ui.els.fab.style.display = "none";
			updateToolbarLive(Boolean(publisher.active) || mirror.active);
		} catch (err) {
			warn("toolbar mount failed:", err);
		}
	}

	function unmountToolbar() {
		try {
			if (toolbarWrap) toolbarWrap.remove();
		} catch (_) {}
		toolbarEl = null;
		toolbarWrap = null;
		const style = document.getElementById(TOOLBAR_STYLE_ID);
		if (style) style.remove();
		if (ui.els.fab) ui.els.fab.style.display = "";
	}

	function updateToolbarLive(live) {
		if (!toolbarEl) return;
		toolbarEl.setAttribute("data-live", live ? "1" : "0");
	}

	function positionPanel() {
		const panel = ui.els.panel;
		if (!panel || panel.getAttribute("data-open") !== "1") return;
		const anchor = ui.anchor;
		if (!anchor || !anchor.isConnected) {
			panel.style.left = "";
			panel.style.top = "";
			panel.style.right = "18px";
			panel.style.bottom = "72px";
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const width = panel.offsetWidth || 330;
		const height = panel.offsetHeight || 420;
		let left = rect.left + rect.width / 2 - width / 2;
		left = Math.max(12, Math.min(window.innerWidth - width - 12, left));
		let top = rect.top - height - 12;
		if (top < 12) top = Math.min(window.innerHeight - height - 12, rect.bottom + 12);
		panel.style.left = Math.round(left) + "px";
		panel.style.top = Math.round(top) + "px";
		panel.style.right = "auto";
		panel.style.bottom = "auto";
	}

	function setPanelOpen(open, anchor) {
		if (!ui.host) buildUI();
		ui.anchor = open ? anchor || null : null;
		ui.els.panel.setAttribute("data-open", open ? "1" : "0");
		if (ui.els.fab) ui.els.fab.setAttribute("aria-expanded", open ? "true" : "false");
		if (toolbarEl) toolbarEl.setAttribute("aria-expanded", open ? "true" : "false");
		if (open) {
			render();
			positionPanel();
			refreshPlugins().catch(() => {});
		}
	}

	function togglePanel(anchor) {
		const open = ui.els.panel ? ui.els.panel.getAttribute("data-open") === "1" : false;
		setPanelOpen(!open, anchor);
	}

	function escapeHtml(value) {
		return String(value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function render() {
		try {
			if (!ui.host) buildUI();
			if (!ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
			ui.els.modeSel.value = config.mode;
			ui.els.fpsInput.value = String(config.fps);
			ui.els.codecSel.value = config.codec;
			ui.els.resSel.value = String(config.maxHeight);
			ui.els.bitrateInput.value = String(config.maxBitrateMbps);
			if (ui.shadow.activeElement !== ui.els.hostInput) ui.els.hostInput.value = config.host;
			if (ui.shadow.activeElement !== ui.els.mirrorInput) {
				ui.els.mirrorInput.value = config.mirrorKey || "";
			}
			ui.els.mirrorBtn.textContent = mirror.starting
				? "Connecting…"
				: mirror.active
					? "Stop mirror"
					: "Mirror stream";
			ui.els.mirrorBtn.disabled = mirror.starting || mirror.stopping;

			const publishing = Boolean(publisher.active);
			const mirroring = mirror.active || mirror.starting || Boolean(mirror.pending);
			const live = publishing || mirror.active || viewer.swaps.size > 0;
			ui.els.fab.setAttribute("data-live", live ? "1" : "0");
			updateToolbarLive(live);

			const identity = publisher.localIdentity ? parseIdentity(publisher.localIdentity) : null;
			const lines = [];
			const activity = publishing
				? " · <span class='ok'>publishing " + escapeHtml(publisher.active.key) + "</span>"
				: mirroring
					? " · <span class='ok'>" +
						(mirror.active ? "mirroring " : "connecting to ") +
						escapeHtml(mirror.key || config.mirrorKey) +
						"</span>"
					: "";
			lines.push(
				"<b>Mode</b> " +
					(config.mode === "bb" ? "Broadcast Box" : "Uncapped LiveKit") +
					activity,
			);
			if (config.mode === "bb" && !config.host) {
				lines.push(
					"<span class='err'>No Broadcast Box host set — shares stay on LiveKit until you add one.</span>",
				);
			}
			if (identity) {
				lines.push("<b>You</b> user " + identity.userId + " · connection " + identity.connectionId);
			} else {
				lines.push("<b>You</b> not in a voice connection");
			}
			lines.push("<b>Tiles</b> " + viewer.tiles + " screen share(s) · " + viewer.swaps.size + " on Broadcast Box");
			if (publisher.lastError) lines.push("<span class='err'>" + escapeHtml(publisher.lastError) + "</span>");
			if (viewer.lastError) lines.push("<span class='err'>" + escapeHtml(viewer.lastError) + "</span>");
			if (mirror.lastError) lines.push("<span class='err'>" + escapeHtml(mirror.lastError) + "</span>");
			ui.els.status.innerHTML = lines.join("<br>");
			if (ui.els.panel.getAttribute("data-open") === "1") positionPanel();
		} catch (err) {
			warn("render failed:", err);
		}
	}

	/* ------------------------------------------------------------------- boot */

	function start() {
		log(
			"v" + VERSION + " booting",
			config.host ? "against " + config.host : "without a Broadcast Box host",
			"(mode:",
			config.mode + ")",
		);
		installCaptureHook();
		installSenderHook();
		startViewer();
		hydrateConfig();
		const tryRender = () => (document.body ? render() : setTimeout(tryRender, 400));
		tryRender();
		mountToolbar();
		mountSettingsEntry();
		ui.timer = setInterval(render, 3000);
		// Pick up installed plugins once the store API and this object are live.
		setTimeout(() => {
			refreshPlugins().catch(() => {});
		}, 900);
	}

	window.__fluxerBB = {
		version: VERSION,
		config,
		mirror,
		start,
		startMirror,
		stopMirror,
		stop: async () => {
			await stopMirror({ native: true, reason: "plugin stop" });
			uninstallCaptureHook();
			if (scanTimer) clearInterval(scanTimer);
			scanTimer = null;
			if (observer) observer.disconnect();
			observer = null;
			for (const video of Array.from(viewer.swaps.keys())) restoreVideo(video);
			await stopPublish();
			if (publisher.placeholder) publisher.placeholder.stop();
			publisher.placeholder = null;
			if (publisher.realStream) {
				publisher.realStream.getTracks().forEach((t) => {
					try {
						t.stop();
					} catch (_) {}
				});
			}
			publisher.realStream = null;
			publisher.localDisplayStream = null;
			for (const entry of Array.from(pluginHost.entries.values())) stopPlugin(entry);
			if (ui.timer) clearInterval(ui.timer);
			unmountToolbar();
			closeSettingsPage();
			if (settingsPageState.guardHandler) {
				document.removeEventListener("click", settingsPageState.guardHandler, true);
				settingsPageState.guardHandler = null;
				settingsPageState.guards = false;
			}
			const settingsStyle = document.getElementById("fluxer-bb-settings-style");
			if (settingsStyle) settingsStyle.remove();
			const settingsEntry = document.getElementById(SETTINGS_ENTRY_ID);
			if (settingsEntry) settingsEntry.remove();
			if (ui.host && ui.host.isConnected) ui.host.remove();
		},
		// Debug / self-test surface
		publish: publishToBB,
		testCapture: startBBShare,
		stopPublish,
		watch: (key, videoEl) => {
			const target = videoEl || document.querySelector("#fluxer-bb-host")?.shadowRoot?.querySelector("video");
			if (!target) throw new Error("no video element");
			return watchWhep(key, (stream) => {
				target.muted = true;
				target.srcObject = stream;
				target.play().catch(() => {});
			}).ready;
		},
		findLocalIdentity,
		keyForIdentity,
		openPanel: () => setPanelOpen(true, null),
		closePanel: () => setPanelOpen(false),
		togglePanel: () => togglePanel(null),
		openStore: openStorePanel,
		openSettings: openSettingsPage,
		plugins: {
			refresh: refreshPlugins,
			list: () => pluginHost.available || [],
			running: () =>
				Array.from(pluginHost.entries.entries())
					.filter(([, entry]) => entry.running)
					.map(([id]) => id),
			error: () => pluginHost.error,
			api: pluginApiBase,
		},
		scan: () => {
			scanViewer();
			return window.__fluxerBB.tiles();
		},
		tiles: () => {
			const out = [];
			document.querySelectorAll('[data-source="screen_share"]').forEach((tile) => {
				const ref = trackRefFromElement(tile);
				if (!ref || !ref.participant) {
					out.push({identity: null, reason: "no trackRef"});
					return;
				}
				out.push({
					identity: ref.participant.identity,
					isLocal: Boolean(ref.participant.isLocal),
					key: keyForIdentity(ref.participant.identity),
					videos: tile.querySelectorAll("video").length,
					source: String(ref.source),
				});
			});
			return out;
		},
		state: () => ({
			version: VERSION,
			mode: config.mode,
			hookInstalled: hook.installed,
			localIdentity: publisher.localIdentity,
			key: publisher.localIdentity ? keyForIdentity(publisher.localIdentity) : null,
			publishing: publisher.active ? publisher.active.key : null,
			mirror: { active: mirror.active, key: mirror.key || config.mirrorKey || null },
			tiles: viewer.tiles,
			swaps: viewer.swaps.size,
			lastError: publisher.lastError || viewer.lastError || mirror.lastError || null,
		}),
		debug: () => ({
			mirror: {
				active: mirror.active,
				key: mirror.key || config.mirrorKey || null,
				startedAt: mirror.startedAt || null,
				session: mirror.session
					? {
							conn: mirror.session.pc ? mirror.session.pc.connectionState : null,
							video: mirror.session.stream.getVideoTracks().map((t) => t.readyState),
							audio: mirror.session.stream.getAudioTracks().map((t) => t.readyState),
						}
					: null,
			},
			publisher: {
				realStream: publisher.realStream
					? publisher.realStream.getTracks().map((t) => ({ kind: t.kind, state: t.readyState }))
					: null,
				placeholder: publisher.placeholder
					? { width: publisher.placeholder.canvas.width, height: publisher.placeholder.canvas.height }
					: null,
				active: publisher.active ? { key: publisher.active.key, sessionUrl: publisher.active.sessionUrl } : null,
			},
			swaps: Array.from(viewer.swaps.entries()).map(([video, entry]) => ({
				key: entry.key,
				width: video.videoWidth,
				height: video.videoHeight,
				ready: video.readyState,
				hasStream: Boolean(video.srcObject),
			})),
		}),
		debugAsync: async () => {
			const swaps = [];
			for (const [video, entry] of viewer.swaps) {
				const pc = entry.session && entry.session.pc;
				const stats = [];
				if (pc) {
					try {
						const report = await pc.getStats();
						report.forEach((s) => {
							if (s.type === "inbound-rtp" && s.kind === "video") {
								const codec = s.codecId ? report.get(s.codecId) : null;
								stats.push({
									codec: codec ? codec.mimeType : null,
									bytes: s.bytesReceived,
									received: s.framesReceived,
									decoded: s.framesDecoded,
									keyFrames: s.keyFramesDecoded,
									width: s.frameWidth,
									height: s.frameHeight,
								});
							}
						});
					} catch (_) {}
				}
				swaps.push({
					key: entry.key,
					conn: pc ? pc.connectionState : null,
					ice: pc ? pc.iceConnectionState : null,
					width: video.videoWidth,
					height: video.videoHeight,
					ready: video.readyState,
					stats,
				});
			}
			const publisherStats = [];
			if (publisher.active && publisher.active.pc) {
				try {
					const report = await publisher.active.pc.getStats();
					report.forEach((s) => {
						if (s.type === "outbound-rtp" && s.kind === "video") {
							const codec = s.codecId ? report.get(s.codecId) : null;
							publisherStats.push({
								encoder: s.encoderImplementation || null,
								codec: codec ? codec.mimeType : null,
								width: s.frameWidth,
								height: s.frameHeight,
								fps: s.framesPerSecond,
								bytes: s.bytesSent,
								framesEncoded: s.framesEncoded,
								targetBitrate: s.targetBitrate,
								reason: s.qualityLimitationReason || null,
							});
						}
					});
				} catch (_) {}
			}
			return { publisher: publisher.active ? publisher.active.key : null, publisherStats, swaps };
		},
	};

	start();
})();
