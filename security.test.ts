import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

function normalUserContext() {
  return {
    user: {
      id: 987_654,
      openId: "unprivileged-test-user",
      name: "Unprivileged User",
      email: "user@test.invalid",
      loginMethod: "test",
      role: "user",
      isActive: true,
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

describe("server-side authorization", () => {
  it("denies company setting mutations to non-admin users", async () => {
    const caller = appRouter.createCaller(normalUserContext());
    await expect(caller.admin.companySave({ companyName: "Unauthorized Change" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies customer and bill data access without explicit permissions", async () => {
    const caller = appRouter.createCaller(normalUserContext());
    await expect(caller.customers.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.bills.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.overview.dashboard({ month: 1, year: 2026 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies protected storage uploads before touching storage", async () => {
    const caller = appRouter.createCaller(normalUserContext());
    await expect(caller.files.uploadImage({ category: "logo", fileName: "test.png", mimeType: "image/png", base64: "aA==" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies bulk JSON imports to non-admin users", async () => {
    const caller = appRouter.createCaller(normalUserContext());
    await expect(caller.bulkImport.run({ payload: { customers: [{ name: "Blocked", serialNumber: 999999 }] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
