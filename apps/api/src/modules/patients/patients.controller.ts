import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { createPatientSchema, duplicateProbeSchema, PatientsService, searchPatientsSchema, updatePatientSchema } from "./patients.service";

@Controller("patients")
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @RequirePermissions("PATIENT_READ")
  @Get()
  async search(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(searchPatientsSchema, query);
    const { items, total } = await this.patients.search(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PATIENT_CREATE")
  @Post("duplicate-check")
  @HttpCode(200)
  async duplicateCheck(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.patients.duplicateCheck(ctx, parse(duplicateProbeSchema, body)) };
  }

  @RequirePermissions("PATIENT_CREATE")
  @Post()
  async create(
    @Ctx() ctx: RequestContext, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { patient, replayed } = await this.patients.create(ctx, parse(createPatientSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: patient };
  }

  @RequirePermissions("PATIENT_READ")
  @Get(":id")
  async get(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.patients.get(ctx, id(patientId)) };
  }

  @RequirePermissions("PATIENT_UPDATE")
  @Patch(":id")
  async update(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) {
    return { data: await this.patients.update(ctx, id(patientId), parse(updatePatientSchema, body)) };
  }
}
