# CRDTrade Blitz test (paper, separate account)

Updated **19 Nov, 10:57 am IST** · refreshes every minute: reload this page to see the latest · [run log](https://github.com/Karan2009lion/crdtrunblitz/actions/runs/44450484788)

> **Test finished at 19 Nov, 10:57 am IST, as planned. The results below are final.**

| | |
|---|---|
| Bot | **Finished** · decides every minute on 1-minute momentum, buys and shorts, at most 0.5% lost a trade · $5.00–$10.00 a trade · paper money (started with $150.00), no real orders |
| Account value | **$150.19** (+$0.19, +0.12% since start) |
| Just holding BTC instead | +1.37% |
| Cash | $140.20 |
| Blitz | Not used today · to start it, ask Claude or create a branch named `blitz-2026-11-19` |
| Open trade | Bought 0.00016 BTC at $63,560.12, stop $61,653.32, target $68,136.45 · now −$0.02 |
| Trades | 2 (1 won) · fees paid $0.10 |
| BTC price | $63,457.00 ·  |
| Running since | 19 Nov, 8:48 am IST (2h 8m) · time without prices: none |

![The bot's screen right now](live.jpg?v=29917767)

## Last trades

| Opened | Closed | Side | Entry | Exit | Profit | Why it closed |
|---|---|---|---|---|---|---|
| 19 Nov, 8:52 am IST | 19 Nov, 10:48 am IST | Buy | $62,683.09 | $63,419.41 | +$0.31 (+1.02%) | its 2 hours are up |
| 19 Nov, 8:51 am IST | 19 Nov, 8:51 am IST | Short | $62,631.01 | $62,739.71 | −$0.10 (−0.32%) | Stop loss hit |

## The bot's log (newest first)

- 19 Nov, 10:56 am IST · **buy** · Bought $10.00 of BTC/USDT at 63,560.12 (stop 61,653.32, target 68,136.45). Score +75: MACD histogram turned positive. Neural network: 16% chance of reaching the target.
- 19 Nov, 10:49 am IST · **think** · BTC/USDT: score -39, needs ±50 to trade. Waiting for the next 1-minute candle. MACD momentum is negative but easing.
- 19 Nov, 10:48 am IST · **info** · Blitz ended: its 2 hours are up. 2 trades, 1 won, +$0.21 after $0.09 of fees. Next Blitz from midnight.
- 19 Nov, 10:48 am IST · **sell** · Sold BTC/USDT at 63,419.41 for +$0.31 (+1.02%). its 2 hours are up.
- 19 Nov, 8:52 am IST · **buy** · Blitz: Bought $30.00 of BTC/USDT at 62,683.09 (stop 62,375.92). Limit order filled. Trend switch.
- 19 Nov, 8:52 am IST · **info** · Blitz: waiting to buy $30.00 at 62,683.09 or better (limit order, up to 3 minutes; now 62,697.03). Trend switch.
- 19 Nov, 8:51 am IST · **buy** · Covered BTC/USDT at 62,739.71 for −$0.10 (-0.32%). Stop loss hit.
- 19 Nov, 8:51 am IST · **sell** · Blitz: Shorted $30.00 of BTC/USDT at 62,631.01 (stop 62,709.73). Limit order filled. Trend switch.
- 19 Nov, 8:49 am IST · **info** · Blitz: waiting to sell short $30.00 at 62,631.01 or better (limit order, up to 3 minutes; now 62,617.89). Trend switch.
- 19 Nov, 8:48 am IST · **info** · Blitz started: quick trades on the 1-minute chart until 10:48 AM. Buys or sells short whenever the 1-minute chart leans one way (score ±30) and holds while it keeps going, behind a stop that trails 0.5% behind the best price. $20.00–$30.00 a trade. It stops early if the session loses 2% ($3.00). Every trade pays fees, so expect small losses.
- 19 Nov, 8:48 am IST · **info** · Bot started on BTC/USDT: buys when 1-minute momentum turns up, sells short when it turns down, stop 2.5× and target 6× the typical 1-minute move (stop at least 3% away), each trade sized so its stop loses your set % of the account. Your settings: decides every minute, at most 0.5% of the account lost a trade, $5–$10 a trade, buys and shorts, neural network may skip trades once trusted. Next decision at 08:49 AM when the current 1-minute candle closes.

---

history.csv on this branch has the price and account value for every minute. To stop the bot, ask Claude, or create a branch named `stop-live-run`.