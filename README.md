# 🏃 Беговой календарь Москвы и МО (`running_calendar_moscow`)

Автоматически обновляемый календарь забегов, марафонов, полумарафонов, трейлов и легкоатлетических стартов в манеже по Москве и Московской области.

🌐 **Веб-версия (GitHub Pages):** [https://prartem476-dev.github.io/running_calendar_moscow/](https://prartem476-dev.github.io/running_calendar_moscow/)  
📅 **Подписка на iCal (`.ics`):** `https://prartem476-dev.github.io/running_calendar_moscow/moscow_running_events.ics`  
📦 **JSON база данных:** `https://prartem476-dev.github.io/running_calendar_moscow/moscow_running_events.json`

## ⚙️ Как это работает

1. **`moscow_running_parser.py`** — парсит расписание забегов с порталов «ПроБЕГ» (`probeg.org`) и «Беговое сообщество» (`runc.run`), очищает дубли, классифицирует покрытия (`Шоссе`, `Трейл / Грунт`, `Манеж`) и сохраняет результат в `moscow_running_events.json` и `moscow_running_events.ics`.
2. **`index.html`** — интерактивный веб-календарь с фильтрацией по месяцам, дистанциям (`5 км`, `10 км`, `21.1 км`, `42.2 км`), покрытию, региону и кнопками добавления в Google/Apple/Яндекс Календарь.
3. **`.github/workflows/scheduler.yml`** — GitHub Actions воркфлоу, который запускается автоматически каждый понедельник в **05:00 UTC (08:00 МСК)** или вручную через кнопку **Run workflow**, обновляет `.json` и `.ics` файлы и коммитит изменения обратно в репозиторий.
