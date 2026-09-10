import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from './config/loader.js';
import { createApp } from './app.js';
import { closeDatabase } from './db/client.js';
import { killAllChildProcesses } from './providers/base-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

dotenvConfig({ path: resolve(PROJECT_ROOT, '.env') });

async function main() {
  const configPath = process.env.CONFIG_PATH ?? resolve(PROJECT_ROOT, 'config.yaml');
  const config = loadConfig(configPath);

  const app = await createApp(config, dirname(configPath));

  try {
    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    console.log(`
╔══════════════════════════════════════════════╗
║         star-cliproxy Server Started         ║
╠══════════════════════════════════════════════╣
║  Dashboard:  http://${config.server.host}:${config.server.port}       ║
║  API:        http://${config.server.host}:${config.server.port}/v1    ║
║  Health:     http://${config.server.host}:${config.server.port}/health║
║  Admin API:  http://${config.server.host}:${config.server.port}/admin ║
╚══════════════════════════════════════════════╝
    `);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) {
      console.log('\nForce exiting...');
      process.exit(1);
    }
    isShuttingDown = true;
    console.log('\nShutting down...');

    // Force exit if graceful shutdown exceeds 2s, before tsx's 5s timeout triggers.
    const forceExitTimer = setTimeout(() => {
      console.error('Shutdown timed out after 2s, force exiting...');
      process.exit(1);
    }, 2000);
    forceExitTimer.unref();

    try {
      killAllChildProcesses();
      await app.close();
      closeDatabase();
    } catch (err) {
      console.error('Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
