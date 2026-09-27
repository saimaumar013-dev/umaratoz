import { eq } from "drizzle-orm";
import { monthlyBills } from "../drizzle/schema";
import { getBillStatus } from "../shared/billing";

export async function syncBillStatuses(db: any, rows: any[]) {
  const changes: Promise<unknown>[] = [];
  const synchronized = rows.map(row => {
    const status = getBillStatus(row.totalPayable, row.receivedAmount, row.dueDate);
    if (status !== row.status) {
      changes.push(db.update(monthlyBills).set({ status }).where(eq(monthlyBills.id, row.id)));
      return { ...row, status };
    }
    return row;
  });
  if (changes.length) await Promise.all(changes);
  return synchronized;
}
