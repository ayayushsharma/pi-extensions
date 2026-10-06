/**
 * ctx-limit — force early auto-compaction by lowering the effective context window.
 *
 * Pi triggers auto-compaction at `model.contextWindow - compaction.reserveTokens`
 * and exposes no setter for the window. `ctx.compact()` is not a substitute: it is
 * the *manual* path, which aborts the running agent turn and never continues it —
 * which is why a watchdog built on `ctx.compact()` leaves the agent stopped after
 * it compacts.
 *
 * So this extension changes the one value core reads the window from:
 *
 *   model.contextWindow = min(manual_limit, original_contextWindow)
 *
 * in place. Pi then compacts at `effectiveWindow - reserveTokens` through its
 * normal automatic path — identical cut point, keep-tail, summary format, and file
 * tracking — and continues the run the same way stock Pi does (the between-turn
 * check before the next assistant response, plus the post-run threshold check).
 * The extension never calls `ctx.compact()`.
 *
 * The original window is remembered per `provider/id` and restored when the limit
 * is disabled or the session ends, so nothing is persisted.
 *
 * The extension is inert until a manual limit is configured. When none is set
 * anywhere, Pi's own behaviour governs the session untouched.
 *
 * Config precedence (highest wins):
 *   /ctx-set (session override) > --context-size > CTX_LIMIT_TOKENS >
 *   project .pi/settings.json > agent ~/.pi/agent/settings.json
 *
 * Compaction headroom stays Pi's own `compaction.reserveTokens` (default 16384);
 * only the effective window changes.
 *
 * Known limitation: a virtual model's declared `contextWindow` is not what
 * compaction checks — Pi checks the physical model each request routes to, which
 * an extension cannot reach. The cap therefore applies to physical models only.
 *
 * Usage:
 *   pi --extension ./extensions/ctx-limit.ts --context-size 128000
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Defaults ───

/** Pi's built-in `compaction.reserveTokens` fallback (see Pi settings docs). */
const CORE_DEFAULT_RESERVE_TOKENS = 16384;

interface CtxLimitOptions {
	maxTokens?: number;
	minTokens?: number;
	notify?: boolean;
}

// ─── Config file helpers ───

/** Expand a leading `~` (POSIX `/` or Windows `\` separator) to the home dir. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Read and parse a JSON file.
 *
 * Strips a leading UTF-8 BOM: Windows editors (Notepad, PowerShell `Out-File`,
 * some VS Code settings) commonly prepend one, and `JSON.parse` rejects it.
 * Missing/unreadable/malformed files return `undefined`.
 */
function readJsonFile(file: string): any | undefined {
	try {
		const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Pi's agent config directory: `PI_CODING_AGENT_DIR` when set (with `~`
 * expansion and relative paths resolved against the cwd), else `~/.pi/agent`.
 */
function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	return override ? path.resolve(expandHome(override)) : path.join(os.homedir(), ".pi", "agent");
}

/** ctxLimit block from a settings.json file, if present and an object. */
function readSettingsBlock(file: string): CtxLimitOptions {
	const json = readJsonFile(file);
	if (json && typeof json.ctxLimit === "object" && json.ctxLimit !== null) {
		return json.ctxLimit as CtxLimitOptions;
	}
	return {};
}

/** Pi's own `compaction.reserveTokens` from a settings.json file, if set. */
function readCompactionReserve(file: string): number | undefined {
	const json = readJsonFile(file);
	return toPositiveInt(json?.compaction?.reserveTokens);
}

function toPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === "string") {
		const n = Number(value.trim());
		if (Number.isSafeInteger(n) && n > 0) return n;
	}
	return undefined;
}

function toBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	return undefined;
}

function fmt(n: number | null): string {
	if (n === null) return "n/a";
	if (!Number.isFinite(n)) return "∞";
	return n.toLocaleString("en-US");
}

function short(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return `${n}`;
}

// ─── Extension ───

export default function (pi: ExtensionAPI) {
	pi.registerFlag("context-size", {
		description: "Cap the effective context window (tokens) so Pi compacts early, e.g. --context-size 128000",
		type: "string",
	});

	// Session-scoped override from /ctx-set. undefined = no override,
	// null = disabled for this session, number = manual limit.
	let sessionOverride: number | null | undefined;
	/** Original context windows we replaced, keyed by "provider/id". */
	const originalWindows = new Map<string, number>();

	function modelKey(model: any): string {
		return `${model.provider}/${model.id}`;
	}

	/** Remember a model's real window before we touch it; returns that window. */
	function originalWindowOf(model: any): number {
		const key = modelKey(model);
		const known = originalWindows.get(key);
		if (known !== undefined) return known;
		const current = typeof model.contextWindow === "number" ? model.contextWindow : 0;
		originalWindows.set(key, current);
		return current;
	}

	/** Restore a model object we previously capped (idempotent). */
	function restoreModel(model: any): void {
		if (!model) return;
		const known = originalWindows.get(modelKey(model));
		if (known !== undefined) model.contextWindow = known;
	}

	function settingsFiles(cwd?: string): { agentFile: string; projectFile: string } {
		return {
			agentFile: path.join(agentDir(), "settings.json"),
			projectFile: path.join(path.resolve(expandHome(cwd ?? process.cwd())), ".pi", "settings.json"),
		};
	}

	/** Pi's own compaction headroom: project override, agent override, else 16384. */
	function resolveReserve(cwd?: string): number {
		const { agentFile, projectFile } = settingsFiles(cwd);
		return readCompactionReserve(projectFile) ?? readCompactionReserve(agentFile) ?? CORE_DEFAULT_RESERVE_TOKENS;
	}

	function resolveOptions(cwd?: string): Required<CtxLimitOptions> {
		const { agentFile, projectFile } = settingsFiles(cwd);
		const agent = readSettingsBlock(agentFile);
		const project = readSettingsBlock(projectFile);

		// No manual limit is invented here: absent everywhere → 0 (disabled), so
		// Pi's existing defaults govern the session untouched.
		let maxTokens = toPositiveInt(project.maxTokens) ?? toPositiveInt(agent.maxTokens) ?? 0;
		// Optional floor, only meaningful when a limit is set. 0 = no floor.
		const minTokens = toPositiveInt(project.minTokens) ?? toPositiveInt(agent.minTokens) ?? 0;
		const notify = toBool(project.notify) ?? toBool(agent.notify) ?? true;

		const env = toPositiveInt(process.env.CTX_LIMIT_TOKENS);
		if (env !== undefined) maxTokens = env;

		const flag = pi.getFlag("context-size");
		if (typeof flag === "string" && flag.trim() !== "") {
			const t = flag.trim().toLowerCase();
			if (t === "off" || t === "false" || t === "0") {
				return { maxTokens: 0, minTokens, notify };
			}
			const parsed = toPositiveInt(t);
			if (parsed !== undefined) maxTokens = parsed;
		}

		if (sessionOverride !== undefined) {
			maxTokens = sessionOverride ?? 0; // null = disabled
		}

		return { maxTokens, minTokens, notify };
	}

	interface Applied {
		hasModel: boolean;
		/** Model is virtual: capping its declared window does not affect compaction. */
		virtual: boolean;
		disabled: boolean;
		noHeadroom: boolean;
		clamped: boolean;
		manual: number;
		original: number | null;
		effective: number | null;
		reserve: number;
		/** True when the model object actually accepted the new window. */
		applied: boolean;
	}

	/**
	 * Apply the cap to the live model object. Pi reads `model.contextWindow` for
	 * both its between-turn and post-run compaction checks, so setting it here
	 * makes core compact early and continue normally.
	 */
	function applyCap(ctx: ExtensionContext): Applied {
		const opts = resolveOptions(ctx.cwd);
		const reserve = resolveReserve(ctx.cwd);
		const model = ctx.model;
		if (!model) {
			return {
				hasModel: false,
				virtual: false,
				disabled: opts.maxTokens <= 0,
				noHeadroom: false,
				clamped: false,
				manual: opts.maxTokens,
				original: null,
				effective: null,
				reserve,
				applied: false,
			};
		}

		const virtual = typeof (model as any).route === "function";
		const original = originalWindowOf(model);

		let manual = opts.maxTokens;
		let clamped = false;
		if (opts.minTokens > 0 && manual > 0 && manual < opts.minTokens) {
			manual = opts.minTokens;
			clamped = true;
		}

		const base = { hasModel: true, virtual, clamped, manual, original, reserve };

		if (manual <= 0) {
			// Disabled: hand the real window back to Pi.
			let applied = false;
			try {
				model.contextWindow = original;
				applied = true;
			} catch {
				/* read-only model object */
			}
			return { ...base, disabled: true, noHeadroom: false, effective: original, applied };
		}

		const effective = Math.min(manual, original);
		if (effective <= reserve) {
			// No room after Pi's own reserve → leave Pi untouched rather than
			// forcing a compaction every turn.
			let applied = false;
			try {
				model.contextWindow = original;
				applied = true;
			} catch {
				/* read-only model object */
			}
			return { ...base, disabled: false, noHeadroom: true, effective, applied };
		}

		let applied = false;
		try {
			model.contextWindow = effective;
			applied = model.contextWindow === effective;
		} catch {
			applied = false;
		}
		return { ...base, disabled: false, noHeadroom: false, effective, applied };
	}

	function updateStatus(ctx: ExtensionContext, a: Applied): void {
		if (!ctx.hasUI) return;
		if (!a.hasModel) {
			ctx.ui.setStatus("ctx-limit", a.disabled ? "ctx-limit: off" : "ctx-limit: …");
			return;
		}
		if (a.disabled) {
			ctx.ui.setStatus("ctx-limit", "ctx-limit: off");
			return;
		}
		if (a.noHeadroom) {
			ctx.ui.setStatus("ctx-limit", "ctx-limit: !");
			return;
		}
		const used = ctx.getContextUsage()?.tokens ?? null;
		ctx.ui.setStatus(
			"ctx-limit",
			used === null ? `ctx →${short(a.effective!)}` : `ctx ${short(used)}/${short(a.effective!)}`,
		);
	}

	/** Re-apply the cap and refresh the footer; returns the resulting state. */
	function refresh(ctx: ExtensionContext): Applied {
		const a = applyCap(ctx);
		updateStatus(ctx, a);
		return a;
	}

	function statusLines(ctx: ExtensionContext, a: Applied): string[] {
		const used = ctx.getContextUsage()?.tokens ?? null;
		const trigger = a.effective !== null ? Math.max(a.effective - a.reserve, 0) : null;
		const lines = [
			`manual limit:  ${fmt(a.manual)} tokens`,
			`model window:  ${fmt(a.original)}${ctx.model ? ` (${ctx.model.provider}/${ctx.model.id})` : ""}`,
			`effective:     ${fmt(a.effective)} tokens`,
			`pi reserve:    ${fmt(a.reserve)} tokens (compaction.reserveTokens)`,
			`compacts at:   ${fmt(trigger)} tokens (effective − reserve, done by Pi)`,
			`current usage: ${used === null ? "unknown (e.g. right after compaction)" : `${fmt(used)} tokens`}`,
			`state:         ${
				!a.hasModel
					? "waiting for a model"
					: a.disabled
						? "disabled"
						: a.noHeadroom
							? "misconfigured (no headroom)"
							: a.applied
								? "active"
								: "could not set model window"
			}`,
		];
		if (a.clamped) lines.push(`note: manual limit raised to the minTokens floor`);
		if (a.noHeadroom)
			lines.push(
				`note: ${fmt(a.effective)} leaves no room after Pi's ${fmt(a.reserve)} reserve — window left unchanged`,
			);
		if (a.virtual)
			lines.push(
				`note: virtual model — Pi compacts against the routed physical model's window, so this cap is display-only`,
			);
		const flag = pi.getFlag("context-size");
		if (typeof flag === "string" && flag.trim() !== "") lines.push(`flag: --context-size ${flag.trim()}`);
		if (sessionOverride !== undefined)
			lines.push(`session override: ${sessionOverride === null ? "off" : fmt(sessionOverride)}`);
		return lines;
	}

	// ─── Commands ───

	pi.registerCommand("ctx-status", {
		description: "Show the ctx-limit effective window and current usage",
		handler: async (_args, ctx) => {
			const a = applyCap(ctx);
			updateStatus(ctx, a);
			ctx.ui.notify(statusLines(ctx, a).join("\n"), "info");
		},
	});

	pi.registerCommand("ctx-set", {
		description: "Set the session manual limit, e.g. /ctx-set 128000 (or /ctx-set off to disable)",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			if (raw === "" || raw === "help") {
				ctx.ui.notify("Usage: /ctx-set <tokens> | off | clear — session-only, does not edit config files", "info");
				return;
			}
			if (raw === "off" || raw === "clear" || raw === "0") {
				sessionOverride = raw === "clear" ? undefined : null;
				refresh(ctx);
				ctx.ui.notify(
					raw === "clear" ? "ctx-limit: session override cleared" : "ctx-limit: disabled for this session",
					"info",
				);
				return;
			}
			const opts = resolveOptions(ctx.cwd);
			const parsed = toPositiveInt(raw);
			if (parsed === undefined) {
				ctx.ui.notify(`ctx-limit: could not parse "${args.trim()}" as a token count`, "warning");
				return;
			}
			if (opts.minTokens > 0 && parsed < opts.minTokens) {
				ctx.ui.notify(
					`ctx-limit: ${fmt(parsed)} is below the minTokens floor (${fmt(opts.minTokens)}) — refusing, to avoid compact-every-turn thrash`,
					"warning",
				);
				return;
			}
			sessionOverride = parsed;
			refresh(ctx);
			ctx.ui.notify(`ctx-limit: session limit set to ${fmt(parsed)} tokens`, "info");
		},
	});

	// ─── Lifecycle ───

	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		// Give the model we are leaving its real window back, then cap the new one.
		restoreModel((event as any).previousModel);
		refresh(ctx);
	});

	// Re-assert before each run: the registry can swap the live model object
	// (e.g. a provider re-registers) without emitting model_select.
	pi.on("before_agent_start", async (_event, ctx) => {
		refresh(ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		const a = refresh(ctx);
		if (a.disabled || a.noHeadroom) return;
		const opts = resolveOptions(ctx.cwd);
		if (opts.notify && ctx.hasUI) {
			ctx.ui.notify(
				`ctx-limit: Pi compacted at ${fmt((event as any).compactionEntry?.tokensBefore ?? null)} tokens (reason: ${(event as any).reason})`,
				"info",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionOverride = undefined;
		restoreModel(ctx.model);
		try {
			ctx.ui.setStatus("ctx-limit", undefined);
		} catch {
			// Non-interactive modes may not support status — ignore.
		}
	});
}
