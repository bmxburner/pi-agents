/**
 * Dim-behind-overlay (scrim) for ALL overlays, not just ours.
 *
 * Provenance: adapted from the delisted pi-compositor (render-engine.ts
 * applyDim + settings-store.ts fg resolution), then hardened — the original
 * only re-asserted dim after bare resets, so explicitly colored spans
 * (status icons, error/accent text, pills) popped full-bright behind the
 * overlay. This version neutralizes foreground-color SGR params while
 * preserving non-color attributes (bold/faint) and backgrounds.
 *
 * The seam: pi core composites native overlays ON TOP of the base frame
 * inside TuiBase.compositeOverlays, so dimming every base line BEFORE that
 * call leaves whatever overlay is up bright automatically. No geometry, no
 * per-component patches, no per-overlay wiring.
 *
 * Coverage is automatic: ctx.ui.custom({ overlay: true }) (overlay-kit's
 * openCenteredOverlay, runCustom, openLoading), TUI.showOverlay directly
 * (this footer's inspection view), questionnaire — all land in core's
 * overlayStack, so hasOverlay() sees every one, present and future.
 * (Verified: interactive-mode.js is core's only showOverlay caller, and it
 * serves the custom-overlay path — autocomplete/tooltips are inline, so no
 * dim flicker on transient popups.)
 */
import type { TUI } from "@earendil-works/pi-tui";

const DIM_FALLBACK_FG = "\x1b[38;2;82;76;68m"; // #524c44 — compositor's fallback
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const INSTALLED_KEY = Symbol.for("pi-agents.overlay-dim.installed");
// Any SGR sequence with numeric params (bare \x1b[m matches with "").
const SGR_RE = /\x1b\[([0-9;]*)m/g;
const DIM_RESET = "\x1b[0m";
// Kitty image protocol lines are terminal commands, not text — rewriting them
// would corrupt the image stream. (isImageLine isn't exported from pi-tui's
// index, so match the protocol introducer directly.)
const KITTY_IMG_INTRODUCER = "\x1b_G";

/**
 * Rewrite one SGR sequence for the scrim: drop foreground-color params
 * (basic 30-37/90-97, fg-only reset 39, full reset 0, extended 38;5;n and
 * 38;2;r;g;b with their args) and re-assert the dim fg, preserving
 * non-color attributes (bold, faint, underline) and backgrounds. Returns the
 * dim fg alone when nothing survives.
 */
function dimSgr(fg: string, params: string): string {
	if (params === "") return fg; // \x1b[m — reset
	const parts = params.split(";");
	const kept: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const n = Number(parts[i]);
		if (n === 38) {
			// Extended fg: 38;5;n or 38;2;r;g;b — consume mode + its args.
			const mode = Number(parts[i + 1]);
			i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
			continue;
		}
		if (n === 0 || n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) continue;
		kept.push(parts[i] as string);
	}
	return kept.length === 0 ? fg : `${fg}\x1b[${kept.join(";")}m`;
}

/**
 * Wrap a fully-composed frame line so its text renders dimmed behind an
 * overlay. Backgrounds are left untouched so the screen dims rather than
 * voiding to black; a full reset is appended (harmless at EOL) so dim never
 * leaks into the next line. Returns the line unchanged when `fg` is empty.
 */
export function applyDim(line: string, fg: string): string {
	if (line.length === 0 || fg.length === 0) return line;
	return fg + line.replace(SGR_RE, (_m, p: string) => dimSgr(fg, p)) + DIM_RESET;
}

/**
 * Resolve a theme-adaptive dim FOREGROUND from pi's live theme `dim` token,
 * falling back to a neutral gray. Resolved fresh on each dimmed frame (a
 * symbol read + map lookup) so a mid-session theme switch is picked up.
 */
function resolveDimFg(): string {
	try {
		const th = (globalThis as Record<symbol, unknown>)[THEME_KEY] as
			| { getFgAnsi?: (c: string) => string }
			| undefined;
		const ansi = th?.getFgAnsi?.("dim");
		if (typeof ansi === "string" && ansi.length > 0) return ansi;
	} catch {
		/* fall through to fallback */
	}
	return DIM_FALLBACK_FG;
}

// Matches TuiBase.compositeOverlays (tui.d.ts:354):
// compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[]
type CompositeOverlays = (lines: string[], termWidth: number, termHeight: number) => string[];

/**
 * Wrap this TUI instance's overlay composition so base-frame lines render
 * dimmed whenever any overlay is visible. Instance-level (not prototype) so
 * nothing else in the process is touched; safe to call twice; intentionally
 * no uninstall (hot-reload keeps the old closure, which still works). If a
 * future core drops compositeOverlays or hasOverlay, this no-ops and
 * overlays simply render undimmed — never wrong, just plain.
 */
export function installOverlayDim(tui: TUI): void {
	const rec = tui as unknown as Record<PropertyKey, unknown>;
	if (typeof rec.compositeOverlays !== "function" || rec[INSTALLED_KEY] === true) return;
	if (typeof rec.hasOverlay !== "function") return;
	const original = rec.compositeOverlays as CompositeOverlays;
	const hasOverlay = (rec.hasOverlay as () => boolean).bind(tui);
	rec[INSTALLED_KEY] = true;
	rec.compositeOverlays = function (this: unknown, lines: string[], w: number, h: number): string[] {
		let visible = false;
		try {
			visible = hasOverlay();
		} catch {
			visible = false;
		}
		let scoped = lines;
		if (visible) {
			const fg = resolveDimFg();
			if (fg.length > 0) {
				scoped = lines.map((line) => (line.includes(KITTY_IMG_INTRODUCER) ? line : applyDim(line, fg)));
			}
		}
		return original.call(this, scoped, w, h);
	};
}
