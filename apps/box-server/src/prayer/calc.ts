import { CalculationMethod, Coordinates, HighLatitudeRule, Madhab, PrayerTimes } from 'adhan';
import type { CalculationParameters } from 'adhan';
import { checkPrayerDay, countryDefaults, hijriOf, isMethodKey, METHODS, offsetMinutes, tzOf } from '@surau/core';
import type { MethodKey, PrayerDay, PrayerName, Settings } from '@surau/core';

const pad = (n: number): string => String(n).padStart(2, '0');
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when the surau has both coordinates (the calculation needs them). */
export function located(settings: Settings): boolean {
  const l = settings.location;
  return typeof l.latitude === 'number' && typeof l.longitude === 'number'
    && Number.isFinite(l.latitude) && Number.isFinite(l.longitude);
}

/** The method the calculation really uses: the setting, or the country's own when it is `auto`. */
export function effectiveMethod(settings: Settings): MethodKey {
  const m = settings.prayerCalc.method;
  return isMethodKey(m) ? m : countryDefaults(settings.location.country).method;
}

export function effectiveMadhab(settings: Settings): 'shafi' | 'hanafi' {
  const m = settings.prayerCalc.madhab;
  return m === 'shafi' || m === 'hanafi' ? m : countryDefaults(settings.location.country).madhab;
}

/** BM label of the calculation, for the admin page and the kiosk footer. */
export function calcLabelMs(settings: Settings): string {
  return `Kiraan setempat (${METHODS[effectiveMethod(settings)].labelMs})`;
}

export function calcLabelEn(settings: Settings): string {
  return `Local calculation (${METHODS[effectiveMethod(settings)].labelEn})`;
}

function parametersFor(settings: Settings, coordinates: Coordinates): CalculationParameters {
  const def = METHODS[effectiveMethod(settings)];
  let params: CalculationParameters;
  if (def.adhan === null || def.adhan === 'Other') {
    params = CalculationMethod.Other();
    params.fajrAngle = def.fajrAngle ?? 18;
    params.ishaAngle = def.ishaAngle ?? 18;
    if (def.ishaInterval !== undefined) params.ishaInterval = def.ishaInterval;
    if (def.maghribAngle !== undefined) params.maghribAngle = def.maghribAngle;
  } else {
    params = CalculationMethod[def.adhan]();
  }
  params.madhab = effectiveMadhab(settings) === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;
  switch (settings.prayerCalc.highLatitude) {
    case 'middleOfNight': params.highLatitudeRule = HighLatitudeRule.MiddleOfTheNight; break;
    case 'seventhOfNight': params.highLatitudeRule = HighLatitudeRule.SeventhOfTheNight; break;
    case 'twilightAngle': params.highLatitudeRule = HighLatitudeRule.TwilightAngle; break;
    default: params.highLatitudeRule = HighLatitudeRule.recommended(coordinates);
  }
  const adj = settings.prayerCalc.adjustMinutes;
  params.adjustments = {
    fajr: adj.subuh, sunrise: adj.syuruk, dhuhr: adj.zohor, asr: adj.asar, maghrib: adj.maghrib, isha: adj.isyak,
  };
  return params;
}

/** HH:mm of an instant on the wall clock of `tz`; null when it is not a real time. */
function hhmm(instant: Date, tz: string): string | null {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;
  const local = new Date(instant.getTime() + offsetMinutes(instant, tz) * 60000);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/**
 * The day's seven times computed from the surau's own coordinates (adhan-js, fully offline). Null when the
 * surau is not located, the date is bad, or the formula gives no sensible day (the caller then has no day).
 * Never stored: it is cheap and always follows the current location and calculation settings.
 */
export function computeDay(date: string, settings: Settings): PrayerDay | null {
  const m = DATE_RE.exec(date);
  if (!m || !located(settings)) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const tz = tzOf(settings);
  try {
    const coordinates = new Coordinates(settings.location.latitude as number, settings.location.longitude as number);
    // adhan reads the calendar day from the local getters of the Date it is given: local noon of that day is safe.
    const times = new PrayerTimes(coordinates, new Date(y, mo - 1, d, 12), parametersFor(settings, coordinates));
    const imsakAt = new Date(times.fajr.getTime() - (settings.prayerCalc.imsakMinutes - settings.prayerCalc.adjustMinutes.imsak) * 60000);
    const out: Record<PrayerName, string | null> = {
      imsak: hhmm(imsakAt, tz),
      subuh: hhmm(times.fajr, tz),
      syuruk: hhmm(times.sunrise, tz),
      zohor: hhmm(times.dhuhr, tz),
      asar: hhmm(times.asr, tz),
      maghrib: hhmm(times.maghrib, tz),
      isyak: hhmm(times.isha, tz),
    };
    if (Object.values(out).some((v) => v === null)) return null;
    const day: PrayerDay = { date, hijri: hijriOf(date), times: out as Record<PrayerName, string> };
    return checkPrayerDay(day) === null ? day : null;
  } catch {
    return null;
  }
}
