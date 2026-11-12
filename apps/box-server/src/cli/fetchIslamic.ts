import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AYAT_COUNTS, quranFilePath, saveQuran } from '../islamic/quranStore.ts';
import { guardedFetch } from '../net/safeFetch.ts';
import { fetchEveryAyahSurah, fetchQuranEnc } from '../islamic/fetch.ts';

const USAGE =
  'usage: node apps/box-server/src/cli/fetchIslamic.ts --data <dir> [--quran] [--audio <surah>[,<surah>...]] [--reciter Husary_64kbps] [--cache-max-mb 300]';

export async function runCli(
  argv: string[],
  fetchImpl: typeof fetch = guardedFetch(),
  out: (line: string) => void = console.log,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string', default: './data' },
      quran: { type: 'boolean', default: false },
      audio: { type: 'string' },
      reciter: { type: 'string', default: 'Husary_64kbps' },
      'cache-max-mb': { type: 'string', default: '300' },
    },
  });
  const surahs = (values.audio ?? '')
    .split(',')
    .filter((s) => s !== '')
    .map(Number);
  if (!values.quran && surahs.length === 0) {
    out(USAGE);
    return 2;
  }
  for (const n of surahs) {
    if (!Number.isInteger(n) || n < 1 || n > 114) {
      out(`invalid surah "${n}"`);
      return 2;
    }
  }
  const cacheMaxMb = Number(values['cache-max-mb']);
  if (!Number.isInteger(cacheMaxMb) || cacheMaxMb < 50 || cacheMaxMb > 2000) {
    out('--cache-max-mb must be a whole number from 50 to 2000');
    return 2;
  }
  const dataDir = resolve(values.data);

  if (values.quran) {
    out('fetching QuranEnc malay_basumayyah (114 surahs)...');
    const quran = await fetchQuranEnc(fetchImpl, undefined, (done, total) => {
      if (done % 20 === 0 || done === total) out(`  surah ${done}/${total}`);
    });
    const file = saveQuran(dataDir, quran);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    out(`wrote ${quranFilePath(dataDir)} (${statSync(file).size} bytes, version ${quran.version})`);
    out(`sha256 ${sha}`);
  }

  for (const surah of surahs) {
    out(`fetching ${values.reciter} surah ${surah} (${AYAT_COUNTS[surah - 1]} ayat)...`);
    const { bytes } = await fetchEveryAyahSurah(
      fetchImpl,
      dataDir,
      values.reciter,
      surah,
      AYAT_COUNTS[surah - 1] ?? 0,
      undefined,
      { cacheMaxMb },
    );
    out(`  surah ${surah}: ${bytes} bytes (${(bytes / 1048576).toFixed(1)} MB)`);
  }
  return 0;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}
