/**
 * Tiny shared helpers used across modules (kept dependency-free so any layer
 * can import them without cycles).
 */

/** Truncate `str` to `max` characters, appending an ellipsis when it was cut. */
export function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Separator between the sections of a status/meta line ("a · b · c"). Shared so
 * a new segment can't drift from the ones already on the line.
 */
export const SECTION_SEP = " · ";

/**
 * Elapsed-time segment for the search status bar, already prefixed with the
 * separator so it splices into a status line as-is: " · 412 ms", " · 1.4 s",
 * " · 1m 4s". Empty when the time is unknown, so callers can inline it
 * unconditionally.
 *
 * Rounds to one decimal BEFORE the 60s check, so the seam reads "1m 0s"
 * rather than "60.0 s".
 */
export function durationSuffix(ms?: number): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${SECTION_SEP}${Math.round(ms)} ms`;
	const secs = Math.round(ms / 100) / 10;
	if (secs < 60) return `${SECTION_SEP}${secs.toFixed(1)} s`;
	const whole = Math.round(secs);
	return `${SECTION_SEP}${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/** decodeURIComponent that returns the input unchanged on malformed escapes. */
export function decodeUriSafe(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Normalise a tag value: trim and drop a single leading `#`. */
export function normalizeTag(value: string): string {
	return value.trim().replace(/^#/, "");
}
