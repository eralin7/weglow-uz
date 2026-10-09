(function () {
  'use strict';

  var CONFIG = window.WEGLOW_CONFIG || {};
  var API = (CONFIG.payApi || '').replace(/\/$/, '');
  var KEY_STORE = 'weglow-admin-key';
  var MANAGER_STORE = 'weglow-manager-name';
  var key = '';
  var catalog = [];
  var payments = [];

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  };

  var STATUS = { new: 'Новый', pending: 'Ожидает оплаты', paid: 'Оплачен', cancelled: 'Отменён', failed: 'Ошибка' };
  var SHORT = { marine: 'Marine Collagen', vitc: 'Collagen + Vit C' };
  var PS = { uzcard: 'Uzcard', humo: 'Humo', visa: 'Visa', mastercard: 'Mastercard', payme: 'Payme', click: 'Click', uzum: 'Uzum' };
  var ERRORS = {
    UNAUTHORIZED: 'Неверный пароль — войдите заново.',
    BAD_PHONE: 'Для SMS нужен узбекский номер +998 XX XXX XX XX.',
    PRODUCT_NOT_FOR_SALE: 'У товара не указана цена. Заполните её в таблице uz_products.',
    PRODUCT_MXIK_MISSING: 'У товара не указан ИКПУ или код упаковки (uz_products).',
    MULTICARD_NOT_CONFIGURED: 'Не заданы ключи Multicard на сервере.'
  };

  function show(view) { $$('[data-view]').forEach(function (el) { el.hidden = el.dataset.view !== view; }); $('[data-logout]').hidden = view !== 'app'; }
  function sum(n) { return Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' сум'; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function uzPhone(v) { var d = digits(v); if (d.length === 9) d = '998' + d; return /^998\d{9}$/.test(d) ? d : null; }
  function fmtPhone(d) { return d && d.length === 12 ? '+' + d.slice(0, 3) + ' ' + d.slice(3, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8, 10) + ' ' + d.slice(10) : (d ? '+' + d : '—'); }
  function fmtDate(s) { var d = new Date(s); return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function product(id) { return catalog.filter(function (p) { return p.id === id; })[0]; }

  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: Object.assign({ 'x-admin-key': key }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401) { logout(); }
        if (!r.ok) { var e = new Error(data.error || 'HTTP_' + r.status); e.code = data.error; throw e; }
        return data;
      });
    });
  }

  /* ------------------------------------------------------------ auth */

  function logout() { key = ''; store.set(KEY_STORE, ''); show('login'); }
  $('[data-logout]').addEventListener('click', logout);

  $('[data-login-form]').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#key');
    key = input.value.trim();
    api('GET', '/manager/payments')
      .then(function (res) { store.set(KEY_STORE, key); input.value = ''; startApp(res.payments); })
      .catch(function () { key = ''; input.closest('.field').classList.add('is-invalid'); });
  });
  $('#key').addEventListener('input', function () { this.closest('.field').classList.remove('is-invalid'); });

  /* ------------------------------------------------------------ invoice form */

  var form = $('[data-invoice-form]');
  var qtyOut = form.querySelector('output[name="qty"]');

  function updateTotal() {
    var p = product(form.elements.product.value);
    $('[data-total]').textContent = p && p.price_uzs ? sum(p.price_uzs * (+qtyOut.value || 1)) : 'нет цены';
  }

  $$('[data-step]', form).forEach(function (b) {
    b.addEventListener('click', function () {
      qtyOut.value = String(Math.min(99, Math.max(1, (+qtyOut.value || 1) + (+b.dataset.step))));
      updateTotal();
    });
  });
  form.elements.product.addEventListener('change', updateTotal);
  form.elements.phone.addEventListener('input', function () { this.closest('.field').classList.remove('is-invalid'); });
  form.elements.manager.value = store.get(MANAGER_STORE);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('[data-form-error]');
    err.hidden = true;
    var sms = form.elements.sms.checked;
    var phone = uzPhone(form.elements.phone.value);
    if (sms && !phone) { form.elements.phone.closest('.field').classList.add('is-invalid'); return; }
    store.set(MANAGER_STORE, form.elements.manager.value.trim());
    var btn = $('[data-create]');
    btn.disabled = true;
    api('POST', '/manager/invoice', {
      product_id: form.elements.product.value, qty: +qtyOut.value, name: form.elements.name.value,
      phone: form.elements.phone.value, lang: form.elements.lang.value, send_sms: sms, manager: form.elements.manager.value
    })
      .then(function (res) { btn.disabled = false; showResult(res.payment, res.text, sms); loadPayments(); })
      .catch(function (e2) { btn.disabled = false; err.hidden = false; err.textContent = ERRORS[e2.code] || ('Ошибка: ' + (e2.code || e2.message)); });
  });

  function showResult(p, text, sms) {
    var link = p.short_link || p.checkout_url;
    var prod = product(p.product_id);
    $('[data-r-number]').textContent = 'WG-' + p.number;
    $('[data-r-summary]').textContent = (prod ? prod.name_ru : p.product_id) + ' × ' + p.qty + ' — ' + sum(p.amount_uzs);
    $('[data-r-link]').value = link;
    var smsEl = $('[data-r-sms]');
    smsEl.hidden = !sms;
    smsEl.textContent = 'SMS со ссылкой отправлено на ' + fmtPhone(p.customer_phone);
    var waTarget = p.customer_phone ? digits(p.customer_phone) : '';
    $('[data-r-wa]').href = 'https://wa.me/' + waTarget + '?text=' + encodeURIComponent(text);
    $('[data-r-tg]').href = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text.replace(link, '').trim());
    var qrBox = $('[data-r-qr]');
    qrBox.innerHTML = '';
    if (window.qrcode) {
      var qr = window.qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }
    form.hidden = true;
    $('[data-result]').hidden = false;
  }

  $('[data-copy]').addEventListener('click', function () {
    var input = $('[data-r-link]');
    var btn = this;
    (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject()).catch(function () {
      input.select(); document.execCommand('copy');
    }).then(function () { btn.textContent = 'Скопировано'; setTimeout(function () { btn.textContent = 'Копировать'; }, 1500); });
  });

  $('[data-new]').addEventListener('click', function () {
    form.reset();
    qtyOut.value = '1';
    form.elements.manager.value = store.get(MANAGER_STORE);
    updateTotal();
    $('[data-result]').hidden = true;
    form.hidden = false;
  });

  /* ------------------------------------------------------------ payments list */

  function renderPayments() {
    var filter = ($('input[name="f"]:checked') || {}).value || 'all';
    var rows = payments.filter(function (p) {
      return filter === 'all' || (filter === 'paid' ? p.status === 'paid' : p.status === 'pending' || p.status === 'new');
    });
    $('[data-empty]').hidden = rows.length > 0;
    $('[data-rows]').innerHTML = rows.map(function (p) {
      var prod = product(p.product_id);
      var how = p.provider === 'nasiya' ? 'Uzum Nasiya' : (PS[p.ps] || p.ps || (p.source === 'manager' ? 'Счёт менеджера' : 'Сайт'));
      var link = p.short_link || p.checkout_url;
      return '<tr>' +
        '<td class="num">WG-' + p.number + '<small>' + esc(fmtDate(p.created_at)) + '</small><small>' + esc(p.source === 'manager' ? (p.created_by || 'менеджер') : 'сайт') + '</small></td>' +
        '<td>' + esc(p.customer_name || '—') + '<small>' + esc(fmtPhone(p.customer_phone)) + '</small></td>' +
        '<td class="prod">' + esc(SHORT[p.product_id] || (prod ? prod.name_ru : p.product_id)) + ' × ' + p.qty + '</td>' +
        '<td class="sum">' + sum(p.amount_uzs) + '<small>' + esc(how) + '</small></td>' +
        '<td><span class="badge badge--' + p.status + '">' + STATUS[p.status] + '</span>' +
          (p.receipt_url ? '<small><a href="' + esc(p.receipt_url) + '" target="_blank" rel="noopener">чек</a></small>' : '') +
          '<div class="mgr__actions">' +
          (link && p.status === 'pending' && p.provider === 'multicard' ? '<button type="button" data-act="copy" data-link="' + esc(link) + '">Ссылка</button>' : '') +
          (p.status === 'pending' ? '<button type="button" data-act="cancel" data-id="' + p.id + '">Отменить</button>' : '') +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  function loadPayments() {
    return api('GET', '/manager/payments').then(function (res) { payments = res.payments; renderPayments(); });
  }

  $('[data-refresh]').addEventListener('click', loadPayments);
  $$('input[name="f"]').forEach(function (r) { r.addEventListener('change', renderPayments); });
  $('[data-rows]').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'copy') {
      if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.link);
      b.textContent = 'Скопировано';
    }
    if (b.dataset.act === 'cancel' && confirm('Отменить счёт? Клиент больше не сможет по нему оплатить.')) {
      b.disabled = true;
      api('POST', '/manager/cancel', { id: b.dataset.id }).then(loadPayments).catch(function (e2) { b.disabled = false; alert('Не удалось отменить: ' + (e2.code || e2.message)); });
    }
  });

  /* ------------------------------------------------------------ start */

  function startApp(initial) {
    show('app');
    fetch(API + '/catalog').then(function (r) { return r.json(); }).then(function (res) {
      catalog = res.products;
      form.elements.product.innerHTML = catalog.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.price_uzs ? '' : ' disabled') + '>' + esc(p.name_ru) + (p.price_uzs ? ' — ' + sum(p.price_uzs) : ' — нет цены') + '</option>';
      }).join('');
      updateTotal();
      payments = initial || [];
      renderPayments();
    });
    setInterval(function () { if (key && !document.hidden) loadPayments().catch(function () {}); }, 30000);
  }

  if (!API) { show('off'); return; }
  key = store.get(KEY_STORE);
  if (!key) { show('login'); return; }
  api('GET', '/manager/payments').then(function (res) { startApp(res.payments); }).catch(function () { show('login'); });
})();
