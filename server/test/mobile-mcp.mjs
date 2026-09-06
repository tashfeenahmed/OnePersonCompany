// Route the MCP subprocess through the real Hono handlers without opening a port.
// OPC_DATA_DIR is inherited from the isolated test worker.
import { Hono } from 'hono';
import { mobile } from '../src/routes/mobile.ts';
import { skillRoutes } from '../src/routes/skills.ts';
const app = new Hono();
app.route('/api/mobile', mobile);
app.route('/api/skills', skillRoutes);
globalThis.fetch = (input, init) => app.request(input, init);
