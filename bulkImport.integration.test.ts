import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";
import { customers, monthlyBills, wapdaRecords } from "../drizzle/schema";
import { getDb } from "./db";

const unique = Date.now() % 1_000_000;
const serialNumber = 300_000 + (unique % 200_000);
const rollbackSerial = serialNumber + 1;
const arraySerial = serialNumber + 2;
const stringSerial = serialNumber + 3;
const mixedSerial = serialNumber + 4;
const nativeSerial = serialNumber + 5;
const year = 6000 + (unique % 3000);
const nativeYear = year + 1;
let customerId = 0;

const caller = appRouter.createCaller({
  user: {
    id: 999_998,
    openId: "bulk-import-test-admin",
    name: "Bulk Import Test Admin",
    email: "bulk-import@test.invalid",
    loginMethod: "test",
    role: "admin",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  },
  req: { protocol: "https", headers: {} },
  res: { clearCookie: () => undefined },
} as unknown as TrpcContext);

async function cleanup() {
  const db = await getDb();
  if (!db) return;
  const rows = await db.select().from(customers).where(eq(customers.serialNumber, serialNumber));
  for (const row of rows) {
    await db.delete(monthlyBills).where(eq(monthlyBills.customerId, row.id));
    await db.delete(customers).where(eq(customers.id, row.id));
  }
  await db.delete(customers).where(eq(customers.serialNumber, rollbackSerial));
  await db.delete(customers).where(eq(customers.serialNumber, arraySerial));
  await db.delete(customers).where(eq(customers.serialNumber, stringSerial));
  await db.delete(customers).where(eq(customers.serialNumber, mixedSerial));
  const nativeRows = await db.select().from(customers).where(eq(customers.serialNumber, nativeSerial));
  for (const row of nativeRows) {
    await db.delete(monthlyBills).where(eq(monthlyBills.customerId, row.id));
    await db.delete(customers).where(eq(customers.id, row.id));
  }
  await db.delete(wapdaRecords).where(and(eq(wapdaRecords.year, year), eq(wapdaRecords.month, 7)));
  await db.delete(wapdaRecords).where(and(eq(wapdaRecords.year, nativeYear), eq(wapdaRecords.month, 9)));
}

afterAll(cleanup);

describe.sequential("bulk JSON import", () => {
  it("accepts a top-level customer array without an object envelope", async () => {
    const result = await caller.bulkImport.run({ payload: [
      {
        id: "array-customer-1",
        name: `Array Customer ${unique}`,
        serial_number: arraySerial,
        unit_price: 47,
        meter_number: `ARRAY-${unique}`,
      },
    ] });
    expect(result).toMatchObject({
      success: true,
      totalRows: 1,
      customers: { inserted: 1, updated: 0 },
      billingHistory: { inserted: 0, updated: 0 },
      wapdaRecords: { inserted: 0, updated: 0 },
    });
    const db = await getDb();
    const [customer] = await db!.select().from(customers).where(eq(customers.serialNumber, arraySerial)).limit(1);
    expect(customer.name).toContain("Array Customer");
    expect(customer.unitPrice).toBe(47);
  });

  it("accepts a stringified root array with mixed stringified and direct customer entries", async () => {
    const payload = JSON.stringify([
      JSON.stringify({
        id: "string-customer-1",
        name: `Stringified Customer ${unique}`,
        serial_number: stringSerial,
        unit_price: 48,
      }),
      {
        id: "mixed-customer-1",
        name: `Direct Mixed Customer ${unique}`,
        serialNumber: mixedSerial,
        unitPrice: 49,
      },
    ]);
    const result = await caller.bulkImport.run({ payload });
    expect(result).toMatchObject({
      success: true,
      totalRows: 2,
      customers: { inserted: 2, updated: 0 },
    });
    const db = await getDb();
    const [stringCustomer] = await db!.select().from(customers).where(eq(customers.serialNumber, stringSerial)).limit(1);
    const [mixedCustomer] = await db!.select().from(customers).where(eq(customers.serialNumber, mixedSerial)).limit(1);
    expect(stringCustomer.unitPrice).toBe(48);
    expect(mixedCustomer.unitPrice).toBe(49);
  });

  it("imports snake_case data and maps source customer IDs", async () => {
    const result = await caller.bulkImport.run({ payload: {
      customers: [{
        id: "legacy-customer-1",
        name: `Imported Customer ${unique}`,
        serial_number: serialNumber,
        unit_price: 45,
        meter_number: `IMPORT-${unique}`,
        meter_location: "Imported Area",
      }],
      billing_history: [
        {
          customer_id: "legacy-customer-1",
          month: 6,
          year,
          previous_reading: 1000,
          current_reading: 1100,
          unit_price: 45,
          received_amount: 1000,
          issued_date: `${year}-06-01`,
          due_date: `${year}-06-10`,
        },
        {
          customer_id: "legacy-customer-1",
          month: 7,
          year,
          previous_reading: 1100,
          current_reading: 1150,
          unit_price: 45,
          received_amount: 5750,
          issued_date: `${year}-07-01`,
          due_date: `${year}-07-10`,
          payment_method: "bank",
        },
      ],
      wapda_records: [{
        month: 7,
        year,
        previous_reading: 5000,
        current_reading: 5200,
        rate_per_unit: 45,
      }],
    } });

    expect(result).toMatchObject({
      success: true,
      totalRows: 4,
      customers: { inserted: 1, updated: 0 },
      billingHistory: { inserted: 2, updated: 0 },
      wapdaRecords: { inserted: 1, updated: 0 },
    });

    const db = await getDb();
    expect(db).toBeTruthy();
    const [customer] = await db!.select().from(customers).where(eq(customers.serialNumber, serialNumber)).limit(1);
    customerId = customer.id;
    const bills = await db!.select().from(monthlyBills).where(eq(monthlyBills.customerId, customerId));
    expect(bills).toHaveLength(2);
    const june = bills.find(bill => bill.month === 6)!;
    const july = bills.find(bill => bill.month === 7)!;
    expect(june.outstandingAmount).toBe(3500);
    expect(july.previousOutstanding).toBe(3500);
    expect(july.totalPayable).toBe(5750);
    expect(july.receivedAmount).toBe(5750);
    expect(july.status).toBe("Paid");
    const [wapda] = await db!.select().from(wapdaRecords).where(and(eq(wapdaRecords.year, year), eq(wapdaRecords.month, 7))).limit(1);
    expect(wapda.unitsConsumed).toBe(200);
    expect(wapda.totalBill).toBe(9000);
  });

  it("re-imports the same business keys as updates without duplicates", async () => {
    const result = await caller.bulkImport.run({ payload: {
      customers: [{ id: "legacy-customer-1", name: `Imported Customer Updated ${unique}`, serialNumber, unitPrice: 45 }],
      billingHistory: [
        { customerId: "legacy-customer-1", month: 6, year, previousReading: 1000, currentReading: 1100, receivedAmount: 2000 },
        { customerId: "legacy-customer-1", month: 7, year, previousReading: 1100, currentReading: 1150, receivedAmount: 5750, paymentMethod: "Bank" },
      ],
      wapdaRecords: [{ month: 7, year, previousReading: 5000, currentReading: 5200, ratePerUnit: 46 }],
    } });

    expect(result).toMatchObject({
      totalRows: 4,
      customers: { inserted: 0, updated: 1 },
      billingHistory: { inserted: 0, updated: 2 },
      wapdaRecords: { inserted: 0, updated: 1 },
    });
    const db = await getDb();
    const bills = await db!.select().from(monthlyBills).where(eq(monthlyBills.customerId, customerId));
    expect(bills).toHaveLength(2);
    const july = bills.find(bill => bill.month === 7)!;
    expect(july.previousOutstanding).toBe(2500);
    expect(july.totalPayable).toBe(4750);
    expect(july.receivedAmount).toBe(4750);
    expect(july.outstandingAmount).toBe(0);
    const [customer] = await db!.select().from(customers).where(eq(customers.id, customerId));
    expect(customer.name).toContain("Updated");
    const [wapda] = await db!.select().from(wapdaRecords).where(and(eq(wapdaRecords.year, year), eq(wapdaRecords.month, 7))).limit(1);
    expect(wapda.totalBill).toBe(9200);
  });

  it("imports native SolarBill nested history with month names and preserved totals", async () => {
    const result = await caller.bulkImport.run({ payload: {
      export_generated_at: "2026-09-13T19:49:42.198Z",
      app: "SolarBill - ATOZ Solar System",
      totals: { customers: 1, bills: 1, wapda_records: 1 },
      customers: [{
        id: "native-customer-1",
        serial_number: nativeSerial,
        account_id: `NATIVE-${nativeSerial}`,
        name: `Native Export Customer ${unique}`,
        unit_price: 65,
        meter_number: "N-01",
        photo: "https://example.invalid/customer.jpg",
        latest_meter_photo: "https://example.invalid/meter.jpg",
        billing_history: [{
          id: "native-bill-1",
          invoice_number: `NATIVE-${nativeYear}-09-${nativeSerial}`,
          month: "September",
          year: nativeYear,
          previous_reading: 10,
          current_reading: 20,
          units_consumed: 10,
          unit_price: 65,
          previous_outstanding: 700,
          amount: 650,
          discount: 0,
          late_fee: 0,
          total_payable: 1350,
          received_amount: 1350,
          outstanding_amount: 0,
          payment_method: "Cash",
          issued_date: `${nativeYear}-09-03`,
          due_date: `${nativeYear}-09-07`,
          received_date: `${nativeYear}-09-07`,
          status: "Paid",
        }],
      }],
      wapda_records: [{ month: "September", year: nativeYear, previous_reading: 1, current_reading: 11, units_consumed: 10, rate_per_unit: 65, total_bill: 650 }],
    } });
    expect(result).toMatchObject({ success: true, totalRows: 3, customers: { inserted: 1 }, billingHistory: { inserted: 1 }, wapdaRecords: { inserted: 1 } });
    const db = await getDb();
    const [customer] = await db!.select().from(customers).where(eq(customers.serialNumber, nativeSerial)).limit(1);
    const [bill] = await db!.select().from(monthlyBills).where(eq(monthlyBills.customerId, customer.id)).limit(1);
    expect(customer.photoUrl).toBe("https://example.invalid/customer.jpg");
    expect(bill.invoiceNumber).toContain("NATIVE-");
    expect(bill.month).toBe(9);
    expect(bill.totalPayable).toBe(1350);
    expect(bill.status).toBe("Paid");
  });

  it("rolls back every table when any imported relation is invalid", async () => {
    await expect(caller.bulkImport.run({ payload: {
      customers: [{ name: "Must Roll Back", serialNumber: rollbackSerial }],
      billing_history: [{ customerId: "missing-source-id", month: 8, year, currentReading: 10 }],
    } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const db = await getDb();
    const rows = await db!.select().from(customers).where(eq(customers.serialNumber, rollbackSerial));
    expect(rows).toHaveLength(0);
  });
});
