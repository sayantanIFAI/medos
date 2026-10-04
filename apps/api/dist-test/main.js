"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const bootstrap_1 = require("./bootstrap");
const config_1 = require("./common/config");
const logger_1 = require("./common/logger");
async function main() {
    const config = (0, config_1.loadConfig)();
    const app = await (0, bootstrap_1.createApp)();
    app.enableShutdownHooks();
    await app.listen(config.PORT);
    (0, logger_1.logJson)("info", "api_started", { port: config.PORT });
}
main().catch((e) => {
    process.stderr.write(`Fatal startup error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
//# sourceMappingURL=main.js.map