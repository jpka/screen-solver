// PROTOTYPE — throwaway LAN server for testing the client on a real phone.
// Sends no-store so a rotation/layout fix is never masked by a cached page.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const TYPES = { ".html": "text/html; charset=utf-8", ".md": "text/plain; charset=utf-8" };

http.createServer((req, res) => {
  const rel = req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0];
  const fp = path.join(__dirname, path.normalize(rel).replace(/^[\\/]+/, ""));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    res.end(data);
  });
}).listen(PORT, "0.0.0.0", () => console.log(`serving ${__dirname} on 0.0.0.0:${PORT}`));
