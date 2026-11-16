import { create } from 'zustand';
import { realApi, type Balances, type RealStatus } from './api';

interface RealStore {
  /** 'unavailable' when the app wasn't started with its local server (for example `npm run dev`). */
  state: 'checking' | 'unavailable' | 'disconnected' | 'connected';
  environment?: 'testnet' | 'live';
  keyHint?: string;
  balances?: Balances;
  updatedAt?: number;
  message?: string;
}

/** The Binance connection as the local server reports it. Never saved: the server holds the key. */
export const useReal = create<RealStore>()(() => ({ state: 'checking' }));

const apply = (s: RealStatus) =>
  useReal.setState({
    state: s.connected ? 'connected' : 'disconnected',
    environment: s.environment,
    keyHint: s.keyHint,
    balances: s.balances ?? (s.connected ? useReal.getState().balances : undefined),
    updatedAt: s.balances ? Date.now() : useReal.getState().updatedAt,
    message: undefined,
  });

export async function refreshReal(): Promise<void> {
  try {
    const s = await realApi.status();
    if (s.connected) apply(await realApi.balances());
    else apply(s);
  } catch (e) {
    useReal.setState({ state: 'unavailable', message: (e as Error).message });
  }
}

export async function connectReal(environment: 'testnet' | 'live', apiKey: string, apiSecret: string): Promise<string | null> {
  try {
    const s = await realApi.connect(environment, apiKey, apiSecret);
    apply(s);
    return s.withdrawCheck === 'unknown' ? "Connected. Binance didn't say whether this key can withdraw money: make sure withdrawals are off for it." : null;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function disconnectReal(): Promise<void> {
  try {
    apply(await realApi.disconnect());
  } catch (e) {
    useReal.setState({ message: (e as Error).message });
  }
}
