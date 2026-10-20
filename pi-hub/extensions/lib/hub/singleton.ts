/**
 * singleton — one hub per advert scope (ADR-021).
 *
 * The advert file (`~/.pi/agent/pi-hub/hub.json` by default) is the
 * singleton record: the first hub to start claims it, and every later
 * starter refuses while the claim is live. Liveness is pid + reachability,
 * never pid alone (pids recycle) and never file existence alone (a
 * hard-killed hub leaves a dead file behind):
 *
 *   live = pid alive AND (started within grace OR tcp port accepts OR sock accepts)
 *
 * The claim is written *before* the port/socket bind so a second starter
 * sees the first even while it is still coming up. The claim is released
 * only by its owner (pid match), so an old hub shutting down can never
 * withdraw a newer hub's advert. A simultaneous-start race (both pass the
 * pre-check) is closed by the post-bind re-read in Hub.start: the loser
 * sees a foreign pid and stands down.
 *
 * Scope note: the singleton is keyed by advert path. Production hubs share
 * the default path, so exactly one runs per machine. Tests isolate with a
 * per-hub PI_HUB_ADVERT_FILE and therefore stay parallel.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { probePort, probeSocket } from "../probe.js";

export interface AdvertClaim {
  sock: string;
  port: number;
  host: string;
  pid: number;
  startedAt: number;
}

/** Grace during which a freshly-claimed hub counts as live even though its
 *  port/socket may not accept yet (it is still binding). */
export const CLAIM_GRACE_MS = 10_000;

export function readAdvert(advertPath: string): AdvertClaim | null {
  try {
    const raw = JSON.parse(fs.readFileSync(advertPath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.pid !== "number" || typeof raw.port !== "number") return null;
    return {
      sock: typeof raw.sock === "string" ? raw.sock : "",
      port: raw.port,
      host: typeof raw.host === "string" ? raw.host : "127.0.0.1",
      pid: raw.pid,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means a process exists but belongs to another user; ESRCH means gone.
    return e?.code === "EPERM";
  }
}

/**
 * The live hub owning this advert scope, or null when the scope is free.
 * A claim by this process is reclaimable (previous start in the same
 * process that never released); anything else must prove liveness.
 */
export async function findLiveHub(advertPath: string, graceMs = CLAIM_GRACE_MS): Promise<AdvertClaim | null> {
  const adv = readAdvert(advertPath);
  if (!adv || adv.pid === process.pid) return null;
  if (!pidAlive(adv.pid)) return null;
  const age = Date.now() - adv.startedAt;
  if (adv.startedAt > 0 && age >= 0 && age < graceMs) return adv;
  const [portOpen, sockOpen] = await Promise.all([
    probePort(adv.host, adv.port),
    adv.sock ? probeSocket(adv.sock) : Promise.resolve(false),
  ]);
  return portOpen || sockOpen ? adv : null;
}

export function describeAdvert(adv: AdvertClaim): string {
  const when = adv.startedAt > 0 ? new Date(adv.startedAt).toISOString() : "unknown time";
  return `pid ${adv.pid}, ${adv.host}:${adv.port}, sock ${adv.sock || "(none)"}, started ${when}`;
}

/** Atomic claim write (tmp + rename) — never a half-written advert. */
export function writeAdvert(advertPath: string, claim: AdvertClaim): void {
  fs.mkdirSync(path.dirname(advertPath), { recursive: true });
  const tmp = `${advertPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(claim, null, 2));
  fs.renameSync(tmp, advertPath);
}

/**
 * Claim this advert scope for a new hub. Throws naming the live owner when
 * the scope is taken; stale claims (dead pid, unreachable port+socket past
 * grace) are reclaimed by overwrite.
 */
export async function claimSingleton(advertPath: string, claim: AdvertClaim): Promise<void> {
  const live = await findLiveHub(advertPath);
  if (live) {
    throw new Error(
      `another hub is already running (${describeAdvert(live)}). ` +
        `Only one hub runs per machine: stop it first, or point this hub at a different ` +
        `port AND a different advert file (PI_HUB_PORT + PI_HUB_ADVERT_FILE). ` +
        `Advert: ${advertPath}`,
    );
  }
  writeAdvert(advertPath, claim);
}

/** Withdraw our own claim; a foreign claim is never touched. */
export function releaseSingleton(advertPath: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(advertPath, "utf8"));
    if (raw?.pid === process.pid) fs.rmSync(advertPath, { force: true });
  } catch {}
}
