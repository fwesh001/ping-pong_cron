import express, { type Express } from "express";
import adminRoutes from "./routes/admin.routes";
import "./cron/monitor";

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    if (requestOrigin && (allowedOrigins.includes("*") || allowedOrigins.includes(requestOrigin))) {
      res.header("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : requestOrigin);
      res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.header("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  });
  
  // Health check endpoint for cron-job services
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });
  
  app.use("/api/v1/admin", adminRoutes);
  return app;
}

const app = createApp();

export default app;
