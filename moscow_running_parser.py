#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Мульти-источниковый автоматический парсер беговых событий Москвы и Московской области.
Собирает актуальное расписание забегов с 12 площадок:
1. Беговое сообщество (runc.run) — главная серия московских стартов (Лужники, Садовое кольцо, ЦСКА)
2. ПроБЕГ (probeg.org) — календарь шоссейных забегов, марафонов и трейлов Москвы и МО
3. RussiaRunning (reg.russiarunning.com) — крупнейшая платформа регистрации на забеги и марафоны России
4. Лига Героев (heroleague.ru/calendar) — ЗаБег.РФ, Забег 2030, Гонка Героев в Москве и Алабино
5. Reg.Place (reg.place) — агрегатор регистрации на беговые и трейловые старты Москвы и МО
6. MyRace (myrace.info) — серия стартов City Trail, X-Race, Кубок России Мастерс и др.
7. Mountain-Race (mountain-race.ru) — специализированный календарь трейлов и кроссов Москвы и МО
8. City Trail (city-trail.ru) — серия городских трейлов в парках Москвы и Подмосковья
9. DAB Running (dab-running.ru) — серия горных трейлов DAB Vertical Four Seasons в СК «Кант» (м. Нагорная)
10. Медвежья гонка (bearrace.ru) — экстремальные забеги с препятствиями в ОУСЦ «Планерная» (Химки)
11. CRACE (cracerun.ru) — российская серия фитнес-гонок (бег + функциональные станции Hyrox)
12. Лето ГТО / Московский Спорт (gto-leto.sport.mos.ru) + 5 вёрст / S95 — фестивали ГТО и парковые забеги Москвы

Генерирует:
- moscow_running_events.json (структурированная база забегов для веб-приложения)
- moscow_running_events.ics (календарь в формате iCalendar для подписки в Apple/Google/Yandex Calendar)
"""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)

PROBEG_MOSCOW_URL = "https://probeg.org/races/region_group/46,47/date_region/2/?hide_parkruns=on"
PROBEG_PARKRUNS_URL = "https://probeg.org/races/region_group/46,47/date_region/2/"
RUNC_URL = "https://runc.run/"
RUSSIARUNNING_API_URL = "https://reg.russiarunning.com/api/events/list"
HEROLEAGUE_API_URL = "https://heroleague.ru/api/event_city/filtered"
REGPLACE_RUN_URL = "https://reg.place/events?q[scope]=future&q[sport_id]=1"
MYRACE_URL = "https://myrace.info/"
MOUNTAIN_RACE_URL = "https://mountain-race.ru/events/"
CITY_TRAIL_URL = "https://city-trail.ru/"
DAB_RUNNING_URL = "https://dab-running.ru/trails/"
BEARRACE_URL = "https://bearrace.ru/"
CRACERUN_URL = "https://cracerun.ru/"
GTO_LETO_URL = "https://gto-leto.sport.mos.ru/"

JSON_OUTPUT = Path("moscow_running_events.json")
ICS_OUTPUT = Path("moscow_running_events.ics")

RU_MONTHS = {
    "января": 1,
    "февраля": 2,
    "марта": 3,
    "апреля": 4,
    "мая": 5,
    "июня": 6,
    "июля": 7,
    "августа": 8,
    "сентября": 9,
    "октября": 10,
    "ноября": 11,
    "декабря": 12,
}

RU_MONTHS_NOMINATIVE = {
    "январь": 1,
    "февраль": 2,
    "март": 3,
    "апрель": 4,
    "май": 5,
    "июнь": 6,
    "июль": 7,
    "август": 8,
    "сентябрь": 9,
    "октябрь": 10,
    "ноябрь": 11,
    "декабрь": 12,
}

MOSCOW_OBLAST_KEYWORDS = [
    "москва", "московск", "зеленоград", "троицк", "балашиха", "красногорск",
    "одинцов", "химки", "мытищ", "королёв", "королев", "люберц", "подольск",
    "домодедов", "щёлков", "щелков", "серпухов", "коломн", "раменск",
    "долгопрудн", "жуковск", "пушкин", "реутов", "ногинск", "сергиев посад",
    "воскресенск", "лобня", "клин", "дубна", "истра", "истринск", "дмитров",
    "чехов", "наро-фоминск", "солнечногорск", "видное", "фрязино", "бронниц",
    "павловский посад", "звенигород", "шатура", "можайск", "бородино", "руза",
    "спас-каменка", "мураново", "трубино", "пересвет", "яхрома", "габо",
    "битца", "мещерск", "крылатск", "лужники", "измайлов", "царицын",
    "кузьминк", "сокольник", "вднх", "черноголовк", "протвино", "пущино",
    "кубинка", "апрелевк", "дедовск", "голицыно", "котельник", "дзержинск",
    "лыткарин", "красноармейск", "ивантеевк", "орехово-зуев", "егорьевск",
    "кашир", "ступин", "зарайск", "волоколамск", "талдом", "шаховск",
    "лотошин", "селятин", "кратово", "малаховк", "салтыковк", "вельяминов",
]


def is_moscow_or_mo(location_or_text: str) -> Tuple[bool, str]:
    """Проверяет, относится ли локация к Москве или Московской области."""
    low = location_or_text.lower()
    if not any(kw in low for kw in MOSCOW_OBLAST_KEYWORDS):
        return False, "Москва"

    is_city = (
        low.startswith("москва")
        or low.startswith("г. москва")
        or "зеленоград" in low
        or "троицк" in low
        or "лужники" in low
        or "крылатск" in low
    )
    if "московская область" in low or "московская обл" in low or "подмосковье" in low:
        is_city = False

    return True, ("Москва" if is_city else "Подмосковье")


def classify_surface_and_type(title: str, distances: List[str]) -> Tuple[str, str]:
    """Определяет тип покрытия и категорию забега по названию и дистанциям."""
    t_lower = title.lower()
    d_joined = " ".join(distances).lower()

    if any(k in t_lower for k in ["5 вёрст", "5 верст", "s95", "паркран", "parkrun", "паркбег", "пятюня"]):
        return "Парковый забег", "Парковый забег 5 км"

    if any(k in t_lower for k in ["манеж", "скорость", "в помещении", "indoor", "кубок россии мастерс"]):
        surface = "Манеж"
    elif any(
        k in t_lower
        for k in [
            "трейл", "trail", "кросс", "cross", "горн", "лес", "парсек",
            "ultras", "gryadka", "бородино", "туман", "буря", "вальс", "open band",
        ]
    ):
        surface = "Трейл / Грунт"
    else:
        surface = "Шоссе"

    if any(k in t_lower for k in ["ультра", "ultra", "backyard", "сутки", "100 км"]) or "100 км" in d_joined:
        category = "Ультрамарафон"
    elif "марафон" in t_lower and "полумарафон" not in t_lower:
        category = "Марафон"
    elif "полумарафон" in t_lower or "21.1" in d_joined or "21 км" in d_joined or "полумарафон" in d_joined:
        category = "Полумарафон"
    elif surface == "Трейл / Грунт":
        category = "Трейл / Кросс"
    elif surface == "Манеж":
        category = "Трек / Манеж"
    elif "эстафета" in t_lower or "relay" in t_lower:
        category = "Эстафета"
    elif "детск" in t_lower or "kids" in t_lower:
        category = "Детский забег"
    else:
        category = "Городской забег"

    return surface, category


def parse_probeg_date(raw_date: str) -> Tuple[Optional[str], Optional[str]]:
    """Парсит даты вида '24.10.2026', '09–10.10.2027', '28.02–01.03.2027'."""
    s = raw_date.strip().replace("—", "-").replace("–", "-")

    m_single = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m_single:
        d, m, y = m_single.groups()
        iso = f"{y}-{m}-{d}"
        return iso, iso

    m_range_same = re.match(r"^(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m_range_same:
        d1, d2, m, y = m_range_same.groups()
        return f"{y}-{m}-{d1}", f"{y}-{m}-{d2}"

    m_range_diff = re.match(r"^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m_range_diff:
        d1, m1, d2, m2, y = m_range_diff.groups()
        return f"{y}-{m1}-{d1}", f"{y}-{m2}-{d2}"

    m_any = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", s)
    if m_any:
        d, m, y = m_any.groups()
        iso = f"{y}-{m}-{d}"
        return iso, iso

    return None, None


def parse_russian_date_flexible(label: str, ref_date: datetime) -> Tuple[Optional[str], Optional[str]]:
    """
    Парсит русские даты:
    - '21-22 ноября'
    - '24 октября'
    - '27 - 28 ноября'
    - '9 - 10 января 2027'
    - '30 октября — 1 ноября'
    """
    s = re.sub(r"\s+", " ", label.strip().lower().replace("—", "-").replace("–", "-"))

    # Формат: '30 октября - 1 ноября [2026]'
    m_two_months = re.match(r"^(\d{1,2})\s+([а-яё]+)\s*-\s*(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$", s)
    if m_two_months:
        d1_s, m1_name, d2_s, m2_name, y_s = m_two_months.groups()
        m1 = RU_MONTHS.get(m1_name)
        m2 = RU_MONTHS.get(m2_name)
        if m1 and m2:
            year = int(y_s) if y_s else ref_date.year
            if not y_s and datetime(year, m1, int(d1_s)).date() < ref_date.date():
                year += 1
            y2 = year + 1 if m2 < m1 else year
            return f"{year:04d}-{m1:02d}-{int(d1_s):02d}", f"{y2:04d}-{m2:02d}-{int(d2_s):02d}"

    # Формат: '21-22 ноября [2026]' или '24 октября [2026]'
    m_same_month = re.match(r"^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s+([а-яё]+)(?:\s+(\d{4}))?$", s)
    if m_same_month:
        d1_s, d2_s, m_name, y_s = m_same_month.groups()
        month = RU_MONTHS.get(m_name)
        if month:
            d1 = int(d1_s)
            d2 = int(d2_s) if d2_s else d1
            year = int(y_s) if y_s else ref_date.year
            if not y_s and datetime(year, month, d1).date() < ref_date.date():
                year += 1
            return f"{year:04d}-{month:02d}-{d1:02d}", f"{year:04d}-{month:02d}-{d2:02d}"

    return None, None


def clean_distance_list(raw_spans: List[str]) -> List[str]:
    """Нормализует список дистанций."""
    cleaned = []
    for item in raw_spans:
        text = re.sub(r"\s+", " ", item).strip()
        if not text:
            continue
        if text.lower() == "марафон":
            text = "42.2 км (Марафон)"
        elif text.lower() == "полумарафон":
            text = "21.1 км (Полумарафон)"
        cleaned.append(text)
    return cleaned if cleaned else ["5 км", "10 км"]


def fetch_probeg_events(include_parkruns: bool = False) -> List[Dict[str, Any]]:
    """Парсит календарь забегов Москвы и МО с портала ПроБЕГ."""
    events: List[Dict[str, Any]] = []
    target_url = PROBEG_PARKRUNS_URL if include_parkruns else PROBEG_MOSCOW_URL
    try:
        resp = requests.get(
            target_url,
            headers={"User-Agent": USER_AGENT},
            timeout=25,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки ПроБЕГ ({target_url}): {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    rows = soup.select("table tr")

    for tr in rows:
        tds = tr.find_all("td")
        if len(tds) < 6:
            continue

        date_text = tds[1].get_text(strip=True)
        start_date, end_date = parse_probeg_date(date_text)
        if not start_date:
            continue

        title_cell = tds[2]
        main_link = title_cell.find("a", href=re.compile(r"^/event/\d+/"))
        if not main_link:
            continue

        title = re.sub(r"\s+", " ", main_link.get_text(strip=True))
        is_parkrun = any(k in title.lower() for k in ["5 вёрст", "5 верст", "s95", "паркран", "parkrun", "паркбег"])
        if include_parkruns and not is_parkrun:
            continue

        probeg_url = f"https://probeg.org{main_link.get('href')}"

        rating = None
        cell_text = title_cell.get_text(" ", strip=True)
        m_rating = re.search(r"(\d\.\d),\s*число оценивших", cell_text)
        if m_rating:
            try:
                rating = float(m_rating.group(1))
            except ValueError:
                rating = None

        location = re.sub(r"\s+", " ", tds[3].get_text(" ", strip=True)) or "Москва"
        dist_spans = [sp.get_text(" ", strip=True) for sp in tds[4].find_all("span")]
        if not dist_spans:
            raw_dist = tds[4].get_text(" ", strip=True)
            dist_spans = [raw_dist] if raw_dist else []
        distances = clean_distance_list(dist_spans)

        links_cell = tds[5]
        site_url = None
        reg_url = None
        vk_url = None

        for a in links_cell.find_all("a"):
            href = (a.get("href") or "").strip()
            if not href:
                continue
            if href.startswith("/"):
                href = f"https://probeg.org{href}"
            label = a.get_text(" ", strip=True).lower()
            if "регистрация" in label and not reg_url:
                reg_url = href
            elif "сайт" in label and not site_url:
                site_url = href
            elif ("vk.com" in href or "vk.ru" in href) and not vk_url:
                vk_url = href

        primary_url = reg_url or site_url or probeg_url
        surface, category = classify_surface_and_type(title, distances)
        _, region_tag = is_moscow_or_mo(location)

        uid_seed = f"{start_date}-{title.lower()}"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        source_label = "5 вёрст / S95" if is_parkrun else "ПроБЕГ"

        events.append(
            {
                "id": event_id,
                "title": title,
                "date": start_date,
                "end_date": end_date,
                "display_date": date_text,
                "location": location,
                "region": region_tag,
                "distances": distances,
                "surface": surface,
                "category": category,
                "rating": rating,
                "organizer": "Парковые забеги (5 вёрст / S95)" if is_parkrun else "Клубы и организаторы / ПроБЕГ",
                "url": primary_url,
                "registration_url": reg_url,
                "official_url": site_url,
                "source_url": probeg_url,
                "vk_url": vk_url,
                "source": source_label,
                "is_parkrun": is_parkrun,
                "featured": (not is_parkrun)
                and any(
                    kw in title.lower()
                    for kw in [
                        "московский марафон",
                        "московский полумарафон",
                        "моя столица",
                        "гром",
                        "grom",
                        "ночной забег",
                        "крылатск",
                        "лужники",
                    ]
                ),
            }
        )

    label_info = "парковых стартов 5 вёрст / S95" if include_parkruns else "событий с ПроБЕГ"
    print(f"[INFO] Получено {label_info}: {len(events)}")
    return events


RUNC_PRESET_DETAILS = {
    "speedrace": {
        "distances": ["60 м", "400 м", "800 м", "1500 м", "3000 м", "Эстафета 4×200 м"],
        "location": "Москва, ЛФК ЦСКА",
    },
    "aprilrun5km": {
        "distances": ["5 км"],
        "location": "Москва, ОК «Лужники»",
    },
    "fastdogxc": {
        "distances": ["2 км (каникросс)"],
        "location": "Москва, Битцевский лес",
    },
    "foxhillxc": {
        "distances": ["2 км", "4 км", "6 км", "8 км"],
        "location": "Москва, Битцевский лес",
    },
    "moscowhalf": {
        "distances": ["21.1 км (Полумарафон)", "5 км"],
        "location": "Москва, ОК «Лужники»",
    },
    "gardenring": {
        "distances": ["16 км", "Эстафета по Садовому кольцу"],
        "location": "Москва, Садовое кольцо",
    },
    "colorrun5km": {
        "distances": ["5 км"],
        "location": "Москва, ОК «Лужники»",
    },
    "nightrun10km": {
        "distances": ["10 км"],
        "location": "Москва, ОК «Лужники»",
    },
    "runfest": {
        "distances": ["15 км", "10 км", "5 км"],
        "location": "Москва, Садовое кольцо / Лужники",
    },
    "moscowmarathon": {
        "distances": ["42.2 км (Марафон)", "10 км"],
        "location": "Москва, ОК «Лужники»",
    },
}


def fetch_runc_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит серию московских стартов Бегового сообщества (runc.run)."""
    events: List[Dict[str, Any]] = []
    try:
        resp = requests.get(RUNC_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки RUNC.RUN: {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    items = soup.select(".responsive-left-runs-menu__item")

    seen_keys = set()
    for item in items:
        label_el = item.select_one(".responsive-left-runs-menu__item-label")
        link_el = item.select_one(".responsive-left-runs-menu__item-link")
        if not label_el or not link_el:
            continue

        raw_date = label_el.get_text(" ", strip=True)
        title = link_el.get_text(" ", strip=True)
        href = (link_el.get("href") or "").strip()

        if any(
            spb_kw in href.lower() or spb_kw in title.lower()
            for spb_kw in ["wnmarathon", "spbhalf", "белые ночи", "северная столица"]
        ):
            continue

        start_date, end_date = parse_russian_date_flexible(raw_date, ref_date)
        if not start_date:
            continue

        dedup_key = (start_date, title.lower())
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)

        distances = ["5 км", "10 км"]
        location = "Москва, ОК «Лужники»"
        for slug, meta in RUNC_PRESET_DETAILS.items():
            if slug in href.lower():
                distances = meta["distances"]
                location = meta["location"]
                break

        if "kids.runc.run" in href.lower():
            distances = ["400 м (дети)", "800 м (дети)"]

        surface, category = classify_surface_and_type(title, distances)
        uid_seed = f"{start_date}-{title.lower()}-runc"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        events.append(
            {
                "id": event_id,
                "title": title,
                "date": start_date,
                "end_date": end_date,
                "display_date": raw_date,
                "location": location,
                "region": "Москва",
                "distances": distances,
                "surface": surface,
                "category": category,
                "rating": 5.0,
                "organizer": "Беговое сообщество (RunC)",
                "url": href,
                "registration_url": href,
                "official_url": href,
                "source_url": RUNC_URL,
                "vk_url": "https://vk.com/runcrun",
                "source": "Беговое сообщество",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено московских событий Бегового сообщества: {len(events)}")
    return events


def fetch_regplace_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит беговые старты Москвы и МО с платформы регистрации Reg.Place (все страницы каталога)."""
    events: List[Dict[str, Any]] = []
    urls_to_check = [
        REGPLACE_RUN_URL,
        f"{REGPLACE_RUN_URL}&page=2",
        "https://reg.place/events?q[scope]=future&q[city]=Москва",
    ] + [f"https://reg.place/events?q[scope]=future&page={p}" for p in range(1, 7)]
    seen_hrefs = set()

    for page_url in urls_to_check:
        try:
            resp = requests.get(page_url, headers={"User-Agent": USER_AGENT}, timeout=20)
            if resp.status_code != 200:
                continue
        except Exception as exc:
            print(f"[WARN] Ошибка загрузки Reg.Place ({page_url}): {exc}")
            continue

        soup = BeautifulSoup(resp.text, "html.parser")
        for card in soup.select("article.b-event-card"):
            title_link = card.select_one(".b-event-card__title-link")
            meta_el = card.select_one(".b-event-card__meta")
            if not title_link or not meta_el:
                continue

            title = re.sub(r"\s+", " ", title_link.get_text(" ", strip=True))
            raw_href = (title_link.get("href") or "").split("?")[0]
            if not raw_href or raw_href in seen_hrefs:
                continue

            meta_text = re.sub(r"\s+", " ", meta_el.get_text(" ", strip=True))
            parts = [p.strip() for p in meta_text.split("•") if p.strip()]
            if not parts:
                continue

            tags_text = " ".join(t.get_text(" ", strip=True) for t in card.select(".b-event-card__tag")).lower()
            t_low = title.lower()
            is_running = (
                "бег" in tags_text
                or "рогейн" in tags_text
                or "ориентирование" in tags_text
                or "дог-трейл" in tags_text
                or any(k in t_low for k in ["трейл", "забег", "марафон", "кросс", "crace", "hyrox", "буря"])
            )
            if not is_running:
                continue

            date_part = parts[0]
            city_part = parts[1] if len(parts) >= 3 else "Москва / Московская область"

            # Если город не указан, но это известная московская серия (например, Open Band Буря)
            is_msk, region_tag = is_moscow_or_mo(f"{city_part} {title}")
            if not is_msk and "open band" not in t_low:
                continue
            if "open band" in t_low and not is_msk:
                region_tag = "Подмосковье"
                city_part = "Московская область, Красногорск"

            start_date, end_date = parse_russian_date_flexible(date_part, ref_date)
            if not start_date:
                continue

            seen_hrefs.add(raw_href)
            full_url = f"https://reg.place{raw_href}" if raw_href.startswith("/") else raw_href
            distances = ["5 км", "10 км", "21.1 км"]
            surface, category = classify_surface_and_type(title, distances)
            uid_seed = f"{start_date}-{title.lower()}-regplace"
            event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

            events.append(
                {
                    "id": event_id,
                    "title": title,
                    "date": start_date,
                    "end_date": end_date,
                    "display_date": date_part,
                    "location": city_part if "моск" in city_part.lower() else f"Московская область, {city_part}",
                    "region": region_tag,
                    "distances": distances,
                    "surface": surface,
                    "category": category,
                    "rating": None,
                    "organizer": "Reg.Place",
                    "url": full_url,
                    "registration_url": full_url,
                    "official_url": full_url,
                    "source_url": "https://reg.place/events",
                    "vk_url": None,
                    "source": "Reg.Place",
                    "is_parkrun": False,
                    "featured": "буря" in t_low or "самопреодоление" in t_low,
                }
            )

    print(f"[INFO] Получено событий с Reg.Place: {len(events)}")
    return events


def fetch_myrace_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит московские старты с платформы MyRace.info (City Trail, X-Race, Мастерс)."""
    events: List[Dict[str, Any]] = []
    try:
        resp = requests.get(MYRACE_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки MyRace.info: {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    for item in soup.select("a.events-list__item"):
        date_el = item.select_one(".date")
        city_el = item.select_one(".flag")
        h2_el = item.select_one("h2")
        type_el = item.select_one(".type")
        if not date_el or not city_el or not h2_el:
            continue

        sport_type = (type_el.get_text(" ", strip=True) if type_el else "").lower()
        if sport_type not in ["бег", "трейл", "скайраннинг", "гонки с препятствиями", "фестиваль"]:
            continue

        city_text = city_el.get_text(" ", strip=True)
        # Извлекаем чистый заголовок без вложенного div.registration-status
        h2_clone = BeautifulSoup(str(h2_el), "html.parser").find("h2")
        for st in h2_clone.select(".registration-status"):
            st.decompose()
        title = re.sub(r"\s+", " ", h2_clone.get_text(" ", strip=True))

        is_msk, region_tag = is_moscow_or_mo(f"{city_text} {title}")
        if not is_msk:
            continue

        raw_date = date_el.get_text(" ", strip=True)
        start_date, end_date = parse_russian_date_flexible(raw_date, ref_date)
        if not start_date or start_date < ref_date.strftime("%Y-%m-%d"):
            continue

        href = (item.get("href") or "").strip()
        full_url = f"https://myrace.info{href}" if href.startswith("/") else href

        distances = ["5 км", "10 км", "20 км"] if "трейл" in sport_type else ["5 км", "10 км"]
        surface, category = classify_surface_and_type(f"{title} {sport_type}", distances)
        uid_seed = f"{start_date}-{title.lower()}-myrace"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        events.append(
            {
                "id": event_id,
                "title": title,
                "date": start_date,
                "end_date": end_date,
                "display_date": raw_date,
                "location": city_text if "моск" in city_text.lower() else f"Московская область, {city_text}",
                "region": region_tag,
                "distances": distances,
                "surface": surface,
                "category": category,
                "rating": 4.9,
                "organizer": "MyRace",
                "url": full_url,
                "registration_url": full_url,
                "official_url": full_url,
                "source_url": MYRACE_URL,
                "vk_url": None,
                "source": "MyRace.info",
                "is_parkrun": False,
                "featured": "city trail" in title.lower(),
            }
        )

    print(f"[INFO] Получено событий с MyRace.info: {len(events)}")
    return events


def fetch_mountain_race_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит трейловые забеги Москвы и Подмосковья с портала Mountain-Race.ru."""
    events: List[Dict[str, Any]] = []
    try:
        resp = requests.get(MOUNTAIN_RACE_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки Mountain-Race.ru: {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    today_iso = ref_date.strftime("%Y-%m-%d")

    for section in soup.find_all("section"):
        h2 = section.find("h2")
        section_year = ref_date.year
        if h2:
            m_year = re.search(r"(\d{4})", h2.get_text(" ", strip=True))
            if m_year:
                section_year = int(m_year.group(1))

        for row in section.select("div.row.border-bottom"):
            if row.select_one(".bg-status-canceled"):
                continue

            link_el = row.select_one("a[href*='/events/']")
            if not link_el:
                continue

            title = re.sub(r"\s+", " ", link_el.get_text(" ", strip=True))
            loc_div = row.select_one(".fs-sm.text-secondary")
            location = re.sub(r"\s+", " ", loc_div.get_text(" ", strip=True)) if loc_div else ""

            is_msk, region_tag = is_moscow_or_mo(f"{location} {title}")
            if not is_msk:
                continue

            # Парсим дату вида '24.10' или '01.11 – 02.11'
            date_col = row.select_one(".col-md-2")
            if not date_col:
                continue
            raw_date = date_col.get_text(" ", strip=True)
            m_dates = re.findall(r"(\d{2})\.(\d{2})", raw_date)
            if not m_dates:
                continue

            d1, m1 = m_dates[0]
            d2, m2 = m_dates[-1]
            start_date = f"{section_year:04d}-{int(m1):02d}-{int(d1):02d}"
            end_date = f"{section_year:04d}-{int(m2):02d}-{int(d2):02d}"
            if start_date < today_iso:
                continue

            dist_chips = []
            for badge in row.select("span.bg-secondary"):
                spans = [s.get_text(" ", strip=True) for s in badge.find_all("span")]
                if spans:
                    dist_chips.append(" ".join(spans))
            distances = clean_distance_list(dist_chips)

            href = (link_el.get("href") or "").strip()
            full_url = f"https://mountain-race.ru{href}" if href.startswith("/") else href
            surface, category = classify_surface_and_type(title, distances)
            uid_seed = f"{start_date}-{title.lower()}-mr"
            event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

            events.append(
                {
                    "id": event_id,
                    "title": title,
                    "date": start_date,
                    "end_date": end_date,
                    "display_date": f"{raw_date}.{section_year}",
                    "location": location or "Москва и Московская область",
                    "region": region_tag,
                    "distances": distances,
                    "surface": "Трейл / Грунт",
                    "category": "Трейл / Кросс",
                    "rating": 4.9,
                    "organizer": "Mountain-Race",
                    "url": full_url,
                    "registration_url": full_url,
                    "official_url": full_url,
                    "source_url": MOUNTAIN_RACE_URL,
                    "vk_url": "https://vk.com/mountain_race",
                    "source": "Mountain-Race.ru",
                    "is_parkrun": False,
                    "featured": True,
                }
            )

    print(f"[INFO] Получено событий с Mountain-Race.ru: {len(events)}")
    return events


def format_rr_distance(dist_km: Any, name: str) -> Optional[str]:
    """Форматирует дистанцию из элемента raceItems платформы RussiaRunning."""
    if dist_km and isinstance(dist_km, (int, float)) and dist_km > 0:
        if abs(dist_km - 42.195) < 0.3 or abs(dist_km - 42.2) < 0.2:
            return "42.2 км (Марафон)"
        if abs(dist_km - 21.0975) < 0.2 or abs(dist_km - 21.1) < 0.2:
            return "21.1 км (Полумарафон)"
        if dist_km < 1:
            meters = int(round(dist_km * 1000))
            return f"{meters} м"
        if float(dist_km).is_integer():
            return f"{int(dist_km)} км"
        return f"{round(float(dist_km), 2)} км"
    clean_name = (name or "").strip()
    if any(k in clean_name.lower() for k in ["км", "метр", "марафон", "миля"]):
        return clean_name
    return None


def fetch_russiarunning_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит предстоящие забеги Москвы и МО через официальный JSON API reg.russiarunning.com."""
    events: List[Dict[str, Any]] = []
    today_iso = ref_date.strftime("%Y-%m-%d")
    seen_codes = set()

    for skip in range(0, 264, 24):
        payload = {
            "page": {"take": 24, "skip": skip},
            "language": "ru",
            "filter": {
                "eventsLoaderType": 0,
                "search": "",
                "championshipIds": [],
            },
        }
        try:
            resp = requests.post(
                RUSSIARUNNING_API_URL,
                json=payload,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=20,
            )
            if resp.status_code != 200:
                break
            batch = resp.json().get("list") or []
            if not batch:
                break
        except Exception as exc:
            print(f"[WARN] Ошибка загрузки RussiaRunning (skip={skip}): {exc}")
            break

        for it in batch:
            code = (it.get("code") or "").strip()
            if not code or code in seen_codes:
                continue

            disc = (it.get("disciplineCode") or "").lower()
            if disc and disc not in ["run", "trail", "obstacle-racing", "nordic-walking", "athletics"]:
                continue

            title = re.sub(r"\s+", " ", (it.get("title") or "").strip()).strip("^")
            place = re.sub(r"\s+", " ", (it.get("place") or "").strip())
            address = re.sub(r"\s+", " ", (it.get("address") or "").strip())
            city_name = re.sub(r"\s+", " ", (it.get("cityName") or "").strip())

            # Отсеиваем события других городов (например, если в названии другой город)
            combined_loc = f"{place} {address} {city_name}"
            if any(other in combined_loc.lower() for other in ["санкт-петербург", "нижний новгород", "самара", "тюмень", "грозный"]):
                continue

            is_msk, region_tag = is_moscow_or_mo(f"{combined_loc} {title}")
            if not is_msk:
                continue

            begin_raw = (it.get("beginDate") or "")[:10]
            end_raw = (it.get("endDate") or begin_raw)[:10]
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", begin_raw) or begin_raw < today_iso:
                continue

            seen_codes.add(code)

            # Извлекаем дистанции из raceItems
            distances: List[str] = []
            for ri in it.get("raceItems") or []:
                ri_disc = (ri.get("disciplineCode") or "").lower()
                if ri_disc == "goods-services":
                    continue
                d_str = format_rr_distance(ri.get("distance"), ri.get("name") or "")
                if d_str and d_str not in distances:
                    distances.append(d_str)

            if not distances:
                distances = ["5 км", "10 км", "21.1 км"]

            location_display = place if place and "описании" not in place.lower() else (address or "Москва")
            url = f"https://reg.russiarunning.com/event/{code}"
            surface, category = classify_surface_and_type(title, distances)

            rating = it.get("participantRating") or it.get("approvedStarRating") or it.get("starRating")
            if isinstance(rating, (int, float)) and rating > 0:
                rating = round(float(rating), 1)
            else:
                rating = None

            uid_seed = f"{begin_raw}-{code.lower()}-rr"
            event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

            events.append(
                {
                    "id": event_id,
                    "title": title,
                    "date": begin_raw,
                    "end_date": end_raw if end_raw >= begin_raw else begin_raw,
                    "display_date": datetime.strptime(begin_raw, "%Y-%m-%d").strftime("%d.%m.%Y"),
                    "location": location_display,
                    "region": region_tag,
                    "distances": distances,
                    "surface": surface,
                    "category": category,
                    "rating": rating,
                    "organizer": it.get("organizerName") or "RussiaRunning",
                    "url": url,
                    "registration_url": url,
                    "official_url": url,
                    "source_url": "https://reg.russiarunning.com/",
                    "vk_url": None,
                    "source": "RussiaRunning",
                    "is_parkrun": False,
                    "featured": bool(
                        it.get("rrRecomended")
                        or any(k in title.lower() for k in ["моя столица", "сергиевым", "патриот", "8 городов", "полумарафон"])
                    ),
                }
            )

    print(f"[INFO] Получено московских событий с RussiaRunning: {len(events)}")
    return events


def fetch_heroleague_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит московские старты «Лиги Героев» (heroleague.ru/calendar): ЗаБег.РФ, Гонка Героев, Забег 2030."""
    events: List[Dict[str, Any]] = []
    date_from = ref_date.strftime("%Y-%m-%dT00:00:00.000Z")
    date_to = f"{ref_date.year + 1}-12-31T23:59:59.000Z"

    payload = {
        "city": {"id": 0},
        "date_from": date_from,
        "date_to": date_to,
        "event_type": {"public_id": None},
    }

    try:
        resp = requests.post(
            HEROLEAGUE_API_URL,
            json=payload,
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=20,
        )
        resp.raise_for_status()
        values = resp.json().get("values") or []
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки Лиги Героев (heroleague.ru): {exc}")
        return events

    seen_ids = set()
    for item in values:
        pub_id = item.get("public_id") or ""
        if not pub_id or pub_id in seen_ids:
            continue

        address = re.sub(r"\s+", " ", (item.get("address") or "").strip())
        city_id = (item.get("city") or {}).get("id")
        ev_obj = item.get("event") or {}
        ev_type_obj = item.get("event_type") or {}

        base_title = (ev_obj.get("title") or ev_type_obj.get("title") or "").strip()
        subtitle = (ev_obj.get("title_above") or "").strip()

        if city_id != 524901 and not is_moscow_or_mo(f"{address} {base_title}")[0]:
            continue

        start_raw = (item.get("start_time") or "")[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", start_raw):
            continue

        seen_ids.add(pub_id)

        if subtitle and subtitle.lower() not in base_title.lower() and len(subtitle) < 48:
            full_title = f"{base_title} — {subtitle}"
        else:
            full_title = base_title

        ext_url = (ev_obj.get("external_url") or "").strip()
        if ext_url.startswith("/"):
            url = f"https://heroleague.ru{ext_url}"
        elif ext_url.startswith("http"):
            url = ext_url
        else:
            url = "https://heroleague.ru/calendar"

        if "забег.рф" in full_title.lower() or "всероссийский полумарафон" in full_title.lower():
            distances = ["21.1 км (Полумарафон)", "10 км", "5 км", "1 км"]
            surface = "Шоссе"
            category = "Полумарафон"
        elif "гонка героев" in full_title.lower():
            distances = ["8–10 км (25+ препятствий)"]
            surface = "Трейл / Грунт"
            category = "Трейл / Кросс"
        else:
            distances = ["21.1 км", "10 км", "5 км", "1 км"]
            surface, category = classify_surface_and_type(full_title, distances)

        is_msk, region_tag = is_moscow_or_mo(address or "Москва")
        if "алабино" in address.lower():
            region_tag = "Подмосковье"

        uid_seed = f"{start_raw}-{pub_id.lower()}-hl"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        events.append(
            {
                "id": event_id,
                "title": full_title,
                "date": start_raw,
                "end_date": start_raw,
                "display_date": datetime.strptime(start_raw, "%Y-%m-%d").strftime("%d.%m.%Y"),
                "location": address or "Москва",
                "region": region_tag,
                "distances": distances,
                "surface": surface,
                "category": category,
                "rating": 5.0,
                "organizer": "Лига Героев",
                "url": url,
                "registration_url": url,
                "official_url": "https://heroleague.ru/calendar",
                "source_url": "https://heroleague.ru/calendar",
                "vk_url": "https://vk.com/heroleague",
                "source": "Лига Героев",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено московских событий Лиги Героев: {len(events)}")
    return events


def fetch_dab_running_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит серию горных трейлов DAB Vertical Four Seasons (СК «Кант», Москва, м. Нагорная) с dab-running.ru."""
    events: List[Dict[str, Any]] = []
    today_iso = ref_date.strftime("%Y-%m-%d")
    try:
        resp = requests.get(DAB_RUNNING_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки DAB Running ({DAB_RUNNING_URL}): {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    seen_hrefs = set()

    for a in soup.select("a[href*='/races/']"):
        href = (a.get("href") or "").strip()
        if not href or href in seen_hrefs:
            continue

        text = re.sub(r"\s+", " ", a.get_text(" | ", strip=True))
        if "отменен" in text.lower() or "online" in text.lower() or "онлайн" in text.lower():
            continue

        m_date = re.search(r"(\d{2}\.\d{2}\.\d{4})", text)
        if not m_date:
            continue

        raw_date = m_date.group(1)
        start_date, end_date = parse_probeg_date(raw_date)
        if not start_date or start_date < today_iso:
            continue

        seen_hrefs.add(href)
        # Извлекаем название забега после даты
        parts = [p.strip() for p in text.split("|") if p.strip()]
        title = parts[-1] if parts else "DAB Vertical Night Trail"

        full_url = f"https://dab-running.ru{href}" if href.startswith("/") else href
        distances = ["14 км (+700м)", "10 км (+500м)", "7 км (+350м)", "3.5 км (+150м)", "1 км (дети)"]
        uid_seed = f"{start_date}-{title.lower()}-dab"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        events.append(
            {
                "id": event_id,
                "title": title,
                "date": start_date,
                "end_date": end_date,
                "display_date": raw_date,
                "location": "Москва, м. Нагорная, СК «Кант» (Электролитный пр., 7Б)",
                "region": "Москва",
                "distances": distances,
                "surface": "Трейл / Грунт",
                "category": "Трейл / Кросс",
                "rating": 5.0,
                "organizer": "DAB Running",
                "url": full_url,
                "registration_url": full_url,
                "official_url": full_url,
                "source_url": DAB_RUNNING_URL,
                "vk_url": "https://vk.com/dabrunning",
                "source": "DAB Running",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено событий с DAB Running: {len(events)}")
    return events


def fetch_city_trail_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит серию городских трейлов City Trail by Wild Trail (city-trail.ru) в парках Москвы и МО."""
    events: List[Dict[str, Any]] = []
    try:
        resp = requests.get(CITY_TRAIL_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        if resp.status_code != 200:
            return events
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки City Trail ({CITY_TRAIL_URL}): {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    seen_stages = set()

    for a in soup.find_all("a", href=re.compile(r"^/[1-9]$")):
        href = (a.get("href") or "").strip()
        text = re.sub(r"\s+", " ", a.get_text(" | ", strip=True))
        parts = [p.strip() for p in text.split("|") if p.strip()]
        # Ожидаем структуру: ['6', 'x-race', '1 ноября', 'парк X-Land', ...]
        if len(parts) < 4 or not parts[0].isdigit():
            continue

        stage_num = parts[0]
        if stage_num in seen_stages:
            continue

        stage_slug = parts[1].title()
        raw_date = parts[2]
        park_loc = parts[3]

        start_date, end_date = parse_russian_date_flexible(raw_date, ref_date)
        if not start_date:
            continue

        seen_stages.add(stage_num)
        title = f"City Trail #{stage_num} — {stage_slug} ({park_loc})"
        full_url = f"https://city-trail.ru{href}"
        is_msk, region_tag = is_moscow_or_mo(park_loc)
        if "x-land" in park_loc.lower() or "ромашково" in park_loc.lower():
            region_tag = "Подмосковье"
        else:
            region_tag = "Москва"

        distances = ["5 км", "10 км", "15 км", "25–30 км"]
        uid_seed = f"{start_date}-{stage_num}-citytrail"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        events.append(
            {
                "id": event_id,
                "title": title,
                "date": start_date,
                "end_date": end_date,
                "display_date": raw_date,
                "location": f"{region_tag}, {park_loc}",
                "region": region_tag,
                "distances": distances,
                "surface": "Трейл / Грунт",
                "category": "Трейл / Кросс",
                "rating": 5.0,
                "organizer": "Wild Trail / City Trail",
                "url": full_url,
                "registration_url": full_url,
                "official_url": full_url,
                "source_url": CITY_TRAIL_URL,
                "vk_url": "https://vk.com/city_trail",
                "source": "City Trail",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено этапов с City-Trail.ru: {len(events)}")
    return events


def fetch_bearrace_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит экстремальные забеги с препятствиями «Медвежья гонка» (bearrace.ru, ОУСЦ Планерная, Химки)."""
    events: List[Dict[str, Any]] = []
    today_iso = ref_date.strftime("%Y-%m-%d")
    try:
        resp = requests.get(BEARRACE_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки BearRace ({BEARRACE_URL}): {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    seen_urls = set()

    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        if "russiarunning.com/event/" not in href or href in seen_urls:
            continue

        # Извлекаем дату DDMMYYYY из кода ссылки, например ZabegsprepyatstviyamiMedvezhyagonka13122026
        m_date = re.search(r"(\d{2})(\d{2})(202\d)", href)
        if not m_date:
            continue

        d, m, y = m_date.groups()
        start_date = f"{y}-{m}-{d}"
        if start_date < today_iso:
            continue

        seen_urls.add(href)
        clean_reg_url = href.split("?")[0]
        title = "Забег с препятствиями «Медвежья гонка»"
        uid_seed = f"{start_date}-bearrace"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

        events.append(
            {
                "id": event_id,
                "title": title,
                "date": start_date,
                "end_date": start_date,
                "display_date": f"{d}.{m}.{y}",
                "location": "Московская область, г. Химки, ОУСЦ «Планерная»",
                "region": "Подмосковье",
                "distances": ["5+ км (30+ препятствий)", "Командная эстафета"],
                "surface": "Трейл / Грунт",
                "category": "Трейл / Кросс",
                "rating": 4.9,
                "organizer": "Медвежья гонка (BearRace)",
                "url": clean_reg_url,
                "registration_url": clean_reg_url,
                "official_url": BEARRACE_URL,
                "source_url": BEARRACE_URL,
                "vk_url": "https://vk.com/bearrace",
                "source": "BearRace.ru",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено событий с BearRace.ru: {len(events)}")
    return events


def fetch_cracerun_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит фитнес-гонки CRACE / HYROX (cracerun.ru) и проверяет наличие московских стартов."""
    events: List[Dict[str, Any]] = []
    today_iso = ref_date.strftime("%Y-%m-%d")
    try:
        resp = requests.get(CRACERUN_URL, headers={"User-Agent": USER_AGENT}, timeout=20)
        if resp.status_code != 200:
            return events
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки CRACE ({CRACERUN_URL}): {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    for a in soup.find_all("a", href=True):
        title = re.sub(r"\s+", " ", a.get_text(" ", strip=True))
        href = (a.get("href") or "").strip()
        if "crace" not in title.lower():
            continue
        is_msk, region_tag = is_moscow_or_mo(title)
        if not is_msk:
            continue

        m_date = re.search(r"/(\d{2})(\d{2})(\d{2})$", href)
        if not m_date:
            continue
        d, m, y_short = m_date.groups()
        start_date = f"20{y_short}-{m}-{d}"
        if start_date < today_iso:
            continue

        uid_seed = f"{start_date}-{title.lower()}-crace"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]
        events.append(
            {
                "id": event_id,
                "title": f"Фитнес-гонка {title} (HYROX формат)",
                "date": start_date,
                "end_date": start_date,
                "display_date": f"{d}.{m}.20{y_short}",
                "location": "Москва",
                "region": region_tag,
                "distances": ["8×1 км бег + 8 функциональных станций"],
                "surface": "Манеж",
                "category": "Трек / Манеж",
                "rating": 5.0,
                "organizer": "CRACE Russia",
                "url": href if href.startswith("http") else f"https://cracerun.ru{href}",
                "registration_url": href,
                "official_url": CRACERUN_URL,
                "source_url": CRACERUN_URL,
                "vk_url": "https://vk.com/cracerussia",
                "source": "CRACE",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено московских событий с CRACE: {len(events)}")
    return events


def fetch_gto_leto_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Парсит фестивали «Лето ГТО | Московский Спорт» (gto-leto.sport.mos.ru)."""
    events: List[Dict[str, Any]] = []
    today_iso = ref_date.strftime("%Y-%m-%d")
    try:
        import urllib3
        urllib3.disable_warnings()
        resp = requests.get(GTO_LETO_URL, headers={"User-Agent": USER_AGENT}, timeout=15, verify=False)
        if resp.status_code != 200:
            return events
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки Лето ГТО ({GTO_LETO_URL}): {exc}")
        return events

    soup = BeautifulSoup(resp.text, "html.parser")
    text = soup.get_text("\n", strip=True)
    # Ищем опубликованные даты вида DD.MM.YYYY или DD месяца
    for m in re.finditer(r"(\d{2}\.\d{2}\.202\d)", text):
        raw_date = m.group(1)
        start_date, _ = parse_probeg_date(raw_date)
        if not start_date or start_date < today_iso:
            continue
        uid_seed = f"{start_date}-gto-leto"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]
        events.append(
            {
                "id": event_id,
                "title": "Фестиваль «Лето ГТО» — Московский Спорт",
                "date": start_date,
                "end_date": start_date,
                "display_date": raw_date,
                "location": "Москва, площадки Московского Спорта",
                "region": "Москва",
                "distances": ["Бег ГТО (60 м, 1 км, 2 км, 3 км)"],
                "surface": "Трек / Манеж",
                "category": "Городской забег",
                "rating": 4.9,
                "organizer": "Московский Спорт",
                "url": GTO_LETO_URL,
                "registration_url": GTO_LETO_URL,
                "official_url": GTO_LETO_URL,
                "source_url": GTO_LETO_URL,
                "vk_url": None,
                "source": "Московский Спорт (ГТО)",
                "is_parkrun": False,
                "featured": True,
            }
        )

    print(f"[INFO] Получено событий с Лето ГТО (sport.mos.ru): {len(events)}")
    return events


def normalize_dedup_title(title: str) -> str:
    """Нормализует название для умной дедупликации между разными агрегаторами."""
    low = title.lower()
    for stop in ["забег", "пробег", "трейл", "trail", "кросс", "серия", "2026", "2027"]:
        low = low.replace(stop, "")
    return re.sub(r"[^a-zа-яё0-9]", "", low)


def merge_and_deduplicate(event_lists: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Объединяет события из всех источников без дублей и сортирует по дате."""
    merged: List[Dict[str, Any]] = []
    seen = set()

    for ev_list in event_lists:
        for ev in ev_list:
            norm_title = normalize_dedup_title(ev["title"])
            if not norm_title:
                norm_title = re.sub(r"[^a-zа-яё0-9]", "", ev["title"].lower())
            key = (ev["date"], norm_title[:14])
            if key in seen:
                continue
            seen.add(key)
            merged.append(ev)

    merged.sort(
        key=lambda x: (
            x["date"],
            x.get("is_parkrun", False),
            not x.get("featured", False),
            x["title"],
        )
    )
    return merged


def escape_ics_text(text: str) -> str:
    """Экранирует спецсимволы согласно RFC 5545 (iCalendar)."""
    if not text:
        return ""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def generate_ics(events: List[Dict[str, Any]], output_path: Path) -> None:
    """Создает валидный .ics файл для импорта и подписки в календарях (без еженедельного спама паркранов)."""
    now_utc = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Moscow Running Calendar//running_calendar_moscow//RU",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Беговой календарь Москвы и МО",
        "X-WR-TIMEZONE:Europe/Moscow",
        "X-WR-CALDESC:Актуальное расписание забегов, марафонов и трейлов в Москве и Подмосковье",
    ]

    ics_events = [e for e in events if not e.get("is_parkrun", False)]

    for ev in ics_events:
        start_dt = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        end_dt_raw = datetime.strptime(ev.get("end_date") or ev["date"], "%Y-%m-%d").date()
        end_dt_exclusive = end_dt_raw + timedelta(days=1)

        dtstart_str = start_dt.strftime("%Y%m%d")
        dtend_str = end_dt_exclusive.strftime("%Y%m%d")

        distances_str = ", ".join(ev.get("distances", []))
        desc_parts = [
            f"Дистанции: {distances_str}",
            f"Категория: {ev.get('category', 'Забег')} ({ev.get('surface', 'Шоссе')})",
            f"Локация: {ev.get('location', 'Москва')}",
            f"Источник: {ev.get('source', '')}",
            f"Ссылка: {ev.get('url', '')}",
        ]
        description = escape_ics_text("\n".join(desc_parts))
        summary = escape_ics_text(f"🏃 {ev['title']} ({distances_str})")
        location = escape_ics_text(ev.get("location", "Москва"))
        url = ev.get("url", "")

        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{ev['id']}@running-calendar-moscow",
                f"DTSTAMP:{now_utc}",
                f"DTSTART;VALUE=DATE:{dtstart_str}",
                f"DTEND;VALUE=DATE:{dtend_str}",
                f"SUMMARY:{summary}",
                f"LOCATION:{location}",
                f"DESCRIPTION:{description}",
                f"URL:{url}",
                "STATUS:CONFIRMED",
                "TRANSP:TRANSPARENT",
                "END:VEVENT",
            ]
        )

    lines.append("END:VCALENDAR")
    output_path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    print(f"[INFO] Календарь iCal успешно сохранён в {output_path} ({len(ics_events)} событий)")


def main() -> None:
    now_msk = datetime.now(timezone(timedelta(hours=3)))
    print(f"[INFO] Запуск мульти-источникового парсера забегов Москвы ({now_msk.isoformat()})")

    runc_events = fetch_runc_events(now_msk)
    heroleague_events = fetch_heroleague_events(now_msk)
    dab_events = fetch_dab_running_events(now_msk)
    city_trail_events = fetch_city_trail_events(now_msk)
    bearrace_events = fetch_bearrace_events(now_msk)
    crace_events = fetch_cracerun_events(now_msk)
    gto_events = fetch_gto_leto_events(now_msk)
    probeg_events = fetch_probeg_events(include_parkruns=False)
    russiarunning_events = fetch_russiarunning_events(now_msk)
    mountain_events = fetch_mountain_race_events(now_msk)
    myrace_events = fetch_myrace_events(now_msk)
    regplace_events = fetch_regplace_events(now_msk)
    parkrun_events = fetch_probeg_events(include_parkruns=True)

    events = merge_and_deduplicate(
        [
            runc_events,
            heroleague_events,
            dab_events,
            city_trail_events,
            bearrace_events,
            crace_events,
            gto_events,
            probeg_events,
            russiarunning_events,
            mountain_events,
            myrace_events,
            regplace_events,
            parkrun_events,
        ]
    )

    main_races_count = sum(1 for e in events if not e.get("is_parkrun", False))
    parkruns_count = sum(1 for e in events if e.get("is_parkrun", False))

    payload = {
        "updated_at": now_msk.strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "updated_at_human": now_msk.strftime("%d.%m.%Y в %H:%M МСК"),
        "region": "Москва и Московская область",
        "total_events": len(events),
        "main_races_count": main_races_count,
        "parkruns_count": parkruns_count,
        "sources": [
            {"name": "Беговое сообщество (runc.run)", "url": "https://runc.run/"},
            {"name": "ПроБЕГ (probeg.org)", "url": "https://probeg.org/"},
            {"name": "RussiaRunning (reg.russiarunning.com)", "url": "https://reg.russiarunning.com/"},
            {"name": "Лига Героев (heroleague.ru)", "url": "https://heroleague.ru/calendar"},
            {"name": "Reg.Place (reg.place)", "url": "https://reg.place/events"},
            {"name": "City Trail (city-trail.ru)", "url": "https://city-trail.ru/"},
            {"name": "DAB Running (dab-running.ru)", "url": "https://dab-running.ru/"},
            {"name": "Медвежья гонка (bearrace.ru)", "url": "https://bearrace.ru/"},
            {"name": "CRACE (cracerun.ru)", "url": "https://cracerun.ru/"},
            {"name": "Лето ГТО (gto-leto.sport.mos.ru)", "url": "https://gto-leto.sport.mos.ru/"},
            {"name": "MyRace (myrace.info)", "url": "https://myrace.info/"},
            {"name": "Mountain-Race (mountain-race.ru)", "url": "https://mountain-race.ru/events/"},
            {"name": "5 вёрст & S95 (субботние парковые забеги)", "url": "https://5verst.ru/"},
        ],
        "events": events,
    }

    JSON_OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"[INFO] JSON база сохранена в {JSON_OUTPUT}: всего {len(events)} стартов "
        f"({main_races_count} целевых соревнований + {parkruns_count} парковых забегов 5 вёрст/S95)"
    )

    generate_ics(events, ICS_OUTPUT)


if __name__ == "__main__":
    main()
