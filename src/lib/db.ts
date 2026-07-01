/**
 * Prisma Client Singleton
 *
 * Provides a single PrismaClient instance for the application.
 * Prevents multiple instances in development due to hot-reloading.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Environment variable DATABASE_URL is required for Prisma client initialization.");
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
    adapter: new PrismaPg({
      connectionString: databaseUrl,
    }),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
