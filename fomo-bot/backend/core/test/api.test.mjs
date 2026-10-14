import test from 'node:test';
import assert from 'node:assert/strict';
import { config, USDC, SOL } from '../src/config.mjs';
import { validateQuote, Http, Jupiter } from '../src/api.mjs';
import { cleanError } from '../src/util.mjs';
const c = config({});
export function quote(input = USDC, output = SOL, amount = '1000000', out = '10000000') {
  return { inputMint: input, outputMint: output, inAmount: String(amount), outAmount: String(out),
    otherAmountThreshold: String(BigInt(out) * 9950n / 10000n), slippageBps: 50, priceImpact: -0.1,
    feeBps: 10, swapMode: 'ExactIn', router: 'metis', receivedAt: Date.now() };
}
test('quotes reject excessive slippage, fees, substituted mints and malformed raw quantities', () => {
  const q = quote(); assert.doesNotThrow(() => validateQuote(q, USDC, SOL, '1000000', c));
  for (const modified of [{ ...q, slippageBps: 500 }, { ...q, feeBps: 50 }, { ...q, inputMint: SOL },
    { ...q, outAmount: '1e9' }, { ...q, otherAmountThreshold: '1' }, { ...q, priceImpact: undefined }])
    assert.throws(() => validateQuote(modified, USDC, SOL, '1000000', c));
});
test('execution timeout is attempted once, never duplicated', async () => {
  let attempts = 0;
  const http = new Http(0, async () => { attempts++; throw new Error('timeout'); });
  const api = new Jupiter(c, http);
  await assert.rejects(() => api.execute('bytes', 'request'));
  assert.equal(attempts, 1);
});
test('read-only API requests can recover from transient errors', async () => {
  let calls = 0;
  const http = new Http(0, async () => { calls++; if (calls === 1) throw new Error('temporary'); return { ok: true, json: async () => ({ value: 1 }) }; });
  assert.deepEqual(await http.request('https://example.invalid'), { value: 1 });
  assert.equal(calls, 2);
});
test('order requests include the accepted minimum tip and transaction ceiling', async () => {
  let requested;
  const api = new Jupiter(c,new Http(0,async url => {
    requested = new URL(url);
    return { ok:true,json:async () => quote() };
  }));
  await api.quote(USDC,SOL,'1000000');
  assert.equal(requested.searchParams.get('jitoTipLamports'),'1000');
  assert.equal(requested.searchParams.get('maxSupportedTransactionVersion'),'0');
});
test('HTTP validation details are useful and credentials are redacted by the CLI sanitizer', async () => {
  const http = new Http(0,async () => ({ ok:false,status:400,json:async () => ({ error:{issues:[{path:['jitoTipLamports'],message:'must be >= 1000 secret-key'}]} }) }));
  await assert.rejects(http.request('https://invalid'), error => {
    const text = cleanError(error,{ apiKey:'secret-key' });
    assert.match(text,/jitoTipLamports: must be >= 1000/);
    assert.ok(!text.includes('secret-key')); return true;
  });
});
