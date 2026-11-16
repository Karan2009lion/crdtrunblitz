# CRDTrade: BTC trader

A trading bot for **Bitcoin (BTC/USDT)** that runs in your browser on live Binance prices. Press
**Start bot** and it trades on its own: it buys when 4-hour momentum turns up, **sells short when it
turns down** (so it can profit in a downtrend), and watches its stop and target on every price
update. Each trade is sized from your money: if its stop is hit it loses at most the share of the
account you choose (0.5% by default, fees included), so a small account makes small trades.

It starts with **$10,000 of practice money** and explains every decision in a log. Real trading on
Binance is optional (Profile screen).

It is built for a long, unattended test: leave it running for days, then download a report.

## Quick start

You need **Node.js 22 LTS** (or 20.19 or newer) from <https://nodejs.org> and **Git** from
<https://git-scm.com>.

**macOS / Linux** (Terminal):

```bash
git clone -b claude/paper-trading-bot https://github.com/Karan2009lion/CRDTrade.git
cd CRDTrade
./start.sh
```

**Windows** (Command Prompt or PowerShell):

```bat
git clone -b claude/paper-trading-bot https://github.com/Karan2009lion/CRDTrade.git
cd CRDTrade
start.bat
```

The script checks Node.js, installs the dependencies, builds the app for your computer, and
starts it at **<http://localhost:4173>** with the app's own small local server (`server/index.mjs`),
which also handles real trading. It opens your browser for you. Keep that terminal window open.
Pressing Ctrl+C stops the app.

- **Starting it again later.** Run `./start.sh` or `start.bat` again from the same folder. Your paper test is
  saved in the browser, so it carries on where it left off.
- **Getting the latest version.** Run `./start.sh --update` or `start.bat --update`.
- **Without Git.** Download the ZIP from
  <https://github.com/Karan2009lion/CRDTrade/archive/refs/heads/claude/paper-trading-bot.zip>,
  unzip it, and run `start.sh` or `start.bat` from inside the folder. `--update` needs Git.

The main screen is kept simple: **Start bot**, the chart, the open trade, and a list of finished
trades (bought at, sold at, profit, balance). Everything else is on **Profile**: your settings, the
fees and tax, what the bot has learned, the test record and real trading.

On Profile, under *Paper money*, choose **$10,000** or **₹1,00,000** before starting. A rupee account is held as USDT at the day's rupee rate (fetched when you choose it, or ₹95 per dollar if that fails) and fixed for the test; every amount then shows in rupees, while BTC prices stay in USDT as on Binance. To change it later, start over with the ↻ button.

## Running a 15-day test

The bot only trades while the page is open. To get a clean result:

1. **Keep both open.** Leave the terminal window and the browser tab open. A browser window
   of its own is best, so the tab is never in the background of a busy window.
2. **Stop the computer sleeping.** Set the computer never to sleep while plugged in.
   - macOS: *System Settings → Battery/Energy → Prevent automatic sleeping*.
   - Windows: *Settings → System → Power → Sleep: Never*.

   The app keeps the screen awake while the bot runs, if the browser allows it. The bot panel
   says whether it is doing so.
3. **Turn off tab sleeping.** In Chrome or Edge, turn off *Memory Saver* / *Sleeping tabs*, or
   add `localhost` to the sites that stay active.
4. **Always use <http://localhost:4173>.** The test is saved per address. `127.0.0.1` or another
   port would show an empty account.
5. **Use one browser and one tab.** Use the same browser and profile for the whole test, and don't
   clear its site data. If you open the app in a second tab, that tab waits and does not trade. It
   takes over only if the first tab closes.
6. **Download the report.** At the end, open **Profile** and press **Download test report** under
   *Test record*. The JSON file holds the summary, every trade, the hourly account value and the log.

### Windows: survive restarts

Windows can restart on its own for updates, which would close the app. Two steps prevent that,
or recover from it:

1. **Pause updates.** Go to *Settings → Windows Update → Pause updates*, and pause for 2 weeks.
2. **Start automatically.** Double-click `autostart.bat` in the CRDTrade folder once. From then on,
   signing in to Windows starts the app and opens the browser. The bot carries on with the same
   test and catches up on what it missed. To undo this, run `autostart.bat --off`. Windows only
   runs it after you sign in, so this works best on a PC that signs in without a password.

The app opens in your **default browser**, so run the test in that browser. On a laptop, also set
*Control Panel → Power Options → Choose what closing the lid does* to **Do nothing** while
plugged in.

The **Test record** on Profile compares the bot with simply holding BTC from the start. It also shows trades,
profit factor, biggest drop, fees, and how long the app went without live prices.

### If the app is closed, offline or asleep

When live prices return, the bot catches up:

- **Stops and targets.** For an open trade, it downloads the 1-minute candles it missed. If the
  stop loss or take profit was reached, it closes the trade at that level, at the time it
  happened. It closes at the open price instead if the price gapped past the level.
- **Decisions.** It makes the decision for the most recent finished 4-hour candle.
- **What it can't recover.** Entries on earlier candles that closed while it was away are lost.

Time without prices is counted and shown, so you can tell how clean the test was. A health line
in the bot panel shows whether prices are live. If Binance is unreachable, the app keeps
retrying on its own.

## The strategy

| | |
|---|---|
| Market | BTC/USDT, live Binance prices |
| Signal | Momentum (MACD) on **4-hour candles**, decided when each candle closes (00:00, 04:00, 08:00 … UTC) |
| Entry | Buys on a strong positive score (≥ 50), sells short on a strong negative one (paper only) |
| Trade size | Sized so the stop loses at most your set % of the account (default 0.5%), fees included |
| Stop loss | 2.5 × ATR (the typical 4-hour move) from the entry |
| Take profit | 6 × ATR from the entry |
| Watching | Stop and target checked on every live price update, about every second |
| Costs | 0.1% fee and 0.02% slippage on every order |

### How often it decides

Profile → *How often the bot decides* picks the candle size: **every minute, 15 minutes, hour or 4
hours** (default). On short candles a typical move is smaller than the fees, so stops there are kept
at least 3% away (the target widens with them); without that floor the 1-minute version lost the
whole account. Tested the same way (`scripts/timeframe-research.ts`), 0.5% at risk a trade:

| Decides | Mar 2025 – Mar 2026 | Apr – Oct 26, 2026 | Trades a month |
|---|---|---|---|
| Every minute | +7.5% | −2.0% | about 6 |
| Every 15 minutes | −6.5% | −2.0% | about 7 |
| Every hour | +6.3% | −2.3% | about 5 |
| **Every 4 hours** | **+9.0%** | **+2.6%** | about 3 |

Deciding more often did not make more money: 4 hours was the only one ahead in both periods.

### Blitz: 2 hours of quick trades, once a day

**Start Blitz** on the main screen trades the 1-minute chart quickly for up to 2 hours: it buys or
sells short whenever the chart leans one way (score ±30), and instead of selling at a fixed target
it holds while the move keeps going, behind a stop that trails 0.5% behind the best price (above it
for a short). Blitz can have its own amount per trade (Profile → *Blitz amount per trade*, e.g.
$20–$30), separate from normal trades. Limits, so it can't run away with the account:

- at most 2 hours, then it closes its trade and goes back to your normal settings;
- once a day (from midnight on your computer's clock);
- it stops early if the session has lost 2% of the balance;
- paper trading only. An open normal trade is closed first if you start Blitz.

No quick-trade rule beat the fees in testing: before fees they roughly break even, and each round
trip pays about 0.24% of the amount traded (bigger trades pay proportionally more). Letting winners
run behind a trailing stop lost about a quarter as much as selling at a fixed target
(`scripts/blitz-hold-research.ts`, $30 trades on $150, one 2-hour session a day):

| Blitz exits | Average session | Sessions that ended up | Best session | Trades |
|---|---|---|---|---|
| Sell at +0.45% or after 15 minutes | −$0.41 | 1% | +$0.28 | 5.6 |
| **Trailing stop 0.5% (now)** | **−$0.12** | **20%** | **+$0.99** | **2** |

Earlier Blitz research: `scripts/blitz-research.ts` (8 chart strategies × 4 quick exits) and
`scripts/blitz-speed-research.ts` (the faster the setting, the bigger the loss).

### Neural network

A small neural network (14 chart measurements, 12 hidden units, `src/trader/brain.ts`) learns from
every signal on your chosen candles, taken or not, how it ended, and estimates each new signal's
chance of reaching its target. Its estimate goes in the log with every trade. It learns from the
chosen candles' history when the app starts (2 years of 4-hour or 1-hour candles, 180 days of
15-minute, 10 days of 1-minute) and keeps learning as candles close.

It may **skip** a trade only once it has earned trust: at least 30 of the signals it would have
skipped must have finished, losing at least 0.15× the risk on average. Profile shows its record.
In a walk-forward test (`scripts/brain-research.ts`) it never earned trust on 4-hour or 1-hour
candles, so it changed nothing there; on 15-minute and 1-minute candles it briefly did, and cost 2–3%.
Left to filter without the trust rule it did worse than taking every signal, and a placebo trained on
shuffled results did about as well. So it is there to learn and to show its view, not as an edge.

There are no other filters: the old quiet-market filter made no difference once trades were sized
by risk, and the old Live 1-minute mode (with its 4-hour trend and choppy-market checks) lost money
on every period tested, so both are gone. The chart's timeframe buttons only change the chart.

### Before and after

On Binance 1-minute BTC prices, starting with $10,000 (`scripts/trader-report.ts`). The newest 19
days were kept hidden from all research until the end.

| | Mar 2025 – Mar 2026 | Apr – Oct 26, 2026 | Oct 27 – Nov 14, 2026 (hidden) | Worst trade | Biggest drop |
|---|---|---|---|---|---|
| Before: Live 1-minute mode | −72.7% | −41.5% | −4.9% | −$98 | 75.8% |
| Before: Tested 4-hour, whole account | +58.6% | +29.4% | +2.2% | −$929 | 22.7% |
| **Now: at most 0.5% lost a trade** | **+9.0%** | **+2.6%** | **−0.2%** | **−$55** | **2.6%** |
| Now: at most 1% | +18.5% | +5.1% | −0.4% | −$120 | 5.1% |
| Now: 0.5%, buys only (real trading) | −3.8% | +2.5% | −2.9% | −$52 | 6.8% |
| Holding BTC | −19.0% | +17.4% | −20.0% | | |

Sizing by risk makes the same signals far safer: the worst trade falls from −$929 to −$55 and the
biggest drop from 23% to under 3%, in exchange for smaller gains. **A 15-day run** usually brings
one to three trades: in the past, half of all 15-day windows ended up and half down, with the worst
at −1.9% and the best at +3.3% (0.5% setting). Past results don't predict future returns.

### Learning from mistakes

Every momentum signal in two years of 4-hour history, taken or not, is followed to its stop or
target, and the result is filed under one of 8 situations: buying or selling short, with or against
the bigger trend, in a calm or wild market. Profile shows the table and, for each losing trade, why
it lost. This is relearned every 4 hours.

The bot can also **skip situations that kept losing** (Profile → Learning from mistakes). It is off
by default because in a walk-forward test it did not help: on the older period it turned +18.0% into
−0.3%, and a placebo learner given shuffled results did as well as the real one, so the "lessons"
were mostly noise. The research also tried new intraday setups (pullbacks, breakouts, reversals and
momentum on 5-minute to 1-hour candles) with an online learner, hiding groups of inputs to check
whether it was learning or memorising: none were profitable after fees, and the learner did no
better than its placebo (`scripts/trader-research.ts`, `scripts/momentum-learning-research.ts`).

**News** isn't read: there is no free, reliable news feed the bot could be tested on. Big news
shows up in the price within seconds, and the stop on every trade limits the damage.

### Paper vs real trading

- **Short selling.** Shorts need a margin or futures account on a real exchange. Binance spot can't short,
  so real trading always buys first and sells later.
- **Fills.** Paper fills use the live price plus slippage. Real fills can be worse in fast markets.
- **Not advice.** The bot is a rule-based indicator strategy, not a prediction model.
  Results on paper do not predict real returns, and this app is not financial advice.

## Profile: settings, fees and tax

Open **Profile** in the top bar.

**Your money** goes from what you started with to what you keep: profit before fees, fees, profit
after fees, tax, and what you keep. Choose the tax system: **None**, **India (crypto)** (31.2% on the
gain of each winning trade, fees not deductible, losses don't reduce it; the 1% TDS on sales is shown
as part of that tax), or a **flat rate** on total profit. It is an estimate, not tax advice.

**Bot settings:**

| Setting | What it does |
|---|---|
| Paper money | $10,000 or ₹1,00,000, chosen before a test starts. |
| How often the bot decides | Every minute, 15 minutes, hour or 4 hours (default). |
| Most a trade can lose | Default 0.5% of the balance. Each trade is sized so its stop loses no more, fees included. |
| Most to spend on one trade | Optional cap; required for real trading. |
| Least to spend on one trade | Optional: a smaller risk-sized trade is raised to it (e.g. $5–$10 a trade on $150). |
| Trades a day | No limit, or at most this many new trades from midnight. |
| Trading hours | Any time, or only between two hours of your computer's clock (e.g. 03:00–05:00). A signal outside the hours waits for them while it is still current. Optionally closes the open trade when the hours end. |
| When BTC falls | Sell short (paper) or stay out. Real trading always stays out. |
| Loss limit | Once the test has lost this much, the bot closes its trade and stops. |
| Learning from mistakes | Record lessons only (default), or also skip situations that kept losing. |
| Neural network | Only watch and learn, or skip trades once trusted (default). |

Changes apply from the next trade.

### Trading on Binance

**Where the bot trades** has three choices:

- **Paper money** (default): practice money inside the app. Nothing goes to Binance.
- **Binance Testnet**: Binance's test exchange with free test money. Real orders, no real money. Its
  prices can differ from the real market, so use it to check the set-up works, not to judge profit.
  Get a key at testnet.binance.vision (log in with GitHub, then Generate HMAC_SHA256 Key).
- **Real money**: your Binance account. Needs a real-money API key, a most-to-spend amount, and a
  tick in "I understand the bot trades my real money and can lose it".

How it works and what keeps it safe:

- **Your keys stay on your computer.** The local server saves them in `.crdtrade/binance-keys.json`
  in the CRDTrade folder (never committed to git) and signs each order itself. The browser never
  sees the secret key. The server only answers this app on localhost.
- **Keys that can withdraw are refused.** When you connect a real-money key, the server asks Binance
  whether it can withdraw money and refuses to save it if so. In Binance API Management, enable
  Spot & Margin Trading only, and restrict the key to your IP address if you can.
- **The stop loss is held by Binance.** After each buy, the bot places a stop-loss order on Binance
  (a stop-limit, with its limit 0.5% under the stop so it fills in a fast drop). It protects the
  trade even when the app or your computer is off. Before selling for any other reason, the bot
  cancels it. If the price falls straight through the stop, the bot sells at market itself.
- **Cash is what Binance says.** The bot spends only the free USDT, one trade at a time, and reads
  the balance from Binance after every order. BTC you already held on Binance is never sold.
- **Every order is checked.** The app checks every 15 seconds whether Binance filled a stop, and
  if a sale fails after the stop was cancelled, it puts the stop back.

Before using real money: run on Testnet first and start with a small amount. Real trading only buys,
and buys alone made −3.8%, +2.5% and −2.9% in the three test periods above. In India, crypto profits are taxed at
30% plus cess on every winning trade, losses can't reduce it, and 1% TDS applies to sales. This
app does not file or deduct any tax.

## Backtest

**Backtest** in the top bar replays the same strategy, with your settings, over the last 1–120 days
of real Binance 1-minute prices. It uses the same code as the live bot, starts from a fresh $10,000, and checks
stops and targets on every minute's high and low. You can watch it instantly or as a 1, 5 or 20-minute replay.

## Running the bot on GitHub

The **Live paper bot** workflow (`.github/workflows/live-run.yml`) runs the bot on GitHub's
servers with $10,000 of paper money, so it keeps going while your computer
is off. Every minute it publishes `STATUS.md` on the `live-run` branch: the account, the open
trade, recent trades, the bot's log and a screenshot of the bot's screen
(`history.csv` there has every minute's price and account value).

- **Watch:** open `STATUS.md` on the `live-run` branch on GitHub and reload it.
- **Stop:** create a branch named `stop-live-run`. The bot stops within a minute and the page says so.
- **Start again:** delete that branch, then Actions → Live paper bot → Run workflow. It carries on
  from the saved account, or tick *Start a new test* and give a starting amount, how often it
  decides (1m, 15m, 1h or 4h) and, optionally, the least and most to spend on one trade.

Each run lasts about 5 h 40 min, saves the bot's state and starts the next one. An hourly
restart check can be switched on in the workflow file; it is off, because each check uses Actions
time even while the bot is stopped. In a private repository this uses GitHub Actions minutes:
the free plan includes 2,000 a month, about 33 hours of running.

## For developers

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # indicator, strategy, broker and backtest tests
npm run build      # static site in dist/
npm start          # serve dist/ and the real-trading API at http://localhost:4173
```

`npm run dev` has no local server, so real trading shows as unavailable there. To test real trading
without money or a network, run the stand-in Binance and point the server at it:

```bash
node scripts/mock-binance.mjs                                   # http://localhost:4180
BINANCE_TESTNET_URL=http://localhost:4180 npm start             # then connect with key test-api-key-0000000000
curl -X POST localhost:4180/mock/price -d '{"price":79000}'     # move the price; stops trigger
```

`server/server.test.mjs` runs the server against it as part of `npm test`.

The research behind the settings is reproducible. `scripts/research.ts` runs the walk-forward search on a CSV of
minute candles:

```bash
DATA=candles.csv npx vite-node scripts/research.ts -- grid v2 0 1 results.json
```

Earlier experiments are kept for reference: `scripts/trend-research.ts` with `src/engine/trend.ts`
(trend following), and `scripts/adaptive-research.ts` with `src/engine/adaptive.ts` (following
recent winners). The Binance data used in the research is on the `market-data` branch.

```
src/
  engine/      bot.ts (live loop, catch-up, hours and daily limit), rules.ts (buy/sell rules and
               risk sizing), broker.ts (paper fills), backtest.ts (replay, run in worker.ts)
  trader/      lessons.ts (situations, learning from history, loss causes), brain.ts (neural
               network and its trust record), useLessons.ts (learning from the chosen candles)
  market/      feeds.ts (Binance REST + WebSocket), hub.ts (candle store), history.ts
  lib/         indicators, strategies, formatting, wake lock
  store/       app state (zustand, saved to localStorage), backtest state
  components/  UI
start.sh / start.bat   build and run on your computer
```
