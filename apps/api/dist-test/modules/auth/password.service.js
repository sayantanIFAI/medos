"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PasswordService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const config_1 = require("../../common/config");
const KEY_LEN = 32;
function scryptAsync(password, salt, opts) {
    return new Promise((resolve, reject) => {
        (0, node_crypto_1.scrypt)(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
    });
}
/**
 * Password hashing with scrypt (memory-hard, built into Node; see ADR-009 for why not Argon2 native bindings).
 * Format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>. Parameters are stored so cost can be raised later.
 */
let PasswordService = class PasswordService {
    config;
    dummy;
    constructor(config) {
        this.config = config;
    }
    async hash(password) {
        const N = 2 ** this.config.SCRYPT_LOG_N;
        const r = 8;
        const p = 1;
        const salt = (0, node_crypto_1.randomBytes)(16);
        const key = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p, maxmem: 256 * N * r });
        return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
    }
    async verify(password, stored) {
        const parts = stored.split("$");
        if (parts.length !== 6 || parts[0] !== "scrypt")
            return false;
        const N = Number(parts[1]);
        const r = Number(parts[2]);
        const p = Number(parts[3]);
        if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p))
            return false;
        const salt = Buffer.from(parts[4] ?? "", "base64");
        const expected = Buffer.from(parts[5] ?? "", "base64");
        const actual = await scryptAsync(password.normalize("NFKC"), salt, { N, r, p, maxmem: 256 * N * r });
        return actual.length === expected.length && (0, node_crypto_1.timingSafeEqual)(actual, expected);
    }
    /** Burn comparable CPU when the account does not exist so response time does not reveal it. */
    async verifyDummy(password) {
        this.dummy ??= this.hash("dummy-password-for-timing");
        await this.verify(password, await this.dummy);
    }
};
exports.PasswordService = PasswordService;
exports.PasswordService = PasswordService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(config_1.CONFIG)),
    __metadata("design:paramtypes", [Object])
], PasswordService);
//# sourceMappingURL=password.service.js.map