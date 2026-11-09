# weglow.uz

Статичный сайт WEGLOW для Узбекистана. Русский язык — основной, переключатель RU / UZ в шапке
(выбор запоминается; прямая ссылка на узбекскую версию — `https://weglow.uz/?lang=uz`).

## Структура
- `index.html` — главная страница (тексты на русском)
- `privacy.html` — политика конфиденциальности (RU + UZ)
- `assets/js/config.js` — контакты (WhatsApp, телефон) и адрес платёжного API
- `assets/js/i18n.js` — все узбекские переводы
- `assets/js/main.js` — переключение языка, окна, формы → WhatsApp
- `assets/js/pay.js` — онлайн-оплата и рассрочка (включается через `payApi`)
- `manager/` — страница «Счета для клиентов» для менеджеров
- `server/` — платёжный сервер (Deno + SQLite): Uzum Checkout и Uzum Nasiya
- `deploy/` — Docker Compose, Caddy, скрипты установки и выкладки на VPS в Ташкенте; см. `docs/PAYMENTS.md`
- `assets/css/style.css` — стили
- `CNAME` — домен для GitHub Pages

## Как поменять контакты
Файл `assets/js/config.js`: номер WhatsApp для заявок и телефон в подвале.
Instagram — ссылка в `index.html` (поиск по `instagram.com`).

## Цены и оплата
Цены в сумах, ИКПУ и коды упаковки задаются на странице менеджера (раздел «Товары и цены») и показываются на сайте, когда онлайн-оплата включена. Подключение — `docs/PAYMENTS.md`.

## Локальный просмотр
```
python3 -m http.server 8765
```
и открыть http://localhost:8765
