import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { buildTranscript } from "./transcript.ts";
import { installOverlayDim } from "./overlay-dim.ts";
import { getSubagentState, type SubagentSnapshot } from "./state.ts";

const MAX_FOOTER_ROWS = 8;
const MAX_TRANSCRIPT_LINES = 150;
const SCROLL_STEP = 5;
const SCROLL_PAGE = 20;
const OVERLAY_MARGIN = 1;

/** Inspection-overlay size presets, cycled with ^O in the detail view. */
const DETAIL_SIZES = [
	{ width: "62%", maxHeight: "72%" },
	{ width: "85%", maxHeight: "90%" },
	{ width: "100%", maxHeight: "100%" },
] as const;

/** overlay-kit's centered chrome, when that extension is loaded. Resolved live
 *  (never imported) so extension load order never matters; null = plain
 *  borderless fallback. */
function kitChrome(): ((parts: { width: number; title: string; body: string[]; footer?: string }) => string[]) | null {
	const api = (globalThis as Record<symbol, unknown>)[Symbol.for("overlay-kit/v1")] as { chrome?: unknown } | undefined;
	return typeof api?.chrome === "function"
		? (api.chrome as (parts: { width: number; title: string; body: string[]; footer?: string }) => string[])
		: null;
}

interface SubagentPanelOptions {
	onMessage?: (id: string, text: string) => Promise<void>;
	onCancel?: (id: string) => void;
	onFocus?: (id: string) => void;
	onClose?: (id: string) => void;
}

/** Footer row adapted from pi-agents live state — the single registry.
 *  Field names mirror the old FooterRow so the tree/detail renderers
 *  below work unchanged. All rows share parentRunId "root" (flat list). */
export interface FooterRow {
	runId: string;
	parentRunId: string;
	name: string;
	status: "starting" | "running_tool" | "idle" | "failed" | "completed";
	model: string;
	thinking: string;
	backend?: "pi" | "claude" | "codex";
	activity?: string;
	currentTool?: string;
	latestText?: string;
	error?: string;
	sessionFile?: string;
	surface: string;
	task: string;
	cwd: string;
	startedAt: string;
	finishedAt?: string;
}

function toFooterRow(snap: SubagentSnapshot): FooterRow {
	const status = snap.statusKind === "starting" ? "starting"
		: snap.statusKind === "active" ? "running_tool"
		: snap.statusKind === "waiting" ? "idle"
		: snap.statusKind === "stalled" ? "failed" : "completed";
	const agent = snap.agentName ?? "";
	return {
		runId: snap.id,
		parentRunId: "root",
		name: snap.name,
		status,
		model: agent,
		thinking: "",
		backend: agent.includes("claude") ? "claude" : agent.includes("codex") ? "codex" : "pi",
		activity: snap.activityLabel ?? snap.statusLabel ?? undefined,
		error: snap.errorText ?? undefined,
		sessionFile: snap.sessionFile || undefined,
		surface: snap.surface,
		task: snap.statusLabel ?? snap.activityLabel ?? snap.name,
		cwd: snap.artifactDir,
		startedAt: new Date(snap.startTime).toISOString(),
		finishedAt: snap.doneAt ? new Date(snap.doneAt).toISOString() : undefined,
	};
}

function shortPath(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function elapsed(record: FooterRow): string {
	const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
	const seconds = Math.max(0, Math.floor((end - Date.parse(record.startedAt)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function isTerminal(record: FooterRow): boolean {
	return record.status === "completed" || record.status === "failed";
}

function statusIcon(record: FooterRow): string {
	switch (record.status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "idle":
			return "◐";
		case "queued":
			return "◌";
		default:
			return "●";
	}
}

function statusColor(record: FooterRow): "success" | "error" | "warning" | "accent" {
	if (record.status === "completed") return "success";
	if (record.status === "failed") return "error";
	if (record.status === "idle") return "warning";
	return "accent";
}

/** Strip OSC control sequences (e.g. semantic-prompt markers) that would skew width math. */
function clean(line: string): string {
	return line.replace(/\][^\x07]*\x07/g, "");
}

export class SubagentPanel implements Component, Focusable {
	private _focused = false;
	private records: FooterRow[] = [];
	private visible: FooterRow[] = [];
	/** Row ids dismissed this session (hide finished on new turn). In-memory:
	 *  the live state is the single registry, nothing to persist to. */
	private dismissed = new Set<string>();
	private selected = 0;
	private detail = false;
	private reviewing = false;
	private editor?: Component;
	private mainModel?: string;
	private transcript: { key: string; components: Component[] } | null = null;
	private scrollOffset = 0;
	private detailRunId?: string;
	private detailSizeIdx = DETAIL_SIZES.length - 1;
	private messageInput = new Input();
	private messageStatus?: string;
	private detailOverlay?: SubagentDetailOverlay;
	private overlayHandle?: OverlayHandle;
	private timer: ReturnType<typeof setInterval>;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.messageInput.focused = value && this.detail;
	}

	constructor(
		private readonly tui: TUI,
		private theme: Theme,
		private readonly options: SubagentPanelOptions = {},
	) {
		this.messageInput.onSubmit = (value) => {
			const text = value.trim();
			const record = this.rows()[this.selected];
			if (!text || !record || !this.options.onMessage) return;
			this.messageInput.setValue("");
			this.scrollOffset = 0;
			this.messageStatus = "sending…";
			this.tui.requestRender();
			void this.options.onMessage(record.runId, text).then(
				() => {
					this.messageStatus = "sent";
					this.tui.requestRender();
				},
				(error) => {
					this.messageStatus = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				},
			);
		};
		installOverlayDim(this.tui);
		this.refresh();
		this.timer = setInterval(() => {
			const before = JSON.stringify(this.records);
			this.refresh();
			if (before !== JSON.stringify(this.records)) this.tui.requestRender();
		}, 250);
		this.timer.unref?.();
	}

	setEditor(editor: Component): void {
		this.editor = editor;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	setMainModel(model: string | undefined): void {
		this.mainModel = model;
	}

	/** Hide finished subagents from the footer. Runs when the user starts a new turn. */
	dismissFinished(): number {
		this.refresh();
		let count = 0;
		for (const record of this.records) {
			if (!isTerminal(record) || this.dismissed.has(record.runId)) continue;
			this.dismissed.add(record.runId);
			count++;
		}
		if (count > 0) this.refresh();
		return count;
	}

	/** Down-arrow entry: only non-dismissed subagents. */
	open(): boolean {
		if (this.overlayHandle) this.closeDetail();
		this.refresh();
		if (this.visible.length === 0) return false;
		this.reviewing = false;
		this.detail = false;
		this.selected = Math.min(this.selected, this.visible.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	/** /subagents entry: full history including dismissed. */
	openReview(): boolean {
		if (this.overlayHandle) this.closeDetail();
		this.refresh();
		if (this.records.length === 0) return false;
		this.reviewing = true;
		this.detail = false;
		this.selected = Math.min(this.selected, this.records.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	private rows(): FooterRow[] {
		return this.reviewing ? this.records : this.visible;
	}

	private close(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.reviewing = false;
		this.tui.setFocus(this.editor ?? null);
		this.tui.requestRender();
	}

	private openDetail(): void {
		if (this.rows().length === 0) return;
		this.detail = true;
		this.messageStatus = undefined;
		this.scrollOffset = 0;

		// A focused overlay is important here: Pi's fullscreen TUI otherwise
		// consumes page keys and mouse-wheel events for the main conversation
		// before they reach this widget.
		const showOverlay = (this.tui as TUI & { showOverlay?: TUI["showOverlay"] }).showOverlay;
		if (typeof showOverlay === "function") {
			this.showDetailOverlay(showOverlay);
		} else {
			// Keeps lightweight callers/tests that provide only the old TUI subset
			// usable; real Pi always has showOverlay().
			this.messageInput.focused = true;
		}
		this.tui.requestRender();
	}

	private closeDetail(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.scrollOffset = 0;
		const handle = this.overlayHandle;
		this.overlayHandle = undefined;
		this.detailOverlay = undefined;
		if (handle) {
			handle.hide();
		} else {
			this.tui.setFocus(this);
		}
		this.tui.requestRender();
	}

	private showDetailOverlay(showOverlay: TUI["showOverlay"]): void {
		const overlay = new SubagentDetailOverlay(this);
		this.detailOverlay = overlay;
		const size = DETAIL_SIZES[this.detailSizeIdx] ?? DETAIL_SIZES[DETAIL_SIZES.length - 1];
		this.overlayHandle = showOverlay.call(this.tui, overlay, {
			width: size.width,
			maxHeight: size.maxHeight,
			anchor: "center",
			margin: OVERLAY_MARGIN,
		});
	}

	/** Cycle the inspection-overlay size. Core has no live-resize handle, so
	 *  re-show at the new preset — chat behind is untouched. */
	private cycleDetailSize(): void {
		if (!this.overlayHandle) return;
		const showOverlay = (this.tui as TUI & { showOverlay?: TUI["showOverlay"] }).showOverlay;
		if (typeof showOverlay !== "function") return;
		this.detailSizeIdx = (this.detailSizeIdx + 1) % DETAIL_SIZES.length;
		try {
			this.overlayHandle.hide();
		} catch {
			/* already gone — re-show anyway */
		}
		this.overlayHandle = undefined;
		this.showDetailOverlay(showOverlay);
		// showOverlay focuses by default, but re-assert: the fresh wrapper
		// starts unfocused and IME follows wrapper focus, not the editor flag.
		this.overlayHandle?.focus();
	}

	/** Called by the overlay wrapper so the embedded editor keeps IME focus. */
	setDetailInputFocused(value: boolean): void {
		this.messageInput.focused = value && this.detail;
	}

	private detailMaxHeight(): number {
		const rows = this.tui.terminal?.rows;
		return typeof rows === "number" && Number.isFinite(rows)
			? Math.max(1, rows - OVERLAY_MARGIN * 2)
			: MAX_TRANSCRIPT_LINES + 8;
	}

	renderDetailForOverlay(width: number): string[] {
		const chrome = kitChrome();
		if (!chrome) return this.renderDetail(width, this.detailMaxHeight());
		// Chrome draws top border + title + footer + bottom border (4 rows);
		// content renders at the inner width so borders never clip text.
		const maxHeight = Math.max(5, this.detailMaxHeight() - 4);
		const inner = Math.max(1, width - 2);
		const sections = this.detailSections(inner, maxHeight);
		if (!sections.titleStyled) return [];
		return chrome({
			width,
			title: sections.titlePlain,
			body: sections.body,
			footer: "Enter send · ↑↓/PgUp/PgDn scroll · ^O size · Esc back",
		});
	}

	private refresh(): void {
		const selectedId = this.rows()[this.selected]?.runId;
		this.records = [...getSubagentState().byId.values()].map(toFooterRow);
		this.visible = this.records.filter((record) => !this.dismissed.has(record.runId));
		const rows = this.rows();
		const restored = selectedId ? rows.findIndex((record) => record.runId === selectedId) : -1;
		this.selected = restored >= 0 ? restored : Math.min(this.selected, Math.max(0, rows.length - 1));
		if (this.focused && rows.length === 0) this.close();
	}

	private handleWheel(data: string): boolean {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (!match) return false;
		const button = Number(match[1]);
		if (!Number.isFinite(button) || (button & 64) === 0) return false;
		const direction = button & 3;
		if (direction === 0) this.scrollOffset += SCROLL_STEP;
		else if (direction === 1) this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
		this.tui.requestRender();
		return true;
	}

	handleInput(data: string): void {
		// Left arrow (Esc as an alias) always goes back one level:
		// detail -> list -> editor.
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			(matchesKey(data, Key.left) && (!this.detail || this.messageInput.getValue().length === 0))
		) {
			if (this.detail) this.closeDetail();
			else this.close();
			return;
		}
		if (this.detail) {
			if (this.handleWheel(data)) return;
			// ^O cycles overlay size. Safe to preempt: pi-tui's Input rejects
			// C0 control characters, so no ctrl combo is ever typeable text.
			if (matchesKey(data, Key.ctrl("o"))) {
				this.cycleDetailSize();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.scrollOffset += SCROLL_STEP;
				this.tui.requestRender();
			} else if (matchesKey(data, Key.down)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_STEP);
				this.tui.requestRender();
			} else if (matchesKey(data, Key.pageUp)) {
				this.scrollOffset += SCROLL_PAGE;
				this.tui.requestRender();
			} else if (matchesKey(data, Key.pageDown)) {
				this.scrollOffset = Math.max(0, this.scrollOffset - SCROLL_PAGE);
				this.tui.requestRender();
			} else {
				this.messageInput.handleInput(data);
				this.tui.requestRender();
			}
			return;
		}
		// Enter or Right arrow opens the selected subagent.
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.openDetail();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selected === 0) this.close();
			else this.selected--;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.rows().length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			const record = this.rows()[this.selected];
			if (record && !isTerminal(record)) this.options.onCancel?.(record.runId);
			this.tui.requestRender();
		}
		if (data === "X") {
			const record = this.rows()[this.selected];
			if (record) this.options.onClose?.(record.runId);
			this.tui.requestRender();
		}
		if (data === "f") {
			const record = this.rows()[this.selected];
			if (record) this.options.onFocus?.(record.runId);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		this.refresh();
		if (this.focused && this.detail && !this.overlayHandle) return this.renderDetail(width);
		return this.renderTree(width);
	}

	private mainLine(): string {
		const main = this.theme.fg("accent", this.theme.bold("main"));
		return this.mainModel ? `${main} ${this.theme.fg("dim", `· ${this.mainModel}`)}` : main;
	}

	private rowBody(record: FooterRow): string {
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const activity = record.currentTool || record.activity || record.status;
		const sep = this.theme.fg("dim", " · ");
		// Backend badge for non-Pi subagents (Claude/Codex)
		const backendBadge = record.backend && record.backend !== "pi"
			? this.theme.fg("accent", `[${record.backend}]`)
			: undefined;
		const segments = [
			backendBadge,
			record.model ? this.theme.fg("dim", record.model) : undefined,
			this.theme.fg("dim", activity),
			...(isTerminal(record) ? [this.theme.fg("dim", elapsed(record))] : []),
		].filter((segment): segment is string => Boolean(segment));
		return `${icon} ${record.name}  ${segments.join(sep)}`;
	}

	private renderTree(width: number): string[] {
		// One tree for every state: the footer while typing, the focused list
		// after Down, and /subagents history. Only selection and hints differ.
		const rows = this.rows();
		if (rows.length === 0) return [];
		const byId = new Map(rows.map((r) => [r.runId, r]));
		const isLast = (record: FooterRow): boolean => {
			const siblings = rows.filter((r) => r.parentRunId === record.parentRunId);
			return siblings[siblings.length - 1]?.runId === record.runId;
		};
		const ancestorChain = (record: FooterRow): FooterRow[] => {
			const chain: FooterRow[] = [];
			let current = record;
			while (current.parentRunId !== "root" && byId.has(current.parentRunId)) {
				current = byId.get(current.parentRunId)!;
				chain.unshift(current);
			}
			return chain;
		};
		const selectedRunId = this.focused ? rows[this.selected]?.runId : undefined;
		const start = this.focused
			? Math.max(0, Math.min(rows.length - MAX_FOOTER_ROWS, this.selected - Math.floor(MAX_FOOTER_ROWS / 2)))
			: 0;
		const window = rows.slice(start, start + MAX_FOOTER_ROWS);
		const lines = [this.mainLine() + (this.reviewing ? this.theme.fg("dim", "  · history") : "")];
		if (start > 0) lines.push(this.theme.fg("dim", "  …"));
		for (const record of window) {
			const prefix =
				ancestorChain(record).map((a) => (isLast(a) ? "   " : "│  ")).join("") +
				(isLast(record) ? "└─ " : "├─ ");
			const line = truncateToWidth(prefix + this.rowBody(record), width, "…");
			if (this.focused && record.runId === selectedRunId) {
				lines.push(this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))));
			} else {
				lines.push(line);
			}
		}
		if (start + window.length < rows.length) {
			lines.push(this.theme.fg("dim", `… +${rows.length - start - window.length} more`));
		}
		lines.push(this.theme.fg("dim", this.focused ? "↑/↓ select   Enter/→ open   f focus pane   x stop   X close   ← back" : "↓ inspect"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private transcriptComponents(record: FooterRow): Component[] | null {
		const file = record.sessionFile;
		if (!file) return null;
		let key: string;
		try {
			const stat = statSync(file);
			key = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return null;
		}
		if (!this.transcript || this.transcript.key !== key) {
			const components = buildTranscript(file, this.tui, record.cwd);
			this.transcript = components ? { key, components } : null;
		}
		return this.transcript?.components ?? null;
	}

	private legacyDetail(record: FooterRow, width: number): string[] {
		const lines = [
			this.theme.fg("muted", "Task"),
			...wrapTextWithAnsi(record.task, Math.max(1, width)).slice(0, 3),
			"",
			this.theme.fg("muted", "Current activity"),
			truncateToWidth(record.currentTool || record.activity || record.status, width, "…"),
		];
		if (record.latestText) {
			lines.push("", this.theme.fg("muted", "Latest output"), ...wrapTextWithAnsi(record.latestText, Math.max(1, width)).slice(-4));
		}
		if (record.error) lines.push("", this.theme.fg("error", truncateToWidth(record.error, width, "…")));
		return lines;
	}

	private detailSections(width: number, maxHeight: number): { titlePlain: string; titleStyled: string; body: string[]; hints: string } {
		const record = this.rows()[this.selected];
		const hints = "Enter send   ↑/↓/PgUp/PgDn scroll   ^O size   Esc back";
		if (!record) return { titlePlain: "", titleStyled: "", body: [], hints };
		if (this.detailRunId !== record.runId) {
			this.detailRunId = record.runId;
			this.scrollOffset = 0;
			this.transcript = null;
		}
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const titlePlain = `${record.name} · ${record.status} · ${elapsed(record)}`;
		const titleStyled = truncateToWidth(`${icon} ${this.theme.bold(record.name)} ${this.theme.fg("dim", `· ${record.status} · ${elapsed(record)}`)}`, width);
		const head = [
			this.theme.fg("dim", `${record.model} · ${shortPath(record.cwd)}`),
			"",
		];
		const tail = [
			"",
			...(this.messageStatus
				? [this.theme.fg(this.messageStatus === "sent" || this.messageStatus === "sending…" ? "dim" : "error", this.messageStatus)]
				: []),
			this.theme.fg("muted", "Message this subagent:"),
			...this.messageInput.render(width),
		];
		// Title row + hints row live outside body (chrome draws them, or the
		// flat renderer adds them back) - budget content for the rest.
		const available = Math.max(1, maxHeight - 1 - head.length - tail.length - 1);
		const body = [...head];
		const components = this.transcriptComponents(record);
		if (!components || components.length === 0) {
			body.push(...this.legacyDetail(record, width).slice(0, available));
		} else {
			const transcript: string[] = [];
			for (const component of components) {
				for (const line of component.render(width)) transcript.push(clean(line));
			}
			if (record.activity === "responding" && record.latestText) {
				transcript.push("", this.theme.fg("dim", "live"), ...wrapTextWithAnsi(record.latestText, Math.max(1, width)));
			}
			const bodyViewport = Math.max(1, available - 2);
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, transcript.length - bodyViewport));
			const end = Math.max(0, transcript.length - this.scrollOffset);
			const start = Math.max(0, end - bodyViewport);
			const content: string[] = [];
			if (start > 0) content.push(this.theme.fg("dim", `… ${start} earlier lines · ↑/PgUp scroll`));
			content.push(...transcript.slice(start, end));
			if (this.scrollOffset > 0) content.push(this.theme.fg("dim", `… ${transcript.length - end} newer lines · ↓/PgDn follow`));
			body.push(...content.slice(0, available));
		}
		body.push(...tail);
		return { titlePlain, titleStyled, body, hints };
	}

	private renderDetail(width: number, maxHeight = MAX_TRANSCRIPT_LINES + 8): string[] {
		const sections = this.detailSections(width, maxHeight);
		if (!sections.titleStyled) return [];
		return [sections.titleStyled, ...sections.body, this.theme.fg("dim", sections.hints)]
			.slice(0, maxHeight).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.messageInput.invalidate();
	}

	dispose(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.overlayHandle?.hide();
		this.overlayHandle = undefined;
		this.detailOverlay = undefined;
		clearInterval(this.timer);
	}
}

/**
 * Focus target used by the transcript overlay. The persistent panel remains a
 * below-editor widget; this wrapper lets Pi's viewport defer page/mouse scroll
 * events while the transcript is open.
 */
class SubagentDetailOverlay implements Component, Focusable {
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.panel.setDetailInputFocused(value);
	}

	constructor(private readonly panel: SubagentPanel) {}

	handleInput(data: string): void {
		this.panel.handleInput(data);
	}

	render(width: number): string[] {
		return this.panel.renderDetailForOverlay(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}
