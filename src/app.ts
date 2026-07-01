import express, { type Express } from "express";
import adminRoutes from "./routes/admin.routes";
import "./cron/monitor";

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  
  // Health check endpoint for cron-job services
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });
  
  app.use("/api/v1/admin", adminRoutes);
  return app;
}

const app = createApp();

export default app;
