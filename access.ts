import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { userPermissions } from "../drizzle/schema";
import { getDb } from "./db";

export type PermissionKey =
  | "canViewCustomers"
  | "canManageCustomers"
  | "canViewBills"
  | "canManageBills"
  | "canViewReports"
  | "canManageWapda";

export async function requireAccess(
  user: { id: number; role: "user" | "admin"; isActive?: boolean },
  permission?: PermissionKey,
) {
  if (user.isActive === false) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Your account has been disabled by an administrator." });
  }
  if (user.role === "admin" || !permission) return;
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database is unavailable." });
  const [row] = await db.select().from(userPermissions).where(eq(userPermissions.userId, user.id)).limit(1);
  if (!row?.[permission]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to perform this action." });
  }
}

export function requireAdmin(user: { role: "user" | "admin"; isActive?: boolean }) {
  if (user.isActive === false || user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Administrator access is required." });
  }
}
