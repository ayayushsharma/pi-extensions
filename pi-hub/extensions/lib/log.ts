/**
 * log — file-only logging. Never stdout/stderr: this runs inside a pi TUI
 * process and any stray write corrupts the screen.
 */
import * as fs from "node:fs";
import * as path from "node:path";

let logFile = "";
let debugOn = false;
let ready = false;

export function initLog(file: string, debug: boolean): void {
  logFile = file;
  debugOn = debug;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    ready = true;
  } catch {
    ready = false;
  }
}

function write(line: string): void {
  if (!ready) return;
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the hub */
  }
}

export function hubLog(...args: unknown[]): void {
  write(`[pi-hub] ${args.map(String).join(" ")}`);
}

export function hubDebug(...args: unknown[]): void {
  if (debugOn) write(`[pi-hub:debug] ${args.map(String).join(" ")}`);
}
