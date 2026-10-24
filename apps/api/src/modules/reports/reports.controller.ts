import { Controller, Get, Query } from "@nestjs/common";
import { Feature } from "../../common/feature.guard";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { expirySchema, outstandingSchema, rangeSchema, ReportsService } from "./reports.service";

/** Operational reports only. All are read-only, facility-scoped from the session, and bounded (date ranges ≤ 93 days). */
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermissions("REPORT_READ")
  @Get("opd/daily")
  async opdDaily(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.opdDaily(ctx, parse(rangeSchema, q)) }; }

  @RequirePermissions("REPORT_READ")
  @Get("opd/by-doctor")
  async opdByDoctor(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.opdByDoctor(ctx, parse(rangeSchema, q)) }; }

  @RequirePermissions("REPORT_READ")
  @Get("opd/by-department")
  async opdByDepartment(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.opdByDepartment(ctx, parse(rangeSchema, q)) }; }

  @RequirePermissions("REPORT_READ")
  @Get("collections")
  async collections(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.collections(ctx, parse(rangeSchema, q)) }; }

  @RequirePermissions("REPORT_READ")
  @Get("cashier-shifts")
  async shifts(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.shifts(ctx, parse(rangeSchema, q)) }; }

  @RequirePermissions("REPORT_READ")
  @Get("outstanding-invoices")
  async outstanding(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.outstanding(ctx, parse(outstandingSchema, q)) }; }

  @Feature("IPD_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("ipd/current-admissions")
  async currentAdmissions(@Ctx() ctx: RequestContext) { return { data: await this.reports.currentAdmissions(ctx) }; }

  @Feature("IPD_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("ipd/admissions-discharges")
  async admissionsAndDischarges(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.admissionsAndDischarges(ctx, parse(rangeSchema, q)) }; }

  @Feature("IPD_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("ipd/bed-occupancy")
  async bedOccupancy(@Ctx() ctx: RequestContext) { return { data: await this.reports.bedOccupancy(ctx) }; }

  @Feature("PHARMACY_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("pharmacy/sales")
  async pharmacySales(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.pharmacySales(ctx, parse(rangeSchema, q)) }; }

  @Feature("PHARMACY_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("pharmacy/stock")
  async currentStock(@Ctx() ctx: RequestContext) { return { data: await this.reports.currentStock(ctx) }; }

  @Feature("PHARMACY_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("pharmacy/low-stock")
  async lowStock(@Ctx() ctx: RequestContext) { return { data: await this.reports.lowStock(ctx) }; }

  @Feature("PHARMACY_ENABLED")
  @RequirePermissions("REPORT_READ")
  @Get("pharmacy/near-expiry")
  async nearExpiry(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.reports.nearExpiry(ctx, parse(expirySchema, q)) }; }
}
