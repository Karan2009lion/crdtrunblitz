import { useState } from 'react';
import { useStore, startCash, startLabel } from '../store/useStore';
import { usePrices } from '../hooks/useMarket';
import { equity } from '../engine/broker';
import { money, pct, signedMoney } from '../lib/format';
import { BrandMark, Icon } from './Icon';
import { LOGIN_HASH, signOut } from '../login';
import { ConfirmDialog } from './ConfirmDialog';

export function TopBar() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const cash = useStore((s) => s.cash);
  const positions = useStore((s) => s.positions);
  const resetAccount = useStore((s) => s.resetAccount);
  const view = useStore((s) => s.view);
  const tradingMode = useStore((s) => s.tradingMode);
  const setView = useStore((s) => s.setView);
  const prices = usePrices();
  const [confirmReset, setConfirmReset] = useState(false);

  const account = useStore((s) => s.account);
  const testStart = useStore((s) => s.test?.startEquity);
  const eq = equity({ cash, positions }, prices);
  // Before a real test starts there is nothing to compare with yet.
  const startEquity = testStart ?? (tradingMode === 'paper' ? startCash(account) : eq);
  const pnl = eq - startEquity;
  const tone = pnl > 0.005 ? 'up' : pnl < -0.005 ? 'down' : '';

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        CRDTrade
        <span className="paper-badge" data-mode={tradingMode}>
          {tradingMode === 'live' ? 'REAL MONEY · BTC' : tradingMode === 'testnet' ? 'Binance Testnet · BTC' : 'Paper trading · BTC'}
        </span>
      </div>

      <div className="segmented view-switch" role="tablist" aria-label="Mode">
        <button role="tab" aria-selected={view === 'live'} onClick={() => setView('live')}>
          Trade
        </button>
        <button role="tab" aria-selected={view === 'backtest'} onClick={() => setView('backtest')}>
          Backtest
        </button>
        <button role="tab" aria-selected={view === 'profile'} onClick={() => setView('profile')}>
          Profile
        </button>
      </div>

      <div className="account" aria-label="Account summary">
        <div className="stat">
          <span className="stat-label">Balance</span>
          <span className="stat-value num">{money(eq)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Profit</span>
          <span className={`stat-value num ${tone}`}>
            {signedMoney(pnl)} <small>({pct((pnl / startEquity) * 100)})</small>
          </span>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          className="btn btn-icon btn-ghost"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="btn btn-icon btn-ghost" onClick={() => setConfirmReset(true)} title="Start over" aria-label="Start over with a new paper test">
          <Icon name="reset" />
        </button>
        {LOGIN_HASH && (
          <button className="btn btn-sm btn-ghost" onClick={signOut} title="Sign out of this browser">
            Sign out
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title={tradingMode === 'paper' ? `Start over with ${startLabel(account)}?` : 'Start a new test?'}
        body={
          tradingMode === 'paper'
            ? 'This stops the bot and erases the paper test: every position, trade, hourly record and log entry. Download the test report first if you want to keep it. Afterwards you can choose dollars or rupees on the Profile screen.'
            : 'This stops the bot and erases the test record: trades, hourly records and log. Your Binance balances are not touched. Download the test report first if you want to keep it.'
        }
        confirmLabel="Erase and start over"
        danger
        onConfirm={() => {
          const err = resetAccount();
          if (err) useStore.getState().toast('bad', err);
          setConfirmReset(false);
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </header>
  );
}
