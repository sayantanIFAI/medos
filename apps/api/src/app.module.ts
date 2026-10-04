import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuditService } from "./common/audit.service";
import { AuthGuard } from "./common/auth.guard";
import { CONFIG, loadConfig } from "./common/config";
import { AllExceptionsFilter } from "./common/http-pipeline";
import { IdempotencyService } from "./common/idempotency.service";
import { PrismaService } from "./common/prisma.service";
import { RateLimitGuard } from "./common/rate-limit.guard";
import { AppointmentsController } from "./modules/appointments/appointments.controller";
import { AppointmentsService } from "./modules/appointments/appointments.service";
import { EncountersController } from "./modules/encounters/encounters.controller";
import { EncountersService } from "./modules/encounters/encounters.service";
import { QueueController } from "./modules/queue/queue.controller";
import { QueueService } from "./modules/queue/queue.service";
import { AuditController } from "./modules/audit/audit.controller";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthService } from "./modules/auth/auth.service";
import { PasswordService } from "./modules/auth/password.service";
import { FacilitiesController } from "./modules/facilities/facilities.controller";
import { FacilitiesService } from "./modules/facilities/facilities.service";
import { HealthController } from "./modules/health/health.controller";
import { MastersController } from "./modules/masters/masters.controller";
import { MastersService } from "./modules/masters/masters.service";
import { PatientsController } from "./modules/patients/patients.controller";
import { PatientsService } from "./modules/patients/patients.service";
import { NumberingController } from "./modules/numbering/numbering.controller";
import { NumberingService } from "./modules/numbering/numbering.service";
import { TenantsController } from "./modules/tenants/tenants.controller";
import { TenantsService } from "./modules/tenants/tenants.service";
import { UsersController } from "./modules/users/users.controller";
import { UsersService } from "./modules/users/users.service";

/** Single registry so a test can prove every route declares its access policy. */
export const CONTROLLERS = [
  HealthController, AuthController, TenantsController, FacilitiesController,
  UsersController, NumberingController, AuditController, MastersController, PatientsController,
  EncountersController, AppointmentsController, QueueController,
];

@Module({
  controllers: CONTROLLERS,
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    PrismaService, AuditService, PasswordService,
    AuthService, TenantsService, FacilitiesService, UsersService, NumberingService, MastersService, PatientsService, IdempotencyService,
    EncountersService, AppointmentsService, QueueService,
    // Order matters: rate limit first (cheap), then authentication + authorization.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [PrismaService, NumberingService, AuditService, PasswordService, TenantsService, IdempotencyService, EncountersService],
})
export class AppModule {}
