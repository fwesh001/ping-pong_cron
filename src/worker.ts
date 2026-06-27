import "dotenv/config";
import process from "node:process";
import { performance } from "node:perf_hooks";
import express from "express";
import axios, { AxiosError } from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const app = express();
const PORT = process.env.PORT || 3000;

const POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;

interface PingResult {
  monitorId: string;
  statusCode: number | null;
  latencyMs: number;
  isUp: boolean;
  error: string | null;
}

const pingTarget = async (monitor: {
  id: string;
  serviceName: string;
  targetUrl: string;
  timeoutMs: number | null;
}): Promise<PingResult> => {
  const start = performance.now();
  const timeout = monitor.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await axios.get(monitor.targetUrl, {
      timeout,
      validateStatus: () => true,
      headers: { "User-Agent": "PingPong-Worker/1.0" },
    });

    const latencyMs = Math.round(performance.now() - start);
    const statusCode = response.status;
    const isUp = statusCode >= 200 && statusCode < 400;

    return {
      monitorId: monitor.id,
      statusCode,
      latencyMs,
      isUp,
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const axiosError = err as AxiosError;

    return {
      monitorId: monitor.id,
      statusCode: axiosError.response?.status ?? null,
      latencyMs,
      isUp: false,
      error: axiosError.message ?? "Unknown network error",
    };
  }
};

const startEngineTick = async (): Promise<void> => {
  const tickStart = Date.now();
  console.log(`\n[${new Date(tickStart).toISOString()}] ── Engine Tick Started ──`);

  try {
    const dueMonitors = await prisma.monitor.findMany({
      where: {
        status: "ACTIVE",
        nextCheckAt: { lte: new Date() },
      },
      include: { user: true },
    });

    console.log(`[Tick] Found ${dueMonitors.length} due monitors`);

    if (dueMonitors.length === 0) {
      setTimeout(() => void startEngineTick(), POLL_INTERVAL_MS);
      return;
    }

    const zeroCreditMonitors = dueMonitors.filter((m) => m.user.creditBalance <= 0);
    const validMonitors = dueMonitors.filter((m) => m.user.creditBalance > 0);

    if (zeroCreditMonitors.length > 0) {
      const zeroCreditUserIds = [...new Set(zeroCreditMonitors.map((m) => m.userId))];

      await prisma.$transaction([
        prisma.monitor.updateMany({
          where: { id: { in: zeroCreditMonitors.map((m) => m.id) } },
          data: { status: "PAUSED" },
        }),
        prisma.notification.createMany({
          data: zeroCreditUserIds.map((userId) => ({
            userId,
            type: "SYSTEM",
            message: "Your monitor(s) were paused due to insufficient credits. Please top up.",
          })),
        }),
      ]);

      console.log(
        `[Credit Guard] Paused ${zeroCreditMonitors.length} monitors across ${zeroCreditUserIds.length} users (zero credits)`
      );
    }

    if (validMonitors.length > 0) {
      const results = await Promise.allSettled(validMonitors.map((monitor) => pingTarget(monitor)));

      let successCount = 0;
      let failCount = 0;
      let logsSaved = 0;
      let creditsSiphoned = 0;

      const reconciliationPromises: Promise<void>[] = [];

      results.forEach((result, index) => {
        const monitor = validMonitors[index];

        if (result.status === "fulfilled") {
          const ping = result.value;
          if (ping.isUp) successCount++;
          else failCount++;

          console.log(
            `[Ping] Monitor [${ping.monitorId}] (${monitor.serviceName}) → ${ping.statusCode ?? "ERR"} in ${ping.latencyMs}ms ${ping.isUp ? "✓ UP" : "✗ DOWN"}`
          );
          if (ping.error) {
            console.log(`       └─ Error: ${ping.error}`);
          }

          const nextCheckAt = new Date(Date.now() + (monitor.pingIntervalSecs ?? 60) * 1000);

          const persistPromise = (async (): Promise<void> => {
            try {
              // A. Create heartbeat log
              await prisma.pingLog.create({
                data: {
                  monitorId: monitor.id,
                  userId: monitor.userId,
                  status: ping.isUp ? "UP" : "DOWN",
                  statusCode: ping.statusCode,
                  responseTimeMs: ping.latencyMs,
                  latencyMs: ping.latencyMs,
                  isUp: ping.isUp,
                  errorMessage: ping.error,
                  checkedAt: new Date(),
                },
              });

              // B. Advance monitor schedule
              await prisma.monitor.update({
                where: { id: monitor.id },
                data: {
                  lastPingedAt: new Date(),
                  nextCheckAt,
                },
              });

              // C. Credit siphon
              await prisma.user.update({
                where: { id: monitor.userId },
                data: { creditBalance: { decrement: 1 } },
              });

              logsSaved++;
              creditsSiphoned++;

              console.log(
                `       └─ Saved log, next check at ${nextCheckAt.toISOString()}, credit siphoned (-1)`
              );
            } catch (dbError) {
              console.error(`       └─ DB write failed for monitor [${monitor.id}]:`, dbError);
            }
          })();

          reconciliationPromises.push(persistPromise);
        } else {
          failCount++;
          console.log(
            `[Ping] Monitor [${monitor.id}] (${monitor.serviceName}) → FAILED: ${result.reason}`
          );
        }
      });

      // Execute all persistence operations concurrently; individual failures are isolated
      await Promise.allSettled(reconciliationPromises);

      console.log(
        `[Tick] Results: ${successCount} up, ${failCount} down | Logs saved: ${logsSaved} | Credits siphoned: ${creditsSiphoned}`
      );
    }

    const tickDuration = Date.now() - tickStart;
    console.log(`[${new Date().toISOString()}] ── Engine Tick Completed in ${tickDuration}ms ──`);
  } catch (error) {
    console.error("[Tick] Fatal error during engine tick:", error);
  }

  setTimeout(() => void startEngineTick(), POLL_INTERVAL_MS);
};

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "healthy", message: "Engine is humming smoothly." });
});

const main = async (): Promise<void> => {
  process.on("uncaughtException", (error: Error) => {
    console.error("[uncaughtException] Thread-safe crash prevented:", error);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[unhandledRejection] Thread-safe crash prevented:", reason);
  });

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     Ping-Pong Background Worker v1.0            ║");
  console.log("║     Clockwork Engine Loop Initialized           ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Polling interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`Default timeout:  ${DEFAULT_TIMEOUT_MS}ms`);

  startEngineTick();

  app.listen(PORT, () => {
    console.log(`[Port Adapter] Listening on port ${PORT} to pass Render deployment check`);
  });
};

main().catch((err) => console.error("Fatal exception in main thread:", err));
