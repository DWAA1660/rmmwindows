import { createApp } from './app.mjs';

const service = createApp();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const listener = service.app.listen(port, host, () => console.log(`RMM listening on ${host}:${port}`));
const scheduler = setInterval(() => {
  try { service.tickSchedules(); } catch (error) { console.error('Scheduler failure:', error.message); }
}, 15000);
scheduler.unref();
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  clearInterval(scheduler);
  listener.close(() => { service.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
