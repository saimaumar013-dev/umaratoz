import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";
import { customers, monthlyBills, wapdaRecords } from "../drizzle/schema";
import { getDb } from "./db";

const unique = Date.now() % 1_000_000;
const serialNumber = 700_000 + (unique % 200_000);
const year = 8000 + (unique % 1900);
let customerId = 0;
let autoAssignedCustomerId = 0;

const ctx = {
  user: {
    id: 999_999,
    openId: "integration-test-admin",
    name: "Integration Test Admin",
    email: "integration@test.invalid",
    loginMethod: "test",
    role: "admin",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  },
  req: { protocol: "https", headers: {} },
  res: { clearCookie: () => undefined },
} as unknown as TrpcContext;

const caller = appRouter.createCaller(ctx);

async function cleanup() {
  const db = await getDb();
  if (!db) return;
  if (customerId) {
    await db.delete(monthlyBills).where(eq(monthlyBills.customerId, customerId));
    await db.delete(customers).where(eq(customers.id, customerId));
  }
  if (autoAssignedCustomerId) await db.delete(customers).where(eq(customers.id, autoAssignedCustomerId));
  await db.delete(wapdaRecords).where(and(eq(wapdaRecords.year, year), eq(wapdaRecords.month, 1)));
}

afterAll(cleanup);

describe.sequential("production billing workflow", () => {
  it("uploads a real persistent image through protected storage", async () => {
    const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
    const uploaded = await caller.files.uploadImage({ category: "customer", fileName: "workflow-pixel.png", mimeType: "image/png", base64: onePixelPng });
    expect(uploaded.key).toContain("atoz/");
    expect(uploaded.url).toMatch(/^\/manus-storage\//);
  });

  it("creates and edits a customer", async () => {
    const created = await caller.customers.save({
      name: `Workflow Customer ${unique}`,
      serialNumber,
      mobileNumber: "03001234567",
      whatsappNumber: "923001234567",
      address: "Long test address for responsive bill verification",
      meterNumber: `M-${unique}`,
      meterType: "Digital",
      meterLocation: "Test Area",
      unitPrice: 45,
    });
    customerId = created.id;
    await caller.customers.save({
      id: customerId,
      name: `Workflow Customer Updated ${unique}`,
      serialNumber,
      mobileNumber: "03001234567",
      whatsappNumber: "923001234567",
      address: "Long test address for responsive bill verification",
      meterNumber: `M-${unique}`,
      meterType: "Digital",
      meterLocation: "Test Area",
      unitPrice: 45,
    });
    const detail = await caller.customers.get({ id: customerId });
    expect(detail.customer.name).toContain("Updated");
  });

  it("assigns the first available sNo when a new customer omits it", async () => {
    const created = await caller.customers.save({ name: `Auto Serial Customer ${unique}`, unitPrice: 65 });
    autoAssignedCustomerId = created.id;
    expect(created.sNo).toBeGreaterThan(0);
    const [row] = await (await getDb())!.select().from(customers).where(eq(customers.id, created.id));
    expect(row?.sNo).toBe(created.sNo);
  });

  it("creates January, auto-fills February, and updates duplicates", async () => {
    const january = await caller.bills.save({
      customerId, month: 1, year, previousReading: 1000, currentReading: 1100,
      unitPrice: 45, previousOutstanding: 0, discount: 0, lateFee: 0,
      issuedDate: `${year}-01-01`, dueDate: "2020-01-10", receivedAmount: 0,
    });
    expect(january.updatedExisting).toBe(false);
    const febDefaults = await caller.bills.defaults({ customerId, month: 2, year });
    expect(febDefaults.previousReading).toBe(1100);
    expect(febDefaults.previousOutstanding).toBe(4500);

    const february = await caller.bills.save({
      customerId, month: 2, year, previousReading: febDefaults.previousReading,
      currentReading: 1200, unitPrice: 45, previousOutstanding: febDefaults.previousOutstanding,
      discount: 0, lateFee: 0, issuedDate: `${year}-02-01`, dueDate: `${year}-02-10`, receivedAmount: 1000, paymentMethod: "Cash",
    });
    expect(february.updatedExisting).toBe(false);

    const duplicateUpdate = await caller.bills.save({
      customerId, month: 2, year, previousReading: 1100, currentReading: 1200,
      unitPrice: 45, previousOutstanding: 4500, discount: 100, lateFee: 50,
      issuedDate: `${year}-02-01`, dueDate: `${year}-02-10`, receivedAmount: 1000, paymentMethod: "Cash",
    });
    expect(duplicateUpdate.updatedExisting).toBe(true);
    const bills = await caller.bills.list({ customerId });
    expect(bills).toHaveLength(2);
    expect(bills.find(b => b.month === 1)?.status).toBe("Overdue");
  });

  it("persists edited bill fields when the bill is reopened", async () => {
    const bills = await caller.bills.list({ customerId });
    const feb = bills.find(b => b.month === 2)!;
    await caller.bills.save({
      id: feb.id, customerId, month: 2, year, previousReading: 1100, currentReading: 1333,
      unitPrice: 52, previousOutstanding: 4500, discount: 125, lateFee: 75,
      issuedDate: `${year}-02-02`, dueDate: `${year}-02-12`, receivedAmount: 1200,
      receivedDate: `${year}-02-06`, paymentMethod: "JazzCash", meterReaderName: "Updated Reader",
      remarks: "Updated bill details",
    });
    const reopened = await caller.bills.get({ id: feb.id });
    expect(reopened.bill.currentReading).toBe(1333);
    expect(reopened.bill.unitPrice).toBe(52);
    expect(reopened.bill.discount).toBe(125);
    expect(reopened.bill.lateFee).toBe(75);
    expect(reopened.bill.meterReaderName).toBe("Updated Reader");
    expect(reopened.bill.remarks).toBe("Updated bill details");
    expect(reopened.bill.paymentMethod).toBe("JazzCash");
  });

  it("handles partial and full payment and synchronizes latest outstanding", async () => {
    const bills = await caller.bills.list({ customerId });
    const feb = bills.find(b => b.month === 2)!;
    expect(feb.status).toBe("Unpaid");
    expect(feb.outstandingAmount).toBeGreaterThan(0);

    await caller.bills.save({
      id: feb.id, customerId, month: 2, year, previousReading: 1100, currentReading: 1200,
      unitPrice: 45, previousOutstanding: 4500, discount: 100, lateFee: 50,
      issuedDate: `${year}-02-01`, dueDate: `${year}-02-10`, receivedAmount: 999_999,
      receivedDate: `${year}-02-05`, paymentMethod: "Bank",
    });
    const paid = await caller.bills.get({ id: feb.id });
    expect(paid.bill.status).toBe("Paid");
    expect(paid.bill.outstandingAmount).toBe(0);
    expect(paid.bill.receivedAmount).toBe(paid.bill.totalPayable);
    const detail = await caller.customers.get({ id: customerId });
    expect(detail.summary.outstanding).toBe(0);
  });

  it("saves WAPDA once, calculates profit from billed totals, and produces reports", async () => {
    const first = await caller.overview.wapdaSave({ month: 1, year, previousReading: 5000, currentReading: 5100, ratePerUnit: 45 });
    expect(first.unitsConsumed).toBe(100);
    expect(first.totalBill).toBe(4500);
    await caller.overview.wapdaSave({ month: 1, year, previousReading: 5000, currentReading: 5100, ratePerUnit: 46 });
    const records = await caller.overview.wapdaList();
    expect(records.filter(r => r.year === year && r.month === 1)).toHaveLength(1);

    const dashboard = await caller.overview.dashboard({ month: 1, year });
    expect(dashboard.totals.profit).toBe(dashboard.totals.billed - dashboard.totals.wapdaExpense);
    const report = await caller.overview.report({ startDate: `${year}-01-01`, endDate: `${year}-02-28` });
    expect(report.bills).toHaveLength(2);
    expect(report.areaProfit[0]?.area).toBe("Test Area");
  });

  it("closes and reactivates a customer without deleting billing history", async () => {
    const beforeClose = await caller.overview.dashboard({ month: 2, year });
    const closed = await caller.customers.close({ id: customerId, reason: "Customer moved away." });
    expect(closed.status).toBe("closed");
    expect(closed.finalReading).toBeGreaterThan(0);
    const closedList = await caller.customers.list({ status: "closed" });
    expect(closedList.some(customer => customer.id === customerId)).toBe(true);
    const closedDetail = await caller.customers.get({ id: customerId });
    expect(closedDetail.customer.lifecycleStatus).toBe("closed");
    expect(closedDetail.customer.closeReason).toBe("Customer moved away.");
    expect(closedDetail.bills.length).toBeGreaterThan(0);
    const dashboardWhileClosed = await caller.overview.dashboard({ month: 2, year });
    expect(dashboardWhileClosed.totals.customers).toBeLessThan(beforeClose.totals.customers);
    expect(dashboardWhileClosed.totals.bills).toBeLessThan(beforeClose.totals.bills);
    expect(dashboardWhileClosed.bills.some(bill => bill.customerId === customerId)).toBe(false);
    await caller.customers.reactivate({ id: customerId });
    const activeList = await caller.customers.list({ status: "active" });
    expect(activeList.some(customer => customer.id === customerId)).toBe(true);
    const restored = await caller.customers.get({ id: customerId });
    expect(restored.customer.lifecycleStatus).toBe("active");
    expect(restored.bills.length).toBeGreaterThan(0);
  });

  it("recalculates carry-forward outstanding after bill deletion and removes customer safely", async () => {
    const bills = await caller.bills.list({ customerId });
    const feb = bills.find(b => b.month === 2)!;
    const jan = bills.find(b => b.month === 1)!;
    await caller.bills.delete({ id: feb.id });
    let detail = await caller.customers.get({ id: customerId });
    expect(detail.summary.outstanding).toBe(4500);
    await caller.bills.delete({ id: jan.id });
    detail = await caller.customers.get({ id: customerId });
    expect(detail.summary.outstanding).toBe(0);
    await caller.customers.delete({ id: customerId });
    customerId = 0;
    const search = await caller.customers.list({ search: `Workflow Customer Updated ${unique}` });
    expect(search).toHaveLength(0);
  });

});
