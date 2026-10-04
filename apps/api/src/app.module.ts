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
import { VitalsController } from "./modules/vitals/vitals.controller";
import { VitalsService } from "./modules/vitals/vitals.service";
import { AllergiesController } from "./modules/clinical/allergies.controller";
import { AllergiesService } from "./modules/clinical/allergies.service";
import { ClinicianService } from "./modules/clinical/clinician.service";
import { ConsultationsController } from "./modules/clinical/consultations.controller";
import { ConsultationsService } from "./modules/clinical/consultations.service";
import { PrescriptionsController } from "./modules/prescriptions/prescriptions.controller";
import { PrescriptionsService } from "./modules/prescriptions/prescriptions.service";
import { BillingController } from "./modules/billing/billing.controller";
import { CatalogService } from "./modules/billing/catalog.service";
import { InvoicesService } from "./modules/billing/invoices.service";
import { LedgerService } from "./modules/billing/ledger.service";
import { PaymentsService } from "./modules/billing/payments.service";
import { ShiftsService } from "./modules/billing/shifts.service";
import { DispensingService } from "./modules/pharmacy/dispensing.service";
import { InventoryService } from "./modules/pharmacy/inventory.service";
import { MedicinesService } from "./modules/pharmacy/medicines.service";
import { PharmacyController } from "./modules/pharmacy/pharmacy.controller";
import { StockService } from "./modules/pharmacy/stock.service";
import { AdmissionsService } from "./modules/ipd/admissions.service";
import { ChargesService } from "./modules/ipd/charges.service";
import { IpdController } from "./modules/ipd/ipd.controller";
import { WardsService } from "./modules/ipd/wards.service";
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
  EncountersController, AppointmentsController, QueueController, VitalsController,
  AllergiesController, ConsultationsController, PrescriptionsController, BillingController, PharmacyController, IpdController,
];

@Module({
  controllers: CONTROLLERS,
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    PrismaService, AuditService, PasswordService,
    AuthService, TenantsService, FacilitiesService, UsersService, NumberingService, MastersService, PatientsService, IdempotencyService,
    EncountersService, AppointmentsService, QueueService, VitalsService,
    ClinicianService, AllergiesService, ConsultationsService, PrescriptionsService,
    CatalogService, InvoicesService, LedgerService, PaymentsService, ShiftsService,
    StockService, MedicinesService, InventoryService, DispensingService,
    WardsService, AdmissionsService, ChargesService,
    // Order matters: rate limit first (cheap), then authentication + authorization.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [PrismaService, NumberingService, AuditService, PasswordService, TenantsService, IdempotencyService, EncountersService, AdmissionsService, ChargesService],
})
export class AppModule {}
