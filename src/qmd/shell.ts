/**
 * Thin wrapper around `cross-spawn` that provides a drop-in replacement for
 * `child_process.execFile` and `child_process.spawn`.
 *
 * Why cross-spawn: on Windows, Node's execFile/spawn cannot directly execute
 * `.cmd`/`.bat` files (e.g. pnpm shims) — they need `cmd.exe /c` wrapping.
 * cross-spawn handles this transparently, along with PATH resolution and
 * shebang handling on Unix.
 */

import spawn from "cross-spawn";
import { SpawnOptions } from "child_process";

export { spawn };

export interface ExecFileOptions extends SpawnOptions {
	timeout?: number;
	maxBuffer?: number;
}

export type ExecFileCallback = (
	error: (Error & { code?: string | number }) | null,
	stdout: string,
	stderr: string
) => void;

/**
 * Drop-in replacement for `child_process.execFile`.
 *
 * Uses cross-spawn's spawn under the hood, buffers stdout/stderr, enforces
 * timeout and maxBuffer, and invokes the callback with the same error shape
 * as execFile (error.code is "ENOENT" for missing binary, numeric for
 * non-zero exit, null for success).
 */
export function execFile(
	file: string,
	args: string[],
	options: ExecFileOptions,
	callback: ExecFileCallback
): void {
	const { timeout, maxBuffer = 64 * 1024 * 1024, ...spawnOptions } = options;

	const child = spawn(file, args, spawnOptions);

	let stdout = "";
	let stderr = "";
	let settled = false;

	const timer = timeout
		? setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill();
				const err = new Error(`Command timed out after ${timeout}ms: ${file}`) as Error & {
					code?: number;
				};
				err.code = 1;
				callback(err, stdout, stderr);
			}, timeout)
		: null;

	child.on("error", (err: Error & { code?: string }) => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		callback(err, stdout, stderr);
	});

	child.on("close", (code: number) => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);

		if (code === 0) {
			callback(null, stdout, stderr);
		} else {
			const err = new Error(
				`Command failed: ${file} ${args.join(" ")}\n${stderr}`
			) as Error & { code?: number };
			err.code = code;
			callback(err, stdout, stderr);
		}
	});

	if (child.stdout) {
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < maxBuffer) {
				stdout += chunk.toString();
			}
		});
	}

	if (child.stderr) {
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < maxBuffer) {
				stderr += chunk.toString();
			}
		});
	}
}
