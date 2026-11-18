# CRDTrade Blitz test (paper, separate account)

Updated **18 Nov, 7:51 pm IST** · refreshes every minute: reload this page to see the latest · [run log](https://github.com/Karan2009lion/crdtrunblitz/actions/runs/44301724533)

> **Test finished at 18 Nov, 7:51 pm IST, as planned. The results below are final.**

| | |
|---|---|
| Bot | **Finished** · decides every minute on 1-minute momentum, buys and shorts, at most 0.5% lost a trade · $5.00–$10.00 a trade · paper money (started with $150.00), no real orders |
| Account value | **$149.81** (−$0.19, −0.13% since start) |
| Just holding BTC instead | −0.39% |
| Cash | $149.81 |
| Blitz | Not used today · to start it, ask Claude or create a branch named `blitz-2026-11-18` |
| Open trade | None: waiting for 1-minute momentum to turn |
| Trades | 2 (0 won) · fees paid $0.09 |
| BTC price | $63,998.30 ·  |
| Running since | 18 Nov, 5:46 pm IST (2h 4m) · time without prices: none |

![The bot's screen right now](live.jpg?v=29916861)

## Last trades

| Opened | Closed | Side | Entry | Exit | Profit | Why it closed |
|---|---|---|---|---|---|---|
| 18 Nov, 7:33 pm IST | 18 Nov, 7:40 pm IST | Buy | $63,986.02 | $63,884.84 | −$0.09 (−0.31%) | Stop loss hit |
| 18 Nov, 6:14 pm IST | 18 Nov, 6:23 pm IST | Short | $64,024.60 | $64,134.58 | −$0.10 (−0.32%) | Buy/sell pressure: out |

## The bot's log (newest first)

- 18 Nov, 7:47 pm IST · **think** · BTC/USDT: score +21, needs ±50 to trade. Waiting for the next 1-minute candle. MACD momentum is positive and rising.
- 18 Nov, 7:46 pm IST · **info** · Blitz ended: its 2 hours are up. 2 trades, 0 won, −$0.19 after $0.09 of fees. Next Blitz from midnight.
- 18 Nov, 7:40 pm IST · **sell** · Sold BTC/USDT at 63,884.84 for −$0.09 (-0.31%). Stop loss hit.
- 18 Nov, 7:33 pm IST · **buy** · Blitz: Bought $30.00 of BTC/USDT at 63,986.02 (stop 63,891.32). Limit order filled. Buy/sell pressure.
- 18 Nov, 7:33 pm IST · **info** · Blitz: waiting to buy $30.00 at 63,986.02 or better (limit order, up to 3 minutes; now 63,995.49). Buy/sell pressure.
- 18 Nov, 6:23 pm IST · **buy** · Covered BTC/USDT at 64,134.58 for −$0.10 (-0.32%). Buy/sell pressure: out.
- 18 Nov, 6:14 pm IST · **sell** · Blitz: Shorted $30.00 of BTC/USDT at 64,024.60 (stop 64,180.89). Limit order filled. Buy/sell pressure.
- 18 Nov, 6:13 pm IST · **info** · Blitz: waiting to sell short $30.00 at 64,024.60 or better (limit order, up to 3 minutes; now 64,008.97). Buy/sell pressure.
- 18 Nov, 5:46 pm IST · **info** · Blitz started: quick trades on the 1-minute chart until 07:46 PM. Buys or sells short whenever the 1-minute chart leans one way (score ±30) and holds while it keeps going, behind a stop that trails 0.5% behind the best price. $20.00–$30.00 a trade. It stops early if the session loses 2% ($3.00). Every trade pays fees, so expect small losses.
- 18 Nov, 5:46 pm IST · **info** · Bot started on BTC/USDT: buys when 1-minute momentum turns up, sells short when it turns down, stop 2.5× and target 6× the typical 1-minute move (stop at least 3% away), each trade sized so its stop loses your set % of the account. Your settings: decides every minute, at most 0.5% of the account lost a trade, $5–$10 a trade, buys and shorts, neural network may skip trades once trusted. Next decision at 05:47 PM when the current 1-minute candle closes.

---

history.csv on this branch has the price and account value for every minute. To stop the bot, ask Claude, or create a branch named `stop-live-run`.