import "dotenv/config";
import process from "node:process";

const startEngineTick = async (): Promise<void> => {
  console.log(`[${new Date().toISOString()}] Worker tick started`);

  setTimeout(() => {
    void startEngineTick();
  }, 10000);
};

const main = async (): Promise<void> => {
  process.on("uncaughtException", (error: Error) => {
    console.error("[uncaughtException]", error);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[unhandledRejection]", reason);
  });

  console.log("Ping-pong background worker starting...");
  await startEngineTick();
};

void main();
