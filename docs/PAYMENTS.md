# Онлайн-оплата weglow.uz

Две системы:

- **Rahmat (АО «Multicard Payment»)** — оплата картами Uzcard, Humo, Visa, Mastercard и через Payme, Click, Uzum, Alif, Paynet, Oson, HUMO Pay, СБП и др. Деньги приходят на расчётный счёт в Капиталбанке. Фискальный чек формируется автоматически.
- **Uzum Nasiya** — рассрочка. Клиент платит частями, магазин получает всю сумму.

Пока в `assets/js/config.js` пустое поле `payApi`, сайт работает как раньше: заказ уходит в WhatsApp.

## Как устроено

```
weglow.uz (GitHub Pages)  ──►  Supabase Edge Function `pay`  ──►  Multicard API / Uzum Nasiya API
                                   │  таблицы uz_products, uz_payments
                                   └► уведомление об оплате в Telegram
```

- Клиент на сайте выбирает: «Оплатить онлайн», «В рассрочку» или «Через менеджера» (WhatsApp).
- Менеджер выставляет счёт на странице **https://weglow.uz/manager/** (вход по паролю `ADMIN_KEY`): клиенту приходит SMS со ссылкой, можно отправить ссылку в WhatsApp/Telegram или показать QR-код.
- Номера заказов вида **WG-1001** — по ним счёт виден в кабинете Rahmat.

## Шаги подключения

1. **Заявки** — см. тексты ниже. Rahmat: open.rhmt.uz, 1865, @rhmt_support_bot. Uzum Nasiya: через менеджера Капиталбанка / Uzum.
2. **Получить от Rahmat**: `application_id`, `secret`, `store_id` (ID кассы). Указать им адрес для callback (см. п. 5).
3. **Получить от Uzum Nasiya**: Bearer-токен, ID категории товара (`category`) и тип единицы (`unit_id`).
4. **Бухгалтер**: ИКПУ (MXIK) и код упаковки для каждого товара (tasnif.soliq.uz), ставка НДС, если компания плательщик НДС.
5. **Развернуть функцию** (Supabase CLI):
   ```bash
   supabase link --project-ref <REF>
   supabase db push                       # таблицы uz_products, uz_payments
   supabase secrets set \
     MULTICARD_APP_ID=... MULTICARD_SECRET=... MULTICARD_STORE_ID=... \
     NASIYA_TOKEN=... \
     ADMIN_KEY=<длинный пароль для менеджеров> \
     PUBLIC_FN_URL=https://<REF>.supabase.co/functions/v1/pay \
     SITE_URL=https://weglow.uz \
     CORS_ORIGINS=https://weglow.uz,https://www.weglow.uz \
     TG_BOT_TOKEN=... TG_CHAT_ID=...
   supabase functions deploy pay
   ```
   Callback для Rahmat: `https://<REF>.supabase.co/functions/v1/pay/multicard/callback`.
   Для теста можно временно задать `MULTICARD_BASE_URL=https://dev-mesh.multicard.uz` (песочница).
6. **Цены и коды товаров** — в таблице `uz_products` (Supabase → Table editor): `price_uzs`, `mxik`, `package_code`, `vat_percent`, `nasiya_category`, `nasiya_unit_id`. Товар без цены онлайн не продаётся.
7. **Включить на сайте**: в `assets/js/config.js` указать `payApi: 'https://<REF>.supabase.co/functions/v1/pay'` и выложить.

## Важно

- Callback Multicard должен отвечать `{"success": true}`, иначе платёж отменяется. Функция проверяет подпись `md5(store_id + invoice_id + amount + secret)` и сумму заказа.
- У Uzum Nasiya нет тестовой среды — первый договор проверять на небольшой сумме вместе с менеджером Uzum.
- В Nasiya метод проверки статуса принимает номер договора, а подтверждение и отмена — внутренний `order`. Если менеджер Uzum скажет иначе — поправить `nasiya/confirm` в `supabase/functions/pay/index.ts`.

## Текст заявки в Rahmat (Multicard)

> Здравствуйте! Хотим подключить онлайн-эквайринг Rahmat для интернет-магазина https://weglow.uz (морской коллаген WEGLOW).
> Компания: <название юрлица>, ИНН <ИНН>, расчётный счёт в АКБ «Капиталбанк».
> Нужно: оплата на платёжной странице Multicard (инвойсы через API) — карты Uzcard, Humo, Visa, Mastercard, Payme, Click, Uzum и другие приложения; отправка ссылки на оплату по SMS; фискализация чеков на вашей стороне.
> Вопросы: 1) комиссия по каждому способу оплаты; 2) срок зачисления на счёт; 3) какой партнёр стоит за кнопкой «Оплатить в рассрочку» на вашей платёжной странице; 4) можно ли выставлять счета из личного кабинета без API; 5) список документов для договора.
> Контакт: <имя, телефон, Telegram>.

## Текст заявки в Uzum Nasiya

> Здравствуйте! Хотим подключить рассрочку Uzum Nasiya для интернет-магазина https://weglow.uz (морской коллаген WEGLOW). Расчётный счёт — в АКБ «Капиталбанк».
> Компания: <название юрлица>, ИНН <ИНН>.
> Интеграция: Uzum Nasiya Partner API (check-status, calculate, orders, confirm, cancel) — уже готова на нашей стороне.
> Просим: 1) условия и комиссию для партнёра; 2) доступные сроки рассрочки; 3) Bearer-токен для API; 4) ID категории товара и тип единицы для нашего товара (биологически активная добавка, упаковка 30 саше); 5) срок зачисления средств.
> Контакт: <имя, телефон, Telegram>.
