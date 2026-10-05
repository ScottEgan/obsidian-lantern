// Private utility from exactly cross-spawn 7.0.6; used only by qmd/shell.ts.
declare module "cross-spawn/lib/util/escape" {
	export function command(value: string): string;
	export function argument(value: string, doubleEscapeMetaChars?: boolean): string;
}
