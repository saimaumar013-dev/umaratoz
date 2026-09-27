import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireAccess, requireAdmin } from "../access";
import { storagePut } from "../storage";

export const fileRouter = router({
  uploadImage: protectedProcedure.input(z.object({
    category: z.enum(["customer", "meter", "logo", "jazzcash", "easypaisa", "bank"]),
    fileName: z.string().min(1).max(180),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    base64: z.string().min(1),
  })).mutation(async ({ ctx, input }) => {
    if (["logo", "jazzcash", "easypaisa", "bank"].includes(input.category)) {
      requireAdmin(ctx.user);
    } else if (input.category === "customer") {
      await requireAccess(ctx.user, "canManageCustomers");
    } else {
      try {
        await requireAccess(ctx.user, "canManageBills");
      } catch {
        await requireAccess(ctx.user, "canManageCustomers");
      }
    }
    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.length > 5 * 1024 * 1024) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Image must be 5 MB or smaller." });
    }
    const extension = input.mimeType === "image/png" ? "png" : input.mimeType === "image/webp" ? "webp" : "jpg";
    const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.[^.]+$/, "");
    return storagePut(`atoz/${ctx.user.id}/${input.category}/${Date.now()}-${safeName}.${extension}`, bytes, input.mimeType);
  }),
});
