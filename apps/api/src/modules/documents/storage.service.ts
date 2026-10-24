import { Inject, Injectable } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DomainError } from "@medos/shared";
import { CONFIG, type AppConfig } from "../../common/config";

const SAFE_SEGMENT = /^[0-9a-f-]{36}$/;

/**
 * File byte storage. MLP-1 uses the local disk (STORAGE_DIR); the interface is deliberately tiny so an S3-compatible
 * driver can replace it (CLAUDE.md §42, REMINDER.md). Keys are `<tenantId>/<fileId>`: both are server-generated UUIDs, never user input.
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.root = resolve(config.STORAGE_DIR);
  }

  static keyFor(tenantId: string, fileId: string): string {
    return `${tenantId}/${fileId}`;
  }

  private pathFor(key: string): string {
    const parts = key.split("/");
    if (parts.length !== 2 || !parts.every((p) => SAFE_SEGMENT.test(p))) throw new DomainError("INTERNAL_ERROR", "Invalid storage key", 500);
    const full = resolve(join(this.root, ...parts));
    if (!full.startsWith(this.root + sep)) throw new DomainError("INTERNAL_ERROR", "Invalid storage key", 500);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: "wx", mode: 0o600 }); // never overwrite an existing object
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DomainError("NOT_FOUND", "Resource not found", 404);
      throw e;
    }
  }
}
