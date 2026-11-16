import { useEffect } from 'react';
import { useStore } from './store/useStore';
import { TopBar } from './components/TopBar';
import { ChartPanel } from './components/ChartPanel';
import { BotPanel } from './components/BotPanel';
import { BottomTabs } from './components/BottomTabs';
import { Toasts } from './components/Toasts';
import { BacktestView } from './components/backtest/BacktestView';
import { ProfileView } from './components/ProfileView';

export default function App() {
  const theme = useStore((s) => s.theme);
  const view = useStore((s) => s.view);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="app">
      <div>
        <TopBar />
      </div>
      {view === 'live' ? (
        <main className="main">
          <ChartPanel />
          <BotPanel />
          <BottomTabs />
        </main>
      ) : view === 'backtest' ? (
        <BacktestView />
      ) : (
        <ProfileView />
      )}
      <Toasts />
    </div>
  );
}
