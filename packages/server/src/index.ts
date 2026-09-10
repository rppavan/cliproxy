import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from './config/loader.js';
import { createApp } from './app.js';
import { closeDatabase } from './db/client.js';
import { killAllChildProcesses } from './providers/base-provider.js';

// 프로젝트 루트 디렉토리 계산 (packages/server/src/index.ts → 3단계 상위)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

// 루트의 .env 로드
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

  // 우아한 종료
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) {
      console.log('\nForce exiting...');
      process.exit(1);
    }
    isShuttingDown = true;
    console.log('\nShutting down...');

    // 2초 내에 종료되지 않으면 강제 종료 (tsx의 5초 타임아웃보다 먼저 안전하게 종료)
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
