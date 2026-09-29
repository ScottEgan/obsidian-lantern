import { describe, it, expect } from "vitest";
import { truncate, errorMessage, durationSuffix, SECTION_SEP } from "../src/util";

describe("truncate", () => {
	it("returns the string unchanged when within the limit (incl. boundary)", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello", 5)).toBe("hello");
	});
	it("cuts and appends an ellipsis when over the limit", () => {
		expect(truncate("hello world", 5)).toBe("hello…");
	});
});

describe("errorMessage", () => {
	it("uses .message for Error instances", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});
	it("stringifies non-Error values", () => {
		expect(errorMessage("nope")).toBe("nope");
		expect(errorMessage(42)).toBe("42");
	});
});

describe("durationSuffix", () => {
	it("renders whole milliseconds under a second", () => {
		expect(durationSuffix(0)).toBe(" · 0 ms");
		expect(durationSuffix(412.4)).toBe(" · 412 ms");
		expect(durationSuffix(999)).toBe(" · 999 ms");
	});
	it("renders one-decimal seconds from a second up", () => {
		expect(durationSuffix(1000)).toBe(" · 1.0 s");
		expect(durationSuffix(1400)).toBe(" · 1.4 s");
		expect(durationSuffix(3240)).toBe(" · 3.2 s");
	});
	it("crosses the minute as minutes and seconds, never '60.0 s'", () => {
		expect(durationSuffix(59999)).toBe(" · 1m 0s");
		expect(durationSuffix(64000)).toBe(" · 1m 4s");
		expect(durationSuffix(125000)).toBe(" · 2m 5s");
	});
	it("is empty when the time is unknown, so it can be inlined unconditionally", () => {
		expect(durationSuffix()).toBe("");
		expect(durationSuffix(NaN)).toBe("");
		expect(durationSuffix(-1)).toBe("");
		expect(durationSuffix(Infinity)).toBe("");
	});
	it("prefixes every value with the shared section separator", () => {
		for (const ms of [12, 999, 1400, 64000]) {
			expect(durationSuffix(ms).startsWith(SECTION_SEP)).toBe(true);
		}
	});
});
