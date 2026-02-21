import chalk from 'chalk';
import { MAX_RETRIES, RETRY_DELAY_MS, PROGRESS_INTERVAL_MS, FETCH_TIMEOUT_MS } from './constants.js';
import { logInfo, logWarn, logError } from './logger.js';
import { sleep } from './utils.js';

/**
 * Fetch a URL with retry logic and progress reporting.
 * Shows a message every PROGRESS_INTERVAL_MS to indicate the app is alive.
 */
export async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    // Progress timer: print a dot every 5s to show we're alive
    let elapsed = 0;
    const progressTimer = setInterval(() => {
      elapsed += PROGRESS_INTERVAL_MS / 1000;
      logInfo(chalk.gray(`  ... still waiting for response (${elapsed}s) - ${url}`));
    }, PROGRESS_INTERVAL_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      clearInterval(progressTimer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (err) {
      clearTimeout(timeoutId);
      clearInterval(progressTimer);

      if (attempt < retries) {
        logWarn(`⚠ Attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
        logInfo(chalk.gray(`  Retrying in ${RETRY_DELAY_MS / 1000}s...`));
        await sleep(RETRY_DELAY_MS);
      } else {
        logError(`✖ All ${retries} attempts failed for ${url}: ${err.message}`);
        throw err;
      }
    }
  }
}
