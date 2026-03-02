const http = require("http");
const { execFile } = require("child_process");
const crypto = require("crypto");

const PORT = 3847;
const MAX_MESSAGE_LENGTH = 500;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 5; // 5 requests per minute per IP
const KOI_API = "http://127.0.0.1:8351";

const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT_MAX;
}

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt + RATE_LIMIT_WINDOW) rateLimitMap.delete(ip);
  }
}, 300000);

/**
 * Classify an execFile error into a user-friendly message.
 */
function classifyError(err) {
  if (!err) return null;
  const msg = (err.message || "").toLowerCase();
  const stderr = (err.stderr || "").toLowerCase();
  const combined = msg + " " + stderr;

  if (err.killed || combined.includes("timeout") || combined.includes("timed out")) {
    return "Octo is taking too long to respond. Try a simpler question.";
  }
  if (combined.includes("rate limit") || combined.includes("429") || combined.includes("cooldown")) {
    return "Octo's language model is temporarily rate-limited. Try again in a few minutes.";
  }
  if (combined.includes("insufficient") || combined.includes("credit") || combined.includes("quota") || combined.includes("billing")) {
    return "Octo's language model provider is temporarily unavailable. Try again later.";
  }
  if (combined.includes("401") || combined.includes("403") || combined.includes("auth")) {
    return "Octo's language model provider is temporarily unavailable. Try again later.";
  }
  if (combined.includes("model") || combined.includes("provider") || combined.includes("502") || combined.includes("503")) {
    return "Octo's language model is temporarily unavailable. Try again in a few minutes.";
  }
  return "Something went wrong. Try again.";
}

/**
 * Fallback to KOI API /chat for degraded RAG response.
 */
function koiChatFallback(message, callback) {
  const body = JSON.stringify({ query: message });
  const url = new URL(`${KOI_API}/chat`);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 20000,
  };

  const req = http.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      try {
        const result = JSON.parse(data);
        if (res.statusCode === 200 && result.answer) {
          callback(null, result.answer);
        } else {
          callback(new Error(result.detail || "KOI chat failed"));
        }
      } catch (e) {
        callback(new Error("Failed to parse KOI response"));
      }
    });
  });

  req.on("error", (e) => callback(e));
  req.on("timeout", () => { req.destroy(); callback(new Error("KOI chat timeout")); });
  req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && req.url === "/chat") {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (!checkRateLimit(ip)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many requests. Please wait a moment." }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on("end", () => {
      try {
        const { message, sessionId } = JSON.parse(body);
        if (!message || typeof message !== "string" || message.trim().length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Message is required" }));
          return;
        }
        const cleanMessage = message.trim().substring(0, MAX_MESSAGE_LENGTH);
        const sid = sessionId || "web-" + crypto.randomBytes(4).toString("hex");

        execFile("openclaw", [
          "agent",
          "--session-id", sid,
          "--message", cleanMessage,
          "--json"
        ], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) {
            const userMessage = classifyError(err);
            console.error("Agent error:", err.message, stderr ? `stderr: ${stderr}` : "");

            // Fallback to KOI /chat for degraded RAG response
            koiChatFallback(cleanMessage, (fallbackErr, fallbackAnswer) => {
              if (!fallbackErr && fallbackAnswer) {
                console.log("Served response via KOI /chat fallback");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  reply: fallbackAnswer,
                  sessionId: sid,
                  fallback: true,
                }));
              } else {
                console.error("KOI fallback also failed:", fallbackErr?.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: userMessage }));
              }
            });
            return;
          }
          try {
            const result = JSON.parse(stdout);
            const payloads = result.result?.payloads || [];
            const textParts = payloads
              .filter(p => p.text)
              .map(p => p.text);
            const text = textParts[textParts.length - 1] || "No response";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ reply: text, sessionId: sid }));
          } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Could not parse response" }));
          }
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Octo Chat API listening on 127.0.0.1:" + PORT);
});
