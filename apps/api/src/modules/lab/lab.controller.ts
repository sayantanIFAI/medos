import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { LabService, cancelLabBookingSchema, createLabBookingSchema, listLabBookingsSchema, listLabTestsSchema, upsertLabTestSchema } from "./lab.service";

@Controller("lab")
export class LabController {
  constructor(private readonly lab: LabService) {}

  @RequirePermissions("LAB_READ")
  @Get("tests")
  async tests(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listLabTestsSchema, query);
    const { items, total } = await this.lab.listTests(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("ADMIN_MASTERS")
  @Put("tests")
  async upsertTest(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.lab.upsertTest(ctx, parse(upsertLabTestSchema, body));
    res.status(r.created ? 201 : 200);
    return { data: r };
  }

  @RequirePermissions("LAB_READ")
  @Get("bookings")
  async bookings(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listLabBookingsSchema, query);
    const { items, total } = await this.lab.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("LAB_BOOK", "PATIENT_READ")
  @Post("bookings")
  async book(@Ctx() ctx: RequestContext, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { booking, replayed } = await this.lab.create(ctx, parse(createLabBookingSchema, body), { source: "MANUAL", idempotencyKey: parseIdempotencyKey(key) });
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: booking };
  }

  @RequirePermissions("LAB_READ")
  @Get("bookings/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") bookingId: string) {
    return { data: await this.lab.get(ctx, id(bookingId)) };
  }

  @RequirePermissions("LAB_BOOK")
  @Post("bookings/:id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") bookingId: string, @Body() body: unknown) {
    return { data: await this.lab.cancel(ctx, id(bookingId), parse(cancelLabBookingSchema, body).reason) };
  }
}
