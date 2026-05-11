// Phase 1a — scrape Polymarket leaderboard top wallets across time windows.
//
// Output: _NEXT_STEPS/branch-3-phase1a-leaderboard.json
//   { fetchedAt, windows: { weekly: [...], monthly: [...], all: [...] }, allUnique: [...] }
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase1a-leaderboard-fetch.ts

import puppeteer, { Browser, Page } from 'puppeteer';
import { writeFileSync } from 'node:fs';

const URL = 'https://polymarket.com/leaderboard';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const OUT = `${process.env.HOME}/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/branch-3-phase1a-leaderboard.json`;

// Time-window buttons visible in the UI per recon (Today / Weekly / Monthly / All).
// We pull Weekly + Monthly + All for the sprint (Today is too narrow for a 90d
// screening signal).
const TARGET_WINDOWS: Array<'Weekly' | 'Monthly' | 'All'> = ['Weekly', 'Monthly', 'All'];

interface WindowResult {
  window: string;
  wallets: string[];           // ordered by leaderboard rank (rank 1 = first)
  rawText: string;             // first 1000 chars of leaderboard region for diagnostics
}

async function clickButtonByLabel(page: Page, label: string): Promise<boolean> {
  // Click first button whose text matches `label` exactly (case-insensitive).
  return await page.evaluate((target) => {
    const want = target.toLowerCase().trim();
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="tab"], a'));
    for (const el of candidates) {
      const t = (el.textContent || '').toLowerCase().trim();
      if (t === want) {
        el.click();
        return true;
      }
    }
    return false;
  }, label);
}

async function ensureProfitLossSort(page: Page): Promise<boolean> {
  // The default sort is usually Profit/Loss already, but force it to be safe.
  return await clickButtonByLabel(page, 'Profit/Loss');
}

async function scrollToBottom(page: Page, maxScrolls = 8): Promise<void> {
  for (let i = 0; i < maxScrolls; i++) {
    const heightBefore = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 1200));
    const heightAfter = await page.evaluate(() => document.body.scrollHeight);
    if (heightAfter === heightBefore) break;
  }
}

async function extractLeaderboardWallets(page: Page): Promise<{ wallets: string[]; rawText: string }> {
  // Polymarket leaderboard rows contain wallet links like /profile/0xABC...
  // But the DOM may render addresses inside <a href="/profile/...">. We grab
  // them in source order.
  const result = await page.evaluate(() => {
    const wallets: string[] = [];
    // Method 1: profile links
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/profile/"]').forEach((a) => {
      const m = a.href.match(/0x[a-fA-F0-9]{40}/);
      if (m) wallets.push(m[0].toLowerCase());
    });
    // Method 2: fallback — any 0x... in body text, in source order
    if (wallets.length < 20) {
      const text = document.body.textContent || '';
      const all = text.match(/0x[a-fA-F0-9]{40}/g) || [];
      for (const w of all) wallets.push(w.toLowerCase());
    }
    // De-dupe while preserving order
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const w of wallets) {
      if (!seen.has(w)) {
        seen.add(w);
        ordered.push(w);
      }
    }
    // Snapshot of leaderboard region text for diagnostics
    const mainEl = document.querySelector('main') || document.body;
    const rawText = (mainEl.textContent || '').slice(0, 1000);
    return { wallets: ordered, rawText };
  });
  return result;
}

async function fetchWindow(browser: Browser, window: string): Promise<WindowResult> {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1400, height: 1800 });

  console.log(`  ▸ ${window} — opening leaderboard...`);
  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    console.warn(`    ⚠ goto warning: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 3000));

  // Force Profit/Loss sort (don't fail if already selected)
  const sortClicked = await ensureProfitLossSort(page);
  console.log(`    sort=Profit/Loss applied: ${sortClicked}`);
  await new Promise((r) => setTimeout(r, 1500));

  // Click the time-window button
  const windowClicked = await clickButtonByLabel(page, window);
  console.log(`    window=${window} applied: ${windowClicked}`);
  if (!windowClicked) {
    console.warn(`    ⚠ couldn't find a "${window}" button — falling back to default view`);
  }
  await new Promise((r) => setTimeout(r, 3000));

  // Scroll to load more rows
  await scrollToBottom(page);

  const extracted = await extractLeaderboardWallets(page);
  console.log(`    captured ${extracted.wallets.length} wallets`);

  await page.close();
  return {
    window,
    wallets: extracted.wallets,
    rawText: extracted.rawText.slice(0, 400),
  };
}

async function main() {
  console.log('▸ Phase 1a — Polymarket leaderboard fetch across time windows');
  console.log(`  windows: ${TARGET_WINDOWS.join(', ')}`);
  console.log(`  output:  ${OUT}`);
  console.log();

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const results: Record<string, WindowResult> = {};
  for (const w of TARGET_WINDOWS) {
    try {
      results[w] = await fetchWindow(browser, w);
    } catch (e) {
      console.error(`    ❌ ${w} failed: ${(e as Error).message}`);
      results[w] = { window: w, wallets: [], rawText: `ERROR: ${(e as Error).message}` };
    }
  }

  await browser.close();

  // Compute union + rank per window
  const allUnique = new Set<string>();
  for (const r of Object.values(results)) {
    for (const w of r.wallets) allUnique.add(w);
  }

  const rankByWindow: Record<string, Record<string, number>> = {};
  for (const [winName, r] of Object.entries(results)) {
    rankByWindow[winName] = {};
    r.wallets.forEach((w, i) => {
      rankByWindow[winName][w] = i + 1;
    });
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    targetWindows: TARGET_WINDOWS,
    windows: results,
    allUnique: [...allUnique],
    rankByWindow,
    summary: {
      uniqueAcrossWindows: allUnique.size,
      perWindow: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.wallets.length])),
    },
  };

  writeFileSync(OUT, JSON.stringify(output, null, 2));

  console.log();
  console.log('=== SUMMARY ===');
  for (const [k, v] of Object.entries(output.summary.perWindow)) {
    console.log(`  ${k.padEnd(10)} → ${v} wallets`);
  }
  console.log(`  unique total: ${output.summary.uniqueAcrossWindows}`);
  console.log();
  console.log(`saved → ${OUT}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
