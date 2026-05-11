// Phase 1 RECON — Branch 3 specialist research sprint, 2026-05-11
//
// Goal: discover whatever API Polymarket's leaderboard frontend calls, so we can
// hit it directly with 30d / 90d / all-time params (instead of running Puppeteer
// three times).
//
// Strategy:
//   1. Load https://polymarket.com/leaderboard with Puppeteer
//   2. Capture every JSON/text response that contains wallet addresses
//   3. Log the URLs + sample responses so we can see which endpoint backs the
//      leaderboard data
//   4. ALSO extract DOM addresses as a fallback signal
//
// Run: cd ~/Desktop/POLYMARKET_TRADING_3.0 && npx tsx scripts/research/phase1-leaderboard-recon.ts

import puppeteer from 'puppeteer';

const URL = 'https://polymarket.com/leaderboard';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface Capture {
  url: string;
  method: string;
  status: number;
  ct: string;
  bodyPreview: string;
  bodySize: number;
  walletCount: number;
  walletSample: string[];
}

async function main() {
  console.log('▸ Phase 1 leaderboard recon — Branch 3 research sprint');
  console.log(`  url: ${URL}`);
  console.log();

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  const captures: Capture[] = [];

  page.on('response', async (response) => {
    const url = response.url();
    const req = response.request();
    const method = req.method();
    const ct = response.headers()['content-type'] || '';

    // Skip pure-asset URLs
    if (url.match(/\.(woff2?|ttf|css|png|svg|ico|jpg|jpeg|gif|webp)(\?|$)/i)) return;
    if (url.includes('/_next/static/') && !url.endsWith('.json')) return;
    if (url.includes('cdp.customer.io') || url.includes('amplitude') || url.includes('launchdarkly') || url.includes('reddit.com')) return;

    let body = '';
    try {
      body = await response.text();
    } catch {
      return;
    }

    const walletMatches = body.match(/0x[a-fA-F0-9]{40}/g) || [];
    const uniqueWallets = [...new Set(walletMatches.map((w) => w.toLowerCase()))];

    captures.push({
      url: url.length > 220 ? url.slice(0, 217) + '...' : url,
      method,
      status: response.status(),
      ct: ct.slice(0, 50),
      bodyPreview: body.slice(0, 200).replace(/\s+/g, ' '),
      bodySize: body.length,
      walletCount: uniqueWallets.length,
      walletSample: uniqueWallets.slice(0, 5),
    });
  });

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch (e) {
    console.warn(`  ⚠ goto warning: ${(e as Error).message}`);
  }
  // Extra wait for lazy XHRs
  await new Promise((r) => setTimeout(r, 6000));

  // Try clicking any timeframe controls if visible — best-effort
  try {
    const buttons = await page.$$('button');
    console.log(`  page has ${buttons.length} buttons (will scan their labels below)`);
  } catch {}

  // Extract DOM-visible addresses
  const domWallets = await page.evaluate(() => {
    const text = (document.body && document.body.textContent) || '';
    const matches = text.match(/0x[a-fA-F0-9]{40}/g) || [];
    return [...new Set(matches.map((m) => m.toLowerCase()))];
  });

  // Look for time-window controls
  const buttonLabels = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('button, [role="tab"], a').forEach((b) => {
      const t = (b.textContent || '').trim();
      if (t && t.length < 40) out.push(t);
    });
    return [...new Set(out)];
  });

  await browser.close();

  // Report
  console.log('=== XHRs / responses with wallet addresses ===');
  const withWallets = captures.filter((c) => c.walletCount > 0).sort((a, b) => b.walletCount - a.walletCount);
  for (const c of withWallets.slice(0, 30)) {
    console.log(`  [${c.method} ${c.status}] wallets=${c.walletCount.toString().padStart(3)} size=${c.bodySize.toString().padStart(6)}`);
    console.log(`    ${c.url}`);
    console.log(`    ct=${c.ct}`);
    console.log(`    preview: ${c.bodyPreview.slice(0, 150)}`);
    console.log(`    sample wallets: ${c.walletSample.join(', ')}`);
    console.log();
  }

  console.log('=== TOTAL ===');
  console.log(`  unique addresses from network captures: ${new Set(withWallets.flatMap((c) => c.walletSample)).size}+`);
  console.log(`  unique addresses from DOM:              ${domWallets.length}`);
  console.log();

  console.log('=== BUTTON / TAB labels (potential time-window controls) ===');
  for (const label of buttonLabels.slice(0, 40)) {
    console.log(`  "${label}"`);
  }

  console.log();
  console.log('=== ALL captured non-asset URLs (for diagnostic) ===');
  const seenHosts = new Map<string, number>();
  for (const c of captures) {
    const host = new URL(c.url).hostname;
    seenHosts.set(host, (seenHosts.get(host) || 0) + 1);
  }
  for (const [host, count] of [...seenHosts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${host}: ${count}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
