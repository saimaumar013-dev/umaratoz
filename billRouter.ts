import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, monthlyBills } from "../../drizzle/schema";
import { getBillStatus, getCurrentCharges, getOutstanding, getTotalPayable, getUnits, invoiceNumber } from "../../shared/billing";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../access";
import { getDb } from "../db";
import { syncBillStatuses } from "../statuses";

async function rebuildCustomerLedger(db: any, customerId: number) {
  const rows = await db.select().from(monthlyBills).where(eq(monthlyBills.customerId, customerId)).orderBy(asc(monthlyBills.year), asc(monthlyBills.month));
  let previousOutstanding = 0;
  for (const row of rows) {
    // Monthly units are the canonical sum of saved daily deltas. Do not
    // reconstruct them from cumulative first/last meter readings here.
    const unitsConsumed = Number(row.unitsConsumed ?? 0);
    const amount = getCurrentCharges(unitsConsumed, row.unitPrice);
    const totalPayable = getTotalPayable(previousOutstanding, amount, row.lateFee, row.discount);
    const receivedAmount = Math.min(row.receivedAmount, totalPayable);
    const outstandingAmount = getOutstanding(totalPayable, receivedAmount);
    const status = getBillStatus(totalPayable, receivedAmount, row.dueDate);
    await db.update(monthlyBills).set({ previousOutstanding, unitsConsumed, amount, totalPayable, receivedAmount, outstandingAmount, status }).where(eq(monthlyBills.id, row.id));
    previousOutstanding = outstandingAmount;
  }
}

const billInput = z.object({
  id: z.number().int().positive().optional(),
  customerId: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(9999),
  previousReading: z.number().nonnegative(),
  currentReading: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
  previousOutstanding: z.number().nonnegative().default(0),
  discount: z.number().nonnegative().default(0),
  lateFee: z.number().nonnegative().default(0),
  readingDate: z.string().max(10).nullable().optional(),
  meterReaderName: z.string().max(200).nullable().optional(),
  meterReadingPhotoUrl: z.string().nullable().optional(),
  issuedDate: z.string().min(10).max(10),
  dueDate: z.string().min(10).max(10),
  receivedAmount: z.number().nonnegative().default(0),
  receivedDate: z.string().max(10).nullable().optional(),
  paymentMethod: z.enum(["Cash", "JazzCash", "Easypaisa", "Bank"]).nullable().optional(),
  remarks: z.string().max(3000).nullable().optional(),
});

export const billRouter = router({
  list: protectedProcedure.input(z.object({
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().optional(),
    customerId: z.number().int().positive().optional(),
    search: z.string().optional(),
    status: z.enum(["Paid", "Unpaid", "Overdue"]).optional(),
  }).optional()).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewBills");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const conditions = [];
    const activeCustomers = await db.select({ id: customers.id, sNo: customers.sNo }).from(customers).where(eq(customers.lifecycleStatus, "active"));
    const activeCustomerIds = new Set(activeCustomers.map(customer => customer.id));
    const sNoByCustomerId = new Map(activeCustomers.map(customer => [customer.id, customer.sNo]));
    if (input?.month) conditions.push(eq(monthlyBills.month, input.month));
    if (input?.year) conditions.push(eq(monthlyBills.year, input.year));
    if (input?.customerId) conditions.push(eq(monthlyBills.customerId, input.customerId));
    if (input?.status) conditions.push(eq(monthlyBills.status, input.status));
    if (input?.search?.trim()) conditions.push(or(
      sql`${monthlyBills.customerName} like ${`%${input.search.trim()}%`}`,
      sql`${monthlyBills.invoiceNumber} like ${`%${input.search.trim()}%`}`,
    )!);
    const rows = await db.select().from(monthlyBills).where(conditions.length ? and(...conditions) : undefined).orderBy(desc(monthlyBills.year), desc(monthlyBills.month), asc(monthlyBills.customerName));
    const current = await syncBillStatuses(db, rows.filter(row => activeCustomerIds.has(row.customerId)));
    return current.sort((a, b) => (sNoByCustomerId.get(a.customerId) ?? Number.MAX_SAFE_INTEGER) - (sNoByCustomerId.get(b.customerId) ?? Number.MAX_SAFE_INTEGER)).map(row => ({ ...row, customerSNo: sNoByCustomerId.get(row.customerId) ?? null }));
  }),

  get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewBills");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [bill] = await syncBillStatuses(db, await db.select().from(monthlyBills).where(eq(monthlyBills.id, input.id)).limit(1));
    if (!bill) throw new TRPCError({ code: "NOT_FOUND", message: "Bill not found" });
    const [customer] = await db.select().from(customers).where(eq(customers.id, bill.customerId)).limit(1);
    return { bill, customer };
  }),

  defaults: protectedProcedure.input(z.object({ customerId: z.number().int().positive(), month: z.number().int().min(1).max(12), year: z.number().int() })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewBills");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    const [existing] = await db.select().from(monthlyBills).where(and(eq(monthlyBills.customerId, input.customerId), eq(monthlyBills.month, input.month), eq(monthlyBills.year, input.year))).limit(1);
    if (existing) return { existing, previousReading: existing.previousReading, previousOutstanding: existing.previousOutstanding, unitPrice: existing.unitPrice };
    const [previous] = await db.select().from(monthlyBills).where(and(
      eq(monthlyBills.customerId, input.customerId),
      or(lt(monthlyBills.year, input.year), and(eq(monthlyBills.year, input.year), lt(monthlyBills.month, input.month))),
    )).orderBy(desc(monthlyBills.year), desc(monthlyBills.month)).limit(1);
    return {
      existing: null,
      previousReading: previous?.currentReading ?? 0,
      previousOutstanding: previous?.outstandingAmount ?? 0,
      unitPrice: customer.unitPrice,
    };
  }),

  save: protectedProcedure.input(billInput).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageBills");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    if (input.currentReading < input.previousReading) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Current reading cannot be lower than previous reading." });
    }
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found" });
    const unitsConsumed = getUnits(input.previousReading, input.currentReading);
    const amount = getCurrentCharges(unitsConsumed, input.unitPrice);
    const totalPayable = getTotalPayable(input.previousOutstanding, amount, input.lateFee, input.discount);
    const receivedAmount = Math.min(input.receivedAmount, totalPayable);
    const outstandingAmount = getOutstanding(totalPayable, receivedAmount);
    const status = getBillStatus(totalPayable, receivedAmount, input.dueDate);
    const existingPeriod = await db.select().from(monthlyBills).where(and(eq(monthlyBills.customerId, input.customerId), eq(monthlyBills.month, input.month), eq(monthlyBills.year, input.year))).limit(1);
    const existing = existingPeriod[0];
    const [originalBill] = input.id ? await db.select().from(monthlyBills).where(eq(monthlyBills.id, input.id)).limit(1) : [];
    if (input.id && !originalBill) {
      throw new TRPCError({ code: "NOT_FOUND", message: "The bill being edited no longer exists. Refresh the bills list and try again." });
    }
    const id = input.id ?? existing?.id;
    if (input.id && existing && existing.id !== input.id) {
      throw new TRPCError({ code: "CONFLICT", message: "A bill already exists for this customer, month, and year." });
    }
    const values = {
      customerId: input.customerId,
      customerName: customer.name,
      invoiceNumber: id ? (originalBill?.invoiceNumber ?? existing?.invoiceNumber ?? invoiceNumber(input.year, input.month, customer.serialNumber)) : invoiceNumber(input.year, input.month, customer.serialNumber),
      month: input.month,
      year: input.year,
      previousReading: input.previousReading,
      currentReading: input.currentReading,
      unitsConsumed,
      unitPrice: input.unitPrice,
      previousOutstanding: input.previousOutstanding,
      amount,
      discount: input.discount,
      lateFee: input.lateFee,
      totalPayable,
      receivedAmount,
      outstandingAmount,
      readingDate: input.readingDate || null,
      meterReaderName: input.meterReaderName || null,
      meterReadingPhotoUrl: input.meterReadingPhotoUrl || null,
      issuedDate: input.issuedDate,
      dueDate: input.dueDate,
      receivedDate: receivedAmount > 0 ? (input.receivedDate || new Date().toISOString().slice(0, 10)) : null,
      paymentMethod: receivedAmount > 0 ? (input.paymentMethod || "Cash" as const) : null,
      remarks: input.remarks || null,
      status,
    };
    try {
      let savedId = id;
      if (id) {
        const result = await db.update(monthlyBills).set(values).where(eq(monthlyBills.id, id));
        if (!result || Number((result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? 0) !== 1) {
          throw new TRPCError({ code: "NOT_FOUND", message: "The bill could not be updated. Refresh the bills list and try again." });
        }
      } else {
        const [result] = await db.insert(monthlyBills).values(values);
        savedId = Number(result.insertId);
      }
      await db.update(customers).set({ latestMeterPhotoUrl: input.meterReadingPhotoUrl || customer.latestMeterPhotoUrl }).where(eq(customers.id, customer.id));
      await rebuildCustomerLedger(db, input.customerId);
      if (originalBill && originalBill.customerId !== input.customerId) await rebuildCustomerLedger(db, originalBill.customerId);
      const [saved] = await db.select().from(monthlyBills).where(eq(monthlyBills.id, savedId!)).limit(1);
      return { id: savedId!, updatedExisting: Boolean(existing || input.id), bill: saved };
    } catch (error: any) {
      if (error?.code === "ER_DUP_ENTRY" || String(error?.message).includes("Duplicate")) {
        throw new TRPCError({ code: "CONFLICT", message: "A bill already exists for this customer, month, and year." });
      }
      throw error;
    }
  }),

  delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageBills");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [bill] = await db.select().from(monthlyBills).where(eq(monthlyBills.id, input.id)).limit(1);
    await db.delete(monthlyBills).where(eq(monthlyBills.id, input.id));
    if (bill) await rebuildCustomerLedger(db, bill.customerId);
    return { success: true };
  }),
});
