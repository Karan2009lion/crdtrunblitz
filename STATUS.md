# CRDTrade Blitz test (paper, separate account)

Updated **17 Nov, 11:31 pm IST** · refreshes every minute: reload this page to see the latest · [run log](https://github.com/Karan2009lion/crdtrunblitz/actions/runs/44120307441)

> **Test finished at 17 Nov, 11:31 pm IST, as planned. The results below are final.**

| | |
|---|---|
| Bot | **Finished** · decides every minute on 1-minute momentum, buys and shorts, at most 0.5% lost a trade · $5.00–$10.00 a trade · paper money (started with $150.00), no real orders |
| Account value | **$149.78** (−$0.22, −0.14% since start) |
| Just holding BTC instead | −0.19% |
| Cash | $139.79 |
| Blitz | Not used today · to start it, ask Claude or create a branch named `blitz-2026-11-17` |
| Open trade | Sold short 0.00016 BTC at $63,791.39, stop $65,705.13, target $59,198.41 · now −$0.01 |
| Trades | 3 (1 won) · fees paid $0.14 |
| BTC price | $63,807.54 ·  |
| Running since | 17 Nov, 9:28 pm IST (2h 2m) · time without prices: none |

![The bot's screen right now](live.jpg?v=29915641)

## Last trades

| Opened | Closed | Side | Entry | Exit | Profit | Why it closed |
|---|---|---|---|---|---|---|
| 17 Nov, 11:05 pm IST | 17 Nov, 11:28 pm IST | Short | $63,676.08 | $63,784.45 | −$0.10 (−0.32%) | its 2 hours are up |
| 17 Nov, 10:37 pm IST | 17 Nov, 10:57 pm IST | Buy | $64,039.93 | $63,750.51 | −$0.18 (−0.60%) | Stop loss hit |
| 17 Nov, 9:48 pm IST | 17 Nov, 10:29 pm IST | Short | $64,051.31 | $63,804.25 | +$0.07 (+0.24%) | Trailing stop hit (profit locked) |

## The bot's log (newest first)

- 17 Nov, 11:29 pm IST · **sell** · Shorted $10.00 of BTC/USDT at 63,791.39 (stop 65,705.13, target 59,198.41). Score -75: MACD histogram turned negative.
- 17 Nov, 11:28 pm IST · **info** · Blitz ended: its 2 hours are up. 3 trades, 1 won, −$0.21 after $0.13 of fees. Next Blitz from midnight.
- 17 Nov, 11:28 pm IST · **buy** · Covered BTC/USDT at 63,784.45 for −$0.10 (-0.32%). its 2 hours are up.
- 17 Nov, 11:23 pm IST · **think** · BTC/USDT: holding short, score +13. Unrealised −$0.11. Stop 63,951.22.
- 17 Nov, 11:12 pm IST · **think** · BTC/USDT: holding short, score -13. Unrealised −$0.01. Stop 63,951.22.
- 17 Nov, 11:05 pm IST · **sell** · Blitz: Shorted $30.00 of BTC/USDT at 63,676.08 (stop 63,994.46). Limit order filled. Score -30: MACD momentum is negative; Short-term trend is down; RSI 36.9 is falling.
- 17 Nov, 11:05 pm IST · **info** · Blitz: waiting to sell short $30.00 at 63,676.08 or better (limit order, up to 3 minutes; now 63,654.65). Score -30: MACD momentum is negative; Short-term trend is down; RSI 36.9 is falling.
- 17 Nov, 11:02 pm IST · **think** · BTC/USDT: score -10, needs ±30 to trade. Waiting for the next 1-minute candle. Short-term trend is down; MACD momentum is negative.
- 17 Nov, 10:58 pm IST · **warn** · BTC/USDT: sell signal -35 skipped: waiting 6s more after the last sale.
- 17 Nov, 10:57 pm IST · **sell** · Sold BTC/USDT at 63,750.51 for −$0.18 (-0.60%). Stop loss hit.
- 17 Nov, 10:51 pm IST · **think** · BTC/USDT: holding long, score +23. Unrealised +$0.01. Stop 63,770.45.
- 17 Nov, 10:41 pm IST · **think** · BTC/USDT: holding long, score +19. Unrealised −$0.04. Stop 63,719.73.
- 17 Nov, 10:37 pm IST · **buy** · Blitz: Bought $30.00 of BTC/USDT at 64,039.93 (stop 63,719.73). Limit order filled. Score +35: 9 EMA crossed above 21 EMA; Price is stretched above the upper Bollinger Band; MACD momentum is positive.
- 17 Nov, 10:37 pm IST · **info** · Blitz: waiting to buy $30.00 at 64,039.93 or better (limit order, up to 3 minutes; now 64,073.10). Score +35: 9 EMA crossed above 21 EMA; Price is stretched above the upper Bollinger Band; MACD momentum is positive.
- 17 Nov, 10:31 pm IST · **think** · BTC/USDT: score -4, needs ±30 to trade. Waiting for the next 1-minute candle. MACD momentum is positive; RSI 44.1 is falling; Short-term trend is down.
- 17 Nov, 10:29 pm IST · **buy** · Covered BTC/USDT at 63,804.25 for +$0.07 (+0.24%). Trailing stop hit (profit locked).
- 17 Nov, 10:20 pm IST · **think** · BTC/USDT: holding short, score -11. Unrealised +$0.12. Stop 64,009.26.
- 17 Nov, 10:10 pm IST · **think** · BTC/USDT: holding short, score -9. Unrealised +$0.07. Stop 64,094.50.
- 17 Nov, 9:59 pm IST · **think** · BTC/USDT: holding short, score -18. Unrealised +$0.02. Stop 64,226.82.
- 17 Nov, 9:49 pm IST · **think** · BTC/USDT: holding short, score -12. Unrealised $0.00. Stop 64,368.93.

---

history.csv on this branch has the price and account value for every minute. To stop the bot, ask Claude, or create a branch named `stop-live-run`.