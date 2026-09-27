import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { companySettings, userPermissions, users } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAdmin } from "../access";
import { getDb } from "../db";

const nullableText = z.string().max(3000).nullable().optional();

export const adminRouter = router({
  myAccess: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role === "admin") {
      return {
        role: "admin" as const,
        isActive: ctx.user.isActive !== false,
        canViewCustomers: true,
        canManageCustomers: true,
        canViewBills: true,
        canManageBills: true,
        canViewReports: true,
        canManageWapda: true,
        canManageCompany: true,
        canManageUsers: true,
      };
    }
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [permissions] = await db.select().from(userPermissions).where(eq(userPermissions.userId, ctx.user.id)).limit(1);
    return {
      role: "user" as const,
      isActive: ctx.user.isActive !== false,
      canViewCustomers: permissions?.canViewCustomers ?? false,
      canManageCustomers: permissions?.canManageCustomers ?? false,
      canViewBills: permissions?.canViewBills ?? false,
      canManageBills: permissions?.canManageBills ?? false,
      canViewReports: permissions?.canViewReports ?? false,
      canManageWapda: permissions?.canManageWapda ?? false,
      canManageCompany: false,
      canManageUsers: false,
    };
  }),

  companyGet: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(companySettings).where(eq(companySettings.id, 1)).limit(1);
    return row ?? { id: 1, companyName: "ATOZ SOLAR SYSTEM", logoUrl: null, address: null, phone: null, whatsapp: null, email: null, website: null, jazzcashQrUrl: null, jazzcashAccount: null, easypaisaQrUrl: null, easypaisaAccount: null, bankQrUrl: null, bankAccountDetails: null };
  }),

  companySave: protectedProcedure.input(z.object({
    companyName: z.string().trim().min(1).max(200), logoUrl: nullableText, address: nullableText,
    phone: nullableText, whatsapp: nullableText, email: nullableText, website: nullableText,
    jazzcashQrUrl: nullableText, jazzcashAccount: nullableText, easypaisaQrUrl: nullableText,
    easypaisaAccount: nullableText, bankQrUrl: nullableText, bankAccountDetails: nullableText,
  })).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.user);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.insert(companySettings).values({ id: 1, ...input }).onDuplicateKeyUpdate({ set: input });
    return { success: true };
  }),

  usersList: protectedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.user);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const userRows = await db.select().from(users);
    const permissions = await db.select().from(userPermissions);
    const map = new Map(permissions.map(p => [p.userId, p]));
    return userRows.map(({ openId: _openId, ...user }) => ({ ...user, permissions: map.get(user.id) ?? null }));
  }),

  userUpdate: protectedProcedure.input(z.object({
    userId: z.number().int().positive(), role: z.enum(["user", "admin"]), isActive: z.boolean(),
    canViewCustomers: z.boolean(), canManageCustomers: z.boolean(), canViewBills: z.boolean(),
    canManageBills: z.boolean(), canViewReports: z.boolean(), canManageWapda: z.boolean(),
  })).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.user);
    if (ctx.user.id === input.userId && (!input.isActive || input.role !== "admin")) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot disable or demote your own administrator account." });
    }
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { userId, role, isActive, ...permissions } = input;
    await db.update(users).set({ role, isActive }).where(eq(users.id, userId));
    await db.insert(userPermissions).values({ userId, ...permissions }).onDuplicateKeyUpdate({ set: permissions });
    return { success: true };
  }),
});
