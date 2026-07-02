import { type Request, type Response } from "express";
import crypto from "node:crypto";
import axios from "axios";
import prisma from "@/lib/db";
import { logAdminAction } from "@/utils/audit";

const FLW_SECRET_KEY =
  process.env.FLW_SECRET_KEY ?? process.env.FLUTTERWAVE_SECRET ?? process.env.FLUTTERWAVE_SECRET_KEY ?? process.env.FLUTTERWAVE_SECR;
const FLW_WEBHOOK_HASH =
  process.env.FLW_WEBHOOK_HASH ?? process.env.FLUTTERWAVE_WEBHOOK_HASH ?? process.env.FLW_WEBHOOK_HASH;
const FLW_API_BASE = "https://api.flutterwave.com/v3";

export async function initializePayment(req: Request, res: Response) {
  try {
    if (!FLW_SECRET_KEY) {
      console.error("[PAYMENT] FLW_SECRET_KEY is not configured");
      return res.status(500).json({ error: "Payment service not configured" });
    }

    const body = req.body as Record<string, unknown>;
    const packageId = typeof body.packageId === "string" ? body.packageId : undefined;
    const userId = typeof body.userId === "string" ? body.userId : undefined;

    if (!packageId || !userId) {
      return res.status(400).json({ error: "packageId and userId are required" });
    }

    const pkg = await prisma.creditPackage.findUnique({ where: { id: packageId } });
    if (!pkg) {
      return res.status(404).json({ error: "Package not found" });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const txRef = `pp-${userId.slice(0, 8)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    await prisma.transaction.create({
      data: {
        userId,
        packageId,
        amount: pkg.price,
        status: "PENDING",
      },
    });

    const flwResponse = await axios.post(
      `${FLW_API_BASE}/payments`,
      {
        tx_ref: txRef,
        amount: pkg.price,
        currency: "NGN",
        redirect_url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard/credits?payment=callback`,
        payment_options: "card,banktransfer,ussd",
        customer: {
          email: user.email || `${user.fluxUserId}@ping-pong.app`,
          name: user.fluxUserId,
          phonenumber: "",
        },
        customizations: {
          title: "Ping-Pong Credits",
          description: `${pkg.credits} credits - ${pkg.name}`,
          logo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/ping-pong.png`,
        },
        meta: {
          userId,
          packageId,
          credits: pkg.credits,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const checkoutLink = flwResponse.data?.data?.link;
    if (!checkoutLink) {
      console.error("[PAYMENT] Flutterwave response missing checkout link:", flwResponse.data);
      return res.status(502).json({ error: "Failed to initialize payment with Flutterwave" });
    }

    return res.json({
      success: true,
      checkoutLink,
      txRef,
    });
  } catch (err: any) {
    console.error("[PAYMENT] Initialize payment error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to initialize payment" });
  }
}

export async function handleWebhook(req: Request, res: Response) {
  try {
    const signature = req.headers["verif-hash"];

    if (!FLW_WEBHOOK_HASH) {
      console.error("[PAYMENT] FLW_WEBHOOK_HASH is not configured");
      return res.status(500).json({ error: "Webhook hash not configured" });
    }

    if (!signature || signature !== FLW_WEBHOOK_HASH) {
      console.warn("[PAYMENT] Invalid webhook signature received");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const payload = req.body as Record<string, unknown>;
    const event = payload.event as string;
    const data = payload.data as Record<string, unknown> | undefined;

    if (!data) {
      return res.status(400).json({ error: "Missing webhook data" });
    }

    if (event !== "charge.completed") {
      return res.json({ received: true, event, processed: false });
    }

    const status = data.status as string;
    const txRef = data.tx_ref as string;
    const amount = Number(data.amount) || 0;
    const meta = (data.meta as Record<string, unknown>) || {};
    const userId = meta.userId as string | undefined;
    const packageId = meta.packageId as string | undefined;
    const credits = Number(meta.credits) || 0;

    if (!txRef || !userId || !packageId) {
      console.error("[PAYMENT] Webhook: missing required fields", { txRef, userId, packageId });
      return res.status(400).json({ error: "Missing required webhook fields" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findFirst({
        where: {
          userId,
          packageId,
          status: "COMPLETED",
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (existing && existing.amount === amount) {
        console.log(`[PAYMENT] Duplicate webhook ignored for tx_ref=${txRef}`);
        return { duplicate: true };
      }

      const transaction = await tx.transaction.create({
        data: {
          userId,
          packageId,
          amount,
          status: "COMPLETED",
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { creditBalance: { increment: credits } },
      });

      return { duplicate: false, transactionId: transaction.id };
    });

    if (result.duplicate) {
      return res.json({ received: true, processed: false, reason: "duplicate" });
    }

    await logAdminAction(
      userId,
      "SYS_EVNT",
      "CREDIT_PURCHASE",
      `User ${userId} purchased ${credits} credits for ₦${amount} via Flutterwave (tx_ref: ${txRef})`
    );

    console.log(`[PAYMENT] Credits topped up: user=${userId}, credits=${credits}, amount=₦${amount}`);
    return res.json({ received: true, processed: true });
  } catch (err: any) {
    console.error("[PAYMENT] Webhook error:", err.message);
    return res.json({ received: true, processed: false, error: "internal_error" });
  }
}
