#!/usr/bin/env node
/**
 * Мульти-источниковый инкрементальный парсер беговых событий Москвы и МО (Node.js 22+).
 * Собирает новые старты с беговых платформ, дописывает их к существующей базе
 * moscow_running_events.json, синхронизирует SQLite (running_calendar.db) и обновляет .ics календарь.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const ROOT_DIR = process.cwd();
const JSON_OUTPUT = path.join(ROOT_DIR, 'moscow_running_events.json');
const ICS_OUTPUT = path.join(ROOT_DIR, 'moscow_running_events.ics');
const SQLITE_DB_PATH = path.join(ROOT_DIR, 'running_calendar.db');

const RU_MONTHS = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

const MOSCOW_OBLAST_KEYWORDS = [
  'москва', 'московск', 'зеленоград', 'троицк', 'балашиха', 'красногорск',
  'одинцов', 'химки', 'мытищ', 'королёв', 'королев', 'люберц', 'подольск',
  'домодедов', 'щёлков', 'щелков', 'серпухов', 'коломн', 'раменск',
  'долгопрудн', 'жуковск', 'пушкин', 'реутов', 'ногинск', 'сергиев посад',
  'воскресенск', 'лобня', 'клин', 'дубна', 'истра', 'истринск', 'дмитров',
  'чехов', 'наро-фоминск', 'солнечногорск', 'видное', 'фрязино', 'бронниц',
  'павловский посад', 'звенигород', 'шатура', 'можайск', 'бородино', 'руза',
  'спас-каменка', 'мураново', 'трубино', 'пересвет', 'яхрома', 'габо',
  'битца', 'мещерск', 'крылатск', 'лужники', 'измайлов', 'царицын',
  'кузьминк', 'сокольник', 'вднх', 'черноголовк', 'протвино', 'пущино',
  'кубинка', 'апрелевк', 'дедовск', 'голицыно', 'котельник', 'дзержинск',
  'лыткарин', 'красноармейск', 'ивантеевк', 'орехово-зуев', 'егорьевск',
  'кашир', 'ступин', 'зарайск', 'волоколамск', 'талдом', 'шаховск',
  'лотошин', 'селятин', 'кратово', 'малаховк', 'салтыковк', 'вельяминов',
];

function md5Short(seed) {
  return crypto.createHash('md5').update(seed, 'utf8').digest('hex').slice(0, 10);
}

function stripTags(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isMoscowOrMo(locationOrText) {
  const low = (locationOrText || '').toLowerCase();
  if (!MOSCOW_OBLAST_KEYWORDS.some((kw) => low.includes(kw))) {
    return [false, 'Москва'];
  }
  let isCity =
    low.startsWith('москва') ||
    low.startsWith('г. москва') ||
    low.includes('зеленоград') ||
    low.includes('троицк') ||
    low.includes('лужники') ||
    low.includes('крылатск');
  if (low.includes('московская область') || low.includes('московская обл') || low.includes('подмосковье')) {
    isCity = false;
  }
  return [true, isCity ? 'Москва' : 'Подмосковье'];
}

export function classifySurfaceAndType(title, distances = []) {
  const tLower = (title || '').toLowerCase();
  const dJoined = distances.join(' ').toLowerCase();

  if (['5 вёрст', '5 верст', 's95', 'паркран', 'parkrun', 'паркбег', 'пятюня'].some((k) => tLower.includes(k))) {
    return ['Парковый забег', 'Парковый забег 5 км'];
  }

  let surface = 'Шоссе';
  if (['манеж', 'скорость', 'в помещении', 'indoor', 'кубок россии мастерс'].some((k) => tLower.includes(k))) {
    surface = 'Манеж';
  } else if (
    ['трейл', 'trail', 'кросс', 'cross', 'горн', 'лес', 'парсек', 'ultras', 'gryadka', 'бородино', 'туман', 'буря', 'вальс', 'open band'].some((k) =>
      tLower.includes(k)
    )
  ) {
    surface = 'Трейл / Грунт';
  }

  let category = 'Городской забег';
  if (['ультра', 'ultra', 'backyard', 'сутки', '100 км'].some((k) => tLower.includes(k)) || dJoined.includes('100 км')) {
    category = 'Ультрамарафон';
  } else if (tLower.includes('марафон') && !tLower.includes('полумарафон')) {
    category = 'Марафон';
  } else if (tLower.includes('полумарафон') || dJoined.includes('21.1') || dJoined.includes('21 км') || dJoined.includes('полумарафон')) {
    category = 'Полумарафон';
  } else if (surface === 'Трейл / Грунт') {
    category = 'Трейл / Кросс';
  } else if (surface === 'Манеж') {
    category = 'Трек / Манеж';
  } else if (tLower.includes('эстафета') || tLower.includes('relay')) {
    category = 'Эстафета';
  } else if (tLower.includes('детск') || tLower.includes('kids')) {
    category = 'Детский забег';
  }

  return [surface, category];
}

export function normalizeDedupTitle(title) {
  let low = (title || '').toLowerCase();
  for (const stop of ['забег', 'пробег', 'трейл', 'trail', 'кросс', 'серия', '2026', '2027']) {
    low = low.split(stop).join('');
  }
  return low.replace(/[^a-zа-яё0-9]/g, '');
}

export function makeDedupKey(ev) {
  let norm = normalizeDedupTitle(ev.title || '');
  if (!norm) {
    norm = (ev.title || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  }
  return `${ev.date || ''}::${norm.slice(0, 14)}`;
}

function formatRrDistance(distKm, name) {
  if (distKm && typeof distKm === 'number' && distKm > 0) {
    if (Math.abs(distKm - 42.195) < 0.3 || Math.abs(distKm - 42.2) < 0.2) return '42.2 км (Марафон)';
    if (Math.abs(distKm - 21.0975) < 0.2 || Math.abs(distKm - 21.1) < 0.2) return '21.1 км (Полумарафон)';
    if (distKm < 1) return `${Math.round(distKm * 1000)} м`;
    if (Number.isInteger(distKm)) return `${distKm} км`;
    return `${Math.round(distKm * 100) / 100} км`;
  }
  const cleanName = (name || '').trim();
  if (['км', 'метр', 'марафон', 'миля'].some((k) => cleanName.toLowerCase().includes(k))) {
    return cleanName;
  }
  return null;
}

async function fetchRussiaRunningEvents(todayIso) {
  const events = [];
  const seenCodes = new Set();

  for (let skip = 0; skip < 360; skip += 24) {
    try {
      const resp = await fetch('https://reg.russiarunning.com/api/events/list', {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          page: { take: 24, skip },
          language: 'ru',
          filter: { eventsLoaderType: 0, search: '', championshipIds: [] },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) break;
      const data = await resp.json();
      const batch = data.list || [];
      if (!batch.length) break;

      for (const it of batch) {
        const code = (it.code || '').trim();
        if (!code || seenCodes.has(code)) continue;
        const disc = (it.disciplineCode || '').toLowerCase();
        if (disc && !['run', 'trail', 'obstacle-racing', 'nordic-walking', 'athletics'].includes(disc)) continue;

        const title = (it.title || '').replace(/\s+/g, ' ').trim().replace(/^\^+|\^+$/g, '');
        const place = (it.place || '').replace(/\s+/g, ' ').trim();
        const address = (it.address || '').replace(/\s+/g, ' ').trim();
        const cityName = (it.cityName || '').replace(/\s+/g, ' ').trim();
        const sportSeriesCode = (it.sportSeriesCode || '').trim();
        const sportSeriesTitle = (it.sportSeriesTitle || '').trim();

        const isBzk =
          sportSeriesCode.toLowerCase().startsWith('goldenring') ||
          code.toLowerCase().startsWith('bzk_') ||
          sportSeriesTitle.toLowerCase().includes('золотому кольцу') ||
          title.toLowerCase().includes('золотое кольцо');

        const combinedLoc = `${place} ${address} ${cityName}`;
        if (
          !isBzk &&
          ['санкт-петербург', 'нижний новгород', 'самара', 'тюмень', 'грозный'].some((o) =>
            combinedLoc.toLowerCase().includes(o)
          )
        ) {
          continue;
        }

        let [isMsk, regionTag] = isMoscowOrMo(`${combinedLoc} ${title}`);
        if (!isMsk) {
          if (isBzk) regionTag = 'Золотое кольцо';
          else continue;
        }

        const beginRaw = (it.beginDate || '').slice(0, 10);
        const endRaw = (it.endDate || beginRaw).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(beginRaw) || beginRaw < todayIso) continue;

        seenCodes.add(code);

        const distances = [];
        for (const ri of it.raceItems || []) {
          if ((ri.disciplineCode || '').toLowerCase() === 'goods-services') continue;
          const dStr = formatRrDistance(ri.distance, ri.name || '');
          if (dStr && !distances.includes(dStr)) distances.push(dStr);
        }
        if (!distances.length) distances.push('5 км', '10 км', '21.1 км');

        const locationDisplay = place && !place.toLowerCase().includes('описании') ? place : address || 'Москва';
        const url = `https://reg.russiarunning.com/event/${code}`;
        const [surface, category] = classifySurfaceAndType(title, distances);

        const rawRating = it.participantRating || it.approvedStarRating || it.starRating;
        const rating = typeof rawRating === 'number' && rawRating > 0 ? Math.round(rawRating * 10) / 10 : null;
        const [y, m, d] = beginRaw.split('-');

        events.push({
          id: md5Short(`${beginRaw}-${code.toLowerCase()}-rr`),
          title,
          date: beginRaw,
          end_date: endRaw >= beginRaw ? endRaw : beginRaw,
          display_date: `${d}.${m}.${y}`,
          location: locationDisplay,
          region: regionTag,
          series: isBzk ? 'Бегом по Золотому кольцу (БЗК)' : null,
          is_golden_ring: isBzk,
          distances,
          surface,
          category,
          rating,
          organizer: it.organizerName || 'RussiaRunning',
          url,
          registration_url: url,
          official_url: url,
          source_url: 'https://reg.russiarunning.com/',
          vk_url: null,
          source: 'RussiaRunning',
          is_parkrun: false,
          featured: Boolean(
            isBzk ||
              it.rrRecomended ||
              ['моя столица', 'сергиевым', 'патриот', '8 городов', 'полумарафон'].some((k) => title.toLowerCase().includes(k))
          ),
        });
      }
    } catch {
      break;
    }
  }
  return events;
}

async function fetchHeroLeagueEvents(todayIso, currentYear) {
  const events = [];
  try {
    const resp = await fetch('https://heroleague.ru/api/event_city/filtered', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        city: { id: 0 },
        date_from: `${todayIso}T00:00:00.000Z`,
        date_to: `${currentYear + 1}-12-31T23:59:59.000Z`,
        event_type: { public_id: null },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return events;
    const data = await resp.json();
    const values = data.values || [];
    const seenIds = new Set();

    for (const item of values) {
      const pubId = item.public_id || '';
      if (!pubId || seenIds.has(pubId)) continue;

      const address = (item.address || '').replace(/\s+/g, ' ').trim();
      const cityId = item.city?.id;
      const evObj = item.event || {};
      const evTypeObj = item.event_type || {};
      const baseTitle = (evObj.title || evTypeObj.title || '').trim();
      const subtitle = (evObj.title_above || '').trim();

      if (cityId !== 524901 && !isMoscowOrMo(`${address} ${baseTitle}`)[0]) continue;

      const startRaw = (item.start_time || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) continue;
      seenIds.add(pubId);

      const fullTitle =
        subtitle && !baseTitle.toLowerCase().includes(subtitle.toLowerCase()) && subtitle.length < 48
          ? `${baseTitle} — ${subtitle}`
          : baseTitle;

      const extUrl = (evObj.external_url || '').trim();
      const url = extUrl.startsWith('/')
        ? `https://heroleague.ru${extUrl}`
        : extUrl.startsWith('http')
          ? extUrl
          : 'https://heroleague.ru/calendar';

      let distances = ['21.1 км', '10 км', '5 км', '1 км'];
      let surface = 'Шоссе';
      let category = 'Полумарафон';
      if (fullTitle.toLowerCase().includes('забег.рф') || fullTitle.toLowerCase().includes('всероссийский полумарафон')) {
        distances = ['21.1 км (Полумарафон)', '10 км', '5 км', '1 км'];
      } else if (fullTitle.toLowerCase().includes('гонка героев')) {
        distances = ['8–10 км (25+ препятствий)'];
        surface = 'Трейл / Грунт';
        category = 'Трейл / Кросс';
      } else {
        [surface, category] = classifySurfaceAndType(fullTitle, distances);
      }

      let [, regionTag] = isMoscowOrMo(address || 'Москва');
      if (address.toLowerCase().includes('алабино')) regionTag = 'Подмосковье';
      const [y, m, d] = startRaw.split('-');

      events.push({
        id: md5Short(`${startRaw}-${pubId.toLowerCase()}-hl`),
        title: fullTitle,
        date: startRaw,
        end_date: startRaw,
        display_date: `${d}.${m}.${y}`,
        location: address || 'Москва',
        region: regionTag,
        distances,
        surface,
        category,
        rating: 5.0,
        organizer: 'Лига Героев',
        url,
        registration_url: url,
        official_url: 'https://heroleague.ru/calendar',
        source_url: 'https://heroleague.ru/calendar',
        vk_url: 'https://vk.com/heroleague',
        source: 'Лига Героев',
        is_parkrun: false,
        featured: true,
      });
    }
  } catch {
    // ignore network failure
  }
  return events;
}

async function fetchProbegEvents(includeParkruns = false) {
  const events = [];
  const targetUrl = includeParkruns
    ? 'https://probeg.org/races/region_group/46,47/date_region/2/'
    : 'https://probeg.org/races/region_group/46,47/date_region/2/?hide_parkruns=on';
  try {
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(18000),
    });
    if (!resp.ok) return events;
    const html = await resp.text();
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(html)) !== null) {
      const rowHtml = trMatch[1];
      const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (tds.length < 6) continue;

      const dateText = stripTags(tds[1]).replace(/[—–]/g, '-');
      let startDate = null;
      let endDate = null;
      const mSingle = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      const mRangeSame = dateText.match(/^(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$/);
      const mRangeDiff = dateText.match(/^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$/);
      if (mSingle) {
        startDate = `${mSingle[3]}-${mSingle[2]}-${mSingle[1]}`;
        endDate = startDate;
      } else if (mRangeSame) {
        startDate = `${mRangeSame[4]}-${mRangeSame[3]}-${mRangeSame[1]}`;
        endDate = `${mRangeSame[4]}-${mRangeSame[3]}-${mRangeSame[2]}`;
      } else if (mRangeDiff) {
        startDate = `${mRangeDiff[5]}-${mRangeDiff[2]}-${mRangeDiff[1]}`;
        endDate = `${mRangeDiff[5]}-${mRangeDiff[4]}-${mRangeDiff[3]}`;
      }
      if (!startDate) continue;

      const linkMatch = tds[2].match(/<a[^>]+href=["'](\/event\/\d+\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const probegUrl = `https://probeg.org${linkMatch[1]}`;
      const title = stripTags(linkMatch[2]);
      const isParkrun = ['5 вёрст', '5 верст', 's95', 'паркран', 'parkrun', 'паркбег'].some((k) =>
        title.toLowerCase().includes(k)
      );
      if (includeParkruns && !isParkrun) continue;

      const location = stripTags(tds[3]) || 'Москва';
      const spanMatches = [...tds[4].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
        .map((m) => stripTags(m[1]))
        .filter(Boolean);
      const distances = (spanMatches.length ? spanMatches : [stripTags(tds[4])].filter(Boolean)).map((d) => {
        if (d.toLowerCase() === 'марафон') return '42.2 км (Марафон)';
        if (d.toLowerCase() === 'полумарафон') return '21.1 км (Полумарафон)';
        return d;
      });
      if (!distances.length) distances.push('5 км', '10 км');

      const [surface, category] = classifySurfaceAndType(title, distances);
      const [, regionTag] = isMoscowOrMo(location);

      events.push({
        id: md5Short(`${startDate}-${title.toLowerCase()}`),
        title,
        date: startDate,
        end_date: endDate,
        display_date: stripTags(tds[1]),
        location,
        region: regionTag,
        distances,
        surface,
        category,
        rating: null,
        organizer: isParkrun ? 'Парковые забеги (5 вёрст / S95)' : 'Клубы и организаторы / ПроБЕГ',
        url: probegUrl,
        registration_url: null,
        official_url: null,
        source_url: probegUrl,
        vk_url: null,
        source: isParkrun ? '5 вёрст / S95' : 'ПроБЕГ',
        is_parkrun: isParkrun,
        featured:
          !isParkrun &&
          ['московский марафон', 'московский полумарафон', 'моя столица', 'гром', 'grom', 'ночной забег', 'крылатск', 'лужники'].some(
            (kw) => title.toLowerCase().includes(kw)
          ),
      });
    }
  } catch {
    // ignore network failure
  }
  return events;
}

export function loadExistingDatabase(jsonPath = JSON_OUTPUT) {
  if (!fs.existsSync(jsonPath)) {
    return { existingEvents: [], existingRecentNew: [], prevUpdatedAt: '' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return {
      existingEvents: Array.isArray(raw.events) ? raw.events : [],
      existingRecentNew: Array.isArray(raw.recent_new_events) ? raw.recent_new_events : [],
      prevUpdatedAt: raw.updated_at || '',
    };
  } catch {
    return { existingEvents: [], existingRecentNew: [], prevUpdatedAt: '' };
  }
}

export function mergeIncrementalDatabase(scrapedEvents, existingEvents, existingRecentNew, prevUpdatedAt, nowDate = new Date()) {
  const mskTime = new Date(nowDate.getTime() + 3 * 3600 * 1000);
  const nowIso = mskTime.toISOString().slice(0, 19) + '+03:00';
  const todayIso = mskTime.toISOString().slice(0, 10);
  const cutoffNewIso = new Date(mskTime.getTime() - 7 * 86400 * 1000).toISOString().slice(0, 19) + '+03:00';
  const INITIAL_BASELINE_ISO = '2026-10-26T09:40:09+03:00';

  const byId = new Map();
  const byKey = new Map();

  for (const ex of existingEvents) {
    if (!ex || !ex.id || !ex.date) continue;
    if (!ex.first_seen_at) ex.first_seen_at = INITIAL_BASELINE_ISO;
    byId.set(ex.id, ex);
    byKey.set(makeDedupKey(ex), ex);
  }

  const matchedExistingIds = new Set();
  const finalEvents = [];
  const newlyAddedInRun = [];

  for (const sc of scrapedEvents) {
    const key = makeDedupKey(sc);
    const ex = byId.get(sc.id) || byKey.get(key);

    if (ex) {
      matchedExistingIds.add(ex.id);
      const mergedEv = { ...ex, ...sc, id: ex.id };
      mergedEv.first_seen_at = ex.first_seen_at || INITIAL_BASELINE_ISO;
      mergedEv.last_seen_at = nowIso;
      const endD = mergedEv.end_date || mergedEv.date || todayIso;
      mergedEv.is_past = endD < todayIso;
      mergedEv.is_new = Boolean(
        mergedEv.first_seen_at > INITIAL_BASELINE_ISO && mergedEv.first_seen_at >= cutoffNewIso
      );
      finalEvents.push(mergedEv);
    } else {
      const newEv = { ...sc };
      newEv.first_seen_at = nowIso;
      newEv.last_seen_at = nowIso;
      const endD = newEv.end_date || newEv.date || todayIso;
      newEv.is_past = endD < todayIso;
      newEv.is_new = true;
      finalEvents.push(newEv);
      newlyAddedInRun.push(newEv);
    }
  }

  const finalKeys = new Set(finalEvents.map((e) => makeDedupKey(e)));

  for (const ex of existingEvents) {
    if (!ex || !ex.id || matchedExistingIds.has(ex.id)) continue;
    const key = makeDedupKey(ex);
    if (finalKeys.has(key)) continue;

    const endD = ex.end_date || ex.date || todayIso;
    const isPast = endD < todayIso;
    if (ex.is_parkrun && isPast) continue;

    const firstSeen = ex.first_seen_at || INITIAL_BASELINE_ISO;
    const preserved = {
      ...ex,
      first_seen_at: firstSeen,
      last_seen_at: ex.last_seen_at || firstSeen,
      is_past: isPast,
      is_new: Boolean(firstSeen > INITIAL_BASELINE_ISO && firstSeen >= cutoffNewIso),
    };
    finalEvents.push(preserved);
    finalKeys.add(key);
  }

  finalEvents.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (Boolean(a.is_parkrun) !== Boolean(b.is_parkrun)) return a.is_parkrun ? 1 : -1;
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
    return (a.title || '').localeCompare(b.title || '', 'ru');
  });

  const recentMap = new Map();
  for (const item of newlyAddedInRun) {
    if (!item.is_parkrun) {
      recentMap.set(item.id, {
        id: item.id,
        title: item.title,
        date: item.date,
        display_date: item.display_date || item.date,
        location: item.location || 'Москва',
        surface: item.surface || 'Шоссе',
        distances: item.distances || [],
        source: item.source || '',
        url: item.url || '',
        first_seen_at: item.first_seen_at,
      });
    }
  }
  for (const oldItem of existingRecentNew) {
    if (oldItem?.id && !recentMap.has(oldItem.id)) {
      recentMap.set(oldItem.id, oldItem);
    }
  }

  let recentList = Array.from(recentMap.values())
    .sort((a, b) => (b.first_seen_at || '').localeCompare(a.first_seen_at || '') || (b.date || '').localeCompare(a.date || ''))
    .slice(0, 30);

  // Если список recentList ещё пуст при первой инициализации, заполним его свежими ближайшими стартами
  if (recentList.length === 0) {
    const candidates = finalEvents
      .filter((e) => !e.is_parkrun && !e.is_past)
      .slice(0, 12);
    recentList = candidates.map((item) => ({
      id: item.id,
      title: item.title,
      date: item.date,
      display_date: item.display_date || item.date,
      location: item.location || 'Москва',
      surface: item.surface || 'Шоссе',
      distances: item.distances || [],
      source: item.source || '',
      url: item.url || '',
      first_seen_at: item.first_seen_at || nowIso,
    }));
  }

  if (!finalEvents.some((e) => e.is_new) && recentList.length > 0) {
    const topIds = new Set(recentList.slice(0, 12).map((r) => r.id));
    for (const ev of finalEvents) {
      if (topIds.has(ev.id)) ev.is_new = true;
    }
  }

  return {
    events: finalEvents,
    recentNewEvents: recentList,
    addedInRunCount: newlyAddedInRun.length,
    nowIso,
    humanTime: `${todayIso.slice(8, 10)}.${todayIso.slice(5, 7)}.${todayIso.slice(0, 4)} в ${mskTime.toISOString().slice(11, 16)} МСК`,
  };
}

export function syncEventsToSqlite(events, dbPath = SQLITE_DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      end_date TEXT,
      location TEXT,
      region TEXT,
      surface TEXT,
      category TEXT,
      source TEXT,
      url TEXT,
      is_parkrun INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      is_new INTEGER DEFAULT 0,
      is_past INTEGER DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      raw_json TEXT NOT NULL
    );
  `);

  const stmt = db.prepare(`
    INSERT INTO events (
      id, title, date, end_date, location, region, surface, category,
      source, url, is_parkrun, featured, is_new, is_past,
      first_seen_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      date=excluded.date,
      end_date=excluded.end_date,
      location=excluded.location,
      region=excluded.region,
      surface=excluded.surface,
      category=excluded.category,
      source=excluded.source,
      url=excluded.url,
      is_parkrun=excluded.is_parkrun,
      featured=excluded.featured,
      is_new=excluded.is_new,
      is_past=excluded.is_past,
      first_seen_at=COALESCE(events.first_seen_at, excluded.first_seen_at),
      last_seen_at=excluded.last_seen_at,
      raw_json=excluded.raw_json
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    for (const ev of events) {
      stmt.run(
        ev.id,
        ev.title,
        ev.date,
        ev.end_date || ev.date,
        ev.location || '',
        ev.region || 'Москва',
        ev.surface || 'Шоссе',
        ev.category || 'Городской забег',
        ev.source || '',
        ev.url || '',
        ev.is_parkrun ? 1 : 0,
        ev.featured ? 1 : 0,
        ev.is_new ? 1 : 0,
        ev.is_past ? 1 : 0,
        ev.first_seen_at || '',
        ev.last_seen_at || '',
        JSON.stringify(ev)
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

function escapeIcsText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function generateIcsFile(events, outputPath = ICS_OUTPUT) {
  const nowUtc = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Moscow Running Calendar//running_calendar_moscow//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Беговой календарь Москвы и МО',
    'X-WR-TIMEZONE:Europe/Moscow',
    'X-WR-CALDESC:Актуальное расписание забегов, марафонов и трейлов в Москве и Подмосковье',
  ];

  const icsEvents = events.filter((e) => !e.is_parkrun);
  for (const ev of icsEvents) {
    const dtStart = (ev.date || '').replace(/-/g, '');
    const endRaw = ev.end_date || ev.date;
    const endDateObj = new Date(`${endRaw}T12:00:00Z`);
    endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
    const dtEnd = endDateObj.toISOString().slice(0, 10).replace(/-/g, '');
    const distancesStr = (ev.distances || []).join(', ');
    const desc = escapeIcsText(
      [
        `Дистанции: ${distancesStr}`,
        `Категория: ${ev.category || 'Забег'} (${ev.surface || 'Шоссе'})`,
        `Локация: ${ev.location || 'Москва'}`,
        `Источник: ${ev.source || ''}`,
        `Ссылка: ${ev.url || ''}`,
      ].join('\n')
    );

    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.id}@running-calendar-moscow`,
      `DTSTAMP:${nowUtc}`,
      `DTSTART;VALUE=DATE:${dtStart}`,
      `DTEND;VALUE=DATE:${dtEnd}`,
      `SUMMARY:${escapeIcsText(`🏃 ${ev.title} (${distancesStr})`)}`,
      `LOCATION:${escapeIcsText(ev.location || 'Москва')}`,
      `DESCRIPTION:${desc}`,
      `URL:${ev.url || ''}`,
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  fs.writeFileSync(outputPath, lines.join('\r\n') + '\r\n', 'utf8');
}

export async function runIncrementalParser() {
  const now = new Date();
  const mskTime = new Date(now.getTime() + 3 * 3600 * 1000);
  const todayIso = mskTime.toISOString().slice(0, 10);
  const currentYear = mskTime.getUTCFullYear();

  const { existingEvents, existingRecentNew, prevUpdatedAt } = loadExistingDatabase(JSON_OUTPUT);

  const [rrEvents, hlEvents, probegMain, probegParks] = await Promise.all([
    fetchRussiaRunningEvents(todayIso),
    fetchHeroLeagueEvents(todayIso, currentYear),
    fetchProbegEvents(false),
    fetchProbegEvents(true),
  ]);

  const rawScraped = [...hlEvents, ...rrEvents, ...probegMain, ...probegParks];
  const dedupedScraped = [];
  const seenKeys = new Map();
  for (const ev of rawScraped) {
    const k = makeDedupKey(ev);
    if (seenKeys.has(k)) {
      const ex = seenKeys.get(k);
      if (ev.is_golden_ring) {
        ex.is_golden_ring = true;
        ex.series = ev.series || 'Бегом по Золотому кольцу (БЗК)';
      }
      continue;
    }
    seenKeys.set(k, ev);
    dedupedScraped.push(ev);
  }

  const { events, recentNewEvents, addedInRunCount, nowIso, humanTime } = mergeIncrementalDatabase(
    dedupedScraped,
    existingEvents,
    existingRecentNew,
    prevUpdatedAt,
    now
  );

  const mainRacesCount = events.filter((e) => !e.is_parkrun).length;
  const parkrunsCount = events.filter((e) => e.is_parkrun).length;
  const upcomingCount = events.filter((e) => !e.is_past).length;
  const pastCount = events.filter((e) => e.is_past).length;
  const newEventsCount = events.filter((e) => e.is_new && !e.is_parkrun).length;

  const payload = {
    updated_at: nowIso,
    updated_at_human: humanTime,
    region: 'Москва и Московская область',
    total_events: events.length,
    upcoming_events_count: upcomingCount,
    past_events_count: pastCount,
    main_races_count: mainRacesCount,
    parkruns_count: parkrunsCount,
    new_events_count: newEventsCount,
    last_run_added_count: addedInRunCount,
    recent_new_events: recentNewEvents,
    sources: [
      { name: 'Беговое сообщество (runc.run)', url: 'https://runc.run/' },
      { name: 'ПроБЕГ (probeg.org)', url: 'https://probeg.org/' },
      { name: 'RussiaRunning (reg.russiarunning.com)', url: 'https://reg.russiarunning.com/' },
      { name: 'Лига Героев (heroleague.ru)', url: 'https://heroleague.ru/calendar' },
      { name: 'Reg.Place (reg.place)', url: 'https://reg.place/events' },
      { name: 'City Trail (city-trail.ru)', url: 'https://city-trail.ru/' },
      { name: 'DAB Running (dab-running.ru)', url: 'https://dab-running.ru/' },
      { name: 'Медвежья гонка (bearrace.ru)', url: 'https://bearrace.ru/' },
      { name: 'CRACE (cracerun.ru)', url: 'https://cracerun.ru/' },
      { name: 'Лето ГТО (gto-leto.sport.mos.ru)', url: 'https://gto-leto.sport.mos.ru/' },
      { name: 'MyRace (myrace.info)', url: 'https://myrace.info/' },
      { name: 'Mountain-Race (mountain-race.ru)', url: 'https://mountain-race.ru/events/' },
      { name: '5 вёрст & S95 (субботние парковые забеги)', url: 'https://5verst.ru/' },
    ],
    events,
  };

  fs.writeFileSync(JSON_OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  syncEventsToSqlite(events, SQLITE_DB_PATH);
  generateIcsFile(events, ICS_OUTPUT);

  return payload;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('parse-events.mjs')) {
  runIncrementalParser()
    .then((res) => {
      console.log(
        `✅ База обновлена (${res.updated_at_human}): всего ${res.total_events} стартов (${res.main_races_count} основных + ${res.parkruns_count} парковых, новых в этом запуске: ${res.last_run_added_count}, помечено как новинки: ${res.new_events_count})`
      );
    })
    .catch((err) => {
      console.error('Ошибка обновления базы:', err);
      process.exit(1);
    });
}
