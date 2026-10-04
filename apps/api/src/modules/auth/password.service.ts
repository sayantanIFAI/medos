import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { CONFIG, type AppConfig } from "../../common/config";

const KEY_LEN = 32;

function scryptAsync(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Password hashing with scrypt (memory-hard, built into Node; see ADR-009 for why not Argon2 native bindings).
 * Format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>. Parameters are stored so cost can be raised later.
 */
@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async hash(password: string): Promise<string> {
    const N = 2 ** this.config.SCRYPT_LOG_N;
    const r = 8;
    const p = 1;
    const salt = randomBytes(16);
    const key = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p, maxmem: 256 * N * r });
    return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const expected = Buffer.from(parts[5] ?? "", "base64");
    const actual = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p, maxmem: 256 * N * r });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Burn comparable CPU when the account does not exist so response time does not reveal it. */
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash("dummy-password-for-timing");
    await this.verify(password, await this.dummy);
  }
}
