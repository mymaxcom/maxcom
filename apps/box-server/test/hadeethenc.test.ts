import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { guardedFetch } from '../src/net/safeFetch.ts';
import { createHadeethEnc, HadeethEncError } from '../src/hadis/hadeethenc.ts';
import { fakeHadeethEnc, fixture } from './support/fakeHadeethEnc.ts';

const BASE = 'https://hadeethenc.com/api/v1';

describe('HadeethEnc client: the guard is in the path', () => {
  it('refuses a non-https, private, credentialed or local base before any request', () => {
    const fake = fakeHadeethEnc();
    expect(() => createHadeethEnc(fake.fetch, 'http://x')).toThrow(/https/);
    expect(() => createHadeethEnc(fake.fetch, 'https://10.0.0.5/api')).toThrow(/public/);
    expect(() => createHadeethEnc(fake.fetch, 'https://u:p@hadeethenc.com/api')).toThrow();
    expect(() => createHadeethEnc(fake.fetch, 'https://localhost/api')).toThrow();
    expect(fake.calls).toEqual([]);
  });

  it('through guardedFetch, a host that resolves to a private address is refused before the inner fetch', async () => {
    const fake = fakeHadeethEnc();
    const guarded = guardedFetch(fake.fetch, async () => ['10.0.0.5']);
    const he = createHadeethEnc(guarded, BASE);
    expect(await he.probe()).toBe(false);
    await expect(he.one('66512')).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(fake.calls).toEqual([]);
  });

  it('a public host reaches the inner fetch with redirect refused, and the client asks for it too', async () => {
    const fake = fakeHadeethEnc();
    const inits: (RequestInit | undefined)[] = [];
    const spy = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      inits.push(init);
      return fake.fetch(input, init);
    }) as typeof fetch;
    await createHadeethEnc(guardedFetch(spy, async () => ['93.184.216.34']), BASE).one('66512');
    expect(inits[0]?.redirect).toBe('error');
    expect(inits[0]?.signal).toBeDefined();
    const direct: (RequestInit | undefined)[] = [];
    const he2 = createHadeethEnc(((i: Parameters<typeof fetch>[0], init?: RequestInit) => {
      direct.push(init);
      return fake.fetch(i, init);
    }) as typeof fetch, BASE);
    await he2.one('66512');
    expect(direct[0]?.redirect).toBe('error');
  });

  it('a redirect answer (the fetch throws under redirect: error) is a typed source error', async () => {
    const he = createHadeethEnc((async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    }) as unknown as typeof fetch, BASE);
    await expect(he.one('66512')).rejects.toBeInstanceOf(HadeethEncError);
  });

  it('cuts a body over 1 MB with the cap message', async () => {
    const big = (async () => new Response('x'.repeat(2 * 1024 * 1024))) as unknown as typeof fetch;
    const he = createHadeethEnc(big, BASE);
    await expect(he.one('66512')).rejects.toThrow(/too large/);
    await expect(he.one('66512')).rejects.toMatchObject({ code: 'source_bad_response' });
  });

  it('never builds a URL from a bad id, page or category', async () => {
    const fake = fakeHadeethEnc();
    const he = createHadeethEnc(fake.fetch, BASE);
    await expect(he.one('../x')).rejects.toThrow();
    await expect(he.one('1/../../x')).rejects.toThrow();
    await expect(he.one('123456789')).rejects.toThrow();
    await expect(he.one('')).rejects.toThrow();
    await expect(he.list('1; drop', 1, 10)).rejects.toThrow();
    await expect(he.list('1', 0, 10)).rejects.toThrow();
    await expect(he.list('1', 1, 101)).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

describe('HadeethEnc client: parsing', () => {
  it('one() parses the fixture, fixes language=ms, keeps intro and categories, drops the explanation', async () => {
    const fake = fakeHadeethEnc();
    const he = createHadeethEnc(fake.fetch, `${BASE}/`);
    const h = await he.one('66512');
    expect(fake.calls[0]).toBe(`${BASE}/hadeeths/one/?language=ms&id=66512`);
    expect(h).toMatchObject({
      id: '66512', gradeAr: 'صحيح', attributionAr: 'رواه البخاري ومسلم', categories: ['59', '79', '88', '456', '500', '512', '531'],
    });
    expect(h.introMs).toMatch(/bersabda:$/);
    expect(h.textMs.startsWith(h.introMs!)).toBe(true);
    expect(h.introAr).toBeNull();
    expect(h.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(h)).not.toContain('PENJELASAN');
    expect((await he.one('66512')).digest).toBe(h.digest);
    fake.one.set('66512', { ...fixture('one-66512'), hadeeth: `${String(fixture('one-66512').hadeeth)} tambahan` });
    expect((await he.one('66512')).digest).not.toBe(h.digest);
  });

  it('digest is sha256 of text, Arabic, attribution and grade joined by newlines', async () => {
    const fake = fakeHadeethEnc();
    const h = await createHadeethEnc(fake.fetch, BASE).one('66512');
    const expected = createHash('sha256').update(`${h.textMs}\n${h.textAr}\n${h.attributionAr}\n${h.gradeAr}`).digest('hex');
    expect(h.digest).toBe(expected);
  });

  it('normalises line ends and trims', async () => {
    const fake = fakeHadeethEnc();
    fake.one.set('66512', { ...fixture('one-66512'), hadeeth: '  Satu\r\nDua\r  ' });
    const h = await createHadeethEnc(fake.fetch, BASE).one('66512');
    expect(h.textMs).toBe('Satu\nDua');
  });

  it('caps textMs at 8000 characters at parse time', async () => {
    const fake = fakeHadeethEnc();
    fake.one.set('66512', { ...fixture('one-66512'), hadeeth: 'a'.repeat(9000) });
    expect((await createHadeethEnc(fake.fetch, BASE).one('66512')).textMs).toHaveLength(8000);
  });

  it('list() accepts string or number meta and returns ids and titles', async () => {
    const fake = fakeHadeethEnc();
    fake.lists.set('59', ['66512', '66513']);
    const page = await createHadeethEnc(fake.fetch, BASE).list('59', 1, 100);
    expect(page).toEqual({ items: [{ id: '66512', title: 'Hadis 66512' }, { id: '66513', title: 'Hadis 66513' }], lastPage: 1, total: 2 });
    const raw = (async () => new Response(JSON.stringify({ data: [], meta: { last_page: '3', total_items: '9' } }))) as unknown as typeof fetch;
    expect(await createHadeethEnc(raw, BASE).list('1', 1, 3)).toEqual({ items: [], lastPage: 3, total: 9 });
  });

  it('categories() returns 133 rows with string ids and a null parent for roots', async () => {
    const cats = await createHadeethEnc(fakeHadeethEnc().fetch, BASE).categories();
    expect(cats).toHaveLength(133);
    expect(cats.find((c) => c.id === '1')).toEqual({ id: '1', parentId: null, titleEn: "The Noble Qur'an and Qur'anic Sciences", count: 9 });
    expect(cats.find((c) => c.id === '8')?.parentId).toBe('1');
  });

  it('a 500 or 404 is source_unavailable with the status', async () => {
    const fake = fakeHadeethEnc();
    fake.one.set('66512', 500);
    const he = createHadeethEnc(fake.fetch, BASE);
    await expect(he.one('66512')).rejects.toMatchObject({ code: 'source_unavailable', status: 500 });
    await expect(he.list('999999', 1, 10)).rejects.toMatchObject({ code: 'source_unavailable', status: 500 });
    await expect(he.one('4')).rejects.toMatchObject({ code: 'source_unavailable', status: 404 });
  });

  it('a wrong shape is source_bad_response', async () => {
    const fake = fakeHadeethEnc();
    const he = createHadeethEnc(fake.fetch, BASE);
    for (const broken of [
      { ...fixture('one-66512'), hadeeth: 5 },
      { ...fixture('one-66512'), grade: undefined },
      { ...fixture('one-66512'), id: '999' },
      { ...fixture('one-66512'), hadeeth_ar: '' },
    ]) {
      fake.one.set('66512', broken as never);
      await expect(he.one('66512')).rejects.toMatchObject({ code: 'source_bad_response' });
    }
    const notList = (async () => new Response(JSON.stringify({ data: 'x', meta: {} }))) as unknown as typeof fetch;
    await expect(createHadeethEnc(notList, BASE).list('1', 1, 10)).rejects.toMatchObject({ code: 'source_bad_response' });
    const html = (async () => new Response('<html>')) as unknown as typeof fetch;
    await expect(createHadeethEnc(html, BASE).one('66512')).rejects.toMatchObject({ code: 'source_bad_response' });
  });

  it('probe() is true on the languages fixture and false on a network error or a bad status', async () => {
    const fake = fakeHadeethEnc();
    const he = createHadeethEnc(fake.fetch, BASE);
    expect(await he.probe()).toBe(true);
    expect(fake.calls[0]).toBe(`${BASE}/languages`);
    fake.languagesStatus = 503;
    expect(await he.probe()).toBe(false);
    fake.languagesStatus = 200;
    fake.offline = true;
    expect(await he.probe()).toBe(false);
  });
});
