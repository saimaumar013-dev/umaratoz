import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, monthlyBills } from "../../drizzle/schema";
import { DEFAULT_ELECTRICITY_RATE, getBillStatus, getCurrentCharges, getOutstanding, getTotalPayable, getUnits, invoiceNumber } from "../../shared/billing";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess } from "../access";
import { getDb } from "../db";

const serialValue = z.union([z.number(), z.string().trim().min(1)]).refine(value => Number.isInteger(Number(value)) && Number(value) > 0, "sNo must be a positive integer");
const readingEntry = z.object({
  sNo: serialValue.optional(),
  nameTag: z.string().trim().max(200).optional(),
  previousReading: z.union([z.number(), z.string().trim().min(1)]).optional(),
  currentReading: z.union([z.number(), z.string().trim().min(1)]),
  unitsConsumed: z.union([z.number(), z.string().trim().min(1)]).optional(),
  totalAmount: z.union([z.number(), z.string().trim().min(1)]).optional(),
}).refine(value => value.sNo !== undefined || Boolean(value.nameTag?.trim()), "Each row needs sNo or nameTag");
const inputEntries = z.array(z.unknown()).max(10000);
const periodSchema = z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(9999) });
const previewInput = z.object({ entries: inputEntries, ...periodSchema.shape });
const approvalSchema = z.object({ index: z.number().int().nonnegative(), customerId: z.number().int().positive() });

export function normalizeName(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[._'’\-]+/g, " ").replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}
function levenshtein(a: string, b: string) { const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const next = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = next; } } return row[b.length]; }
export function similarity(a: string, b: string) { if (!a || !b) return 0; if (a === b) return 1; const distanceScore = 1 - levenshtein(a, b) / Math.max(a.length, b.length); const compactA = a.replace(/\s/g, ""); const compactB = b.replace(/\s/g, ""); const compactScore = 1 - levenshtein(compactA, compactB) / Math.max(compactA.length, compactB.length); const aTokens = a.split(" ").filter(Boolean); const bTokens = b.split(" ").filter(Boolean); let tokenScore = 0; for (const left of aTokens) for (const right of bTokens) { const shorter = Math.min(left.length, right.length); const longer = Math.max(left.length, right.length); if (left === right) tokenScore = Math.max(tokenScore, 1); else if (shorter >= 3 && (left.startsWith(right) || right.startsWith(left) || left.includes(right) || right.includes(left))) tokenScore = Math.max(tokenScore, shorter / longer); else tokenScore = Math.max(tokenScore, 1 - levenshtein(left, right) / longer); } const intersection = new Set(aTokens.filter(token => bTokens.includes(token))).size; const union = new Set(aTokens.concat(bTokens)).size; return Math.max(distanceScore, compactScore, tokenScore, intersection / Math.max(1, union)); }

type NormalizedEntry = { index: number; sNo?: number; nameTag?: string; previousReading: number; currentReading: number; unitsConsumed: number; totalAmount: number };
export function normalizeEntries(raw: unknown) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new TRPCError({ code: "BAD_REQUEST", message: "Meter readings must be a JSON array." });
  const valid: NormalizedEntry[] = []; const invalid: Array<{ index: number; value: unknown; reason: string }> = []; const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    let value = parsed[index];
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { invalid.push({ index, value, reason: "Invalid JSON entry." }); continue; } }
    const result = readingEntry.safeParse(value);
    if (!result.success) { invalid.push({ index, value, reason: "Each row needs a positive sNo or nameTag, and reading fields must be finite non-negative numbers." }); continue; }
    const sNo = result.data.sNo === undefined ? undefined : Number(result.data.sNo);
    const nameTag = result.data.nameTag?.trim() || undefined;
    const previousReading = Number(result.data.previousReading ?? 0);
    const currentReading = Number(result.data.currentReading);
    const unitsConsumed = Number.isFinite(Number(result.data.unitsConsumed)) ? Math.max(0, Number(result.data.unitsConsumed)) : getUnits(previousReading, currentReading);
    const totalAmount = Math.round(unitsConsumed * DEFAULT_ELECTRICITY_RATE);
    if (![previousReading, currentReading].every(value => Number.isFinite(value) && value >= 0) || currentReading < previousReading) { invalid.push({ index, value, reason: "Readings must be finite non-negative numbers and currentReading cannot be lower than previousReading." }); continue; }
    const key = sNo !== undefined ? `sno:${sNo}` : `name:${normalizeName(nameTag || "")}`;
    if (seen.has(key)) { invalid.push({ index, value, reason: `Duplicate ${sNo !== undefined ? "sNo" : "nameTag"} in this import.` }); continue; }
    seen.add(key); valid.push({ index, sNo, nameTag, previousReading, currentReading, unitsConsumed, totalAmount });
  }
  return { valid, invalid };
}

async function loadPreview(db: any, raw: unknown, month: number, year: number, approvals: Array<{ index: number; customerId: number }> = []) {
  const { valid, invalid } = normalizeEntries(raw); const rows: any[] = await db.select().from(customers); const bills: any[] = await db.select().from(monthlyBills).orderBy(desc(monthlyBills.year), desc(monthlyBills.month), desc(monthlyBills.id));
  const targetByCustomer = new Map<number, any>(); for (const bill of bills) if (bill.month === month && bill.year === year) targetByCustomer.set(bill.customerId, bill);
  const customerById = new Map(rows.map(customer => [customer.id, customer])); const customerBySNo = new Map(rows.map(customer => [customer.sNo, customer])); const exactByName = new Map<string, any>(); const duplicateNames = new Set<string>();
  for (const customer of rows) { const key = normalizeName(customer.name); if (exactByName.has(key)) duplicateNames.add(key); else exactByName.set(key, customer); }
  const matched: any[] = []; const possibleMatches: any[] = []; const notFound: any[] = []; const approvalByIndex = new Map(approvals.map(item => [item.index, item.customerId]));
  for (const entry of valid) {
    const importedKey = normalizeName(entry.nameTag || ""); let customer = entry.sNo !== undefined ? customerBySNo.get(entry.sNo) : exactByName.get(importedKey); let matchType: "serial" | "normalized" | "approved" = customer && entry.sNo !== undefined ? "serial" : "normalized";
    if (entry.sNo === undefined && importedKey && duplicateNames.has(importedKey)) customer = undefined;
    const approvedId = approvalByIndex.get(entry.index);
    if (approvedId !== undefined && importedKey) { const approved = customerById.get(approvedId); if (approved && similarity(importedKey, normalizeName(approved.name)) >= 0.5) { customer = approved; matchType = "approved"; } }
    if (!customer && importedKey) { const candidates: Array<{ customerId: number; existingName: string; score: number }> = rows.map(row => ({ customerId: row.id, existingName: row.name, score: similarity(importedKey, normalizeName(row.name)) })).filter(candidate => candidate.score >= 0.5).sort((a, b) => b.score - a.score); const top = candidates[0]; const second = candidates[1]; if (top && (!second || top.score - second.score >= 0.06)) { customer = customerById.get(top.customerId); matchType = "normalized"; } else if (top) possibleMatches.push({ index: entry.index, importedSNo: entry.sNo, importedName: entry.nameTag, currentReading: entry.currentReading, candidates: candidates.slice(0, 5).map(candidate => ({ ...candidate, score: Number(candidate.score.toFixed(3)) })) }); else notFound.push({ index: entry.index, sNo: entry.sNo, nameTag: entry.nameTag, currentReading: entry.currentReading, reason: "Customer name was not found." }); continue; }
    if (!customer) { notFound.push({ index: entry.index, sNo: entry.sNo, nameTag: entry.nameTag, currentReading: entry.currentReading, reason: `No customer exists with sNo ${entry.sNo}.` }); continue; }
    const bill = targetByCustomer.get(customer.id); matched.push({ index: entry.index, customerId: customer.id, importedSNo: entry.sNo, importedName: entry.nameTag, existingSNo: customer.sNo, existingName: customer.name, oldReading: bill?.currentReading ?? 0, previousReading: entry.previousReading, newReading: entry.currentReading, unitsConsumed: entry.unitsConsumed, totalAmount: entry.totalAmount, billId: bill?.id ?? null, invoiceNumber: bill?.invoiceNumber ?? invoiceNumber(year, month, customer.sNo), matchType, willCreatePeriod: !bill });
  }
  return { month, year, totalRecords: valid.length + invalid.length, matched, possibleMatches, notFound, invalid, duplicateCount: invalid.filter(row => row.reason.includes("Duplicate")).length, updatedCount: matched.filter(row => row.oldReading !== row.newReading).length };
}

function datesForPeriod() { const issuedDate = new Date().toISOString().slice(0, 10); const due = new Date(); due.setDate(due.getDate() + 7); return { issuedDate, dueDate: due.toISOString().slice(0, 10) }; }

export const meterReadingRouter = router({
  preview: protectedProcedure.input(previewInput).mutation(async ({ ctx, input }) => { await requireAccess(ctx.user, "canManageBills"); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); try { return await loadPreview(db, input.entries, input.month, input.year); } catch (error: any) { throw new TRPCError({ code: "BAD_REQUEST", message: error?.message || "Invalid meter-reading JSON." }); } }),
  confirm: protectedProcedure.input(z.object({ entries: inputEntries, approvals: z.array(approvalSchema).default([]), ...periodSchema.shape })).mutation(async ({ ctx, input }) => {
    await requireAccess(ctx.user, "canManageBills"); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
    return db.transaction(async (tx: any) => { const preview = await loadPreview(tx, input.entries, input.month, input.year, input.approvals); if (preview.possibleMatches.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Select an existing customer for every possible match before confirming." }); const dates = datesForPeriod(); let updated = 0; let created = 0;
      for (const row of preview.matched) { const customer = (await tx.select().from(customers).where(eq(customers.id, row.customerId)).limit(1))[0]; if (!customer) continue; const unitsConsumed = row.unitsConsumed; const amount = row.totalAmount; const totalPayable = getTotalPayable(0, amount, 0, 0); const existing = row.billId ? row : null;
        if (existing) { await tx.update(monthlyBills).set({ previousReading: row.previousReading, currentReading: row.newReading, unitsConsumed, unitPrice: DEFAULT_ELECTRICITY_RATE, amount, previousOutstanding: 0, totalPayable, outstandingAmount: getOutstanding(totalPayable, 0), status: getBillStatus(totalPayable, 0, dates.dueDate) }).where(and(eq(monthlyBills.id, row.billId), eq(monthlyBills.customerId, row.customerId))); updated++; }
        else { await tx.insert(monthlyBills).values({ customerId: row.customerId, customerName: customer.name, invoiceNumber: row.invoiceNumber, month: input.month, year: input.year, previousReading: row.previousReading, currentReading: row.newReading, unitsConsumed, unitPrice: DEFAULT_ELECTRICITY_RATE, previousOutstanding: 0, amount, discount: 0, lateFee: 0, totalPayable, receivedAmount: 0, outstandingAmount: totalPayable, readingDate: dates.issuedDate, meterReaderName: null, meterReadingPhotoUrl: null, issuedDate: dates.issuedDate, dueDate: dates.dueDate, receivedDate: null, paymentMethod: null, remarks: "Created by meter reading import", status: getBillStatus(totalPayable, 0, dates.dueDate) }); created++; }
      }
      return { updated, created, skipped: preview.notFound.length + preview.invalid.length, notFound: preview.notFound.length, invalid: preview.invalid.length, duplicates: preview.duplicateCount, totalRecords: preview.totalRecords, importedAt: new Date().toISOString(), preview };
    });
  }),
});
