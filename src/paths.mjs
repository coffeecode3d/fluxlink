/* Fluxlink — shared paths for the launcher, loader and installer
 * SPDX-License-Identifier: MIT
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir() {
	if (process.platform === "win32") {
		return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Fluxlink");
	}
	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Caches", "Fluxlink");
	}
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "fluxlink");
}

export function stateFile(name) {
	return path.join(stateDir(), name);
}

export function ensureStateDir() {
	const dir = stateDir();
	fs.mkdirSync(dir, {recursive: true});
	return dir;
}

export function lockPath(port) {
	return stateFile(`loader-${port}.pid`);
}

export function logPath(name = "loader.log") {
	return stateFile(name);
}

export function isAlive(pid) {
	const value = Number(pid);
	if (!Number.isInteger(value) || value <= 0) return false;
	try {
		process.kill(value, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to another user.
		return err && err.code === "EPERM";
	}
}

export function readLock(file) {
	try {
		// A loader refreshes the lock file every few seconds. If the file is
		// very old, treat it as stale even if the PID happens to be reused by
		// an unrelated process.
		const stat = fs.statSync(file);
		if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) return null;
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (data && isAlive(data.pid)) return data;
	} catch (_) {}
	return null;
}

export function writeLock(file, data) {
	ensureStateDir();
	fs.writeFileSync(file, JSON.stringify(data));
}

export function clearLock(file, pid) {
	try {
		const current = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!pid || current.pid === pid) fs.unlinkSync(file);
	} catch (_) {}
}
