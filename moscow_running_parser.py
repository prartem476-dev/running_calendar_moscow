#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Автоматический парсер беговых событий Москвы и Московской области.
Собирает актуальное расписание забегов с порталов:
1. ПроБЕГ (probeg.org) — календарь забегов Москвы и МО
2. Беговое сообщество (runc.run) — серия главных московских стартов

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
RUNC_URL = "https://runc.run/"

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


def classify_surface_and_type(title: str, distances: List[str]) -> Tuple[str, str]:
    """Определяет тип покрытия и категорию забега по названию и дистанциям."""
    t_lower = title.lower()
    d_joined = " ".join(distances).lower()

    if any(k in t_lower for k in ["манеж", "скорость", "в помещении", "indoor"]):
        surface = "Манеж"
    elif any(k in t_lower for k in ["трейл", "trail", "кросс", "cross", "горн", "лес", "парсек", "ultras", "gryadka"]):
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
    """
    Парсит даты вида:
    - '24.10.2026' -> ('2026-10-24', '2026-10-24')
    - '09–10.10.2027' -> ('2027-10-09', '2027-10-10')
    - '28.02–01.03.2027' -> ('2027-02-28', '2027-03-01')
    """
    s = raw_date.strip().replace("—", "-").replace("–", "-")

    # Простая дата DD.MM.YYYY
    m_single = re.match(r"^(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m_single:
        d, m, y = m_single.groups()
        iso = f"{y}-{m}-{d}"
        return iso, iso

    # Диапазон внутри одного месяца DD-DD.MM.YYYY
    m_range_same = re.match(r"^(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m_range_same:
        d1, d2, m, y = m_range_same.groups()
        return f"{y}-{m}-{d1}", f"{y}-{m}-{d2}"

    # Диапазон разных месяцев DD.MM-DD.MM.YYYY
    m_range_diff = re.match(r"^(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{4})$", s)
    if m_range_diff:
        d1, m1, d2, m2, y = m_range_diff.groups()
        return f"{y}-{m1}-{d1}", f"{y}-{m2}-{d2}"

    # Фолбэк: ищем первую дату DD.MM.YYYY
    m_any = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", s)
    if m_any:
        d, m, y = m_any.groups()
        iso = f"{y}-{m}-{d}"
        return iso, iso

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


def fetch_probeg_events() -> List[Dict[str, Any]]:
    """Парсит календарь забегов Москвы и МО с портала ПроБЕГ."""
    events: List[Dict[str, Any]] = []
    try:
        resp = requests.get(
            PROBEG_MOSCOW_URL,
            headers={"User-Agent": USER_AGENT},
            timeout=25,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"[WARN] Ошибка загрузки ПроБЕГ: {exc}")
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

        # Название забега и ссылка на карточку события на ПроБЕГ
        title_cell = tds[2]
        main_link = title_cell.find("a", href=re.compile(r"^/event/\d+/"))
        if not main_link:
            continue

        title = re.sub(r"\s+", " ", main_link.get_text(strip=True))
        probeg_url = f"https://probeg.org{main_link.get('href')}"

        # Рейтинг, если есть
        rating = None
        cell_text = title_cell.get_text(" ", strip=True)
        m_rating = re.search(r"(\d\.\d),\s*число оценивших", cell_text)
        if m_rating:
            try:
                rating = float(m_rating.group(1))
            except ValueError:
                rating = None

        # Город / локация
        location = re.sub(r"\s+", " ", tds[3].get_text(" ", strip=True))
        if not location:
            location = "Москва"

        # Дистанции
        dist_spans = [sp.get_text(" ", strip=True) for sp in tds[4].find_all("span")]
        if not dist_spans:
            raw_dist = tds[4].get_text(" ", strip=True)
            dist_spans = [raw_dist] if raw_dist else []
        distances = clean_distance_list(dist_spans)

        # Ссылки (официальный сайт, регистрация, соцсети)
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

        is_moscow_city = (
            location.lower().startswith("москва")
            or location.lower().startswith("г. москва")
        )
        region_tag = "Москва" if is_moscow_city else "Подмосковье"

        uid_seed = f"{start_date}-{title.lower()}"
        event_id = hashlib.md5(uid_seed.encode("utf-8")).hexdigest()[:10]

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
                "organizer": "Клубы и организаторы Москвы / ПроБЕГ",
                "url": primary_url,
                "registration_url": reg_url,
                "official_url": site_url,
                "source_url": probeg_url,
                "vk_url": vk_url,
                "source": "ПроБЕГ",
                "featured": any(
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

    print(f"[INFO] Получено событий с ПроБЕГ: {len(events)}")
    return events


def parse_runc_russian_date(label: str, ref_date: datetime) -> Tuple[Optional[str], Optional[str]]:
    """
    Парсит русские даты с runc.run, например:
    '21-22 ноября', '5 апреля', '25-26 апреля'
    Если дата уже прошла относительно ref_date более чем на 15 дней, относит к следующему году.
    """
    s = label.strip().lower().replace("—", "-").replace("–", "-")
    m = re.match(r"^(\d{1,2})(?:-(\d{1,2}))?\s+([а-яё]+)$", s)
    if not m:
        return None, None

    d1_str, d2_str, month_name = m.groups()
    month = RU_MONTHS.get(month_name)
    if not month:
        return None, None

    d1 = int(d1_str)
    d2 = int(d2_str) if d2_str else d1

    year = ref_date.year
    try_date = datetime(year, month, d1)
    if try_date.date() < ref_date.date():
        year += 1

    start_iso = f"{year:04d}-{month:02d}-{d1:02d}"
    end_iso = f"{year:04d}-{month:02d}-{d2:02d}"
    return start_iso, end_iso


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

        # Пропускаем старты Санкт-Петербурга («Белые ночи» и «Северная столица»)
        if any(spb_kw in href.lower() or spb_kw in title.lower() for spb_kw in ["wnmarathon", "spbhalf", "белые ночи", "северная столица"]):
            continue

        start_date, end_date = parse_runc_russian_date(raw_date, ref_date)
        if not start_date:
            continue

        dedup_key = (start_date, title.lower())
        if dedup_key in seen_keys:
            continue
        seen_keys.add(dedup_key)

        # Определяем детали по пресету
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
                "featured": True,
            }
        )

    print(f"[INFO] Получено московских событий Бегового сообщества: {len(events)}")
    return events


def merge_and_deduplicate(
    probeg_list: List[Dict[str, Any]],
    runc_list: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Объединяет события из разных источников без дублей и сортирует по дате."""
    merged: List[Dict[str, Any]] = []
    seen = set()

    # Сначала добавляем фирменные старты RunC, затем полный календарь ПроБЕГ
    for ev in runc_list + probeg_list:
        norm_title = re.sub(r"[^a-zа-яё0-9]", "", ev["title"].lower())
        key = (ev["date"], norm_title[:18])
        if key in seen:
            continue
        seen.add(key)
        merged.append(ev)

    merged.sort(key=lambda x: (x["date"], not x.get("featured", False), x["title"]))
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
    """Создает валидный .ics файл для импорта и подписки в календарях."""
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

    for ev in events:
        start_dt = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        end_dt_raw = datetime.strptime(ev.get("end_date") or ev["date"], "%Y-%m-%d").date()
        # В стандарте iCalendar для целодневных событий DTEND не включителен (+1 день)
        end_dt_exclusive = end_dt_raw + timedelta(days=1)

        dtstart_str = start_dt.strftime("%Y%m%d")
        dtend_str = end_dt_exclusive.strftime("%Y%m%d")

        distances_str = ", ".join(ev.get("distances", []))
        desc_parts = [
            f"Дистанции: {distances_str}",
            f"Категория: {ev.get('category', 'Забег')} ({ev.get('surface', 'Шоссе')})",
            f"Локация: {ev.get('location', 'Москва')}",
            f"Организатор / Источник: {ev.get('organizer', '')}",
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
    print(f"[INFO] Календарь iCal успешно сохранён в {output_path} ({len(events)} событий)")


def get_fallback_events(ref_date: datetime) -> List[Dict[str, Any]]:
    """Резервный набор главных московских забегов на случай недоступности внешних сайтов."""
    year = ref_date.year
    next_year = year + 1
    return [
        {
            "id": "fallback01",
            "title": "Соревнования «Скорость» в манеже",
            "date": f"{year}-11-21",
            "end_date": f"{year}-11-22",
            "display_date": "21–22 ноября",
            "location": "Москва, ЛФК ЦСКА",
            "region": "Москва",
            "distances": ["60 м", "400 м", "800 м", "1500 м", "3000 м"],
            "surface": "Манеж",
            "category": "Трек / Манеж",
            "rating": 5.0,
            "organizer": "Беговое сообщество (RunC)",
            "url": "https://speedrace.runc.run/",
            "registration_url": "https://speedrace.runc.run/",
            "official_url": "https://speedrace.runc.run/",
            "source_url": "https://runc.run/",
            "vk_url": "https://vk.com/runcrun",
            "source": "Беговое сообщество",
            "featured": True,
        },
        {
            "id": "fallback02",
            "title": "Забег «Апрель»",
            "date": f"{next_year}-04-05",
            "end_date": f"{next_year}-04-05",
            "display_date": "5 апреля",
            "location": "Москва, ОК «Лужники»",
            "region": "Москва",
            "distances": ["5 км"],
            "surface": "Шоссе",
            "category": "Городской забег",
            "rating": 5.0,
            "organizer": "Беговое сообщество (RunC)",
            "url": "https://aprilrun5km.runc.run/",
            "registration_url": "https://aprilrun5km.runc.run/",
            "official_url": "https://aprilrun5km.runc.run/",
            "source_url": "https://runc.run/",
            "vk_url": "https://vk.com/runcrun",
            "source": "Беговое сообщество",
            "featured": True,
        },
        {
            "id": "fallback03",
            "title": "Московский полумарафон",
            "date": f"{next_year}-04-25",
            "end_date": f"{next_year}-04-26",
            "display_date": "25–26 апреля",
            "location": "Москва, ОК «Лужники»",
            "region": "Москва",
            "distances": ["21.1 км (Полумарафон)", "5 км"],
            "surface": "Шоссе",
            "category": "Полумарафон",
            "rating": 5.0,
            "organizer": "Беговое сообщество (RunC)",
            "url": "https://moscowhalf.runc.run/",
            "registration_url": "https://moscowhalf.runc.run/",
            "official_url": "https://moscowhalf.runc.run/",
            "source_url": "https://runc.run/",
            "vk_url": "https://vk.com/runcrun",
            "source": "Беговое сообщество",
            "featured": True,
        },
        {
            "id": "fallback04",
            "title": "Московский Марафон",
            "date": f"{next_year}-09-26",
            "end_date": f"{next_year}-09-27",
            "display_date": "26–27 сентября",
            "location": "Москва, ОК «Лужники»",
            "region": "Москва",
            "distances": ["42.2 км (Марафон)", "10 км"],
            "surface": "Шоссе",
            "category": "Марафон",
            "rating": 5.0,
            "organizer": "Беговое сообщество (RunC)",
            "url": "https://moscowmarathon.runc.run/",
            "registration_url": "https://moscowmarathon.runc.run/",
            "official_url": "https://moscowmarathon.runc.run/",
            "source_url": "https://runc.run/",
            "vk_url": "https://vk.com/runcrun",
            "source": "Беговое сообщество",
            "featured": True,
        },
    ]


def main() -> None:
    now_msk = datetime.now(timezone(timedelta(hours=3)))
    print(f"[INFO] Запуск парсера беговых событий Москвы ({now_msk.isoformat()})")

    probeg_events = fetch_probeg_events()
    runc_events = fetch_runc_events(now_msk)

    events = merge_and_deduplicate(probeg_events, runc_events)
    if not events:
        print("[WARN] Внешние источники не вернули данных, используем резервный список.")
        events = get_fallback_events(now_msk)

    payload = {
        "updated_at": now_msk.strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "updated_at_human": now_msk.strftime("%d.%m.%Y в %H:%M МСК"),
        "region": "Москва и Московская область",
        "total_events": len(events),
        "sources": [
            {"name": "ПроБЕГ (probeg.org)", "url": "https://probeg.org/"},
            {"name": "Беговое сообщество (runc.run)", "url": "https://runc.run/"},
        ],
        "events": events,
    }

    JSON_OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[INFO] JSON база сохранена в {JSON_OUTPUT} ({len(events)} событий)")

    generate_ics(events, ICS_OUTPUT)


if __name__ == "__main__":
    main()
