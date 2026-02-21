import chalk from 'chalk';

// ─── Progress Tracker ────────────────────────────────────────────────────────

const BAR_WIDTH = 28;
const isTTY = process.stderr.isTTY;

/**
 * Singleton progress tracker.
 * Call configure() once the total number of indexes is known, then
 * use the various update methods as the crawl proceeds.
 */
class ProgressTracker {
  constructor() {
    this._active = false;

    // Index-level progress
    this.totalIndexes = 0;
    this.doneIndexes = 0;          // done including already-skipped (for %)
    this._pendingIndexes = 0;      // indexes that need actual work (for ETA)
    this._processedPending = 0;    // pending indexes actually worked through

    // Sitemap-level progress (current index)
    this.currentIndexTotal = 0;   // sitemaps in the active index
    this.currentIndexDone = 0;    // sitemaps completed in the active index

    // Rolling statistics for ETA
    this._sitemapTimes = [];      // ms durations for each sitemap
    this._sitemapsPerIndex = [];  // sitemap counts for each completed index
    this._sitemapStart = null;    // Date.now() when the last sitemap started

    this._crawlStart = Date.now();
    this._rendered = false;       // whether a bar line is currently on stderr
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * @param {number} totalIndexes   - full count including already-processed ones
   * @param {number} pendingIndexes - count of indexes that will actually be worked
   */
  configure(totalIndexes, pendingIndexes) {
    this.totalIndexes = totalIndexes;
    this._pendingIndexes = pendingIndexes;
    // Pre-fill doneIndexes with the already-skipped count so the bar starts
    // at the right position rather than at zero.
    this.doneIndexes = totalIndexes - pendingIndexes;
    this._processedPending = 0;
    this._active = true;
    this._rendered = false;
  }

  // ── Index lifecycle ────────────────────────────────────────────────────────

  beginIndex(sitemapCount) {
    this.currentIndexTotal = sitemapCount;
    this.currentIndexDone = 0;
  }

  endIndex() {
    this.doneIndexes++;
    this._processedPending++;
    if (this.currentIndexTotal > 0) {
      this._sitemapsPerIndex.push(this.currentIndexTotal);
    }
    this.currentIndexTotal = 0;
    this.currentIndexDone = 0;
  }

  // ── Sitemap lifecycle ──────────────────────────────────────────────────────

  beginSitemap() {
    this._sitemapStart = Date.now();
  }

  endSitemap() {
    if (this._sitemapStart !== null) {
      this._sitemapTimes.push(Date.now() - this._sitemapStart);
      this._sitemapStart = null;
    }
    this.currentIndexDone++;
    this.render();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Clear the progress line from stderr (called before any console.log so
   * log output and the bar don't interleave visually).
   */
  clear() {
    if (!this._active || !isTTY || !this._rendered) return;
    process.stderr.write('\r\x1b[2K');
    this._rendered = false;
  }

  /**
   * Render (or re-render) the progress line on stderr.
   */
  render() {
    if (!this._active || !isTTY) return;
    const line = this._buildLine();
    process.stderr.write('\r\x1b[2K' + line);
    this._rendered = true;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _avgSitemapMs() {
    if (this._sitemapTimes.length === 0) return null;
    const tail = this._sitemapTimes.slice(-40); // rolling window
    return tail.reduce((a, b) => a + b, 0) / tail.length;
  }

  _avgSitemapsPerIndex() {
    if (this._sitemapsPerIndex.length === 0) return null;
    const tail = this._sitemapsPerIndex.slice(-10);
    return tail.reduce((a, b) => a + b, 0) / tail.length;
  }

  _etaMs() {
    const avgMs = this._avgSitemapMs();
    if (avgMs === null) return null;

    const remainingInCurrentIndex = this.currentIndexTotal - this.currentIndexDone;
    // Use pending-only counters so already-skipped indexes don't distort ETA
    const remainingIndexes = this._pendingIndexes - this._processedPending - 1; // -1 for current

    let estimatedSitemaps = remainingInCurrentIndex;
    if (remainingIndexes > 0) {
      const avgPerIdx = this._avgSitemapsPerIndex() ?? this.currentIndexTotal;
      estimatedSitemaps += remainingIndexes * avgPerIdx;
    }

    return estimatedSitemaps * avgMs;
  }

  _formatDuration(ms) {
    if (ms === null || ms < 0) return '—';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
    if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  _buildLine() {
    const done = this.doneIndexes;
    const total = this.totalIndexes;
    const pct = total > 0 ? done / total : 0;

    // Bar
    const filled = Math.round(pct * BAR_WIDTH);
    const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(BAR_WIDTH - filled));

    // Percentage
    const pctStr = `${Math.floor(pct * 100)}%`.padStart(4);

    // Index counter
    const idxStr = `idx ${done}/${total}`;

    // Sitemap within current index
    const smStr = this.currentIndexTotal > 0
      ? `sitemap ${this.currentIndexDone}/${this.currentIndexTotal}`
      : '';

    // ETA
    const etaMs = this._etaMs();
    const etaStr = etaMs !== null ? `ETA ${this._formatDuration(etaMs)}` : 'ETA —';

    // Elapsed
    const elapsed = this._formatDuration(Date.now() - this._crawlStart);
    const elapsedStr = `elapsed ${elapsed}`;

    const parts = [idxStr, smStr, etaStr, elapsedStr].filter(Boolean);
    return `${bar} ${chalk.bold(pctStr)} ${chalk.gray('│')} ${parts.join(chalk.gray(' │ '))}`;
  }
}

export const progress = new ProgressTracker();
