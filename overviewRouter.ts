import { TRPCError } from "@trpc/server";
import { and, asc, between, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { customers, dailyWapdaRecords, monthlyBills, wapdaRecords } from "../../drizzle/schema";
import { DEFAULT_ELECTRICITY_RATE, calculateNetProfit, getUnits } from "../../shared/billing";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../access";
import { getDb } from "../db";
import { syncBillStatuses } from "../statuses";

export const overviewRouter = router({
  dashboard: protectedProcedure.input(z.object({ month: z.number().int().min(1).max(12), year: z.number().int() })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewReports");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const activeCustomers = await db.select({ id: customers.id, sNo: customers.sNo }).from(customers).where(eq(customers.lifecycleStatus, "active")).orderBy(asc(customers.sNo));
    const activeCustomerIds = new Set(activeCustomers.map(customer => customer.id));
    const sNoByCustomerId = new Map(activeCustomers.map(customer => [customer.id, customer.sNo]));
    const allPeriodBills = await syncBillStatuses(db, await db.select().from(monthlyBills).where(and(eq(monthlyBills.month, input.month), eq(monthlyBills.year, input.year))).orderBy(asc(monthlyBills.customerName)));
    const periodBills = allPeriodBills.filter(bill => activeCustomerIds.has(bill.customerId)).sort((a, b) => (sNoByCustomerId.get(a.customerId) ?? Number.MAX_SAFE_INTEGER) - (sNoByCustomerId.get(b.customerId) ?? Number.MAX_SAFE_INTEGER)).map(bill => ({ ...bill, customerSNo: sNoByCustomerId.get(bill.customerId) ?? null }));
    const dailyWapda = await db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year)));
    const wapdaUnits = dailyWapda.reduce((sum, row) => sum + Number(row.unitsConsumed), 0);
    const wapdaExpense = dailyWapda.reduce((sum, row) => sum + Number(row.unitsConsumed) * Number(row.ratePerUnit || DEFAULT_ELECTRICITY_RATE), 0);
    const wapdaRate = dailyWapda[0]?.ratePerUnit ?? DEFAULT_ELECTRICITY_RATE;
    const [fallbackWapdaRate] = await db.select({ ratePerUnit: wapdaRecords.ratePerUnit }).from(wapdaRecords).orderBy(desc(wapdaRecords.year), desc(wapdaRecords.month)).limit(1);
    const previousOutstanding = periodBills.reduce((sum, bill) => sum + bill.previousOutstanding, 0);
    const totals = periodBills.reduce((acc, bill) => ({
      units: acc.units + bill.unitsConsumed,
      billed: acc.billed + bill.totalPayable,
      received: acc.received + bill.receivedAmount,
      outstanding: acc.outstanding + bill.outstandingAmount,
      paid: acc.paid + (bill.status === "Paid" ? 1 : 0),
      unpaid: acc.unpaid + (bill.status !== "Paid" ? 1 : 0),
    }), { units: 0, billed: 0, received: 0, outstanding: 0, paid: 0, unpaid: 0 });
    const customerRevenue = periodBills.reduce((sum, bill) => sum + Number(bill.unitsConsumed) * Number(bill.unitPrice || DEFAULT_ELECTRICITY_RATE), 0);
    const averageSellingRate = totals.units > 0 ? customerRevenue / totals.units : 0;
    const costRatePerUnit = wapdaRate ?? fallbackWapdaRate?.ratePerUnit ?? DEFAULT_ELECTRICITY_RATE;
    const profit = customerRevenue - wapdaExpense;
    const yearBills = await db.select().from(monthlyBills).where(eq(monthlyBills.year, input.year));
    const yearWapda = await db.select().from(dailyWapdaRecords).where(eq(dailyWapdaRecords.year, input.year));
    const trend = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const bills = yearBills.filter(b => b.month === month);
      const received = bills.reduce((s, b) => s + b.receivedAmount, 0);
      const billed = bills.reduce((s, b) => s + b.totalPayable, 0);
      const units = bills.reduce((s, b) => s + b.unitsConsumed, 0);
      const daily = yearWapda.filter(row => row.month === month);
      const expense = daily.reduce((sum, row) => sum + Number(row.unitsConsumed) * Number(row.ratePerUnit || DEFAULT_ELECTRICITY_RATE), 0);
      const revenue = bills.reduce((sum, bill) => sum + Number(bill.unitsConsumed) * Number(bill.unitPrice || DEFAULT_ELECTRICITY_RATE), 0);
      return { month, received, billed, units, profit: revenue - expense };
    });
    return {
      totals: { customers: activeCustomers.length, bills: periodBills.length, ...totals, customerRevenue, customerUnits: totals.units, wapdaUnits, previousOutstanding, wapdaExpense, averageSellingRate, costRatePerUnit, profit },
      bills: periodBills,
      trend,
    };
  }),

  latestPeriod: protectedProcedure.query(async ({ ctx }) => {
    await requireAccess(ctx.user, "canViewBills");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select({ month: monthlyBills.month, year: monthlyBills.year }).from(monthlyBills).orderBy(desc(monthlyBills.year), desc(monthlyBills.month)).limit(1);
    return row ?? null;
  }),

  wapdaList: protectedProcedure.query(async ({ ctx }) => {
    await requireAccess(ctx.user, "canViewReports");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return db.select().from(wapdaRecords).orderBy(desc(wapdaRecords.year), desc(wapdaRecords.month));
  }),

  wapdaSave: protectedProcedure.input(z.object({
    month: z.number().int().min(1).max(12), year: z.number().int().min(2000),
    previousReading: z.number().nonnegative(), currentReading: z.number().nonnegative(), ratePerUnit: z.number().nonnegative(),
  })).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageWapda");
    if (input.currentReading < input.previousReading) throw new TRPCError({ code: "BAD_REQUEST", message: "Current reading cannot be lower than previous reading." });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const unitsConsumed = getUnits(input.previousReading, input.currentReading);
    const totalBill = unitsConsumed * input.ratePerUnit;
    await db.insert(wapdaRecords).values({ ...input, unitsConsumed, totalBill }).onDuplicateKeyUpdate({ set: { previousReading: input.previousReading, currentReading: input.currentReading, ratePerUnit: input.ratePerUnit, unitsConsumed, totalBill } });
    return { unitsConsumed, totalBill };
  }),

  wapdaDefaults: protectedProcedure.input(z.object({ month: z.number().int().min(1).max(12), year: z.number().int() })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewReports");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [existing] = await db.select().from(wapdaRecords).where(and(eq(wapdaRecords.month, input.month), eq(wapdaRecords.year, input.year))).limit(1);
    if (existing) return existing;
    const [previous] = await db.select().from(wapdaRecords).where(sql`(${wapdaRecords.year} < ${input.year}) or (${wapdaRecords.year} = ${input.year} and ${wapdaRecords.month} < ${input.month})`).orderBy(desc(wapdaRecords.year), desc(wapdaRecords.month)).limit(1);
    return { month: input.month, year: input.year, previousReading: previous?.currentReading ?? 0, currentReading: previous?.currentReading ?? 0, ratePerUnit: DEFAULT_ELECTRICITY_RATE, unitsConsumed: 0, totalBill: 0 };
  }),

  report: protectedProcedure.input(z.object({
    startDate: z.string().min(10).max(10), endDate: z.string().min(10).max(10),
    customerId: z.number().int().positive().optional(), status: z.enum(["Paid", "Unpaid", "Overdue"]).optional(),
  })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewReports");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const conditions = [gte(monthlyBills.issuedDate, input.startDate), lte(monthlyBills.issuedDate, input.endDate)];
    if (input.customerId) conditions.push(eq(monthlyBills.customerId, input.customerId));
    if (input.status) conditions.push(eq(monthlyBills.status, input.status));
    const customerRows = await db.select().from(customers);
    const sNoByCustomerId = new Map(customerRows.map(customer => [customer.id, customer.sNo]));
    const bills = (await syncBillStatuses(db, await db.select().from(monthlyBills).where(and(...conditions)).orderBy(asc(monthlyBills.issuedDate), asc(monthlyBills.customerName))))
      .sort((a, b) => (sNoByCustomerId.get(a.customerId) ?? Number.MAX_SAFE_INTEGER) - (sNoByCustomerId.get(b.customerId) ?? Number.MAX_SAFE_INTEGER))
      .map(bill => ({ ...bill, customerSNo: sNoByCustomerId.get(bill.customerId) ?? null }));
    const start = new Date(`${input.startDate}T00:00:00`); const end = new Date(`${input.endDate}T23:59:59`);
    const wapda = (await db.select().from(wapdaRecords)).filter(w => {
      const d = new Date(w.year, w.month - 1, 15); return d >= start && d <= end;
    });
    const dailyWapda = await db.select().from(dailyWapdaRecords);
    const expense = dailyWapda.filter(w => w.readingDate >= input.startDate && w.readingDate <= input.endDate).reduce((s, w) => s + Number(w.unitsConsumed) * Number(w.ratePerUnit || DEFAULT_ELECTRICITY_RATE), 0);
    const latestByCustomer = new Map<number, typeof bills[number]>();
    for (const bill of bills) {
      const current = latestByCustomer.get(bill.customerId);
      if (!current || bill.year > current.year || (bill.year === current.year && bill.month > current.month)) latestByCustomer.set(bill.customerId, bill);
    }
    const totals = bills.reduce((a, b) => ({ revenue: a.revenue + b.receivedAmount, billed: a.billed + Math.max(0, b.amount + b.lateFee - b.discount), outstanding: a.outstanding, units: a.units + b.unitsConsumed }), { revenue: 0, billed: 0, outstanding: 0, units: 0 });
    totals.outstanding = Array.from(latestByCustomer.values()).reduce((sum, bill) => sum + bill.outstandingAmount, 0);
    const areas = new Map<string, { units: number; received: number }>();
    const customerMap = new Map(customerRows.map(c => [c.id, c]));
    for (const bill of bills) {
      const area = customerMap.get(bill.customerId)?.meterLocation || "Unspecified";
      const row = areas.get(area) ?? { units: 0, received: 0 };
      row.units += bill.unitsConsumed; row.received += bill.receivedAmount; areas.set(area, row);
    }
    const areaProfit = Array.from(areas.entries()).map(([area, row]) => {
      const allocatedExpense = totals.units > 0 ? expense * (row.units / totals.units) : 0;
      return { area, ...row, allocatedExpense, profit: row.received - allocatedExpense };
    });
    return { bills, totals: { ...totals, expense, profit: totals.revenue - expense }, areaProfit };
  }),
});
