import type { Candle } from '../types';
import { MarketHub } from '../market/hub';
import { fetchBinanceKlines } from '../market/history';
import { MARKET, SYMBOL } from '../store/useStore';
import { LOOKBACK } from './features';
import { learnFromHistory, onCandleClosed } from './learner';
import { useAi } from './useAi';

/** Its own 1-minute feed, so the AI learns whichever strategy the bot trades. */
const aiHub = new MarketHub('1m');
const HISTORY_DAYS = 7;
let busy = false;
let ready = false;

const closedOnly = (candles: Candle[], nowSec: number) => candles.filter((c) => c.time + 60 <= nowSec);

/** Learns from the minutes it hasn't seen: the last 7 days the first time, or what it missed while closed. */
async function catchUp() {
  if (busy) return;
  busy = true;
  const { learner } = useAi.getState();
  const now = Math.floor(Date.now() / 1000);
  const from = learner.samples === 0 ? now - HISTORY_DAYS * 86_400 : Math.max(now - HISTORY_DAYS * 86_400, learner.trainedUntil - (LOOKBACK + 5) * 60);
  try {
    if (now - from > 20 * 60) {
      useAi.setState({
        status: 'loading',
        message: learner.samples === 0 ? 'Downloading 7 days of 1-minute BTC prices to learn from…' : 'Learning from the minutes missed while the app was closed…',
      });
      const candles = await fetchBinanceKlines(SYMBOL, '1m', from, now);
      useAi.setState({ learner: learnFromHistory(useAi.getState().learner, closedOnly(candles, now)) });
    }
    useAi.setState({ status: 'learning', message: '' });
  } catch (e) {
    useAi.setState({ status: 'offline', message: `Couldn't download price history (${(e as Error).message}). Learning from live prices instead.` });
  } finally {
    busy = false;
    ready = true;
  }
}

export function initAi() {
  aiHub.onBar((_symbol, candles, closed) => {
    if (!closed || busy || !ready) return;
    useAi.setState({ learner: onCandleClosed(useAi.getState().learner, candles.slice(0, -1)) });
  });
  aiHub.watch(SYMBOL, (full) => full && void catchUp());
  aiHub.sync([MARKET]);
}
