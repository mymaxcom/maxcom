import { useEffect, useRef, useState } from 'preact/hooks';
import { parseBoxQr } from '@surau/core';
import type { BoxState, NetCheckView, Settings } from '@surau/core';
import { useRemoteKeys } from '../data/remote.ts';
import { BOX_LANGS, tb } from '../i18n-box.ts';
import type { BoxLang } from '../i18n-box.ts';
import { navKeyOf } from '../ui/LangSwitch.tsx';
import { QrCard } from '../ui/QrCard.tsx';
import { BoxHead, fmtAtBox, textAttrs } from './BoxChrome.tsx';
import type { BoxLangProps } from './BoxChrome.tsx';
import { StatusItem } from './Setup.tsx';

type Fetch = typeof fetch;
const realFetch: Fetch = (...a) => globalThis.fetch(...a);

const AUTO_CLOSE_MS = 90_000;
const QR_REM = 37;

export async function fetchNetCheck(fetchImpl: Fetch = realFetch): Promise<NetCheckView> {
  const res = await fetchImpl('/api/box/netcheck', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NetCheckView;
}

type Iface = NetCheckView['interfaces'][number];

/** Windows names ('Ethernet', 'Wi-Fi'), Linux and Android names ('eth0', 'wlan0'); virtual adapters are not the LAN. */
export function classifyInterfaces(list: readonly Iface[]): { ethernet?: Iface; wifi?: Iface } {
  const real = list.filter((i) => !/^v|virtual|vmware|vbox|hyper-v|wsl|docker|tailscale|wireguard|bluetooth|loopback/i.test(i.name));
  return {
    ethernet: real.find((i) => /ethernet|^eth|^en[opsx]/i.test(i.name)),
    wifi: real.find((i) => /wi-?fi|wlan|^wl/i.test(i.name)),
  };
}

function serverUrl(net: NetCheckView, eth: Iface | undefined, wifi: Iface | undefined): string | null {
  if (!net.https.listening) return null;
  // The address the box signs into its codes, the same one the phone is told to use.
  try {
    if (net.probe) {
      const box = parseBoxQr(net.probe.payload).box;
      if (box !== '') return box;
    }
  } catch {
    /* fall back to the interface address */
  }
  const ip = eth?.address ?? wifi?.address;
  return ip !== undefined && net.https.port !== null ? `https://${ip}:${net.https.port}` : null;
}

function Row({ state, label, value }: { state: 'ok' | 'bad' | 'off'; label: string; value: string }) {
  return (
    <div class={`netcheck__row${state === 'bad' ? ' is-bad' : ''}`}>
      <StatusItem state={state} label={label} value={value} />
    </div>
  );
}

/** 0 Back, 1 Test again, or a language on the switch at the top. */
export type NetFocus = 0 | 1 | BoxLang;

/**
 * The remote on the network check. Left and right swap the two buttons, as before; up goes to the language switch
 * (when there is one) at the current language, where left and right walk the languages and down comes back to
 * Test again. Tab walks the languages, then Back and Test again.
 */
export function nextNetFocus(f: NetFocus, key: NonNullable<ReturnType<typeof navKeyOf>>, lang: BoxLang, hasSwitch: boolean): NetFocus {
  const ring: NetFocus[] = hasSwitch ? [...BOX_LANGS, 0, 1] : [0, 1];
  if (key === 'next' || key === 'prev') {
    const i = ring.indexOf(f);
    return ring[(i + (key === 'next' ? 1 : -1) + ring.length) % ring.length] ?? f;
  }
  if (typeof f === 'number') {
    if (key === 'up' && hasSwitch) return lang;
    if (key === 'down' && hasSwitch) return f;
    return f === 0 ? 1 : 0;
  }
  const i = BOX_LANGS.indexOf(f);
  if (key === 'left') return BOX_LANGS[Math.max(0, i - 1)] ?? f;
  if (key === 'right') return BOX_LANGS[Math.min(BOX_LANGS.length - 1, i + 1)] ?? f;
  if (key === 'down') return 1;
  return f;
}

export interface NetCheckProps extends BoxLangProps {
  settings: Settings;
  boxState: BoxState;
  keyFp: string;
  onClose: () => void;
  fetchImpl?: Fetch;
}

/** Read-only network check, over whatever the screen was showing. Mockup screen 6. It changes nothing on the box. */
export function NetCheck({ lang, onLang, settings, boxState, keyFp, onClose, fetchImpl }: NetCheckProps) {
  const [net, setNet] = useState<NetCheckView | null>(null);
  const [failed, setFailed] = useState(false);
  // 0 Kembali, 1 Uji semula, or a language on the switch. OK tests again unless the arrows moved off it.
  const [focus, setFocus] = useState<NetFocus>(1);
  const close = useRef(onClose);
  close.current = onClose;
  const langNow = useRef({ lang, hasSwitch: onLang !== undefined });
  langNow.current = { lang, hasSwitch: onLang !== undefined };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const keepOpen = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => close.current(), AUTO_CLOSE_MS);
  };
  const poll = (): void => {
    fetchNetCheck(fetchImpl).then(
      (v) => {
        if (!alive.current) return;
        setNet(v);
        setFailed(false);
      },
      () => {
        // a failed re-test keeps the rows it has
        if (alive.current) setFailed(true);
      },
    );
  };

  useEffect(() => {
    alive.current = true;
    poll();
    keepOpen();
    const onKey = (ev: KeyboardEvent): void => {
      keepOpen();
      const k = navKeyOf(ev);
      if (k === null) return;
      if (k === 'next' || k === 'prev') ev.preventDefault();
      setFocus((f) => nextNetFocus(f, k, langNow.current.lang, langNow.current.hasSwitch));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useRemoteKeys({
    onOk: () => {
      if (typeof focus === 'string') onLang?.(focus);
      else if (focus === 0) close.current();
      else poll();
    },
    onBack: () => close.current(),
  });

  const timeFormat = settings.prayerBar.timeFormat === '24h' ? '24h' : '12h';
  let body;
  if (net === null) {
    body = <p class="netcheck__wait">{tb(failed ? 'netUnavailable' : 'netLoading', lang)}</p>;
  } else {
    const { ethernet, wifi } = classifyInterfaces(net.interfaces);
    const url = serverUrl(net, ethernet, wifi);
    const phoneAt = fmtAtBox(net.lastPhoneSeenAt, timeFormat, lang);
    const pulled = fmtAtBox(net.lastPull, timeFormat, lang);
    const cloud = !net.linked ? tb('netUnlinked', lang) : pulled !== null ? tb('netLinked', lang, { time: pulled }) : tb('netLinkedNever', lang);
    const iface = (i: Iface | undefined): string =>
      i ? tb('netConnected', lang, { address: i.address }) : tb('netNotUsed', lang);
    body = (
      <>
        <div class="netcheck__rows">
          <Row state={ethernet ? 'ok' : 'off'} label={tb('netEthernet', lang)} value={iface(ethernet)} />
          <Row state={wifi ? 'ok' : 'off'} label={tb('netWifi', lang)} value={iface(wifi)} />
          {boxState === 'setup' ? <Row state="off" label={tb('netInternet', lang)} value={tb('netInternetNotNeeded', lang)} /> : null}
          <Row
            state={url !== null ? 'ok' : 'bad'}
            label={tb('netServer', lang)}
            value={url !== null ? tb('netServerOn', lang, { url }) : tb('netServerOff', lang)}
          />
          <Row
            state={phoneAt !== null ? 'ok' : 'bad'}
            label={tb('netPhone', lang)}
            value={phoneAt !== null ? tb('netPhoneSeen', lang, { time: phoneAt }) : tb('netPhoneNone', lang)}
          />
          <Row state={net.linked ? 'ok' : 'off'} label={tb('netCloud', lang)} value={cloud} />
        </div>
        {phoneAt !== null ? (
          <div class="netcheck__cause is-ok">
            <h2>{tb('netOk', lang)}</h2>
            <p>{tb('netOkHint', lang)}</p>
          </div>
        ) : (
          <div class="netcheck__cause">
            <h2>{tb('netIsolation', lang)}</h2>
            <ol>
              <li>{tb('netIsolation1', lang)}</li>
              <li>{tb('netIsolation2', lang)}</li>
              {!net.linked ? <li>{tb('netUnlinkedHint', lang)}</li> : null}
            </ol>
          </div>
        )}
      </>
    );
  }

  return (
    <div class="screen netcheck box-screen" data-screen="netcheck" data-lang={lang} onPointerDown={keepOpen} role="dialog" aria-label={tb('netTitle', lang)}>
      <div class="netcheck__main">
        <BoxHead
          lang={lang}
          onLang={onLang}
          focus={typeof focus === 'string' ? focus : null}
          title={<span class="box-brandrow__sub">{tb('netTitle', lang)}</span>}
        />
        <div class="netcheck__body" {...textAttrs(lang)}>
          {body}
        </div>
        <div class="netcheck__keys" {...textAttrs(lang)}>
          <button
            type="button"
            tabIndex={-1}
            class={`tvbtn${focus === 0 ? ' is-focused' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => close.current()}
          >
            {tb('netBack', lang)}
          </button>
          <button
            type="button"
            tabIndex={-1}
            class={`tvbtn${focus === 1 ? ' is-focused' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={poll}
          >
            {tb('netRetry', lang)}
          </button>
        </div>
      </div>
      {net?.probe ? (
        <QrCard
          payload={net.probe.payload}
          expiresAt={net.probe.expiresAt}
          caption={tb('netProbeTitle', lang)}
          rem={QR_REM}
          keyFp={keyFp || undefined}
          hint={tb('netProbeHint', lang)}
          lang={lang}
        />
      ) : null}
    </div>
  );
}
