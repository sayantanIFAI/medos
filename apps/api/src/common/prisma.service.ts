import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@medos/database";

/** Transaction client or the root client; both expose the model delegates. */
export type Db = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Interactive transactions queue for a pooled connection under load; give them room instead of failing at 2s/5s.
    super({ transactionOptions: { maxWait: 15_000, timeout: 30_000 } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
