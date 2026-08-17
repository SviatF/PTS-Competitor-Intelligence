import cron from 'node-cron';
import { env } from './config/env.js';
import { db } from './database/client.js';
import { MetaAdLibraryCollector } from './collectors/meta/MetaAdLibraryCollector.js';
import { TelegramNotifier } from './telegram/TelegramNotifier.js';
import { MonitorService } from './services/monitor.js';

const monitor = new MonitorService(new MetaAdLibraryCollector(), new TelegramNotifier());
let running = false;

async function guardedRun() {
  if (running) {
    console.log('[monitor] previous run still active, skipping this tick');
    return;
  }

  running = true;
  try {
    await monitor.runOnce();
  } finally {
    running = false;
  }
}

async function main() {
  if (env.RUN_ONCE) {
    console.log('[app] GitHub Actions one-shot scan started');
    await guardedRun();
    console.log('[app] one-shot scan finished');
    await db.$disconnect();
    return;
  }

  console.log(`[app] PTS Competitor Intelligence started; cron=${env.MONITOR_CRON}`);
  await guardedRun();

  cron.schedule(env.MONITOR_CRON, () => {
    void guardedRun();
  });
}

async function shutdown(signal: string) {
  console.log(`[app] received ${signal}, shutting down`);
  await db.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (error) => {
  console.error('[app] fatal error', error);
  await db.$disconnect();
  process.exit(1);
});
