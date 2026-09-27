import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { adminRouter } from "./routers/adminRouter";
import { billRouter } from "./routers/billRouter";
import { customerRouter } from "./routers/customerRouter";
import { fileRouter } from "./routers/fileRouter";
import { importRouter } from "./routers/importRouter";
import { overviewRouter } from "./routers/overviewRouter";
import { meterReadingRouter } from "./routers/meterReadingRouter";
import { dailyWapdaRouter } from "./routers/dailyWapdaRouter";
import { customerDailyWapdaRouter } from "./routers/customerDailyWapdaRouter";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  customers: customerRouter,
  bills: billRouter,
  overview: overviewRouter,
  admin: adminRouter,
  files: fileRouter,
  bulkImport: importRouter,
  meterReadings: meterReadingRouter,
  dailyWapda: dailyWapdaRouter,
  customerDailyWapda: customerDailyWapdaRouter,
});

export type AppRouter = typeof appRouter;
