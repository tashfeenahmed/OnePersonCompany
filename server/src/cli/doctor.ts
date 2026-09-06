import "../routes/chat.ts";
import "../routes/models.ts";
import { setupReport } from "../routes/setup.ts";
const report = setupReport();
console.log(JSON.stringify(report, null, 2));
if (!report.writable) process.exitCode = 1;
