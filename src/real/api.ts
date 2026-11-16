/** Talks to the local server (server/index.mjs), which signs Binance orders with the key saved on this computer. */

export interface Balances {
  canTrade: boolean;
  USDT: { free: number; locked: number };
  BTC: { free: number; locked: number };
}
export interface RealStatus {
  connected: boolean;
  environment?: 'testnet' | 'live';
  keyHint?: string;
  connectedAt?: number;
  balances?: Balances;
}
export interface BuyResult {
  orderId: number;
  time: number;
  avgPrice: number;
  /** USDT spent. */
  quote: number;
  /** BTC received after Binance's fee. */
  qty: number;
  feeUsdt: number;
}
export interface SellResult {
  orderId: number;
  time: number;
  avgPrice: number;
  qty: number;
  /** USDT received after Binance's fee. */
  quote: number;
  feeUsdt: number;
}
export interface OrderStatus {
  orderId: number;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | string;
  qty: number;
  quote: number;
  avgPrice: number;
  time: number;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'x-crdtrade': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the app's local server. Keep the start.sh / start.bat window open.");
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error('Real trading needs the app started with start.sh or start.bat (its local server signs Binance orders).');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status}).`);
  return data as T;
}

export const realApi = {
  status: () => call<RealStatus>('GET', '/api/real/status'),
  connect: (environment: 'testnet' | 'live', apiKey: string, apiSecret: string) =>
    call<RealStatus & { withdrawCheck?: 'off' | 'unknown' }>('POST', '/api/real/connect', { environment, apiKey, apiSecret }),
  disconnect: () => call<RealStatus>('POST', '/api/real/disconnect', {}),
  balances: () => call<RealStatus & { balances: Balances }>('GET', '/api/real/balances'),
  buy: (quote: number) => call<BuyResult>('POST', '/api/real/buy', { quote }),
  sell: (qty: number) => call<SellResult>('POST', '/api/real/sell', { qty }),
  stop: (qty: number, stopPrice: number) => call<{ orderId: number; qty: number; stopPrice: number; limitPrice: number }>('POST', '/api/real/stop', { qty, stopPrice }),
  cancel: (orderId: number) => call<{ cancelled: boolean; order?: OrderStatus }>('POST', '/api/real/cancel', { orderId }),
  order: (orderId: number) => call<OrderStatus>('GET', `/api/real/order?orderId=${orderId}`),
};
