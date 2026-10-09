/*
 * Online payments on weglow.uz: Multicard / Rahmat checkout and Uzum Nasiya installments.
 * Everything here stays dormant until CONFIG.payApi is set in main.js — the order form then keeps
 * working through WhatsApp only.
 */
(function () {
  'use strict';

  var W = window.Weglow;
  if (!W || !W.config.payApi) return;

  var API = W.config.payApi.replace(/\/$/, '');
  var t = W.t;
  var catalog = null; // { products: [{id, price_uzs}], online, nasiya }

  var orderDlg = document.getElementById('modal-order');
  var form = orderDlg.querySelector('form[data-form="order"]');
  var wrap = orderDlg.querySelector('.form-modal');
  var paym = form.querySelector('[data-paym]');
  var nasiyaOpt = form.querySelector('[data-paym-nasiya]');
  var submitBtn = form.querySelector('[data-order-submit]');
  var note = form.querySelector('[data-order-note]');
  var formError = form.querySelector('[data-pay-error]');
  var nasiyaBox = orderDlg.querySelector('[data-nasiya]');
  var resultDlg = document.getElementById('modal-result');

  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || 'HTTP_' + r.status); e.code = data.error; throw e; }
        return data;
      });
    });
  }

  function sum(n) {
    return Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' ' + t('pay.currency');
  }
  function priceOf(id) {
    var p = catalog && catalog.products.filter(function (x) { return x.id === id; })[0];
    return p && p.price_uzs ? p.price_uzs : 0;
  }
  function qty() { return +form.querySelector('output[name="qty"]').value || 1; }
  function method() { var m = form.querySelector('input[name="method"]:checked'); return m ? m.value : 'whatsapp'; }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }

  /* ------------------------------------------------------------ catalog & prices */

  function renderPrices() {
    document.querySelectorAll('[data-price]').forEach(function (el) {
      var p = priceOf(el.dataset.price);
      el.hidden = !p;
      if (p) el.textContent = sum(p);
    });
    syncForm();
  }

  function syncForm() {
    var price = priceOf(W.product());
    var canOnline = Boolean(catalog && catalog.online && price);
    paym.hidden = !canOnline;
    nasiyaOpt.hidden = !(canOnline && catalog.nasiya);
    if (!canOnline || (nasiyaOpt.hidden && method() === 'nasiya')) {
      var first = form.querySelector('input[name="method"][value="' + (canOnline ? 'online' : 'whatsapp') + '"]');
      if (first) first.checked = true;
    }
    var total = form.querySelector('[data-pay-total]');
    if (total) total.textContent = price ? sum(price * qty()) : '';
    var m = canOnline ? method() : 'whatsapp';
    submitBtn.textContent = t(m === 'online' ? 'pay.submit.online' : m === 'nasiya' ? 'pay.submit.nasiya' : 'pay.submit.wa');
    note.hidden = m !== 'whatsapp';
  }

  api('GET', '/catalog').then(function (data) { catalog = data; renderPrices(); }).catch(function () {});

  form.addEventListener('change', function (e) { if (e.target.name === 'method') syncForm(); });
  form.querySelectorAll('.qty button').forEach(function (b) { b.addEventListener('click', syncForm); });
  W.onLang(function () { if (catalog) renderPrices(); });

  /* ------------------------------------------------------------ order form hooks */

  function showError(el, code) {
    el.hidden = false;
    el.textContent = t('pay.err.' + code) || t('pay.err.generic');
  }

  function busy(on) {
    submitBtn.disabled = on;
    submitBtn.classList.toggle('is-busy', on);
  }

  W.payments = {
    /** Called by main.js on order form submit after validation. Returns true if handled here. */
    submit: function (data) {
      if (paym.hidden) return false;
      var m = method();
      if (m === 'whatsapp') return false;
      formError.hidden = true;
      if (m === 'online') {
        busy(true);
        api('POST', '/checkout', { product_id: W.product(), qty: qty(), name: data.name, phone: data.phone, lang: W.lang() })
          .then(function (res) { location.href = res.checkout_url; })
          .catch(function (e) { busy(false); showError(formError, e.code); });
      } else {
        startNasiya(data);
      }
      return true;
    },
    /** Called by main.js whenever the order modal opens. */
    reset: function () {
      nasiyaBox.hidden = true;
      form.hidden = false;
      formError.hidden = true;
      busy(false);
      syncForm();
    }
  };

  /* ------------------------------------------------------------ Uzum Nasiya */

  var nasiyaState = null; // { phone, name, product, qty, tariff }

  function step(name) {
    nasiyaBox.querySelectorAll('[data-step]').forEach(function (el) { el.hidden = el.dataset.step !== name; });
    nasiyaBox.querySelector('[data-nasiya-error]').hidden = true;
  }

  function nasiyaError(code) {
    step('none');
    showError(nasiyaBox.querySelector('[data-nasiya-error]'), code);
  }

  function startNasiya(data) {
    var phone = digits(data.phone);
    if (phone.length === 9) phone = '998' + phone;
    if (!/^998\d{9}$/.test(phone)) {
      form.elements.phone.closest('.field').classList.add('is-invalid');
      showError(formError, 'UZ_PHONE');
      return;
    }
    nasiyaState = { phone: phone, name: data.name, product: W.product(), qty: qty(), tariff: null };
    form.hidden = true;
    nasiyaBox.hidden = false;
    wrap.scrollTop = 0;
    checkBuyer();
  }

  function checkBuyer() {
    step('loading');
    api('POST', '/nasiya/check', { phone: nasiyaState.phone })
      .then(function (res) {
        if (res.state === 'ok') return loadTariffs();
        if (res.state === 'register') {
          nasiyaBox.querySelector('[data-nasiya-webview]').href = res.webview;
          return step('register');
        }
        step('denied');
      })
      .catch(function (e) { nasiyaError(e.code); });
  }

  function loadTariffs() {
    step('loading');
    api('POST', '/nasiya/calculate', { phone: nasiyaState.phone, product_id: nasiyaState.product, qty: nasiyaState.qty })
      .then(function (res) {
        var box = nasiyaBox.querySelector('[data-tariffs]');
        box.innerHTML = '';
        var firstAvailable = null;
        res.tariffs.forEach(function (tr) {
          var label = document.createElement('label');
          label.className = 'tariff' + (tr.available ? '' : ' is-disabled');
          var input = document.createElement('input');
          input.type = 'radio'; input.name = 'tariff'; input.value = tr.tariff; input.disabled = !tr.available;
          if (tr.available && !firstAvailable) { firstAvailable = tr.tariff; input.checked = true; }
          var text = document.createElement('span');
          var title = (W.lang() === 'uz' ? tr.title_uz : tr.title_ru) || (tr.months + ' ' + t('pay.months'));
          text.innerHTML = '<b></b><small></small>';
          text.querySelector('b').textContent = title;
          text.querySelector('small').textContent = tr.available
            ? t('pay.total') + ' ' + sum(tr.total) + (tr.deposit ? ' · ' + t('pay.deposit') + ' ' + sum(tr.deposit) : '')
            : (tr.error || t('pay.unavailable'));
          var month = document.createElement('em');
          month.textContent = tr.available ? sum(tr.month) + t('pay.per_month') : '';
          label.appendChild(input); label.appendChild(text); label.appendChild(month);
          box.appendChild(label);
        });
        nasiyaBox.querySelector('[data-nasiya-sign]').disabled = !firstAvailable;
        step('tariffs');
      })
      .catch(function (e) { nasiyaError(e.code); });
  }

  nasiyaBox.querySelector('[data-nasiya-recheck]').addEventListener('click', checkBuyer);
  nasiyaBox.querySelector('[data-nasiya-back]').addEventListener('click', function () { W.payments.reset(); });
  nasiyaBox.querySelector('[data-nasiya-sign]').addEventListener('click', function () {
    var picked = nasiyaBox.querySelector('input[name="tariff"]:checked');
    if (!picked) return;
    var btn = this;
    btn.disabled = true;
    api('POST', '/nasiya/order', {
      phone: nasiyaState.phone, name: nasiyaState.name, product_id: nasiyaState.product,
      qty: nasiyaState.qty, tariff: picked.value, lang: W.lang()
    })
      .then(function (res) { location.href = res.webview; })
      .catch(function (e) { btn.disabled = false; nasiyaError(e.code); });
  });

  /* ------------------------------------------------------------ return from checkout / signing */

  function showResult(state, titleKey, textKey, receipt) {
    var box = resultDlg.querySelector('[data-result]');
    box.dataset.result = state;
    resultDlg.querySelector('[data-result-title]').textContent = titleKey ? t(titleKey) : '';
    resultDlg.querySelector('[data-result-text]').textContent = textKey ? t(textKey) : '';
    var a = resultDlg.querySelector('[data-result-receipt]');
    a.hidden = !receipt;
    if (receipt) a.href = receipt;
    resultDlg.querySelector('[data-result-recheck]').hidden = state !== 'pending';
    if (!resultDlg.open) W.showModal(resultDlg);
  }

  function checkPaid(id, attempt) {
    api('GET', '/status?id=' + encodeURIComponent(id))
      .then(function (s) {
        if (s.status === 'paid') return showResult('ok', 'result.paid.title', 'result.paid.text', s.receipt_url);
        if (s.status === 'cancelled' || s.status === 'failed') return showResult('fail', 'result.fail.title', 'result.fail.text');
        if (attempt < 6) { showResult('loading', 'result.wait.title', 'result.wait.text'); return setTimeout(function () { checkPaid(id, attempt + 1); }, 2500); }
        showResult('pending', 'result.pending.title', 'result.pending.text');
      })
      .catch(function () { showResult('fail', 'result.fail.title', 'pay.err.generic'); });
  }

  function confirmNasiya(id, attempt) {
    api('POST', '/nasiya/confirm', { id: id })
      .then(function (s) {
        if (s.status === 'paid') return showResult('ok', 'result.nasiya.title', 'result.nasiya.text');
        if (s.status === 'cancelled') return showResult('fail', 'result.fail.title', 'result.nasiya.cancelled');
        if (attempt < 3) { showResult('loading', 'result.wait.title', 'result.wait.text'); return setTimeout(function () { confirmNasiya(id, attempt + 1); }, 2500); }
        showResult('pending', 'result.pending.title', 'result.nasiya.pending');
      })
      .catch(function () { showResult('fail', 'result.fail.title', 'pay.err.generic'); });
  }

  var params = new URLSearchParams(location.search);
  var paidId = params.get('paid');
  var nasiyaId = params.get('nasiya');
  var recheck = null;
  if (paidId) { recheck = function () { checkPaid(paidId, 0); }; recheck(); }
  if (nasiyaId) { recheck = function () { confirmNasiya(nasiyaId, 0); }; recheck(); }
  resultDlg.querySelector('[data-result-recheck]').addEventListener('click', function () { if (recheck) recheck(); });
  if (paidId || nasiyaId) {
    // Drop the payment id from the address bar so a reload does not repeat the check.
    params.delete('paid'); params.delete('nasiya');
    var qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
})();
