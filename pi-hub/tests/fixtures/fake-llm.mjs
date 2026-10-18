/**
 * fake-llm — an in-process, OpenAI-compatible endpoint for tests.
 *
 * No network, no keys, no cost, no variance: pi children in the sandbox point
 * their `models.json` here, so a "real prompt round-trip" is a local HTTP call
 * that finishes in milliseconds. It also records every request, which is how
 * tests prove a message was sent exactly once (double-send bugs).
 */
import http from "node:http";

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p?.type === "text" ? p.text : "")).join(" ");
  return "";
};

const userText = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i]);
  }
  return "";
};

export async function startFakeLLM({ holdMs = 0, reply = () => "ACK" } = {}) {
  const requests = [];
  let hold = holdMs;
  let closed = false;

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
    }
    if (req.method === "GET" && url.pathname === "/__requests") {
      return json(res, 200, { count: requests.length, requests });
    }
    if (req.method === "POST" && url.pathname === "/__hold") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          hold = Number(JSON.parse(raw || "{}").ms || 0);
        } catch {
          hold = 0;
        }
        json(res, 200, { hold });
      });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      await new Promise((r) => req.on("end", r));
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const text = userText(messages);
      const answer = reply(text);
      requests.push({ at: Date.now(), model: body.model, stream: !!body.stream, messages, text, answer });
      const id = `chatcmpl-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

      if (!body.stream) {
        return json(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage,
        });
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content: "" });
      for (const piece of answer.match(/.{1,12}/g) || []) chunk({ content: piece });
      // A "busy" run: the caller can type while the stream stays open.
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "fake-model", choices: [], usage })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return json(res, 404, { error: { message: `fake-llm: no route ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    /** every request whose conversation contains `text` */
    requestsMentioning(text) {
      return requests.filter((r) => JSON.stringify(r.messages).includes(text));
    },
    setHold(ms) {
      hold = Number(ms || 0);
    },
    reset() {
      requests.length = 0;
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
