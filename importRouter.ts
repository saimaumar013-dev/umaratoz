import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { customers, monthlyBills, wapdaRecords } from "../../drizzle/schema";
import { DEFAULT_ELECTRICITY_RATE, getBillStatus, getCurrentCharges, getOutstanding, getTotalPayable, getUnits, invoiceNumber } from "../../shared/billing";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAdmin } from "../access";
import { getDb } from "../db";

const MAX_ROWS_PER_TABLE = 10_000;
function parseStringifiedJson(value: unknown) {
  let parsed = value;
  for (let depth = 0; depth < 3 && typeof parsed === "string"; depth++) {
    const text = parsed.trim();
    if (!text) return parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return parsed;
    }
  }
  return parsed;
}

const rawRow = z.preprocess(
  parseStringifiedJson,
  z.record(z.string(), z.unknown()),
);
const rawRows = z.preprocess(
  parseStringifiedJson,
  z.array(rawRow).max(MAX_ROWS_PER_TABLE),
);
const rawImportObjectSchema = z.object({
  customers: rawRows.optional(),
  billing_history: rawRows.optional(),
  billingHistory: rawRows.optional(),
  monthly_bills: rawRows.optional(),
  monthlyBills: rawRows.optional(),
  wapda_records: rawRows.optional(),
  wapdaRecords: rawRows.optional(),
}).passthrough().superRefine((value, ctx) => {
  const count = (value.customers?.length ?? 0)
    + (value.billing_history?.length ?? 0)
    + (value.billingHistory?.length ?? 0)
    + (value.monthly_bills?.length ?? 0)
    + (value.monthlyBills?.length ?? 0)
    + (value.wapda_records?.length ?? 0)
    + (value.wapdaRecords?.length ?? 0);
  if (count === 0) ctx.addIssue({ code: "custom", message: "The JSON file must contain customers, billing_history, or wapda_records data." });
});
const rawImportSchema = z.preprocess(
  value => {
    const parsed = parseStringifiedJson(value);
    return Array.isArray(parsed) ? { customers: parsed } : parsed;
  },
  rawImportObjectSchema,
);

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const safeNumber = (value: unknown, fallback = 0) => {
  if (value === null || value === undefined || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : fallback;
};
const monthNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12) return value;
  const text = String(value ?? "").trim();
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const match = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.exec(text);
  if (match) return ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? 0 : date.getMonth() + 1;
};
const dateValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};
const customerSchema = z.object({
  sourceId: z.union([z.string(), z.number()]).optional(),
  name: z.string().trim().min(1).max(200),
  sNo: z.coerce.number().int().positive(),
  photoUrl: nullableText(5000),
  email: z.string().trim().email().or(z.literal("")).nullable().optional(),
  mobileNumber: nullableText(40),
  whatsappNumber: nullableText(40),
  cnic: nullableText(40),
  address: nullableText(2000),
  connectionDate: nullableText(10),
  installationDate: nullableText(10),
  unitPrice: z.coerce.number().nonnegative().default(DEFAULT_ELECTRICITY_RATE),
  meterNumber: nullableText(100),
  meterType: nullableText(100),
  meterLocation: nullableText(200),
  latestMeterPhotoUrl: nullableText(5000),
});

const billSchema = z.object({
  customerSourceId: z.union([z.string(), z.number()]).optional(),
  customerSerialNumber: z.coerce.number().int().positive().optional(),
  customerName: z.string().trim().min(1).max(200).optional(),
  invoiceNumber: z.string().trim().min(1).max(40).optional(),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(9999),
  previousReading: z.coerce.number().nonnegative().default(0),
  currentReading: z.coerce.number().nonnegative(),
  unitPrice: z.coerce.number().nonnegative().optional(),
  discount: z.coerce.number().nonnegative().default(0),
  lateFee: z.coerce.number().nonnegative().default(0),
  receivedAmount: z.coerce.number().nonnegative().default(0),
  readingDate: nullableText(10),
  meterReaderName: nullableText(200),
  meterReadingPhotoUrl: nullableText(5000),
  issuedDate: nullableText(10),
  dueDate: nullableText(10),
  receivedDate: nullableText(10),
  paymentMethod: z.enum(["Cash", "JazzCash", "Easypaisa", "Bank"]).nullable().optional(),
  remarks: nullableText(3000),
  unitsConsumed: z.coerce.number().nonnegative().optional(),
  amount: z.coerce.number().nonnegative().optional(),
  previousOutstanding: z.coerce.number().nonnegative().optional(),
  totalPayable: z.coerce.number().nonnegative().optional(),
  outstandingAmount: z.coerce.number().nonnegative().optional(),
  status: z.enum(["Paid", "Unpaid", "Overdue"]).optional(),
}).superRefine((value, ctx) => {
  if (value.currentReading < value.previousReading) ctx.addIssue({ code: "custom", path: ["currentReading"], message: "Current reading cannot be lower than previous reading." });
  if (value.customerSourceId === undefined && value.customerSerialNumber === undefined && !value.customerName) {
    ctx.addIssue({ code: "custom", path: ["customer"], message: "Each billing_history row needs customerId, customerSerialNumber, or customerName." });
  }
});

const wapdaSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(9999),
  previousReading: z.coerce.number().nonnegative().default(0),
  currentReading: z.coerce.number().nonnegative(),
  ratePerUnit: z.coerce.number().nonnegative().default(DEFAULT_ELECTRICITY_RATE),
}).superRefine((value, ctx) => {
  if (value.currentReading < value.previousReading) ctx.addIssue({ code: "custom", path: ["currentReading"], message: "Current reading cannot be lower than previous reading." });
});

type RawRow = Record<string, unknown>;
const first = (row: RawRow, ...keys: string[]) => keys.map(key => row[key]).find(value => value !== undefined);
const nullable = (value: unknown) => value === undefined || value === null || value === "" ? null : String(value);
const dateFor = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function paymentMethod(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  const methods: Record<string, "Cash" | "JazzCash" | "Easypaisa" | "Bank"> = {
    cash: "Cash", jazzcash: "JazzCash", "jazz cash": "JazzCash", easypaisa: "Easypaisa", "easy paisa": "Easypaisa", bank: "Bank",
  };
  return methods[normalized] ?? value;
}

function normalizeCustomer(row: RawRow) {
  return customerSchema.parse({
    sourceId: first(row, "id", "customerId", "customer_id", "account_id", "accountId"),
    name: first(row, "name", "customerName", "customer_name"),
    sNo: first(row, "sNo", "sno", "s_no", "serialNumber", "serial_number", "serial", "customerSerialNumber", "customer_serial_number"),
    photoUrl: nullable(first(row, "photoUrl", "photo_url", "photo")),
    email: nullable(first(row, "email")),
    mobileNumber: nullable(first(row, "mobileNumber", "mobile_number", "phone")),
    whatsappNumber: nullable(first(row, "whatsappNumber", "whatsapp_number", "whatsapp")),
    cnic: nullable(first(row, "cnic")),
    address: nullable(first(row, "address")),
    connectionDate: nullable(first(row, "connectionDate", "connection_date")),
    installationDate: nullable(first(row, "installationDate", "installation_date")),
    unitPrice: first(row, "unitPrice", "unit_price", "ratePerUnit", "rate_per_unit") ?? DEFAULT_ELECTRICITY_RATE,
    meterNumber: nullable(first(row, "meterNumber", "meter_number")),
    meterType: nullable(first(row, "meterType", "meter_type")),
    meterLocation: nullable(first(row, "meterLocation", "meter_location", "area")),
    latestMeterPhotoUrl: nullable(first(row, "latestMeterPhotoUrl", "latest_meter_photo_url", "latest_meter_photo")),
  });
}

function normalizeBill(row: RawRow) {
  const month = monthNumber(first(row, "month", "billingMonth", "billing_month", "issuedDate", "issued_date"));
  const year = safeNumber(first(row, "year", "billingYear", "billing_year"), new Date().getFullYear());
  const parsed = billSchema.parse({
    customerSourceId: first(row, "customerId", "customer_id", "customerIdSource", "customer_source_id", "account_id", "accountId"),
    customerSerialNumber: first(row, "customerSNo", "customer_sNo", "sNo", "sno", "s_no", "customerSerialNumber", "customer_serial_number", "serialNumber", "serial_number"),
    customerName: first(row, "customerName", "customer_name"),
    invoiceNumber: first(row, "invoiceNumber", "invoice_number"),
    month,
    year,
    previousReading: safeNumber(first(row, "previousReading", "previous_reading")),
    currentReading: safeNumber(first(row, "currentReading", "current_reading")),
    unitPrice: first(row, "unitPrice", "unit_price", "ratePerUnit", "rate_per_unit") === undefined ? undefined : safeNumber(first(row, "unitPrice", "unit_price", "ratePerUnit", "rate_per_unit"), DEFAULT_ELECTRICITY_RATE),
    discount: safeNumber(first(row, "discount")),
    lateFee: safeNumber(first(row, "lateFee", "late_fee")),
    receivedAmount: safeNumber(first(row, "receivedAmount", "received_amount", "paidAmount", "paid_amount")),
    readingDate: dateValue(first(row, "readingDate", "reading_date")),
    meterReaderName: nullable(first(row, "meterReaderName", "meter_reader_name")),
    meterReadingPhotoUrl: nullable(first(row, "meterReadingPhotoUrl", "meter_reading_photo_url", "meter_reading_photo")),
    issuedDate: dateValue(first(row, "issuedDate", "issued_date", "billDate", "bill_date")) ?? dateFor(year, month || 1, 1),
    dueDate: dateValue(first(row, "dueDate", "due_date")) ?? dateFor(year, month || 1, 10),
    receivedDate: dateValue(first(row, "receivedDate", "received_date", "paidDate", "paid_date")),
    paymentMethod: paymentMethod(first(row, "paymentMethod", "payment_method")),
    remarks: nullable(first(row, "remarks", "notes")),
    unitsConsumed: safeNumber(first(row, "unitsConsumed", "units_consumed")),
    amount: safeNumber(first(row, "amount", "totalAmount", "total_amount")),
    previousOutstanding: safeNumber(first(row, "previousOutstanding", "previous_outstanding")),
    totalPayable: safeNumber(first(row, "totalPayable", "total_payable")),
    outstandingAmount: safeNumber(first(row, "outstandingAmount", "outstanding_amount")),
    status: first(row, "status"),
  });
  return { ...parsed, preserveHistoricalFinancials: ["unitsConsumed", "amount", "previousOutstanding", "totalPayable", "outstandingAmount", "status"].some(key => first(row, key) !== undefined && first(row, key) !== null && first(row, key) !== "") };
}

function normalizeWapda(row: RawRow) {
  return wapdaSchema.parse({
    month: monthNumber(first(row, "month", "billingMonth", "billing_month")),
    year: safeNumber(first(row, "year", "billingYear", "billing_year"), new Date().getFullYear()),
    previousReading: safeNumber(first(row, "previousReading", "previous_reading")),
    currentReading: safeNumber(first(row, "currentReading", "current_reading")),
    ratePerUnit: safeNumber(first(row, "ratePerUnit", "rate_per_unit", "unitPrice", "unit_price"), DEFAULT_ELECTRICITY_RATE),
  });
}

function formatValidationError(error: z.ZodError) {
  return error.issues.slice(0, 5).map(issue => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; ");
}

async function rebuildLedger(tx: any, customerId: number) {
  const rows = await tx.select().from(monthlyBills).where(eq(monthlyBills.customerId, customerId)).orderBy(asc(monthlyBills.year), asc(monthlyBills.month));
  let previousOutstanding = 0;
  for (const row of rows) {
    const unitsConsumed = getUnits(row.previousReading, row.currentReading);
    const amount = getCurrentCharges(unitsConsumed, row.unitPrice);
    const totalPayable = getTotalPayable(previousOutstanding, amount, row.lateFee, row.discount);
    const receivedAmount = Math.min(row.receivedAmount, totalPayable);
    const outstandingAmount = getOutstanding(totalPayable, receivedAmount);
    const status = getBillStatus(totalPayable, receivedAmount, row.dueDate);
    await tx.update(monthlyBills).set({ previousOutstanding, unitsConsumed, amount, totalPayable, receivedAmount, outstandingAmount, status }).where(eq(monthlyBills.id, row.id));
    previousOutstanding = outstandingAmount;
  }
}

export const importRouter = router({
  run: protectedProcedure.input(z.object({ payload: z.unknown() })).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.user);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

    let raw: z.infer<typeof rawImportSchema>;
    let normalizedCustomers: ReturnType<typeof normalizeCustomer>[];
    let normalizedBills: ReturnType<typeof normalizeBill>[];
    let normalizedWapda: ReturnType<typeof normalizeWapda>[];
    try {
      raw = rawImportSchema.parse(input.payload);
      normalizedCustomers = (raw.customers ?? []).map(normalizeCustomer);
      const nestedBills = (raw.customers ?? []).flatMap(customer => {
        const bills = first(customer, "billing_history", "billingHistory");
        return Array.isArray(bills) ? bills.map(bill => ({ ...(bill as RawRow), customerId: first(customer, "id", "customerId", "customer_id"), account_id: first(customer, "account_id", "accountId"), customerSerialNumber: first(customer, "sNo", "sno", "s_no", "serialNumber", "serial_number") })) : [];
      });
      normalizedBills = [raw.billing_history, raw.billingHistory, raw.monthly_bills, raw.monthlyBills].flatMap(rows => rows ?? []).concat(nestedBills).map(normalizeBill);
      normalizedWapda = [raw.wapda_records, raw.wapdaRecords].flatMap(rows => rows ?? []).map(normalizeWapda);
    } catch (error) {
      if (error instanceof z.ZodError) throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid import file: ${formatValidationError(error)}` });
      throw error;
    }

    try {
      return await db.transaction(async tx => {
        const counts = {
          customers: { inserted: 0, updated: 0 },
          billingHistory: { inserted: 0, updated: 0 },
          wapdaRecords: { inserted: 0, updated: 0 },
        };
        const persistedCustomers = await tx.select().from(customers);
        const byId = new Map(persistedCustomers.map(customer => [String(customer.id), customer]));
        const bySerial = new Map(persistedCustomers.map(customer => [customer.sNo, customer]));
        const nameBuckets = new Map<string, typeof persistedCustomers>();
        for (const customer of persistedCustomers) {
          const key = customer.name.trim().toLowerCase();
          nameBuckets.set(key, [...(nameBuckets.get(key) ?? []), customer]);
        }
        const sourceIdMap = new Map<string, number>();

        for (let customerIndex = 0; customerIndex < normalizedCustomers.length; customerIndex++) {
          const customer = normalizedCustomers[customerIndex];
          const sourceRow = raw.customers?.[customerIndex] ?? {};
          const values = {
            name: customer.name, sNo: customer.sNo, serialNumber: customer.sNo, photoUrl: customer.photoUrl, email: customer.email || null,
            mobileNumber: customer.mobileNumber, whatsappNumber: customer.whatsappNumber, cnic: customer.cnic, address: customer.address,
            connectionDate: customer.connectionDate, installationDate: customer.installationDate, unitPrice: customer.unitPrice,
            meterNumber: customer.meterNumber, meterType: customer.meterType, meterLocation: customer.meterLocation,
            latestMeterPhotoUrl: customer.latestMeterPhotoUrl,
          };
          const existing = bySerial.get(customer.sNo);
          let persistedId: number;
          if (existing) {
            await tx.update(customers).set(values).where(eq(customers.id, existing.id));
            await tx.update(monthlyBills).set({ customerName: customer.name }).where(eq(monthlyBills.customerId, existing.id));
            persistedId = existing.id;
            counts.customers.updated++;
          } else {
            const [result] = await tx.insert(customers).values(values);
            persistedId = Number(result.insertId);
            counts.customers.inserted++;
          }
          const persisted = { ...existing, ...values, id: persistedId } as typeof persistedCustomers[number];
          byId.set(String(persistedId), persisted);
          bySerial.set(customer.sNo, persisted);
          const nameKey = customer.name.trim().toLowerCase();
          nameBuckets.set(nameKey, [persisted]);
          if (customer.sourceId !== undefined) sourceIdMap.set(String(customer.sourceId), persistedId);
          for (const alternateId of [sourceRow.account_id, sourceRow.accountId, sourceRow.id, sourceRow.customer_id]) {
            if (alternateId !== undefined && alternateId !== null && alternateId !== "") sourceIdMap.set(String(alternateId), persistedId);
          }
        }

        const touchedCustomers = new Set<number>();
        const customersNeedingRebuild = new Set<number>();
        normalizedBills.sort((a, b) => a.year - b.year || a.month - b.month);
        for (const bill of normalizedBills) {
          let customer = bill.customerSerialNumber !== undefined ? bySerial.get(bill.customerSerialNumber) : undefined;
          if (!customer && bill.customerSourceId !== undefined) {
            const mappedId = sourceIdMap.get(String(bill.customerSourceId));
            customer = mappedId ? byId.get(String(mappedId)) : byId.get(String(bill.customerSourceId));
          }
          if (!customer && bill.customerName) {
            const matches = nameBuckets.get(bill.customerName.trim().toLowerCase()) ?? [];
            if (matches.length === 1) customer = matches[0];
          }
          if (!customer) throw new TRPCError({ code: "BAD_REQUEST", message: `Could not match billing_history row for ${bill.customerName || bill.customerSerialNumber || bill.customerSourceId}. Add the customer or its serial number to the JSON file.` });

          const [existing] = await tx.select().from(monthlyBills).where(and(eq(monthlyBills.customerId, customer.id), eq(monthlyBills.year, bill.year), eq(monthlyBills.month, bill.month))).limit(1);
          const unitPrice = bill.unitPrice ?? customer.unitPrice;
          const unitsConsumed = getUnits(bill.previousReading, bill.currentReading);
          const amount = getCurrentCharges(unitsConsumed, unitPrice);
          const totalPayable = getTotalPayable(0, amount, bill.lateFee, bill.discount);
          const receivedAmount = bill.receivedAmount;
          const values = {
            customerId: customer.id, customerName: customer.name,
            invoiceNumber: bill.invoiceNumber ?? existing?.invoiceNumber ?? invoiceNumber(bill.year, bill.month, customer.serialNumber),
            month: bill.month, year: bill.year, previousReading: bill.previousReading, currentReading: bill.currentReading,
            unitsConsumed: bill.preserveHistoricalFinancials && bill.unitsConsumed !== undefined ? bill.unitsConsumed : unitsConsumed,
            unitPrice, previousOutstanding: bill.preserveHistoricalFinancials && bill.previousOutstanding !== undefined ? bill.previousOutstanding : 0,
            amount: bill.preserveHistoricalFinancials && bill.amount !== undefined ? bill.amount : amount, discount: bill.discount, lateFee: bill.lateFee,
            totalPayable: bill.preserveHistoricalFinancials && bill.totalPayable !== undefined ? bill.totalPayable : totalPayable,
            receivedAmount, outstandingAmount: bill.preserveHistoricalFinancials && bill.outstandingAmount !== undefined ? bill.outstandingAmount : getOutstanding(totalPayable, receivedAmount),
            readingDate: bill.readingDate, meterReaderName: bill.meterReaderName, meterReadingPhotoUrl: bill.meterReadingPhotoUrl,
            issuedDate: bill.issuedDate!, dueDate: bill.dueDate!,
            receivedDate: receivedAmount > 0 ? (bill.receivedDate ?? bill.issuedDate) : null,
            paymentMethod: receivedAmount > 0 ? (bill.paymentMethod ?? "Cash" as const) : null,
            remarks: bill.remarks,
            status: bill.preserveHistoricalFinancials && bill.status ? bill.status : getBillStatus(totalPayable, receivedAmount, bill.dueDate),
          };
          if (existing) {
            await tx.update(monthlyBills).set(values).where(eq(monthlyBills.id, existing.id));
            counts.billingHistory.updated++;
          } else {
            await tx.insert(monthlyBills).values(values);
            counts.billingHistory.inserted++;
          }
          touchedCustomers.add(customer.id);
          if (!bill.preserveHistoricalFinancials) customersNeedingRebuild.add(customer.id);
        }

        for (const customerId of Array.from(customersNeedingRebuild)) await rebuildLedger(tx, customerId);

        for (const row of normalizedWapda) {
          const unitsConsumed = getUnits(row.previousReading, row.currentReading);
          const values = { ...row, unitsConsumed, totalBill: Math.round(unitsConsumed * row.ratePerUnit) };
          const [existing] = await tx.select({ id: wapdaRecords.id }).from(wapdaRecords).where(and(eq(wapdaRecords.year, row.year), eq(wapdaRecords.month, row.month))).limit(1);
          if (existing) {
            await tx.update(wapdaRecords).set(values).where(eq(wapdaRecords.id, existing.id));
            counts.wapdaRecords.updated++;
          } else {
            await tx.insert(wapdaRecords).values(values);
            counts.wapdaRecords.inserted++;
          }
        }

        return { success: true as const, ...counts, totalRows: normalizedCustomers.length + normalizedBills.length + normalizedWapda.length };
      });
    } catch (error: any) {
      if (error instanceof TRPCError) throw error;
      if (error?.code === "ER_DUP_ENTRY" || String(error?.message).includes("Duplicate")) {
        throw new TRPCError({ code: "CONFLICT", message: "Import rolled back because a customer serial number or invoice number conflicts with existing data." });
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Import failed and no partial data was saved.", cause: error });
    }
  }),
});
