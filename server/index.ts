import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { getUserById } from "./auth";

const app = express();
app.set("trust proxy", 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // req.session e' popolata dal middleware session() (registrato dopo questo,
      // dentro registerRoutes) — per lo stesso req l'ordine di esecuzione lo
      // garantisce gia' pronto quando "finish" scatta a fine richiesta.
      const userId = (req as any).session?.userId as string | undefined;
      const user = userId ? getUserById(userId) : null;
      const who = user ? user.username : "anon";
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms [${who}]`;
      if (logLine.length > 100) logLine = logLine.slice(0, 99) + "…";
      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    if (!res.headersSent) res.status(status).json({ message });
  });

  // Unknown API paths should never fall through to the SPA.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Non trovato" });
  });

  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");
  server.listen({ port, host, reusePort: true }, () => {
    log(`serving on port ${port}`);
  });
})();
