/**
 * probe — tiny TCP/unix-socket reachability checks with no dependencies.
 * Shared by the hub singleton claim (is that advert live?) and the
 * hub.sock stale-path guard (is that socket live?). Kept free of
 * TypeScript-only syntax so unit tests can import it under Node's
 * strip-only mode.
 */
import * as net from "node:net";

function probe(connect: () => net.Socket, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect();
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(alive);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

export function probePort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false);
  return probe(() => net.connect({ host, port }), timeoutMs);
}

export function probeSocket(sockPath: string, timeoutMs = 600): Promise<boolean> {
  return probe(() => net.connect(sockPath), timeoutMs);
}
