import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, monthlyBills } from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../access";
import { getDb } from "../db";
import { syncBillStatuses } from "../statuses";
import { DEFAULT_ELECTRICITY_RATE } from "../../shared/billing";

const customerInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, "Customer name is required").max(200),
  sNo: z.number().int().positive().optional(),
  serialNumber: z.number().int().positive().optional(),
  photoUrl: z.string().nullable().optional(),
  email: z.string().email().or(z.literal("")).nullable().optional(),
  mobileNumber: z.string().max(40).nullable().optional(),
  whatsappNumber: z.string().max(40).nullable().optional(),
  cnic: z.string().max(40).nullable().optional(),
  address: z.string().max(2000).nullable().optional(),
  connectionDate: z.string().max(10).nullable().optional(),
  installationDate: z.string().max(10).nullable().optional(),
  unitPrice: z.number().nonnegative().default(DEFAULT_ELECTRICITY_RATE),
  meterNumber: z.string().max(100).nullable().optional(),
  meterType: z.string().max(100).nullable().optional(),
  meterLocation: z.string().max(200).nullable().optional(),
  latestMeterPhotoUrl: z.string().nullable().optional(),
});

export const customerRouter = router({
  list: protectedProcedure
    .input(z.object({ search: z.string().optional(), status: z.enum(["active", "closed", "all"]).default("active") }).optional())
    .query(async ({ ctx, input }) => {
      await requireAccess(ctx.user, "canViewCustomers");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const search = input?.search?.trim();
      const lifecycleStatus = input?.status ?? "active";
      const lifecycleCondition = lifecycleStatus === "all" ? undefined : eq(customers.lifecycleStatus, lifecycleStatus);
      const searchCondition = search ? or(like(customers.name, `%${search}%`), like(customers.meterNumber, `%${search}%`), like(customers.mobileNumber, `%${search}%`)) : undefined;
      const rows = await db.select().from(customers)
        .where(lifecycleCondition && searchCondition ? and(lifecycleCondition, searchCondition) : lifecycleCondition ?? searchCondition)
        .orderBy(asc(customers.sNo));
      if (!rows.length) return [];
      const allBills = await db.select().from(monthlyBills).orderBy(desc(monthlyBills.year), desc(monthlyBills.month));
      const map = new Map<number, { totalUnits: number; totalBill: number; totalPaid: number; outstanding: number }>();
      for (const bill of allBills) {
        const row = map.get(bill.customerId) ?? { totalUnits: 0, totalBill: 0, totalPaid: 0, outstanding: bill.outstandingAmount };
        row.totalUnits += bill.unitsConsumed;
        row.totalBill += Math.max(0, bill.amount + bill.lateFee - bill.discount);
        row.totalPaid += bill.receivedAmount;
        map.set(bill.customerId, row);
      }
      return rows.map(customer => ({ ...customer, ...map.get(customer.id) }));
    }),

  get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewCustomers");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.id)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    const bills = await syncBillStatuses(db, await db.select().from(monthlyBills).where(eq(monthlyBills.customerId, input.id)).orderBy(desc(monthlyBills.year), desc(monthlyBills.month)));
    const summary = bills.reduce((acc, bill) => ({
      totalUnits: acc.totalUnits + bill.unitsConsumed,
      totalBill: acc.totalBill + Math.max(0, bill.amount + bill.lateFee - bill.discount),
      totalPaid: acc.totalPaid + bill.receivedAmount,
      outstanding: acc.outstanding,
    }), { totalUnits: 0, totalBill: 0, totalPaid: 0, outstanding: 0 });
    summary.outstanding = bills[0]?.outstandingAmount ?? 0;
    return { customer, bills, summary };
  }),

  save: protectedProcedure.input(customerInput).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageCustomers");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { id, sNo: requestedSNo, serialNumber: legacySerialNumber, ...values } = input;
    try {
      const requested = requestedSNo ?? legacySerialNumber;
      if (id) {
        const [current] = await db.select({ sNo: customers.sNo }).from(customers).where(eq(customers.id, id)).limit(1);
        const canonicalSNo = requested ?? current?.sNo;
        if (!canonicalSNo) throw new TRPCError({ code: "BAD_REQUEST", message: "A valid sNo is required." });
        await db.update(customers).set({ ...values, sNo: canonicalSNo, serialNumber: canonicalSNo }).where(eq(customers.id, id));
        await db.update(monthlyBills).set({ customerName: values.name }).where(eq(monthlyBills.customerId, id));
        return { id, sNo: canonicalSNo };
      }
      const [maxRow] = await db.select({ maxSNo: sql<number>`max(${customers.sNo})` }).from(customers);
      const existing = await db.select({ sNo: customers.sNo, serialNumber: customers.serialNumber }).from(customers).orderBy(asc(customers.sNo));
      const usedSNos = new Set(existing.map(row => row.sNo));
      const usedSerialNumbers = new Set(existing.map(row => row.serialNumber));
      const firstVacantSNo = Array.from({ length: Number(maxRow?.maxSNo ?? 0) + 1 }, (_, index) => index + 1).find(value => !usedSNos.has(value));
      const canonicalSNo = requested ?? firstVacantSNo ?? Number(maxRow?.maxSNo ?? 0) + 1;
      const firstVacantSerialNumber = Array.from({ length: Math.max(canonicalSNo, existing.length) + 1 }, (_, index) => index + 1).find(value => !usedSerialNumbers.has(value));
      const canonicalSerialNumber = legacySerialNumber !== undefined && !usedSerialNumbers.has(legacySerialNumber) ? legacySerialNumber : (firstVacantSerialNumber ?? Math.max(canonicalSNo, existing.length) + 1);
      const [result] = await db.insert(customers).values({ ...values, sNo: canonicalSNo, serialNumber: canonicalSerialNumber });
      return { id: Number(result.insertId), sNo: canonicalSNo };
    } catch (error: any) {
      if (error?.code === "ER_DUP_ENTRY" || String(error?.message).includes("Duplicate")) {
        throw new TRPCError({ code: "CONFLICT", message: "This customer serial number already exists." });
      }
      throw error;
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageCustomers");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(monthlyBills).where(eq(monthlyBills.customerId, input.id));
    if (Number(count) > 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This customer has bills. Delete the bills first to prevent orphaned records." });
    }
    await db.delete(customers).where(eq(customers.id, input.id));
    return { success: true };
  }),

  close: protectedProcedure.input(z.object({ id: z.number().int().positive(), reason: z.string().trim().max(500).optional() })).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageCustomers");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.id)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    if (customer.lifecycleStatus === "closed") return { id: customer.id, status: "closed" as const, alreadyClosed: true, finalReading: null };
    const [latestBill] = await db.select({ id: monthlyBills.id, currentReading: monthlyBills.currentReading, month: monthlyBills.month, year: monthlyBills.year }).from(monthlyBills).where(eq(monthlyBills.customerId, input.id)).orderBy(desc(monthlyBills.year), desc(monthlyBills.month)).limit(1);
    await db.update(customers).set({ lifecycleStatus: "closed", closedAt: new Date(), closeReason: input.reason?.trim() || "Customer no longer uses the service." }).where(eq(customers.id, input.id));
    return { id: customer.id, status: "closed" as const, alreadyClosed: false, finalReading: latestBill?.currentReading ?? 0, finalBillId: latestBill?.id ?? null, finalMonth: latestBill ? { month: latestBill.month, year: latestBill.year } : null };
  }),

  reactivate: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageCustomers");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.id)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    await db.update(customers).set({ lifecycleStatus: "active", closedAt: null, closeReason: null }).where(eq(customers.id, input.id));
    return { id: input.id, status: "active" as const };
  }),
});
