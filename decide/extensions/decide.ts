/**
 * decide — decision-tree analysis extension for Pi.
 *
 * Enforces exhaustive option analysis for open-ended problems:
 * propose options -> record evidence -> score against criteria ->
 * prune/keep -> verdict. State lives in a central store
 * (~/.pi/agent/decide/), keyed by cwd. Nothing is written into the
 * project until a tree completes, at which point a
 * `<slug>-decisions.md` snapshot is written to the tree's cwd.
 * An explicit /decide-export covers sharing incomplete trees.
 *
 * Rules followed:
 * - Factory only registers capabilities; all I/O happens on demand
 *   or in session_start. No stdout/stderr; ctx.ui.notify for output.
 * - Branch-sensitive state in tool-result details, rebuilt from
 *   ctx.sessionManager.getBranch(). Durable log via pi.appendEntry().
 * - All read-modify-write through withFileMutationQueue().
 * - turn_end auto-continuation deliberately NOT implemented in v1:
 *   /decide-continue is the explicit resume mechanism (no loop risk).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OptionStatus = "proposed" | "evidenced" | "scored" | "pruned" | "kept";
type TreeStatus = "active" | "complete" | "abandoned";

interface DecisionOption {
	id: string;
	label: string;
	status: OptionStatus;
	evidence: string[];
	scores: Record<string, number>;
	/** cwd-relative reference paths (never copied, resolved for viewing only) */
	docs: string[];
	note?: string;
	/** sub-decision tree spawned from this option */
	childId?: string;
}

interface DecisionTree {
	id: string;
	title: string;
	problem: string;
	/** project scope: realpath(cwd) captured at creation */
	cwd: string;
	repoRoot?: string;
	createdAt: number;
	updatedAt: number;
	status: TreeStatus;
	criteria: string[];
	options: DecisionOption[];
	verdict?: string;
	/** verdicts superseded by reopen — audit trail, newest last */
	previousVerdicts?: string[];
	/** basename of the auto-written completion snapshot, if any */
	snapshotFile?: string;
	/** parent link when this tree is a sub-decision */
	parent?: { treeId: string; optionId: string };
}

interface ProjectBucket {
	cwd: string;
	slug: string;
	repoRoot?: string;
	updatedAt: number;
	activeId?: string;
	trees: { id: string; title: string; status: TreeStatus; updatedAt: number; parentId?: string }[];
}

interface DecideDetails {
	treeId: string;
	action: string;
	status: TreeStatus;
	summary: string;
	error?: string;
}

interface DecideStepEntry {
	treeId: string;
	title: string;
	event: string;
	at: number;
}

interface DecideOutcome {
	text: string;
	tree?: DecisionTree;
	event: string;
}

// ---------------------------------------------------------------------------
// turn_end auto-nudge state (in-memory, per session)
// ---------------------------------------------------------------------------

/** Consecutive nudges allowed while the tree makes no progress. */
const MAX_NUDGES_PER_STATE = 3;
/** Absolute backstop per session. */
const MAX_NUDGES_PER_SESSION = 12;
/** Doc viewer paging (render() has no height, so the viewer pages). */
const VIEW_WINDOW = 25;
const VIEW_PAGE = 20;
const VIEW_MAX_LINES = 400;
/** Max nesting depth for sub-decisions (parent chain length + 1). */
const MAX_NEST_DEPTH = 5;

interface NudgeState {
	/** A decide tool result has been seen this session. */
	inFlight: boolean;
	treeId?: string;
	lastSnapshot?: string;
	nudgesForSnapshot: number;
	totalNudges: number;
}

function freshNudge(): NudgeState {
	return { inFlight: false, nudgesForSnapshot: 0, totalNudges: 0 };
}

let nudge: NudgeState = freshNudge();

function snapshotTree(tree: DecisionTree): string {
	const opts = tree.options.map((o) => `${o.id}:${o.status}:${o.evidence.length}:${Object.keys(o.scores).length}`).join(",");
	return `${tree.updatedAt}:${tree.status}:${opts}`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function centralRoot(): string {
	return join(homedir(), ".pi", "agent", "decide");
}

function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

function normalizeCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

function projectSlug(cwd: string): string {
	const base = basename(cwd) || "root";
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
	return `${slug}-${shortHash(normalizeCwd(cwd))}`;
}

function detectRepoRoot(cwd: string): string | undefined {
	try {
		const out = execSync("git rev-parse --show-toplevel", { cwd, stdio: ["ignore", "pipe", "ignore"] });
		return out.toString().trim() || undefined;
	} catch {
		return undefined;
	}
}

function slugifyTitle(title: string, fallback: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
	return slug || fallback;
}

function newTreeId(): string {
	const d = new Date();
	const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
	return `${ymd}-${shortHash(`${Date.now()}-${Math.random()}`)}`;
}

function newOptionId(tree: DecisionTree): string {
	return `o${tree.options.length + 1}`;
}

function statusSummary(tree: DecisionTree): string {
	const n = tree.options.length;
	const ev = tree.options.filter((o) => o.evidence.length > 0).length;
	const sc = tree.options.filter((o) => Object.keys(o.scores).length > 0).length;
	const kept = tree.options.filter((o) => o.status === "kept").length;
	const pruned = tree.options.filter((o) => o.status === "pruned").length;
	return `${tree.title} [${tree.status}] ${ev}/${n} evidenced, ${sc}/${n} scored, ${kept} kept, ${pruned} pruned`;
}

function nextAction(tree: DecisionTree, kids?: { option: DecisionOption; child: DecisionTree }[]): string {
	if (tree.status !== "active") return `Tree is ${tree.status}.`;
	const open = (kids ?? []).filter((k) => k.option.status !== "pruned");
	if (open.length > 0) {
		const more = open.length > 1 ? ` (+${open.length - 1} more)` : "";
		return `Resolve sub-decision ${open[0].child.id} (${open[0].child.title}) under ${open[0].option.id}${more}: ${nextAction(open[0].child)}`;
	}
	const needEvidence = tree.options.filter((o) => o.status === "proposed" && o.evidence.length === 0);
	if (needEvidence.length > 0) {
		return `Record evidence for: ${needEvidence.map((o) => `${o.id} (${o.label})`).join(", ")}.`;
	}
	const needScore = tree.options.filter(
		(o) => (o.status === "evidenced" || o.status === "proposed") && Object.keys(o.scores).length === 0,
	);
	if (needScore.length > 0) {
		const crit = tree.criteria.length > 0 ? ` against criteria [${tree.criteria.join(", ")}]` : "";
		return `Score${crit}: ${needScore.map((o) => `${o.id} (${o.label})`).join(", ")}.`;
	}
	const unscored = tree.options.filter((o) => o.status === "evidenced");
	if (unscored.length > 0) return `Mark scored/pruned/kept: ${unscored.map((o) => o.id).join(", ")}.`;
	if (!tree.verdict) return "All options resolved — record a verdict.";
	return "Ready.";
}

function treeDepth(dir: string, treeId: string): number {
	let depth = 0;
	let cur: string | undefined = treeId;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		const t = loadTree(dir, cur);
		if (!t?.parent) break;
		depth += 1;
		cur = t.parent.treeId;
	}
	return depth;
}

function childLinks(dir: string, tree: DecisionTree): { option: DecisionOption; child: DecisionTree }[] {
	const out: { option: DecisionOption; child: DecisionTree }[] = [];
	for (const o of tree.options) {
		if (!o.childId) continue;
		const c = loadTree(dir, o.childId);
		if (c) out.push({ option: o, child: c });
	}
	return out;
}

function activeChildren(dir: string, tree: DecisionTree): { option: DecisionOption; child: DecisionTree }[] {
	return childLinks(dir, tree).filter(({ child }) => child.status === "active");
}

function nextStep(dir: string, tree: DecisionTree): string {
	return nextAction(tree, activeChildren(dir, tree));
}

function statusGlyph(s: OptionStatus): string {
	switch (s) {
		case "proposed": return "○";
		case "evidenced": return "◐";
		case "scored": return "✓";
		case "pruned": return "✕";
		case "kept": return "★";
	}
}

// ---------------------------------------------------------------------------
// Markdown rendering (central mirror + cwd snapshot share one body)
// ---------------------------------------------------------------------------

function renderTreeMarkdown(tree: DecisionTree, projectDir: string): string {
	const lines: string[] = [];
	lines.push(`<!-- decide:treeId=${tree.id} project=${basename(projectDir)} -->`);
	lines.push(`# ${tree.title}`);
	lines.push("");
	lines.push(`- tree: \`${tree.id}\``);
	lines.push(`- status: **${tree.status}**`);
	lines.push(`- created: ${new Date(tree.createdAt).toLocaleString()}`);
	lines.push(`- updated: ${new Date(tree.updatedAt).toLocaleString()}`);
	lines.push(`- scope (cwd at creation): \`${tree.cwd}\``);
	if (tree.verdict) lines.push(`- verdict: **${tree.verdict}**`);
	for (const pv of tree.previousVerdicts ?? []) lines.push(`- superseded: ~~${pv}~~`);
	lines.push("");
	lines.push("## Problem");
	lines.push("");
	lines.push(tree.problem);
	lines.push("");
	lines.push("## Criteria");
	lines.push("");
	lines.push(tree.criteria.length > 0 ? tree.criteria.map((c) => `- ${c}`).join("\n") : "_No criteria recorded._");
	lines.push("");
	lines.push("## Options");
	lines.push("");
	for (const o of tree.options) {
		lines.push(`### ${statusGlyph(o.status)} ${o.label} \`(${o.id}, ${o.status})\``);
	if (o.childId) {
		const kid = loadTree(projectDir, o.childId);
		lines.push(`- sub-decision: \`${o.childId}\`${kid ? ` ([${kid.status}]) ${kid.title}${kid.verdict ? ` — ${kid.verdict}` : ""}` : " (missing)"}`);
	}
		if (o.note) lines.push(`\n${o.note}\n`);
		if (Object.keys(o.scores).length > 0) {
			lines.push("\n| criterion | score |");
			lines.push("|---|---|");
			for (const [k, v] of Object.entries(o.scores)) lines.push(`| ${k} | ${v} |`);
		}
		if (o.evidence.length > 0) {
			lines.push("\n**Evidence:**");
			for (const e of o.evidence.slice(0, 20)) lines.push(`- ${e}`);
			if (o.evidence.length > 20) lines.push(`- … ${o.evidence.length - 20} more (see central JSON)`);
		}
		if (o.docs.length > 0) {
			lines.push("\n**Docs:**");
			for (const d of o.docs) lines.push(`- \`${d}\``);
		}
		lines.push("");
	}
	lines.push("---");
	lines.push("_Derived snapshot. Source of truth lives in the central decide store; re-run `/decide-continue` to revise._");
	lines.push("");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Store (central only; project dirs are never touched except snapshots)
// ---------------------------------------------------------------------------

function readJson<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

function globalIndexPath(): string {
	return join(centralRoot(), "index.json");
}

function loadGlobalIndex(): Record<string, { dir: string; cwd: string; updatedAt: number }> {
	return readJson(globalIndexPath(), {});
}

function projectDirFor(cwd: string): { dir: string; bucket: ProjectBucket } {
	const norm = normalizeCwd(cwd);
	const slug = projectSlug(norm);
	const dir = join(centralRoot(), "projects", slug);
	const bucketPath = join(dir, "index.json");
	const existing = readJson<ProjectBucket | undefined>(bucketPath, undefined);
	if (existing) return { dir, bucket: existing };
	return {
		dir,
		bucket: { cwd: norm, slug, repoRoot: detectRepoRoot(norm), updatedAt: Date.now(), trees: [] },
	};
}

function saveProject(dir: string, bucket: ProjectBucket, globalIdx: Record<string, { dir: string; cwd: string; updatedAt: number }>): void {
	bucket.updatedAt = Date.now();
	atomicWrite(join(dir, "index.json"), JSON.stringify(bucket, null, 2));
	globalIdx[bucket.cwd] = { dir, cwd: bucket.cwd, updatedAt: bucket.updatedAt };
	atomicWrite(globalIndexPath(), JSON.stringify(globalIdx, null, 2));
}

function treeJsonPath(dir: string, treeId: string): string {
	// treeId is generated internally (date + hash); still guard against traversal.
	if (!/^[A-Za-z0-9_-]+$/.test(treeId)) throw new Error(`Bad tree id: ${treeId}`);
	return join(dir, `${treeId}.json`);
}

function treeMdPath(dir: string, treeId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(treeId)) throw new Error(`Bad tree id: ${treeId}`);
	return join(dir, `${treeId}.md`);
}

function loadTree(dir: string, treeId: string): DecisionTree | undefined {
	return readJson<DecisionTree | undefined>(treeJsonPath(dir, treeId), undefined);
}

function persistTree(dir: string, tree: DecisionTree): void {
	tree.updatedAt = Date.now();
	atomicWrite(treeJsonPath(dir, tree.id), JSON.stringify(tree, null, 2));
	atomicWrite(treeMdPath(dir, tree.id), renderTreeMarkdown(tree, dir));
}

function touchBucketEntry(bucket: ProjectBucket, tree: DecisionTree): void {
	const row = bucket.trees.find((t) => t.id === tree.id);
	const entry = { id: tree.id, title: tree.title, status: tree.status, updatedAt: tree.updatedAt, parentId: tree.parent?.treeId };
	if (row) Object.assign(row, entry);
	else bucket.trees.push(entry);
	if (tree.status === "active") bucket.activeId = tree.id;
	else if (bucket.activeId === tree.id) bucket.activeId = undefined;
}

function resolveTreeId(bucket: ProjectBucket, treeId?: string): string | undefined {
	if (treeId) return bucket.trees.some((t) => t.id === treeId) ? treeId : undefined;
	if (bucket.activeId) return bucket.activeId;
	const actives = bucket.trees.filter((t) => t.status === "active").sort((a, b) => b.updatedAt - a.updatedAt);
	return actives[0]?.id;
}

// ---------------------------------------------------------------------------
// Completion snapshot (<slug>-decisions.md in the tree's cwd)
// ---------------------------------------------------------------------------

function snapshotFilename(tree: DecisionTree): string {
	return `${slugifyTitle(tree.title, `decision-${tree.id}`)}-decisions.md`;
}

/** Writes the completion snapshot. Returns the basename written. Never overwrites foreign files. */
function writeCompletionSnapshot(tree: DecisionTree, projectDir: string): string {
	const desiredPath = join(tree.cwd, snapshotFilename(tree));
	let finalPath = desiredPath;
	if (existsSync(desiredPath)) {
		const current = readFileSync(desiredPath, "utf8");
		if (!current.includes(`decide:treeId=${tree.id}`)) {
			finalPath = join(tree.cwd, `${slugifyTitle(tree.title, `decision-${tree.id}`)}-${tree.id}-decisions.md`);
		}
	}
	atomicWrite(finalPath, renderTreeMarkdown(tree, projectDir));
	return basename(finalPath);
}

// ---------------------------------------------------------------------------
// Branch reconstruction (tool details are branch truth)
// ---------------------------------------------------------------------------

function reconstructFromBranch(ctx: ExtensionContext): Map<string, DecideDetails> {
	const seen = new Map<string, DecideDetails>();
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "decide") continue;
			const details = msg.details as DecideDetails | undefined;
			if (details?.treeId) seen.set(details.treeId, details);
		}
	} catch {
		// read-only context or unexpected shape: central store remains the fallback
	}
	return seen;
}

// ---------------------------------------------------------------------------
// Core: shared by the tool and the commands (command ctx has no executeTool)
// ---------------------------------------------------------------------------

const DecideParams = Type.Object({
	action: StringEnum(["start", "add-options", "record-evidence", "score", "prune", "verdict", "status", "list", "reopen"] as const),
	treeId: Type.Optional(Type.String({ description: "Tree id (defaults to the project's active tree)" })),
	title: Type.Optional(Type.String({ description: "Tree title (for start)" })),
	problem: Type.Optional(Type.String({ description: "Problem statement (for start)" })),
	criteria: Type.Optional(Type.Array(Type.String(), { description: "Decision criteria (for start/score)" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Option labels (for start/add-options)" })),
	optionId: Type.Optional(Type.String({ description: "Option id like o1 (for record-evidence/score/prune)" })),
	text: Type.Optional(Type.String({ description: "Evidence bullet or note" })),
	scores: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Criterion -> numeric score" })),
	verdict: Type.Optional(Type.String({ description: "Winning option + rationale (for verdict)" })),
	docs: Type.Optional(Type.Array(Type.String(), { description: "cwd-relative doc references to attach to an option" })),
	parent: Type.Optional(Type.Object({
		treeId: Type.String({ description: "Parent tree id" }),
		optionId: Type.String({ description: "Parent option id like o1" }),
	}, { description: "Attach this start as a sub-decision under a parent option" })),
});

type DecideInput = Static<typeof DecideParams>;

async function runDecide(cwd: string, params: DecideInput): Promise<DecideOutcome> {
	const norm = normalizeCwd(cwd);
	const { dir, bucket: fresh } = projectDirFor(norm);
	// Serialize per project bucket (queue key = bucket index file).
	return withFileMutationQueue(join(dir, "index.json"), async () => {
		const globalIdx = loadGlobalIndex();
		const bucket = readJson<ProjectBucket>(join(dir, "index.json"), fresh);

		if (params.action === "start") {
			const problem = (params.problem ?? "").trim();
			if (!problem) return { text: "Error: problem is required for start.", event: "" };
			const parentRef = params.parent;
			let parentTree: DecisionTree | undefined;
			let parentOpt: DecisionOption | undefined;
			if (parentRef) {
				parentTree = loadTree(dir, parentRef.treeId);
				if (!parentTree) return { text: `Parent tree ${parentRef.treeId} not found in this directory's scope.`, event: "" };
				if (parentTree.status !== "active") return { text: `Parent tree ${parentRef.treeId} is ${parentTree.status}; sub-decisions attach to active trees.`, event: "" };
				parentOpt = parentTree.options.find((o) => o.id === parentRef.optionId);
				if (!parentOpt) return { text: `Option ${parentRef.optionId} not found in parent ${parentRef.treeId}.`, event: "" };
				if (parentOpt.childId) return { text: `${parentRef.optionId} already has sub-decision ${parentOpt.childId}. Continue it with /decide-continue ${parentOpt.childId}.`, event: "" };
				if (treeDepth(dir, parentTree.id) + 1 > MAX_NEST_DEPTH) return { text: `Nesting limit reached (max depth ${MAX_NEST_DEPTH}).`, event: "" };
			} else {
				const active = bucket.trees.find((t) => t.status === "active" && t.id === bucket.activeId);
				if (active) {
					return { text: `An incomplete tree is already active (${active.id}: ${active.title}). Finish it or run /decide-continue, or abandon it before starting a new one.`, event: "" };
				}
			}
			const now = Date.now();
			const tree: DecisionTree = {
				id: newTreeId(),
				title: (params.title ?? problem.slice(0, 60)).trim() || `Decision ${new Date().toLocaleDateString()}`,
				problem,
				cwd: norm,
				repoRoot: detectRepoRoot(norm),
				createdAt: now,
				updatedAt: now,
				status: "active",
				criteria: params.criteria ?? [],
				options: [],
				parent: parentRef ? { treeId: parentRef.treeId, optionId: parentRef.optionId } : undefined,
			};
			for (const label of params.options ?? []) {
				tree.options.push({ id: newOptionId(tree), label, status: "proposed", evidence: [], scores: {}, docs: [] });
			}
			if (parentTree && parentOpt) {
				parentOpt.childId = tree.id;
				persistTree(dir, parentTree);
				touchBucketEntry(bucket, parentTree);
			}
			persistTree(dir, tree);
			touchBucketEntry(bucket, tree);
			saveProject(dir, bucket, globalIdx);
			if (parentTree && parentOpt) {
				return { text: `Started sub-decision ${tree.id} under ${parentTree.id}:${parentOpt.id} (${parentOpt.label})\n${statusSummary(tree)}\nNext: propose ALL candidate options via add-options, then ${nextStep(dir, tree)}\nParent verdict waits for this sub-tree — finish it, then continue ${parentTree.id}.`, tree, event: `started as sub-decision of ${parentTree.id}:${parentOpt.id}` };
			}
			return { text: `Started decision ${tree.id}: ${tree.title}\n${statusSummary(tree)}\nNext: propose ALL candidate options via add-options, then ${nextStep(dir, tree)}`, tree, event: `started (${tree.options.length} options proposed)` };
		}

		if (params.action === "reopen") {
			let target: DecisionTree | undefined;
			if (params.treeId) {
				if (!bucket.trees.some((t) => t.id === params.treeId)) return { text: `Tree ${params.treeId} not found for this directory.`, event: "" };
				target = loadTree(dir, params.treeId);
				if (!target) return { text: `Tree ${params.treeId} is indexed but its data file is missing.`, event: "" };
			} else {
				const done = bucket.trees.filter((t) => t.status !== "active").sort((a, b) => b.updatedAt - a.updatedAt)[0];
				if (done) target = loadTree(dir, done.id);
				if (!target) {
					const aid = resolveTreeId(bucket, undefined);
					target = aid ? loadTree(dir, aid) : undefined;
					if (!target) return { text: "No decision tree to reopen. Start one with /decide <problem>.", event: "" };
				}
			}
			if (target.status === "active") return { text: `Tree ${target.id} is already active. Nothing to reopen.`, tree: target, event: "" };
			const reason = (params.text ?? "").trim();
			if (target.verdict) target.previousVerdicts = [...(target.previousVerdicts ?? []), target.verdict];
			target.verdict = undefined;
			target.status = "active";
			persistTree(dir, target);
			touchBucketEntry(bucket, target);
			saveProject(dir, bucket, globalIdx);
			return { text: `Reopened ${target.id} (${target.title})${reason ? `: ${reason}` : ""}.\nAll evidence, scores, and sub-decisions kept; the old verdict is preserved below.\nNext: ${nextStep(dir, target)} — address the reason, then record a revised verdict.`, tree: target, event: `reopened${reason ? `: ${reason}` : ""}` };
		}

		if (params.action === "list") {
			if (bucket.trees.length === 0) return { text: "No decision trees for this directory yet. Use /decide <problem> to start one.", event: "" };
			const lines = bucket.trees
				.slice()
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((t) => `${t.parentId ? "↳ " : "- "}${t.id} [${t.status}]${t.id === bucket.activeId ? " (active)" : ""} ${t.title}${t.parentId ? ` (sub of ${t.parentId})` : ""}`);
			return { text: `Decision trees for ${norm}:\n${lines.join("\n")}`, event: "" };
		}

		const id = resolveTreeId(bucket, params.treeId);
		if (!id) return { text: "No active decision tree. Start one with /decide <problem>.", event: "" };
		const tree = loadTree(dir, id);
		if (!tree) return { text: `Tree ${id} is indexed but its data file is missing.`, event: "" };

		switch (params.action) {
			case "status": {
				const links = childLinks(dir, tree);
				const sub = links.length > 0
					? `\nSub-decisions:\n${links.map((l) => `  ↳ ${l.option.id} (${l.option.label}) → ${l.child.id} [${l.child.status}] ${l.child.title}${l.child.verdict ? ` — ${l.child.verdict.slice(0, 80)}` : ""}`).join("\n")}`
					: "";
				return { text: `${statusSummary(tree)}${sub}\nNext: ${nextStep(dir, tree)}`, tree, event: "" };
			}
			case "add-options": {
				if (tree.status !== "active") return { text: `Tree is ${tree.status}; cannot add options. Use the reopen action with a reason to revise it.`, tree, event: "" };
				const labels = params.options ?? (params.text ? [params.text] : []);
				if (labels.length === 0) return { text: "Error: options[] (or text) is required.", tree, event: "" };
				for (const label of labels) {
					tree.options.push({ id: newOptionId(tree), label, status: "proposed", evidence: [], scores: {}, docs: params.docs ?? [] });
				}
				persistTree(dir, tree);
				touchBucketEntry(bucket, tree);
				saveProject(dir, bucket, globalIdx);
				return { text: `Added ${labels.length} option(s). ${statusSummary(tree)}\nNext: ${nextStep(dir, tree)}`, tree, event: `added ${labels.length} option(s)` };
			}
			case "record-evidence": {
				if (tree.status !== "active") return { text: `Tree is ${tree.status}; evidence is frozen. Use the reopen action with a reason to revise it.`, tree, event: "" };
				const opt = tree.options.find((o) => o.id === params.optionId);
				if (!opt) return { text: `Option ${params.optionId} not found.`, tree, event: "" };
				if (!params.text && !(params.docs?.length)) return { text: "Error: text (evidence) or docs[] is required.", tree, event: "" };
				if (params.text) opt.evidence.push(params.text);
				if (params.docs?.length) opt.docs.push(...params.docs);
				if (opt.status === "proposed") opt.status = "evidenced";
				persistTree(dir, tree);
				touchBucketEntry(bucket, tree);
				saveProject(dir, bucket, globalIdx);
				return { text: `Evidence recorded on ${opt.id}. ${statusSummary(tree)}\nNext: ${nextStep(dir, tree)}`, tree, event: `evidence on ${opt.id}` };
			}
			case "score": {
				if (tree.status !== "active") return { text: `Tree is ${tree.status}; scores are frozen. Use the reopen action with a reason to revise it.`, tree, event: "" };
				const opt = tree.options.find((o) => o.id === params.optionId);
				if (!opt) return { text: `Option ${params.optionId} not found.`, tree, event: "" };
				if (params.criteria?.length) {
					for (const c of params.criteria) if (!tree.criteria.includes(c)) tree.criteria.push(c);
				}
				if (params.scores) Object.assign(opt.scores, params.scores);
				if (Object.keys(opt.scores).length > 0 && (opt.status === "proposed" || opt.status === "evidenced")) opt.status = "scored";
				persistTree(dir, tree);
				touchBucketEntry(bucket, tree);
				saveProject(dir, bucket, globalIdx);
				return { text: `Scored ${opt.id}. ${statusSummary(tree)}\nNext: ${nextStep(dir, tree)}`, tree, event: `scored ${opt.id}` };
			}
			case "prune": {
				if (tree.status !== "active") return { text: `Tree is ${tree.status}; options are frozen. Use the reopen action with a reason to revise it.`, tree, event: "" };
				const opt = tree.options.find((o) => o.id === params.optionId);
				if (!opt) return { text: `Option ${params.optionId} not found.`, tree, event: "" };
				opt.status = params.verdict === "keep" ? "kept" : "pruned";
				if (params.text) opt.note = params.text;
				const kidNote = opt.childId && loadTree(dir, opt.childId)?.status === "active"
					? ` Note: sub-decision ${opt.childId} stays open but no longer blocks the parent verdict.`
					: "";
				persistTree(dir, tree);
				touchBucketEntry(bucket, tree);
				saveProject(dir, bucket, globalIdx);
				return { text: `${opt.status === "kept" ? "Kept" : "Pruned"} ${opt.id}. ${statusSummary(tree)}${kidNote}\nNext: ${nextStep(dir, tree)}`, tree, event: `${opt.status} ${opt.id}` };
			}
			case "verdict": {
				if (!params.verdict) return { text: "Error: verdict text is required.", tree, event: "" };
				const openKids = activeChildren(dir, tree).filter((k) => k.option.status !== "pruned");
				if (openKids.length > 0) {
					return { text: `Refusing verdict: sub-decision ${openKids[0].child.id} (${openKids[0].child.title}) under ${openKids[0].option.id} is still active. Resolve it first (or prune ${openKids[0].option.id}).`, tree, event: "" };
				}
				const bare = tree.options.filter((o) => o.status === "proposed" && o.evidence.length === 0);
				if (bare.length > 0) {
					return { text: `Refusing verdict: ${bare.map((o) => `${o.id} (${o.label})`).join(", ")} still ${bare.length === 1 ? "lacks" : "lack"} evidence. Record evidence or prune first.`, tree, event: "" };
				}
				tree.verdict = params.verdict;
				tree.status = "complete";
				// Auto-snapshot into the tree's cwd (plan v4). Opt-out via env.
				let snapshotNote = "";
				if (!process.env.DECIDE_NO_AUTO_WRITE) {
					try {
						const base = writeCompletionSnapshot(tree, dir);
						tree.snapshotFile = base;
						snapshotNote = `\nSnapshot written: ${join(tree.cwd, base)}`;
					} catch (err) {
						snapshotNote = `\nNote: could not auto-write snapshot (${err instanceof Error ? err.message : String(err)}). Use /decide-export ${tree.id} <path>.`;
					}
				}
				persistTree(dir, tree);
				touchBucketEntry(bucket, tree);
				saveProject(dir, bucket, globalIdx);
				return { text: `Verdict recorded for ${tree.id}: ${tree.verdict}${snapshotNote}`, tree, event: `verdict: ${tree.verdict}` };
			}
			default:
				return { text: `Unknown action: ${params.action}`, tree, event: "" };
		}
	});
}

function logStep(pi: ExtensionAPI, outcome: DecideOutcome): void {
	if (!outcome.tree || !outcome.event) return;
	try {
		pi.appendEntry<DecideStepEntry>("decide-step", {
			treeId: outcome.tree.id,
			title: outcome.tree.title,
			event: outcome.event,
			at: Date.now(),
		});
	} catch {
		// logging must never fail the operation
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<DecideStepEntry>("decide-step", (entry, { expanded }, theme) => {
		const data = entry.data ?? { treeId: "?", title: "", event: "", at: Date.now() };
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", "[decide]")} ${data.title} — ${data.event}`, 0, 0));
		if (expanded) {
			box.addChild(
				new Text(theme.fg("dim", `${data.treeId} · ${new Date(data.at).toLocaleString()}`), 0, 0),
			);
		}
		return box;
	});

	// -- continuity: quick central lookup on session start ------------------
	pi.on("session_start", async (_event, ctx) => {
		nudge = freshNudge(); // new session, new nudge budget
		try {
			reconstructFromBranch(ctx); // warms branch awareness; central is fallback
			const norm = normalizeCwd(ctx.cwd);
			const bucket = readJson<ProjectBucket | undefined>(
				join(centralRoot(), "projects", projectSlug(norm), "index.json"), undefined,
			);
			if (!bucket) return;
			const actives = bucket.trees.filter((t) => t.status === "active");
			if (actives.length === 0) return;
			const dir = join(centralRoot(), "projects", projectSlug(norm));
			const top = actives.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			const tree = loadTree(dir, top.id);
			const extra = actives.length > 1 ? ` (+${actives.length - 1} more — /decide-list)` : "";
			const progress = tree ? `${statusSummary(tree)}. Next: ${nextStep(dir, tree)}` : `${top.title} (active)`;
			ctx.ui.notify(`Incomplete decision: ${progress} — /decide-continue${extra}`, "info");
		} catch {
			// never break session startup for a status lookup
		}
	});

	pi.on("session_shutdown", async () => {
		// nothing long-lived to release; writes are synchronous + atomic
	});

	// -- turn_end auto-nudge: keep early-exiting models on the job ------------
	// Fires ONLY when every guard holds (see README):
	//   1. runtime allows continuation, turn completed (not aborted/error)
	//   2. a decide flow is in flight this session (zero effect otherwise)
	//   3. the model stopped with a text-only message (turns with tool calls
	//      continue on their own — those need no nudge)
	//   4. the tree is still active on disk
	//   5. progress/cap budget remains (3 nudges per unchanged state, 12/session)
	pi.on("turn_end", async (event, ctx) => {
		try {
			if (process.env.DECIDE_NO_NUDGE) return undefined;
			if (!event.context.canContinue) return undefined;
			if (event.outcome !== "completed") return undefined;
			if (event.continue) return undefined; // another handler already continues

			if (event.toolResults.some((r) => r.toolName === "decide")) {
				nudge.inFlight = true;
				const d = event.toolResults.find((r) => r.toolName === "decide")?.details as DecideDetails | undefined;
				if (d?.treeId) nudge.treeId = d.treeId;
			}
			if (!nudge.inFlight) return undefined;

			const msg = event.message;
			const hasToolCalls =
				msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((b) => b.type === "toolCall");
			if (hasToolCalls) return undefined;

			const norm = normalizeCwd(ctx.cwd);
			const { dir } = projectDirFor(norm);
			const bucket = readJson<ProjectBucket | undefined>(join(dir, "index.json"), undefined);
			if (!bucket) {
				nudge.inFlight = false;
				return undefined;
			}
			const id = resolveTreeId(bucket, nudge.treeId);
			if (!id) {
				nudge.inFlight = false;
				return undefined;
			}
			const tree = loadTree(dir, id);
			if (!tree || tree.status !== "active") {
				nudge.inFlight = false; // completed/abandoned: stand down
				return undefined;
			}

			const snap = snapshotTree(tree);
			if (snap !== nudge.lastSnapshot) {
				nudge.lastSnapshot = snap;
				nudge.nudgesForSnapshot = 0;
			}
			if (nudge.nudgesForSnapshot >= MAX_NUDGES_PER_STATE) return undefined; // stuck: stop nagging
			if (nudge.totalNudges >= MAX_NUDGES_PER_SESSION) return undefined;

			nudge.nudgesForSnapshot += 1;
			nudge.totalNudges += 1;
			const final = nudge.nudgesForSnapshot >= MAX_NUDGES_PER_STATE;
			const text =
				`Decide: tree ${tree.id} (${tree.title}) is still incomplete — ${statusSummary(tree)}. ` +
				`Next: ${nextStep(dir, tree)} Use the decide tool to advance it; do not claim completion first.` +
				(final ? " (Final reminder — I will not ask again.)" : "");
			return {
				entries: [{ type: "custom_message", customType: "decide-nudge", content: text, display: true }],
				continue: true,
			};
		} catch {
			return undefined; // a nudge must never break the loop
		}
	});

	// -- core tool -----------------------------------------------------------
	pi.registerTool({
		name: "decide",
		label: "Decide",
		description: "Decision-tree tracker. Actions: start, add-options, record-evidence, score, prune, verdict, status, list. Always work one option at a time and keep evidence attached to options. Split an option into a sub-decision via start with parent {treeId, optionId}; a parent verdict waits for active sub-decisions. Reopen a completed tree with a reason when new information arrives.",
		promptGuidelines: [
			"For open-ended decisions, use the decide tool: enumerate ALL options before scoring any.",
			"Never record a verdict while any option is still 'proposed' without evidence.",
			"Split a complex option into a sub-decision (start with parent {treeId, optionId}); finish sub-decisions before the parent verdict.",
			"Reopen (with a reason) instead of editing a completed tree when new information arrives.",
		],
		parameters: DecideParams,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			void toolCallId;
			try {
				const outcome = await runDecide(ctx.cwd, params);
				logStep(pi, outcome);
				return {
					content: [{ type: "text" as const, text: outcome.text }],
					details: {
						treeId: outcome.tree?.id ?? params.treeId ?? "",
						action: params.action,
						status: outcome.tree?.status ?? "active",
						summary: outcome.tree ? statusSummary(outcome.tree) : outcome.text.slice(0, 200),
					} as DecideDetails,
				};
			} catch (err) {
				const text = `decide failed: ${err instanceof Error ? err.message : String(err)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { treeId: params.treeId ?? "", action: params.action, status: "active", summary: "", error: text } as DecideDetails,
				};
			}
		},

		renderCall(args, theme, _context) {
			const a = args as { action?: string; treeId?: string };
			let text = theme.fg("toolTitle", theme.bold("decide ")) + theme.fg("muted", a.action ?? "");
			if (a.treeId) text += ` ${theme.fg("accent", a.treeId)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as DecideDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);
			const first = result.content[0];
			const msg = first?.type === "text" ? first.text : "";
			return new Text(theme.fg("muted", (msg.split("\n")[0] ?? "").slice(0, 160)), 0, 0);
		},
	});

	// -- commands ------------------------------------------------------------

	pi.registerCommand("decide", {
		description: "Start a decision tree: /decide <problem>",
		handler: async (args, ctx) => {
			const problem = args.trim();
			if (!problem) {
				ctx.ui.notify("Usage: /decide <problem> — e.g. /decide Choose a vector DB for Pi memory", "error");
				return;
			}
			try {
				const outcome = await runDecide(ctx.cwd, { action: "start", problem });
				logStep(pi, outcome);
				ctx.ui.notify(outcome.text, "info");
			} catch (err) {
				ctx.ui.notify(`decide failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("decide-list", {
		description: "List decision trees for this directory",
		handler: async (_args, ctx) => {
			try {
				const outcome = await runDecide(ctx.cwd, { action: "list" });
				ctx.ui.notify(outcome.text, "info");
			} catch (err) {
				ctx.ui.notify(`decide-list failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("decide-status", {
		description: "Show progress of the active (or given) tree: /decide-status [treeId]",
		handler: async (args, ctx) => {
			const treeId = args.trim() || undefined;
			try {
				const outcome = await runDecide(ctx.cwd, { action: "status", treeId });
				ctx.ui.notify(outcome.text, "info");
			} catch (err) {
				ctx.ui.notify(`decide-status failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("decide-continue", {
		description: "Resume an incomplete tree: /decide-continue [treeId]",
		handler: async (args, ctx) => {
			const treeId = args.trim() || undefined;
			try {
				const norm = normalizeCwd(ctx.cwd);
				const { dir } = projectDirFor(norm);
				const bucket = readJson<ProjectBucket | undefined>(join(dir, "index.json"), undefined);
				const id = bucket ? resolveTreeId(bucket, treeId) : undefined;
				if (!bucket || !id) {
					ctx.ui.notify("No incomplete decision tree for this directory. Start one with /decide <problem>.", "info");
					return;
				}
				const tree = loadTree(dir, id);
				if (!tree) {
					ctx.ui.notify(`Tree ${id} is indexed but its data file is missing.`, "error");
					return;
				}
				if (tree.status !== "active") {
					ctx.ui.notify(`Tree ${id} is ${tree.status}. Nothing to continue.`, "info");
					return;
				}
				bucket.activeId = id;
				saveProject(dir, bucket, loadGlobalIndex());
				// Arm the turn_end nudge: even if the model answers the resume
				// prompt with text only (small-LLM habit), the stall is caught.
				nudge.inFlight = true;
				nudge.treeId = id;
				pi.sendUserMessage(
					`Continue decision tree ${tree.id} (${tree.title}). Problem: ${tree.problem}\nProgress: ${statusSummary(tree)}\nNext step: ${nextStep(dir, tree)}\nWork through the decide tool until every option is evidenced, scored, and pruned/kept, then record a verdict.`,
				);
			} catch (err) {
				ctx.ui.notify(`decide-continue failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("decide-split", {
		description: "Start a sub-decision under an option: /decide-split <optionId> <problem>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /decide-split <optionId> <problem> — e.g. /decide-split o2 Choose a sync provider", "error");
				return;
			}
			const [optionId, ...rest] = parts;
			const problem = rest.join(" ");
			try {
				const norm = normalizeCwd(ctx.cwd);
				const { dir } = projectDirFor(norm);
				const bucket = readJson<ProjectBucket | undefined>(join(dir, "index.json"), undefined);
				const id = bucket ? resolveTreeId(bucket, undefined) : undefined;
				if (!bucket || !id) {
					ctx.ui.notify("No active decision tree for this directory. Start one with /decide <problem>.", "error");
					return;
				}
				const outcome = await runDecide(ctx.cwd, { action: "start", problem, title: problem.slice(0, 60), parent: { treeId: id, optionId } });
				logStep(pi, outcome);
				if (outcome.tree) {
					nudge.inFlight = true;
					nudge.treeId = outcome.tree.id;
				}
				ctx.ui.notify(outcome.text, "info");
			} catch (err) {
				ctx.ui.notify(`decide-split failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerCommand("decide-reopen", {
		description: "Reopen a completed tree for revision: /decide-reopen [treeId] [reason]",
		handler: async (args, ctx) => {
			try {
				const norm = normalizeCwd(ctx.cwd);
				const { dir } = projectDirFor(norm);
				const bucket = readJson<ProjectBucket | undefined>(join(dir, "index.json"), undefined);
				if (!bucket || bucket.trees.length === 0) {
					ctx.ui.notify("No decision trees for this directory yet. Use /decide <problem>.", "error");
					return;
				}
				const parts = args.trim().split(/\s+/).filter(Boolean);
				let treeId: string | undefined;
				let reason = "";
				if (parts.length > 0 && bucket.trees.some((t) => t.id === parts[0])) {
					treeId = parts.shift();
					reason = parts.join(" ");
				} else {
					reason = parts.join(" ");
				}
				const outcome = await runDecide(ctx.cwd, { action: "reopen", treeId, text: reason || undefined });
				logStep(pi, outcome);
				if (outcome.tree?.status === "active") {
					nudge.inFlight = true;
					nudge.treeId = outcome.tree.id;
				}
				ctx.ui.notify(outcome.text, "info");
			} catch (err) {
				ctx.ui.notify(`decide-reopen failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
		},
	});

	pi.registerCommand("decide-export", {
		description: "Export a tree to a shareable markdown file: /decide-export <treeId> [path]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify("Usage: /decide-export <treeId> [path]", "error");
				return;
			}
			const [treeId, ...rest] = parts;
			try {
				const norm = normalizeCwd(ctx.cwd);
				const { dir } = projectDirFor(norm);
				const tree = loadTree(dir, treeId);
				if (!tree) {
					ctx.ui.notify(`Tree ${treeId} not found for this directory.`, "error");
					return;
				}
				const rawDest = rest.length > 0 ? rest.join(" ") : `${slugifyTitle(tree.title, `decision-${tree.id}`)}-${tree.id}-decisions.md`;
				const dest = isAbsolute(rawDest) ? rawDest : join(norm, rawDest);
				if (!resolve(dest).startsWith(norm)) {
					ctx.ui.notify("Export path must stay inside the current directory.", "error");
					return;
				}
				await withFileMutationQueue(dest, async () => {
					atomicWrite(dest, renderTreeMarkdown(tree, dir));
				});
				ctx.ui.notify(`Exported ${tree.id} → ${dest}`, "info");
			} catch (err) {
				ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// -- TUI navigator (read-only v1) ----------------------------------------
	pi.registerCommand("decide-tree", {
		description: "Browse decision trees and nodes (interactive)",
		handler: async (args, ctx) => {
			const loadAll = (): { dir: string; bucket: ProjectBucket; trees: DecisionTree[] } | undefined => {
				try {
					const norm = normalizeCwd(ctx.cwd);
					const { dir } = projectDirFor(norm);
					const bucket = readJson<ProjectBucket | undefined>(join(dir, "index.json"), undefined);
					if (!bucket || bucket.trees.length === 0) return undefined;
					const trees: DecisionTree[] = [];
					for (const row of bucket.trees) {
						const t = loadTree(dir, row.id);
						if (t) trees.push(t);
					}
					trees.sort((a, b) => b.updatedAt - a.updatedAt);
					return { dir, bucket, trees };
				} catch {
					return undefined;
				}
			};

			const data = loadAll();
			if (!data) {
				ctx.ui.notify("No decision trees for this directory yet. Use /decide <problem>.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				const first = args.trim()
					? data.trees.find((t) => t.id === args.trim())
					: data.trees[0];
				if (!first) {
					ctx.ui.notify("Tree not found. See /decide-list.", "error");
					return;
				}
				ctx.ui.notify(`${statusSummary(first)}\nNext: ${nextAction(first)}\nFull text: ${treeMdPath(data.dir, first.id)}`, "info");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new DecideBrowser(data.trees, theme, () => done(), data.dir);
			});
		},
	});
}

// ---------------------------------------------------------------------------
// TUI browser: screen 1 = tree picker, screen 2 = node navigator (read-only)
// ---------------------------------------------------------------------------

class DecideBrowser {
	private trees: DecisionTree[];
	private theme: Theme;
	private onClose: () => void;
	private screen: "trees" | "nodes" = "trees";
	private treeIdx = 0;
	private nodeIdx = 0;
	private expandedDocs = false;
	private viewingDoc = false;
	private viewDocIdx = 0;
	private viewLines: string[] = [];
	private viewTotal = 0;
	private viewOffset = 0;
	private viewNote = "";
	private dir?: string;
	private kidCache = new Map<string, { status: string; title: string } | undefined>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(trees: DecisionTree[], theme: Theme, onClose: () => void, dir?: string) {
		this.trees = trees;
		this.theme = theme;
		this.onClose = onClose;
		this.dir = dir;
	}

	private kidOf(childId: string): { status: string; title: string } | undefined {
		if (!this.dir) return undefined;
		if (!this.kidCache.has(childId)) {
			try {
				const t = loadTree(this.dir, childId);
				this.kidCache.set(childId, t ? { status: t.status, title: t.title } : undefined);
			} catch {
				this.kidCache.set(childId, undefined);
			}
		}
		return this.kidCache.get(childId);
	}

	private get tree(): DecisionTree {
		return this.trees[Math.min(this.treeIdx, this.trees.length - 1)];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			if (this.viewingDoc) {
				this.closeViewer();
				this.invalidate();
				return;
			}
			this.onClose();
			return;
		}
		const up = data === "k" || data === "\u001b[A";
		const down = data === "j" || data === "\u001b[B";
		const back = data === "backspace" || data === "\u007f" || data === "h";
		const enter = data === "\r" || data === "\n" || data === "l";
		const view = data === "v" || data === "V" || data === "\u001b[13;2u";

		if (this.viewingDoc && this.screen === "nodes") {
			const max = Math.max(0, this.viewLines.length - 1);
			let handled = true;
			if (up) this.viewOffset = Math.max(0, this.viewOffset - 1);
			else if (down) this.viewOffset = Math.min(max, this.viewOffset + 1);
			else if (data === " " || data === "\u001b[6~") this.viewOffset = Math.min(max, this.viewOffset + VIEW_PAGE);
			else if (data === "b" || data === "B" || data === "\u001b[5~") this.viewOffset = Math.max(0, this.viewOffset - VIEW_PAGE);
			else if (data === "g") this.viewOffset = 0;
			else if (data === "G") this.viewOffset = Math.max(0, this.viewLines.length - VIEW_WINDOW);
			else handled = false;
			if (handled) {
				this.invalidate();
				return;
			}
		}

		if (up || down) {
			this.invalidate();
			const d = up ? -1 : 1;
			if (this.screen === "trees") {
				this.treeIdx = (this.treeIdx + d + this.trees.length) % this.trees.length;
			} else {
				const n = Math.max(this.tree.options.length, 1);
				this.nodeIdx = (this.nodeIdx + d + n) % n;
				this.expandedDocs = false;
				this.closeViewer();
			}
			return;
		}
		if (enter) {
			this.invalidate();
			if (this.screen === "trees") {
				this.screen = "nodes";
				this.nodeIdx = 0;
				this.expandedDocs = false;
			} else if (this.viewingDoc) {
				this.closeViewer();
			} else {
				this.expandedDocs = !this.expandedDocs;
			}
			return;
		}
		if (view && this.screen === "nodes") {
			this.invalidate();
			if (this.viewingDoc && this.selectedDocs().length > 1) {
				this.viewDocIdx = (this.viewDocIdx + 1) % this.selectedDocs().length;
				this.openViewer();
			} else if (this.viewingDoc) {
				this.closeViewer();
			} else {
				this.viewDocIdx = 0;
				this.openViewer();
			}
			return;
		}
		if (back && this.screen === "nodes") {
			this.invalidate();
			if (this.viewingDoc) {
				this.closeViewer();
				return;
			}
			this.screen = "trees";
			this.expandedDocs = false;
		}
	}

	private selectedDocs(): string[] {
		const t = this.tree;
		if (this.screen !== "nodes" || t.options.length === 0) return [];
		return t.options[Math.min(this.nodeIdx, t.options.length - 1)].docs;
	}

	private closeViewer(): void {
		this.viewingDoc = false;
		this.viewLines = [];
		this.viewTotal = 0;
		this.viewOffset = 0;
		this.viewNote = "";
	}

	/** Lazily loads the selected doc ref into the viewer (capped, cwd-scoped). */
	private openViewer(): void {
		const docs = this.selectedDocs();
		if (docs.length === 0) {
			this.viewingDoc = true;
			this.viewLines = [];
			this.viewNote = "no docs attached — use record-evidence with docs[] to add refs";
			return;
		}
		const rel = docs[Math.min(this.viewDocIdx, docs.length - 1)];
		const base = this.tree.cwd;
		const abs = resolve(base, rel);
		if (abs !== base && !abs.startsWith(base + "/")) {
			this.viewingDoc = true;
			this.viewLines = [];
			this.viewNote = `ref outside decision scope, not shown: ${rel}`;
			return;
		}
		try {
			const stat = statSync(abs);
			if (stat.size > 200 * 1024) {
				this.viewingDoc = true;
				this.viewLines = [];
				this.viewNote = `too large to preview (${Math.round(stat.size / 1024)} KiB): ${rel}`;
				return;
			}
			const raw = readFileSync(abs, "utf8");
			if (raw.includes("\0")) {
				this.viewingDoc = true;
				this.viewLines = [];
				this.viewNote = `binary file, not shown: ${rel}`;
				return;
			}
			const all = raw.replace(/\t/g, "  ").split("\n");
			const shown = all.slice(0, VIEW_MAX_LINES);
			this.viewingDoc = true;
			this.viewLines = shown;
			this.viewTotal = all.length;
			this.viewOffset = 0;
			this.viewNote = docs.length > 1 ? `doc ${this.viewDocIdx + 1}/${docs.length}: ${rel}` : rel;
		} catch {
			this.viewingDoc = true;
			this.viewLines = [];
			this.viewNote = `cannot read: ${rel}`;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];
		lines.push("");
		const title = th.fg("accent", this.screen === "trees" ? " Decide: trees " : ` Decide: ${this.tree.title} `);
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + title, width));
		lines.push("");

		if (this.screen === "trees") {
			this.trees.forEach((t, i) => {
				const cursor = i === this.treeIdx ? th.fg("accent", "> ") : "  ";
				const state = t.status === "active" ? th.fg("accent", "★") : t.status === "complete" ? th.fg("success", "✓") : th.fg("dim", "○");
				const sub = t.parent ? ` ↳ sub of ${t.parent.treeId}:${t.parent.optionId}` : "";
				lines.push(truncateToWidth(`${cursor}${state} ${th.fg("text", t.title)} ${th.fg("dim", `${t.id} · ${t.options.length} options${sub}`)}`, width));
			});
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓/jk select · enter open · q close")}`, width));
		} else {
			const t = this.tree;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${t.id} [${t.status}]`)}${t.verdict ? th.fg("success", ` · verdict: ${t.verdict.slice(0, 60)}`) : ""}`, width));
			lines.push("");
			if (t.options.length === 0) {
				lines.push(truncateToWidth(`  ${th.fg("dim", "No options yet.")}`, width));
			} else {
				t.options.forEach((o, i) => {
					const cursor = i === this.nodeIdx ? th.fg("accent", "> ") : "  ";
					const g = o.status === "kept" ? th.fg("success", "★") : o.status === "pruned" ? th.fg("dim", "✕") : th.fg("accent", statusGlyph(o.status));
					const kid = o.childId ? this.kidOf(o.childId) : undefined;
				const kidMark = o.childId ? ` → ${o.childId} [${kid?.status ?? "?"}]` : "";
				lines.push(truncateToWidth(`${cursor}${g} ${th.fg("text", o.label)} ${th.fg("dim", `(${o.id}, ${o.status})${kidMark}`)}`, width));
				});
				const sel = t.options[Math.min(this.nodeIdx, t.options.length - 1)];
				if (sel) {
					lines.push("");
					lines.push(truncateToWidth(`  ${th.fg("muted", "— " + sel.label + " —")}`, width));
					if (!this.viewingDoc && Object.keys(sel.scores).length > 0) {
						for (const [k, v] of Object.entries(sel.scores)) {
							lines.push(truncateToWidth(`    ${th.fg("dim", k)}: ${th.fg("text", String(v))}`, width));
						}
					}
					if (!this.viewingDoc) for (const e of sel.evidence.slice(0, 5)) {
						lines.push(truncateToWidth(`    ${th.fg("dim", "·")} ${th.fg("muted", e.slice(0, 120))}`, width));
					}
					if (!this.viewingDoc && sel.evidence.length > 5) lines.push(truncateToWidth(`    ${th.fg("dim", `… ${sel.evidence.length - 5} more`)}`, width));
					if (!this.viewingDoc && sel.docs.length > 0) {
						lines.push(truncateToWidth(`    ${th.fg("accent", "docs:")} ${th.fg("dim", this.expandedDocs ? sel.docs.join(", ") : `${sel.docs.length} ref(s) — enter to show`)}`, width));
						if (this.expandedDocs) {
							for (const d of sel.docs.slice(0, 10)) {
								lines.push(truncateToWidth(`      ${th.fg("dim", d)}`, width));
							}
						}
					} else if (!this.viewingDoc) {
						lines.push(truncateToWidth(`    ${th.fg("dim", this.expandedDocs ? "docs: none attached — use record-evidence with docs[] to add refs" : "docs: none")}`, width));
					}
					if (this.viewingDoc) {
						const start = this.viewLines.length === 0 ? 0 : this.viewOffset + 1;
						const end = Math.min(this.viewOffset + VIEW_WINDOW, this.viewLines.length);
						lines.push("");
						lines.push(truncateToWidth(`  ${th.fg("accent", `‹ ${this.viewNote} · lines ${start}–${end} of ${this.viewTotal} ›`)}`, width));
						for (const vl of this.viewLines.slice(this.viewOffset, this.viewOffset + VIEW_WINDOW)) {
							lines.push(truncateToWidth(`    ${th.fg("muted", vl.slice(0, 240))}`, width));
						}
					}
				}
			}
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", this.viewingDoc ? "j/k scroll · space page · g/G top/bottom · v next doc · q close" : "↑↓/jk navigate · enter docs · v view doc · backspace trees · q close")}`, width));
		}
		lines.push("");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
