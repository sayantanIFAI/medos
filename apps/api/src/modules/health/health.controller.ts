import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "../../common/http";
import { PrismaService } from "../../common/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process is up. */
  @Public()
  @Get()
  live() {
    return { data: { status: "ok" } };
  }

  /** Readiness: database reachable. Reveals nothing beyond up/down. */
  @Public()
  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException();
    }
    return { data: { status: "ready" } };
  }
}
