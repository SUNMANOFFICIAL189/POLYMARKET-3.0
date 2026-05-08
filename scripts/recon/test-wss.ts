// Throwaway: probe WSS connectivity on free Polygon RPC endpoints.
import { WebSocketProvider } from 'ethers';

const URLS = [
  'wss://polygon-bor-rpc.publicnode.com',
  'wss://polygon-pokt.nodies.app',
  'wss://polygon.gateway.tenderly.co',
  'wss://polygon.publicnode.com',
  'wss://polygon-bor.publicnode.com',
  'wss://rpc-mainnet.matic.quiknode.pro',
  'wss://polygon-mainnet.public.blastapi.io',
  'wss://ws-matic-mainnet.chainstacklabs.com',
];

async function probe(url: string, timeoutMs = 6000): Promise<{ ok: boolean; block?: number; err?: string }> {
  return new Promise((resolve) => {
    let provider: WebSocketProvider | null = null;
    let settled = false;
    const finish = (r: { ok: boolean; block?: number; err?: string }) => {
      if (settled) return;
      settled = true;
      try { provider?.destroy(); } catch {}
      resolve(r);
    };
    try {
      provider = new WebSocketProvider(url);
      // ethers WebSocketProvider surfaces the underlying ws errors via emit('error')
      provider.on('error', (e: unknown) => finish({ ok: false, err: String((e as Error)?.message ?? e) }));
      provider.getBlockNumber()
        .then((n) => finish({ ok: true, block: n }))
        .catch((e) => finish({ ok: false, err: (e as Error).message }));
    } catch (e) {
      finish({ ok: false, err: (e as Error).message });
    }
    setTimeout(() => finish({ ok: false, err: 'timeout' }), timeoutMs);
  });
}

(async () => {
  for (const url of URLS) {
    const r = await probe(url);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${url} ${r.ok ? `block=${r.block}` : `err=${r.err}`}`);
  }
  process.exit(0);
})();
