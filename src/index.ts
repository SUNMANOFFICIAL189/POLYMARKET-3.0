import 'dotenv/config';
import { Runner } from './core/runner.js';
import { logger } from './utils/logger.js';

const runner = new Runner();

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT — shutting down...');
  await runner.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM — shutting down...');
  await runner.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

runner.start().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});
