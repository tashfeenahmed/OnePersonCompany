import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Runs inside each test worker before imports; never touch a developer database.
const data = mkdtempSync(join(tmpdir(), `opc-test-${process.pid}-`));
process.env.OPC_DATA_DIR = data;
process.env.OPC_ENV_FILE = join(data, 'absent.env');
process.env.OPC_COLLECT_MINUTES = '0';
process.on('exit', () => rmSync(data, { recursive: true, force: true }));
