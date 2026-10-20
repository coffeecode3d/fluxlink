/* Fluxer BroadcastBox Bridge — verifier
 * SPDX-License-Identifier: MIT
 *
 * Runs a checklist against the live Fluxer renderer over CDP so you can tell
 * "is the plugin actually in the app, and can it reach Broadcast Box?" without
 * reading the devtools console by hand.
 *
 *   node src/verify.mjs
 *   node src/verify.mjs --selftest --verbose
 *   node src/verify.mjs --live            (dump screen-share tiles while in a call)
 *   node src/verify.mjs --shot=/tmp/opencode/bb.png
 *   node src/verify.mjs --port 9222 --host https://bb.example.com
 */
const args = process.argv.slice(2);
function argValue(name, fallback) {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}
const PORT = Number(argValue("port", process.env.FLUXER_DEBUG_PORT || 9222));
const HOST = argValue("host", process.env.FLUXER_BB_HOST || "").replace(/\/+$/, "");
const VERBOSE = args.includes("--verbose");
const SELFTEST = args.includes("--selftest");
const LIVE = args.includes("--live");

function report(ok, label, detail) {
	const mark = ok === true ? "PASS" : ok === false ? "FAIL" : "INFO";
	console.log(`  [${mark}] ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flat = (value, n = 200) => String(value ?? "-").replace(/\s+/g, " ").slice(0, n);

async function main() {
	let targets;
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, {cache: "no-store"});
		targets = await res.json();
	} catch (err) {
		console.error(`Cannot reach CDP on 127.0.0.1:${PORT}: ${err.message}`);
		console.error("Start Fluxer via node bin/fluxlink.js first.");
		process.exitCode = 1;
		return;
	}

	// Prefer the real app window (fluxer-app://), not the updater/splash page.
	const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
	const app = pages.find((t) => String(t.url).startsWith("fluxer-app://")) || pages[0];
	if (!app) {
		console.error("No page target found.");
		process.exitCode = 1;
		return;
	}
	console.log(`Fluxer target: ${app.title} <${app.url}>\n`);

	const ws = new WebSocket(app.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve);
		ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
	});

	let nextId = 1;
	const pending = new Map();
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const {resolve, reject} = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
		}
	});
	function send(method, params) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, {resolve, reject});
			ws.send(JSON.stringify({id, method, params: params || {}}));
		});
	}

	async function evaluate(expression, awaitPromise = false) {
		const result = await send("Runtime.evaluate", {
			expression,
			awaitPromise,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			const d =
				result.exceptionDetails.exception?.description ||
				result.exceptionDetails.text ||
				"error";
			return {ok: false, value: String(d).split("\n")[0]};
		}
		return {ok: true, value: result.result?.value};
	}

	async function state() {
		const res = await evaluate("window.__fluxerBB ? JSON.stringify(window.__fluxerBB.state()) : null");
		try {
			return JSON.parse(String(res.value));
		} catch (_) {
			return null;
		}
	}

	await send("Runtime.enable");

	console.log("Plugin presence");
	const injected = await evaluate("!!(window.__fluxerBB && window.__fluxerBB.version)");
	report(injected.value === true, "plugin injected", String(injected.value ?? "not present"));

	const st = await state();
	report(Boolean(st), "state() readable", JSON.stringify(st));

	report(st?.hookInstalled === true, "getDisplayMedia capture hook installed", String(st?.hookInstalled));
	report(
		st?.mode === "bb" || st?.mode === "uncapped",
		"mode configured",
		`${st?.mode} (bb = Broadcast Box, uncapped = LiveKit only)`,
	);

	const panel = await evaluate(
		"!!document.getElementById('fluxer-bb-host') && !!document.getElementById('fluxer-bb-host').shadowRoot",
	);
	report(panel.value === true, "panel UI mounted (shadow DOM)", String(panel.value));

	const identity = await evaluate(
		"(() => { try { const i = window.__fluxerBB.findLocalIdentity(); return i ? JSON.stringify({identity: i, key: window.__fluxerBB.keyForIdentity(i)}) : null; } catch (e) { return 'ERR ' + e.message; } })()",
	);
	report(
		Boolean(identity.value),
		"local voice identity resolvable (needs an active voice connection)",
		flat(identity.value) || "not in voice",
	);

	if (!HOST) {
		report(null, "Broadcast Box checks skipped", "pass --host https://bb.example.com or set FLUXER_BB_HOST");
	}

	if (HOST) {
		console.log("\nBroadcast Box reachability (from the Fluxer renderer origin)");
		const statusGet = await evaluate(
			`fetch(${JSON.stringify(HOST + "/api/status")}, {cache:"no-store"}).then(r => r.status + " " + r.headers.get("access-control-allow-origin")).catch(e => "ERR " + e.message)`,
			true,
		);
		report(String(statusGet.value || "").startsWith("200"), "GET /api/status", flat(statusGet.value));

		const whepPost = await evaluate(
			`fetch(${JSON.stringify(HOST + "/api/whep")}, {method:"POST", headers:{Authorization:"Bearer verify-probe","Content-Type":"application/sdp"}, body:"v=0"}).then(r => r.status).catch(e => "ERR " + e.message)`,
			true,
		);
		// 400 is the expected answer for a dummy SDP: it proves POST + Authorization
		// survive CORS. Anything else means CORS or connectivity failed.
		report(
			String(whepPost.value) === "400",
			"POST /api/whep reachable (400 expected for dummy SDP)",
			flat(whepPost.value),
		);

		// --selftest exercises the real WHIP publish + WHEP subscribe paths with a
		// synthetic canvas stream, so publishing and (video-only) playback can be
		// validated without a voice call or a screen share. Throwaway stream key.
		if (SELFTEST) {
			const key = `fluxer-bb-selftest-${Date.now().toString(36)}`;
			console.log(`\nEnd-to-end self-test (synthetic canvas stream, key "${key}")`);

			const pub = await evaluate(
				`(async () => {
					try {
						const c = document.createElement('canvas');
						c.width = 1280; c.height = 720;
						const ctx = c.getContext('2d');
						let i = 0;
						const timer = setInterval(() => {
							i = (i + 7) % 360;
							ctx.fillStyle = 'hsl(' + i + ',80%,50%)';
							ctx.fillRect(0, 0, c.width, c.height);
							ctx.fillStyle = '#fff';
							ctx.font = '48px sans-serif';
							ctx.fillText('FluxerBB selftest', 48, c.height / 2);
						}, 66);
						const stream = c.captureStream(15);
						window.__bbTestTimer = timer;
						window.__bbTestStream = stream;
						await window.__fluxerBB.publish(stream, ${JSON.stringify(key)});
						return JSON.stringify(window.__fluxerBB.state());
					} catch (e) { return 'ERR ' + (e && e.message); }
				})()`,
				true,
			);
			report(String(pub.value).includes(key), "WHIP publish accepted (201 + answer applied)", flat(pub.value));

			await sleep(2500);
			const ingest = await evaluate(
				`fetch(${JSON.stringify(HOST + "/api/status?key=" + key)}, {cache:"no-store"}).then(async r => r.status + " " + (await r.text()).slice(0,120)).catch(e => "ERR " + e.message)`,
				true,
			);
			report(
				String(ingest.value).startsWith("200") && !String(ingest.value).toLowerCase().includes("no active stream"),
				"server reports the stream live",
				flat(ingest.value),
			);

			const play = await evaluate(
				`(async () => {
					try {
						const v = document.createElement('video');
						v.muted = true; v.playsInline = true;
						v.setAttribute('data-flx', 'fluxer-bb.selftest-video');
						Object.assign(v.style, {position:'fixed', left:'-1000px', top:'0', width:'320px', height:'180px', opacity:'0.01', pointerEvents:'none'});
						document.body.appendChild(v);
						window.__bbTestVideo = v;
						await window.__fluxerBB.watch(${JSON.stringify(key)}, v);
						const samples = [];
						for (let i = 0; i < 10; i++) {
							await new Promise(r => setTimeout(r, 1000));
							samples.push({t: i + 1, w: v.videoWidth, h: v.videoHeight, ready: v.readyState});
							if (v.videoWidth > 0 && i >= 2) break;
						}
						return JSON.stringify({width: v.videoWidth, height: v.videoHeight, ready: v.readyState, samples});
					} catch (e) { return 'ERR ' + (e && e.message); }
				})()`,
				true,
			);
			let played = {};
			try {
				played = JSON.parse(String(play.value));
			} catch (_) {
				played = {};
			}
			report(
				Number(played.width) > 0,
				"WHEP video (video-only, the viewer path) decodes",
				`${played.width || 0}x${played.height || 0}, readyState=${played.ready}`,
			);
			if (VERBOSE) console.log("    samples:", JSON.stringify(played.samples || []));

			const cleanup = await evaluate(
				`(async () => { try { await window.__fluxerBB.stopPublish(); if (window.__bbTestVideo) { window.__bbTestVideo.srcObject = null; window.__bbTestVideo.remove(); delete window.__bbTestVideo; } if (window.__bbTestStream) { window.__bbTestStream.getTracks().forEach(t => t.stop()); delete window.__bbTestStream; } if (window.__bbTestTimer) { clearInterval(window.__bbTestTimer); delete window.__bbTestTimer; } } catch (e) {} return JSON.stringify(window.__fluxerBB.state()); })()`,
				true,
			);
			report(null, "cleaned up (publish stopped, session deleted)", flat(cleanup.value));
		}
	}

	if (LIVE) {
		console.log("\nScreen-share tiles (inspect while a share is live)");
		const scan = await evaluate("window.__fluxerBB.scan()");
		let tiles = [];
		try {
			tiles = JSON.parse(String(await evaluate("JSON.stringify(window.__fluxerBB.tiles())")).toString());
		} catch (_) {}
		if (!Array.isArray(tiles) || tiles.length === 0) {
			report(null, "no screen-share tiles present", "start a screen share, then re-run");
		} else {
			for (const tile of tiles) {
				report(
					tile.identity !== null,
					`tile ${tile.identity || "(unreadable)"}`,
					`BB key ${tile.key} · local=${tile.isLocal} · videos=${tile.videos} · source=${tile.source}`,
				);
			}
		}
		const dbg = await evaluate("JSON.stringify(window.__fluxerBB.debug())");
		console.log("    debug:", flat(dbg.value, 500));
	}

	const shotPath = argValue("shot", "");
	if (shotPath) {
		await evaluate("(() => { try { window.__fluxerBB.openPanel(); return true; } catch (e) { return false; } })()");
		await sleep(700);
		const shot = await send("Page.captureScreenshot", {format: "png"});
		if (shot && shot.data) {
			const {writeFile} = await import("node:fs/promises");
			await writeFile(shotPath, Buffer.from(shot.data, "base64"));
			report(true, "screenshot written", shotPath);
		} else {
			report(false, "screenshot", "no data returned");
		}
	}

	console.log(
		"\nNext: join a voice channel in Fluxer, then start a screen share.\n" +
			"  - in \"Broadcast Box\" mode the tile you see locally is your real capture,\n" +
			"    and other plugin users' viewers pull video from your Broadcast Box\n" +
			"  - run with --live to dump the tiles the viewer scan sees",
	);
	ws.close();
}

await main();
