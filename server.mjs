// Runs worker.js as a normal Node server (for Termux), so requests to the
// Cinema Box API leave from YOUR network instead of Cloudflare's servers.
import http from "node:http";
import worker from "./worker.js";

const PORT = Number(process.env.PORT) || 7000;

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || "127.0.0.1:" + PORT}${req.url}`;
    const request = new Request(url, { method: req.method, headers: req.headers });
    const response = await worker.fetch(request, {}, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String((e && e.message) || e));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Cinema Box addon running: http://127.0.0.1:${PORT}/manifest.json`);
});
