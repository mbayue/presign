import { describe, expect, test } from 'bun:test';
import { address } from '@solana/kit';
import { fetchBlinkTransaction, fetchTransactionRequest } from '../../src/fetch/action-fetcher.ts';
import { untrusted } from '../../src/scan/types.ts';
import { createFakeFetch, createFakeResolve } from '../helpers/fake-http.ts';
import metadataAllTemplated from '../fixtures/actions/metadata-all-templated.json';
import metadataLinked from '../fixtures/actions/metadata-linked.json';
import metadataMissingIcon from '../fixtures/actions/metadata-missing-icon.json';
import metadataSimple from '../fixtures/actions/metadata-simple.json';
import postBad from '../fixtures/actions/post-bad-base64.json';
import postOk from '../fixtures/actions/post-ok.json';

const ACCOUNT = address('11111111111111111111111111111111');
const ACTION = 'https://shop.test/api/donate';
const resolve = createFakeResolve();

describe('fetchBlinkTransaction', () => {
  test('metadata-simple.json: GET then POST to the Action URL', async () => {
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { body: metadataSimple }, [`POST ${ACTION}`]: { body: postOk } });
    const res = await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: fake.fetch, resolve });
    expect(res).toEqual({
      ok: true,
      base64: 'AQIDBA==',
      metadata: {
        title: untrusted(metadataSimple.title),
        description: untrusted(metadataSimple.description),
        label: untrusted(metadataSimple.label),
        icon: untrusted(metadataSimple.icon),
      },
    });
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${ACTION}`, `POST ${ACTION}`]);
    expect(JSON.parse(fake.requests[1]?.body ?? '')).toEqual({ account: ACCOUNT });
  });

  test('metadata-linked.json: POSTs to the first non-templated href and counts the rest', async () => {
    const target = 'https://shop.test/api/donate/1';
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { body: metadataLinked }, [`POST ${target}`]: { body: postOk } });
    const res = await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: fake.fetch, resolve });
    expect(res.ok && res.linkedActionsNotScanned).toBe(2);
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${ACTION}`, `POST ${target}`]);
  });

  test('metadata-all-templated.json: INPUT_REQUIRED and no POST', async () => {
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { body: metadataAllTemplated } });
    const res = await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: fake.fetch, resolve });
    expect(res).toEqual({ ok: false, flag: { ruleId: 'INPUT_REQUIRED' } });
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  test('metadata-missing-icon.json: FETCH_FAILED missing-fields and no POST', async () => {
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { body: metadataMissingIcon } });
    const res = await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: fake.fetch, resolve });
    expect(res).toEqual({ ok: false, flag: { ruleId: 'FETCH_FAILED', reason: 'missing-fields' } });
    expect(fake.requests).toHaveLength(1);
  });

  test('post-bad-base64.json: FETCH_FAILED invalid-transaction', async () => {
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { body: metadataSimple }, [`POST ${ACTION}`]: { body: postBad } });
    expect(await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: fake.fetch, resolve })).toEqual({
      ok: false,
      flag: { ruleId: 'FETCH_FAILED', reason: 'invalid-transaction' },
    });
  });

  test('POST errors map to bad-status and invalid-json', async () => {
    const status = createFakeFetch({
      [`GET ${ACTION}`]: { body: metadataSimple },
      [`POST ${ACTION}`]: { status: 500, body: postOk },
    });
    expect(await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: status.fetch, resolve })).toEqual({
      ok: false,
      flag: { ruleId: 'FETCH_FAILED', reason: 'bad-status' },
    });
    const json = createFakeFetch({ [`GET ${ACTION}`]: { body: metadataSimple }, [`POST ${ACTION}`]: { body: '{oops' } });
    expect(await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: json.fetch, resolve })).toEqual({
      ok: false,
      flag: { ruleId: 'FETCH_FAILED', reason: 'invalid-json' },
    });
  });

  test('a disallowed Action URL sends nothing', async () => {
    const fake = createFakeFetch({});
    expect(await fetchBlinkTransaction('http://shop.test/api', ACCOUNT, { fetch: fake.fetch, resolve })).toEqual({
      ok: false,
      flag: { ruleId: 'DISALLOWED_URL' },
    });
    expect(fake.requests).toHaveLength(0);
  });

  test('a linked href on a private address is DISALLOWED_URL with no POST', async () => {
    const meta = { ...metadataSimple, links: { actions: [{ href: 'https://internal.test/x', label: 'x' }] } };
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { body: meta } });
    const res = await fetchBlinkTransaction(ACTION, ACCOUNT, {
      fetch: fake.fetch,
      resolve: createFakeResolve({ 'internal.test': ['10.9.9.9'] }),
    });
    expect(res).toEqual({ ok: false, flag: { ruleId: 'DISALLOWED_URL' } });
    expect(fake.requests).toHaveLength(1);
  });

  test('a metadata network error is FETCH_FAILED network', async () => {
    const fake = createFakeFetch({ [`GET ${ACTION}`]: { networkError: true } });
    expect(await fetchBlinkTransaction(ACTION, ACCOUNT, { fetch: fake.fetch, resolve })).toEqual({
      ok: false,
      flag: { ruleId: 'FETCH_FAILED', reason: 'network' },
    });
  });
});

describe('fetchTransactionRequest', () => {
  const TR = 'https://pay.test/tx';

  test('GET failure is ignored and the POST still happens', async () => {
    const fake = createFakeFetch({ [`GET ${TR}`]: { status: 500 }, [`POST ${TR}`]: { body: postOk } });
    const res = await fetchTransactionRequest(TR, ACCOUNT, { fetch: fake.fetch, resolve });
    expect(res).toEqual({ ok: true, base64: 'AQIDBA==' });
    expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
  });

  test('label and icon from the GET are kept', async () => {
    const fake = createFakeFetch({
      [`GET ${TR}`]: { body: { label: 'Coffee', icon: 'https://pay.test/i.png' } },
      [`POST ${TR}`]: { body: postOk },
    });
    const res = await fetchTransactionRequest(TR, ACCOUNT, { fetch: fake.fetch, resolve });
    expect(res.ok && res.metadata).toEqual({ label: untrusted('Coffee'), icon: untrusted('https://pay.test/i.png') });
  });

  test('bad POST body is FETCH_FAILED', async () => {
    const fake = createFakeFetch({ [`POST ${TR}`]: { body: postBad } });
    expect(await fetchTransactionRequest(TR, ACCOUNT, { fetch: fake.fetch, resolve })).toEqual({
      ok: false,
      flag: { ruleId: 'FETCH_FAILED', reason: 'invalid-transaction' },
    });
  });
});
