import { Body, Controller, HttpCode, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { VoiceBookingsService, externalRefSchema, voiceBookingSchema, voiceCancelSchema, voiceDoctorSchema } from "./voice.service";

/**
 * Integration surface for the voice bot bridge. Tenant and facility come from the bridge's own login, like every other
 * route. The bridge's role holds only VOICE_BOOKING_SYNC (plus the patient rights it needs to register a new caller).
 */
@Controller("integrations/voice")
export class VoiceBookingsController {
  constructor(private readonly voice: VoiceBookingsService) {}

  @RequirePermissions("VOICE_BOOKING_SYNC")
  @Put("doctors/:ref")
  async doctor(@Ctx() ctx: RequestContext, @Param("ref") ref: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const result = await this.voice.upsertDoctor(ctx, parse(externalRefSchema, ref), parse(voiceDoctorSchema, body));
    res.status(result.created ? 201 : 200);
    return { data: result };
  }

  @RequirePermissions("VOICE_BOOKING_SYNC", "APPOINTMENT_READ")
  @Put("bookings/:ref")
  async booking(@Ctx() ctx: RequestContext, @Param("ref") ref: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const result = await this.voice.upsertBooking(ctx, parse(externalRefSchema, ref), parse(voiceBookingSchema, body));
    res.status(result.outcome === "created" ? 201 : 200);
    return { data: result };
  }

  @RequirePermissions("VOICE_BOOKING_SYNC", "APPOINTMENT_READ")
  @Post("bookings/:ref/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("ref") ref: string, @Body() body: unknown) {
    return { data: await this.voice.cancelBooking(ctx, parse(externalRefSchema, ref), parse(voiceCancelSchema, body ?? {}).reason) };
  }
}
