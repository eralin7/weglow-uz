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

  var STATUS = { new: 'Ждёт оплаты', pending: 'Ожидает оплаты', paid: 'Оплачен', cancelled: 'Отменён', failed: 'Ошибка', refunded: 'Возврат' };
  var SHORT = { marine: 'Marine Collagen', vitc: 'Collagen + Vit C' };
  var ERRORS = {
    UNAUTHORIZED: 'Неверный пароль — войдите заново.',
    PRODUCT_NOT_FOR_SALE: 'У товара не указана цена — заполните её в разделе «Товары и цены».',
    PRODUCT_MXIK_MISSING: 'У товара не указан ИКПУ или код упаковки — заполните в разделе «Товары и цены».',
    UZUM_NOT_CONFIGURED: 'Не заданы ключи Uzum Bank на сервере.',
    BAD_PRICE: 'Цена — целое число сум, от 1 000.',
    BAD_MXIK: 'ИКПУ — ровно 17 цифр.',
    BAD_PACKAGE_CODE: 'Код упаковки — до 20 цифр.',
    BAD_VAT: 'НДС — число от 0 до 99.',
    BAD_NASIYA_CATEGORY: 'Категория Nasiya — целое число (выдаёт менеджер Uzum Nasiya).'
  };

  function show(view) { $$('[data-view]').forEach(function (el) { el.hidden = el.dataset.view !== view; }); $('[data-logout]').hidden = view !== 'app'; }
  function sum(n) { return Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' сум'; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
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
  form.elements.manager.value = store.get(MANAGER_STORE);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var err = $('[data-form-error]');
    err.hidden = true;
    store.set(MANAGER_STORE, form.elements.manager.value.trim());
    var btn = $('[data-create]');
    btn.disabled = true;
    api('POST', '/manager/invoice', {
      product_id: form.elements.product.value, qty: +qtyOut.value, name: form.elements.name.value,
      phone: form.elements.phone.value, lang: form.elements.lang.value, manager: form.elements.manager.value
    })
      .then(function (res) { btn.disabled = false; showResult(res.payment, res.text); loadPayments(); })
      .catch(function (e2) { btn.disabled = false; err.hidden = false; err.textContent = ERRORS[e2.code] || ('Ошибка: ' + (e2.code || e2.message)); });
  });

  function showResult(p, text) {
    var link = p.link;
    var prod = product(p.product_id);
    $('[data-r-number]').textContent = 'WG-' + p.number;
    $('[data-r-summary]').textContent = (prod ? prod.name_ru : p.product_id) + ' × ' + p.qty + ' — ' + sum(p.amount_uzs);
    $('[data-r-link]').value = link;
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
      var how = p.provider === 'nasiya' ? 'Uzum Nasiya' : (p.source === 'manager' ? 'Счёт, карта' : 'Сайт, карта');
      var link = p.link;
      return '<tr>' +
        '<td class="num">WG-' + p.number + '<small>' + esc(fmtDate(p.created_at)) + '</small><small>' + esc(p.source === 'manager' ? (p.created_by || 'менеджер') : 'сайт') + '</small></td>' +
        '<td>' + esc(p.customer_name || '—') + '<small>' + esc(fmtPhone(p.customer_phone)) + '</small></td>' +
        '<td class="prod">' + esc(SHORT[p.product_id] || (prod ? prod.name_ru : p.product_id)) + ' × ' + p.qty + '</td>' +
        '<td class="sum">' + sum(p.amount_uzs) + '<small>' + esc(how) + '</small></td>' +
        '<td><span class="badge badge--' + p.status + '">' + STATUS[p.status] + '</span>' +
          '<div class="mgr__actions">' +
          (link && (p.status === 'pending' || p.status === 'new') ? '<button type="button" data-act="copy" data-link="' + esc(link) + '">Ссылка</button>' : '') +
          (p.status === 'pending' || p.status === 'new' ? '<button type="button" data-act="cancel" data-id="' + p.id + '">Отменить</button>' : '') +
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

  /* ------------------------------------------------------------ products */

  function renderProductSelect() {
    var current = form.elements.product.value;
    form.elements.product.innerHTML = catalog.filter(function (p) { return p.active; }).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.price_uzs ? '' : ' disabled') + '>' + esc(p.name_ru) + (p.price_uzs ? ' — ' + sum(p.price_uzs) : ' — нет цены') + '</option>';
    }).join('');
    if (current) form.elements.product.value = current;
    updateTotal();
  }

  function cell(name, value, attrs) {
    return '<td><input name="' + name + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + '></td>';
  }

  function renderProducts() {
    $('[data-products]').innerHTML = catalog.map(function (p) {
      return '<tr data-id="' + esc(p.id) + '">' +
        '<td class="pname">' + esc(SHORT[p.id] || p.name_ru) + '</td>' +
        cell('price_uzs', p.price_uzs, 'inputmode="numeric" placeholder="350000"') +
        cell('mxik', p.mxik, 'inputmode="numeric" maxlength="17" placeholder="17 цифр"') +
        cell('package_code', p.package_code, 'inputmode="numeric" maxlength="20"') +
        cell('vat_percent', p.vat_percent, 'inputmode="numeric" style="min-width:60px"') +
        cell('nasiya_category', p.nasiya_category, 'inputmode="numeric"') +
        '<td><input type="checkbox" name="active"' + (p.active ? ' checked' : '') + '></td>' +
        '<td><button type="button" class="btn btn--blue btn--sm" data-save>Сохранить</button></td>' +
      '</tr>';
    }).join('');
  }

  $('[data-products]').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-save]');
    if (!btn) return;
    var row = btn.closest('tr');
    var val = function (n) { return row.querySelector('[name="' + n + '"]').value.trim(); };
    var err = $('[data-products-error]');
    err.hidden = true;
    btn.disabled = true;
    api('POST', '/manager/products', {
      id: row.dataset.id, price_uzs: digits(val('price_uzs')) || null, mxik: val('mxik'), package_code: val('package_code'),
      vat_percent: val('vat_percent') || 0, nasiya_category: digits(val('nasiya_category')) || null,
      active: row.querySelector('[name="active"]').checked
    })
      .then(function (res) {
        btn.disabled = false;
        catalog = catalog.map(function (p) { return p.id === res.product.id ? res.product : p; });
        renderProducts();
        renderProductSelect();
        var saved = $('[data-products] tr[data-id="' + res.product.id + '"] td:last-child');
        saved.insertAdjacentHTML('beforeend', ' <span class="saved">Сохранено</span>');
      })
      .catch(function (e2) { btn.disabled = false; err.hidden = false; err.textContent = ERRORS[e2.code] || ('Ошибка: ' + (e2.code || e2.message)); });
  });

  function loadProducts() {
    return api('GET', '/manager/products').then(function (res) { catalog = res.products; renderProducts(); renderProductSelect(); });
  }

  /* ------------------------------------------------------------ start */

  function startApp(initial) {
    show('app');
    payments = initial || [];
    loadProducts().then(renderPayments);
    setInterval(function () { if (key && !document.hidden) loadPayments().catch(function () {}); }, 30000);
  }

  if (!API) { show('off'); return; }
  key = store.get(KEY_STORE);
  if (!key) { show('login'); return; }
  api('GET', '/manager/payments').then(function (res) { startApp(res.payments); }).catch(function () { show('login'); });
})();
