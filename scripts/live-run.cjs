/**
 * Runs the BTC paper bot in headless Chromium on live Binance prices, for up to MINUTES, and
 * every minute publishes to the `live-run` branch:
 *   STATUS.md   the account, the open trade, recent trades and the bot's log
 *   live.jpg    a screenshot of the bot's screen
 *   state.json  the app's saved state, so the next run carries on where this one stopped
 *   history.csv one line a minute: price and account value
 * Stops early when a branch named `stop-live-run` exists (then writes the file `live-run-stopped`).
 * Starts a Blitz session (2 hours of quick trades, once a day) when a branch named
 * `blitz-YYYY-MM-DD` exists for today's date in India time.
 *
 * FRESH=true starts a new test with AMOUNT dollars of paper money, deciding every TIMEFRAME
 * (1m, 15m, 1h or 4h), spending MIN_TRADE to MAX_TRADE dollars a trade (either may be blank);
 * otherwise the saved test carries on.
 *
 *   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo MINUTES=340 node scripts/live-run.cjs
 * (the app must already be served at http://localhost:4173 by server/index.mjs)
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MINUTES = Number(process.env.MINUTES || 340);
/** Seconds between updates (60; local tests use less). */
const EVERY_MS = Number(process.env.EVERY_SECONDS || 60) * 1000;
const URL = 'http://localhost:4173/';
const DATA_BRANCH = 'live-run';
const STOP_BRANCH = 'stop-live-run';
const WORK = path.resolve('live-run-out');
const RUN_URL = process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ git for the data branch */

const git = (args) => execSync(`git ${args}`, { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function openDataBranch() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK);
  git('init -q');
  // LIVE_RUN_REMOTE lets a local test publish to a throwaway repository instead of GitHub.
  git(`remote add origin ${process.env.LIVE_RUN_REMOTE || `https://x-access-token:${process.env.GH_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`}`);
  git('config user.name "github-actions[bot]"');
  git('config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  try {
    git(`fetch -q --depth 1 origin ${DATA_BRANCH}`);
    git(`checkout -q -b ${DATA_BRANCH} FETCH_HEAD`);
    return true;
  } catch {
    git(`checkout -q --orphan ${DATA_BRANCH}`);
    return false;
  }
}
/** One commit, replaced every minute, so the branch stays small. */
function publish() {
  try {
    git('add -A');
    let hasHead = true;
    try {
      git('rev-parse -q --verify HEAD');
    } catch {
      hasHead = false;
    }
    git(hasHead ? 'commit -q --amend -m "Live paper bot status"' : 'commit -q -m "Live paper bot status"');
    git(`push -q -f origin HEAD:${DATA_BRANCH}`);
  } catch (e) {
    console.log('publish failed:', String(e.stderr || e.message).replace(/x-access-token:[^@]+@/g, '***@').slice(0, 300));
  }
}
/** Today's date in India time, as the Blitz request branch names it: blitz-2026-11-16. */
const blitzBranch = (ms) => `blitz-${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms))}`;
/** Which of the control branches exist: the stop branch and today's Blitz request. */
function controlBranches(now) {
  try {
    const out = git(`ls-remote --heads origin ${STOP_BRANCH} ${blitzBranch(now)}`);
    return { stop: out.includes(`refs/heads/${STOP_BRANCH}`), blitz: out.includes(`refs/heads/${blitzBranch(now)}`) };
  } catch {
    return { stop: false, blitz: false };
  }
}

/* ------------------------------------------------------------ the status page */

const ist = (ms) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)) + ' IST';
const usd = (n, sign = false) => `${sign ? (n > 0.005 ? '+' : n < -0.005 ? '−' : '') : n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n) => `${n > 0.005 ? '+' : n < -0.005 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;
const dur = (ms) => {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`;
};
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
const EVERY = { '1m': 'every minute', '15m': 'every 15 minutes', '1h': 'every hour', '4h': 'every 4 hours' };
const CANDLE = { '1m': '1-minute', '15m': '15-minute', '1h': '1-hour', '4h': '4-hour' };

/** A position's value at a price: a short is worth its cash plus what the fall has made. */
const valueOf = (p, px) => (p.side === 'short' ? p.collateral + (p.entryPrice - px) * p.qty : p.qty * px);

function statusPage(s, ui, now, stoppedNote) {
  const px = ui.price;
  const pos = s.positions?.[0];
  const posValue = pos && px ? valueOf(pos, px) : 0;
  const eq = s.cash + posValue;
  const start = s.test?.startEquity ?? s.cash ?? 10000;
  const tf = s.controls?.timeframe ?? '4h';
  const pnl = eq - start;
  const hold = s.test && px ? ((px - s.test.startPrice) / s.test.startPrice) * 100 : 0;
  const trades = s.trades ?? [];
  const wins = trades.filter((t) => t.pnl > 0).length;
  const fees = trades.reduce((a, t) => a + t.fees, 0) + (pos?.entryFee ?? 0);
  const lines = [
    '# CRDTrade BTC trader (paper)',
    '',
    `Updated **${ist(now)}** · refreshes every minute: reload this page to see the latest${RUN_URL ? ` · [run log](${RUN_URL})` : ''}`,
    '',
    stoppedNote ? `> **${stoppedNote}**\n` : '',
    '| | |',
    '|---|---|',
    `| Bot | **${cell(ui.status || (s.running ? 'Running' : 'Paused'))}** · decides ${EVERY[tf] ?? tf} on ${CANDLE[tf] ?? tf} momentum, buys and shorts, at most ${s.controls?.riskPct ?? 0.5}% lost a trade · ${s.controls?.minSpend || s.controls?.maxSpend ? `${s.controls.minSpend ? usd(s.controls.minSpend) : ''}${s.controls.minSpend && s.controls.maxSpend ? '–' : ''}${s.controls.maxSpend ? `${s.controls.minSpend ? '' : 'up to '}${usd(s.controls.maxSpend)}` : ''} a trade · ` : ''}paper money (started with ${usd(start)}), no real orders |`,
    `| Account value | **${usd(eq)}** (${usd(pnl, true)}, ${pct((pnl / start) * 100)} since start) |`,
    `| Just holding BTC instead | ${pct(hold)} |`,
    `| Cash | ${usd(s.cash)} |`,
    s.blitz
      ? `| Blitz | **On until ${ist(s.blitz.endsAt)}** · quick trades on the 1-minute chart · ${usd(eq - s.blitz.startEquity, true)} this session (stops early at −2%) |`
      : `| Blitz | ${s.blitzUsedOn && new Date(now).setHours(0, 0, 0, 0) <= s.blitzUsedOn ? 'Used today' : 'Not used today'} · to start it, ask Claude or create a branch named \`${blitzBranch(now)}\` |`,
    `| Open trade | ${pos ? `${pos.blitz ? 'Blitz: ' : ''}${pos.side === 'short' ? 'Sold short' : 'Bought'} ${pos.qty.toFixed(5)} BTC at ${usd(pos.entryPrice)}${pos.stopLoss ? `, stop ${usd(pos.stopLoss)}` : ''}${pos.takeProfit ? `, target ${usd(pos.takeProfit)}` : ''} · now ${usd(posValue - pos.collateral - pos.entryFee, true)}` : `None: waiting for ${CANDLE[tf] ?? tf} momentum to turn`} |`,
    `| Trades | ${trades.length} (${wins} won) · fees paid ${usd(fees)} |`,
    `| BTC price | ${px ? usd(px) : '–'} · ${cell((ui.health || '').split(' · ')[0])} |`,
    `| Running since | ${s.test ? `${ist(s.test.startedAt)} (${dur(now - s.test.startedAt)})` : '–'} · time without prices: ${s.offlineMs ? dur(s.offlineMs) : 'none'} |`,
    '',
    `![The bot's screen right now](live.jpg?v=${Math.floor(now / 60000)})`,
    '',
    '## Last trades',
    '',
  ];
  if (!trades.length) lines.push(`None yet. The bot trades when ${CANDLE[tf] ?? tf} momentum turns; in testing that was 3–7 times a month.`);
  else {
    lines.push('| Opened | Closed | Side | Entry | Exit | Profit | Why it closed |', '|---|---|---|---|---|---|---|');
    for (const t of trades.slice(-15).reverse())
      lines.push(`| ${ist(t.entryTime)} | ${ist(t.exitTime)} | ${t.side === 'short' ? 'Short' : 'Buy'} | ${usd(t.entryPrice)} | ${usd(t.exitPrice)} | ${usd(t.pnl, true)} (${pct(t.pnlPct)}) | ${cell(t.exitReason)} |`);
  }
  lines.push('', "## The bot's log (newest first)", '');
  for (const g of (s.logs ?? []).slice(0, 20)) lines.push(`- ${ist(g.time)} · **${g.level}** · ${cell(g.message)}`);
  lines.push('', '---', '', `history.csv on this branch has the price and account value for every minute. To stop the bot, ask Claude, or create a branch named \`${STOP_BRANCH}\`.`);
  return lines.join('\n');
}

/* ------------------------------------------------------------ run */

(async () => {
  const had = openDataBranch();
  const fresh = process.env.FRESH === 'true';
  let saved = {};
  try {
    saved = had && !fresh ? JSON.parse(fs.readFileSync(path.join(WORK, 'state.json'), 'utf8')) : {};
  } catch {
    saved = {};
  }
  if (fresh) {
    for (const f of ['state.json', 'history.csv']) fs.rmSync(path.join(WORK, f), { force: true });
    console.log('starting a new test');
  }
  // A new test: the paper money and timeframe asked for, everything else at its defaults.
  const amount = Number(process.env.AMOUNT) >= 10 ? Number(process.env.AMOUNT) : 10000;
  const timeframe = ['1m', '15m', '1h', '4h'].includes(process.env.TIMEFRAME) ? process.env.TIMEFRAME : '4h';
  const account = { currency: 'USD', rate: 1, ...(amount !== 10000 ? { amount } : {}) };
  const dollars = (v) => (Number(v) > 0 ? Number(v) : null);
  const controls = { timeframe, minSpend: dollars(process.env.MIN_TRADE), maxSpend: dollars(process.env.MAX_TRADE) };
  const seed = JSON.stringify({ state: { theme: 'dark', mode: 'tested', interval: timeframe, view: 'live', chartView: 'bot', tradingMode: 'paper', account, cash: amount, controls }, version: 1 });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'Asia/Kolkata' });
  await ctx.addInitScript((btc) => {
    if (!localStorage.getItem('crdtrade-btc')) localStorage.setItem('crdtrade-btc', btc);
  }, saved.btc || seed);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  // Local tests only: swap Binance for a stand-in price feed (MOCK=/path/to/mock.cjs).
  if (process.env.MOCK) await require(process.env.MOCK).setup(page);
  await page.goto(URL);
  await page.waitForFunction(() => document.querySelector('.health')?.getAttribute('data-ok') === 'true', null, { timeout: 180_000 }).catch(() => {});
  if (!(await page.$eval('.power', (e) => e.getAttribute('data-on') === 'true').catch(() => false))) {
    await page.click('.power').catch(() => {});
    console.log('bot started');
  } else console.log('bot resumed from the saved state');

  const end = Date.now() + MINUTES * 60_000;
  let stoppedNote = '';
  while (true) {
    const now = Date.now();
    try {
      const snap = await page.evaluate(() => ({
        btc: localStorage.getItem('crdtrade-btc'),
        status: document.querySelector('.status-pill')?.textContent?.trim(),
        health: document.querySelector('.health')?.textContent?.replace(/\s+/g, ' ').trim(),
        priceText: document.querySelector('.big-price')?.textContent,
      }));
      const s = JSON.parse(snap.btc).state;
      // Right after start the app may not have saved the account yet.
      if (typeof s.cash !== 'number') throw new Error('account not saved yet');
      const price = Number(String(snap.priceText || '').replace(/[^0-9.]/g, '')) || null;
      fs.writeFileSync(path.join(WORK, 'state.json'), JSON.stringify({ btc: snap.btc, savedAt: now }));
      const pos = s.positions?.[0];
      const eq = s.cash + (pos && price ? valueOf(pos, price) : 0);
      const hist = path.join(WORK, 'history.csv');
      if (!fs.existsSync(hist)) fs.writeFileSync(hist, 'time_utc,btc_price,account_value,holding_btc,trades\n');
      fs.appendFileSync(hist, `${new Date(now).toISOString()},${price ?? ''},${eq.toFixed(2)},${pos ? pos.qty.toFixed(6) : 0},${s.trades?.length ?? 0}\n`);
      await page.screenshot({ path: path.join(WORK, 'live.jpg'), type: 'jpeg', quality: 70 });
      const control = controlBranches(now);
      if (control.stop) stoppedNote = `Stopped at ${ist(now)}, as asked. The account and trades below are final.`;
      // A Blitz request for today: press Start Blitz once, if it hasn't run today.
      else if (control.blitz && !s.blitz) {
        const usedToday = await page.evaluate((used) => new Date().setHours(0, 0, 0, 0) === used, s.blitzUsedOn ?? 0);
        if (!usedToday && (await page.$('.blitz-go:not([disabled])'))) {
          await page.click('.blitz-go').catch(() => {});
          console.log('Blitz started, as asked');
        }
      }
      fs.writeFileSync(path.join(WORK, 'STATUS.md'), statusPage(s, { ...snap, price }, now, stoppedNote));
      publish();
      console.log(`${new Date(now).toISOString()} price ${price} account ${eq.toFixed(2)} trades ${s.trades?.length ?? 0} ${snap.status}`);
    } catch (e) {
      if (/not saved yet/.test(e.message)) {
        await sleep(3000);
        continue;
      }
      console.log('sample failed, reloading:', e.message);
      await page.reload().catch(() => {});
    }
    if (stoppedNote) {
      fs.writeFileSync('live-run-stopped', '1');
      break;
    }
    if (Date.now() >= end) break;
    await sleep(Math.max(1000, EVERY_MS - (Date.now() - now)));
  }
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.log('runner failed:', e.stack || e);
  process.exit(1);
});
