/**
 * env — pi-hub configuration (PI_HUB_*), settings block `piHub`, defaults.
 * Never reads TAU_* (coexistence with an installed tau-web is deliberate).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HubRole = "hub" | "mirror";

export const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

/** jiti loads extensions as CJS (`__dirname`); ESM fallback for plain node. */
const HERE = (() => {
  try {
    return __dirname;
  } catch {
    return path.dirname(new URL(import.meta.url).pathname);
  }
})();
export const PACKAGE_ROOT = path.resolve(HERE, "../..");
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, ".pi", "agent");
export const SESSIONS_DIR =
  process.env.PI_CODING_AGENT_SESSION_DIR || path.join(AGENT_DIR, "sessions");
export const HUB_DIR = process.env.PI_HUB_DIR || path.join(HOME, ".pi", "pi-hub");
/** Stable pointer to the most recently started hub, independent of PI_HUB_DIR:
 *  an interactive TUI mirrors into *some* hub without knowing its directory. */
export const ADVERT_FILE = process.env.PI_HUB_ADVERT_FILE || path.join(AGENT_DIR, "pi-hub", "hub.json");
export const CONFIG_FILE = path.join(AGENT_DIR, "settings.json");

function fmt(tpl: string, ...args: Array<string | number>): string {
  return tpl.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}

export interface HubConfig {
  role: HubRole | null; // null = disabled
  disabled: boolean;
  port: number;
  host: string;
  user: string;
  pass: string;
  authEnabled: boolean;
  staticDir: string;
  piBin: string;
  ttlMs: number;
  maxHeadless: number;
  sockPath: string;
  /** where the hub writes its sock/port so TUIs can find it */
  advertPath: string;
  fsRoots: string[];
  logFile: string;
  debug: boolean;
  allowedHosts: string[];
  allowAnyHost: boolean;
  /** opt-in TUI confirmation per browser attach (shared deployments) */
  driveConfirm: boolean;
  version: string;
}

function readSettings(): any {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).piHub || {};
  } catch {
    return {};
  }
}

function envBool(...names: string[]): boolean | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v === undefined) continue;
    return v === "1" || v === "true" || v === "yes";
  }
  return undefined;
}

export function loadConfig(): HubConfig {
  const settings = readSettings();
  const port = Number(
    process.env.PI_HUB_PORT || process.env.PI_HUB_MIRROR_PORT || settings.port || 8292,
  ) || 8292;
  const roleRaw = process.env.PI_HUB_ROLE || process.env.PI_HUB_FORCE_ROLE || settings.role;
  const role: HubRole | null = roleRaw === "hub" || roleRaw === "mirror" ? roleRaw : null;
  const disabled =
    envBool("PI_HUB_DISABLED") === true || settings.disabled === true;
  const roots: string[] = [];
  const pushRoot = (r: unknown) => {
    if (typeof r === "string" && r.trim()) roots.push(path.resolve(HOME, r.trim()));
  };
  if (typeof process.env.PI_HUB_FS_ROOTS === "string") {
    for (const r of process.env.PI_HUB_FS_ROOTS.split(":")) pushRoot(r);
  }
  if (Array.isArray(settings.roots)) settings.roots.forEach(pushRoot);
  return {
    role,
    disabled,
    port,
    host: process.env.PI_HUB_HOST || settings.host || "127.0.0.1",
    user: process.env.PI_HUB_USER || settings.user || "",
    pass: process.env.PI_HUB_PASS || settings.pass || "",
    authEnabled: settings.authEnabled !== false,
    staticDir:
      process.env.PI_HUB_STATIC_DIR || path.join(PACKAGE_ROOT, "public"),
    piBin: process.env.PI_HUB_PI_BIN || settings.piBin || "pi",
    ttlMs: Math.max(0, Number(process.env.PI_HUB_TTL_MS ?? settings.ttlMs ?? 0) || 0),
    maxHeadless: Math.max(
      0,
      Number(process.env.PI_HUB_MAX_HEADLESS || settings.maxHeadless || 0) || 0,
    ),
    sockPath: process.env.PI_HUB_SOCK || settings.sock || path.join(HUB_DIR, "hub.sock"),
    advertPath: ADVERT_FILE,
    fsRoots: [...new Set(roots)],
    logFile: process.env.PI_HUB_LOG_FILE || path.join(HUB_DIR, "pi-hub.log"),
    debug: envBool("PI_HUB_DEBUG") === true,
    allowedHosts: [
      ...(process.env.PI_HUB_ALLOWED_HOSTS || settings.allowedHosts || "")
        .split(/[,:]/)
        .map((s: string) => s.trim())
        .filter(Boolean),
    ],
    allowAnyHost: envBool("PI_HUB_ALLOW_ANY_HOST") === true,
    driveConfirm: envBool("PI_HUB_DRIVE_CONFIRM") === true || settings.driveConfirm === true,
    version: process.env.PI_HUB_VERSION || "0.1.0",
  };
}

export { fmt };
