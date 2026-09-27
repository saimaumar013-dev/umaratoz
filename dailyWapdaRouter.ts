import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, lte, lt } from "drizzle-orm";
import { z } from "zod";
import { customerDailyWapdaRecords, dailyWapdaRecords } from "../../drizzle/schema";
import { DEFAULT_ELECTRICITY_RATE, getUnits } from "../../shared/billing";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../access";
import { getDb } from "../db";

const period = z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(9999) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "readingDate must be YYYY-MM-DD");
const range = period.extend({ startDate: date, endDate: date });
const entry = z.object({
  previousReading: z.union([z.number(), z.string().trim().min(1)]).transform(Number).default(0),
  currentReading: z.union([z.number(), z.string().trim().min(1)]).transform(Number),
  unitsConsumed: z.union([z.number(), z.string().trim().min(1)]).optional().transform(value => value === undefined ? undefined : Number(value)),
  totalAmount: z.union([z.number(), z.string().trim().min(1)]).optional().transform(value => value === undefined ? undefined : Number(value)),
  ratePerUnit: z.union([z.number(), z.string().trim().min(1)]).transform(Number).default(DEFAULT_ELECTRICITY_RATE),
}).superRefine((value, ctx) => {
  if (![value.previousReading, value.currentReading, value.ratePerUnit].every(Number.isFinite)) ctx.addIssue({ code: "custom", message: "All readings and rate must be finite numbers." });
  if (value.previousReading < 0 || value.currentReading < 0 || value.ratePerUnit < 0) ctx.addIssue({ code: "custom", message: "Readings and rate cannot be negative." });
  if (value.currentReading < value.previousReading) ctx.addIssue({ code: "custom", message: "Current reading cannot be lower than previous reading." });
});
const payload = z.object({ ...period.shape, readingDate: date, data: z.union([entry, z.array(entry).min(1), z.string().transform(value => JSON.parse(value))]) });

export type ProfitDailyRow = { readingDate: string; customerRevenue?: number; wapdaCost?: number; customerUnits?: number; wapdaUnits?: number };
export type ProfitPeriod = { revenue: number; wapdaCost: number; netProfit: number; customerUnits: number; wapdaUnits: number; solarDifferenceUnits: number; importedDates: number };
export function calculateProfitPeriods(rows: ProfitDailyRow[], selectedDate: string, month: number, year: number): Record<"today" | "week" | "tenDays" | "twentyDays" | "month", ProfitPeriod> {
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  const selected = new Date(`${selectedDate}T00:00:00Z`);
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = iso(new Date(Date.UTC(year, month, 0)));
  const range = (days: number | null): ProfitPeriod => { const start = days === null ? monthStart : iso(new Date(selected.getTime() - (days - 1) * 86_400_000)); const included = rows.filter(row => row.readingDate >= start && row.readingDate <= (days === null ? monthEnd : selectedDate)); const dates = new Set(included.map(row => row.readingDate)); const revenue = included.reduce((sum, row) => sum + Number(row.customerRevenue ?? 0), 0); const wapdaCost = included.reduce((sum, row) => sum + Number(row.wapdaCost ?? 0), 0); const customerUnits = included.reduce((sum, row) => sum + Number(row.customerUnits ?? 0), 0); const wapdaUnits = included.reduce((sum, row) => sum + Number(row.wapdaUnits ?? 0), 0); return { revenue, wapdaCost, netProfit: revenue - wapdaCost, customerUnits, wapdaUnits, solarDifferenceUnits: customerUnits - wapdaUnits, importedDates: dates.size }; };
  return { today: range(1), week: range(7), tenDays: range(10), twentyDays: range(20), month: range(null) };
}

export function calculateProfitRange(rows: ProfitDailyRow[], startDate: string, endDate: string): ProfitPeriod {
  const included = rows.filter(row => row.readingDate >= startDate && row.readingDate <= endDate);
  const dates = new Set(included.map(row => row.readingDate));
  const revenue = included.reduce((sum, row) => sum + Number(row.customerRevenue ?? 0), 0);
  const wapdaCost = included.reduce((sum, row) => sum + Number(row.wapdaCost ?? 0), 0);
  const customerUnits = included.reduce((sum, row) => sum + Number(row.customerUnits ?? 0), 0);
  const wapdaUnits = included.reduce((sum, row) => sum + Number(row.wapdaUnits ?? 0), 0);
  return { revenue, wapdaCost, netProfit: revenue - wapdaCost, customerUnits, wapdaUnits, solarDifferenceUnits: customerUnits - wapdaUnits, importedDates: dates.size };
}

function assertDatePeriod(readingDate: string, month: number, year: number) {
  const parsed = new Date(`${readingDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month) throw new TRPCError({ code: "BAD_REQUEST", message: "Reading date must belong to the selected month and year." });
}

function parseData(raw: unknown) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const result = z.array(entry).safeParse(values);
  if (!result.success) throw new TRPCError({ code: "BAD_REQUEST", message: result.error.issues[0]?.message || "Invalid daily WAPDA data." });
  const rows = result.data;
  const unitsConsumed = rows.reduce((sum, row) => sum + getUnits(row.previousReading, row.currentReading), 0);
  const ratePerUnit = DEFAULT_ELECTRICITY_RATE;
  return { previousReading: rows.length === 1 ? rows[0].previousReading : 0, currentReading: rows.length === 1 ? rows[0].currentReading : unitsConsumed, unitsConsumed, ratePerUnit, totalBill: Math.round(unitsConsumed * ratePerUnit) };
}

export const dailyWapdaRouter = router({
  list: protectedProcedure.input(period).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewReports");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year))).orderBy(asc(dailyWapdaRecords.readingDate));
  }),
  profitSummary: protectedProcedure.input(period.extend({ selectedDate: date.optional() })).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewReports");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const selectedDate = input.selectedDate ?? `${input.year}-${String(input.month).padStart(2, "0")}-${String(new Date(input.year, input.month, 0).getDate()).padStart(2, "0")}`;
    assertDatePeriod(selectedDate, input.month, input.year);
    const [customerRows, wapdaRows] = await Promise.all([
      db.select().from(customerDailyWapdaRecords).where(and(eq(customerDailyWapdaRecords.month, input.month), eq(customerDailyWapdaRecords.year, input.year))),
      db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year))),
    ]);
    const byDate = new Map<string, ProfitDailyRow>();
    for (const row of customerRows) { const item = byDate.get(row.readingDate) ?? { readingDate: row.readingDate }; item.customerRevenue = (item.customerRevenue ?? 0) + Number(row.unitsConsumed) * Number(row.ratePerUnit || DEFAULT_ELECTRICITY_RATE); item.customerUnits = (item.customerUnits ?? 0) + Number(row.unitsConsumed); byDate.set(row.readingDate, item); }
    for (const row of wapdaRows) { const item = byDate.get(row.readingDate) ?? { readingDate: row.readingDate }; item.wapdaCost = (item.wapdaCost ?? 0) + Number(row.unitsConsumed) * Number(row.ratePerUnit || DEFAULT_ELECTRICITY_RATE); item.wapdaUnits = (item.wapdaUnits ?? 0) + Number(row.unitsConsumed); byDate.set(row.readingDate, item); }
    return { month: input.month, year: input.year, selectedDate, periods: calculateProfitPeriods(Array.from(byDate.values()), selectedDate, input.month, input.year) };
  }),
  summaryRange: protectedProcedure.input(range).query(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canViewReports");
    if (input.endDate < input.startDate) throw new TRPCError({ code: "BAD_REQUEST", message: "End date must be on or after start date." });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    const [customerRows, wapdaRows] = await Promise.all([
      db.select().from(customerDailyWapdaRecords).where(and(eq(customerDailyWapdaRecords.month, input.month), eq(customerDailyWapdaRecords.year, input.year), gte(customerDailyWapdaRecords.readingDate, input.startDate), lte(customerDailyWapdaRecords.readingDate, input.endDate))),
      db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year), gte(dailyWapdaRecords.readingDate, input.startDate), lte(dailyWapdaRecords.readingDate, input.endDate))),
    ]);
    const byDate = new Map<string, ProfitDailyRow>();
    for (const row of customerRows) { const item = byDate.get(row.readingDate) ?? { readingDate: row.readingDate }; item.customerRevenue = (item.customerRevenue ?? 0) + Number(row.unitsConsumed) * Number(row.ratePerUnit || DEFAULT_ELECTRICITY_RATE); item.customerUnits = (item.customerUnits ?? 0) + Number(row.unitsConsumed); byDate.set(row.readingDate, item); }
    for (const row of wapdaRows) { const item = byDate.get(row.readingDate) ?? { readingDate: row.readingDate }; item.wapdaCost = (item.wapdaCost ?? 0) + Number(row.unitsConsumed) * Number(row.ratePerUnit || DEFAULT_ELECTRICITY_RATE); item.wapdaUnits = (item.wapdaUnits ?? 0) + Number(row.unitsConsumed); byDate.set(row.readingDate, item); }
    return { startDate: input.startDate, endDate: input.endDate, ...calculateProfitRange(Array.from(byDate.values()), input.startDate, input.endDate) };
  }),
  preview: protectedProcedure.input(payload).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageWapda");
    assertDatePeriod(input.readingDate, input.month, input.year);
    const data = parseData(input.data);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    let resolvedData = data;
    if (data.previousReading === 0) { const [prior] = await db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year), lt(dailyWapdaRecords.readingDate, input.readingDate))).orderBy(desc(dailyWapdaRecords.readingDate)).limit(1); if (prior) resolvedData = { ...data, previousReading: Number(prior.currentReading), unitsConsumed: getUnits(Number(prior.currentReading), data.currentReading) }; }
    const [existing] = await db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year), eq(dailyWapdaRecords.readingDate, input.readingDate))).limit(1);
    const unitsConsumed = resolvedData.unitsConsumed ?? getUnits(resolvedData.previousReading, resolvedData.currentReading);
    return { month: input.month, year: input.year, readingDate: input.readingDate, data: { ...resolvedData, unitsConsumed, totalBill: Math.round(unitsConsumed * DEFAULT_ELECTRICITY_RATE) }, existing: existing ?? null, action: existing ? "update" as const : "create" as const };
  }),
  confirm: protectedProcedure.input(payload).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageWapda");
    assertDatePeriod(input.readingDate, input.month, input.year);
    const data = parseData(input.data);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    let resolvedData = data;
    if (data.previousReading === 0) { const [prior] = await db.select().from(dailyWapdaRecords).where(and(eq(dailyWapdaRecords.month, input.month), eq(dailyWapdaRecords.year, input.year), lt(dailyWapdaRecords.readingDate, input.readingDate))).orderBy(desc(dailyWapdaRecords.readingDate)).limit(1); if (prior) resolvedData = { ...data, previousReading: Number(prior.currentReading), unitsConsumed: getUnits(Number(prior.currentReading), data.currentReading) }; }
    const unitsConsumed = resolvedData.unitsConsumed ?? getUnits(resolvedData.previousReading, resolvedData.currentReading);
    const totalBill = Math.round(unitsConsumed * DEFAULT_ELECTRICITY_RATE);
    await db.insert(dailyWapdaRecords).values({ month: input.month, year: input.year, readingDate: input.readingDate, previousReading: resolvedData.previousReading, currentReading: resolvedData.currentReading, ratePerUnit: DEFAULT_ELECTRICITY_RATE, unitsConsumed, totalBill }).onDuplicateKeyUpdate({ set: { previousReading: resolvedData.previousReading, currentReading: resolvedData.currentReading, ratePerUnit: DEFAULT_ELECTRICITY_RATE, unitsConsumed, totalBill } });
    return { success: true, action: "saved" as const, readingDate: input.readingDate, unitsConsumed, totalBill };
  }),
});
