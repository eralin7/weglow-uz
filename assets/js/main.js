(function () {
  'use strict';

  // Contacts and the payments API address live in assets/js/config.js.
  var CONFIG = window.WEGLOW_CONFIG;

  var PRODUCTS = {
    marine: {
      name: 'Marine Collagen',
      theme: 'theme-blue',
      images: ['assets/img/blue-1.png', 'assets/img/blue-2.png', 'assets/img/blue-3.png']
    },
    vitc: {
      name: 'Marine Collagen + Vitamin C',
      theme: 'theme-red',
      images: ['assets/img/red-1.png', 'assets/img/red-2.png', 'assets/img/red-3.png']
    }
  };

  var doc = document.documentElement;
  var STORAGE_KEY = 'weglow-lang';
  var lang = 'ru';
  var langListeners = [];

  /* ------------------------------------------------------------------
     Language
     ------------------------------------------------------------------ */
  var originals = new Map(); // element -> { html, attrs: {name: value} }

  function snapshot(el) {
    if (originals.has(el)) return;
    var entry = { html: el.hasAttribute('data-i18n') ? el.innerHTML : null, attrs: {} };
    var spec = el.getAttribute('data-i18n-attr');
    if (spec) spec.split(';').forEach(function (pair) {
      var name = pair.split(':')[0].trim();
      entry.attrs[name] = el.getAttribute(name);
    });
    originals.set(el, entry);
  }

  function t(key) {
    var dict = window.I18N[lang] || {};
    if (key in dict) return dict[key];
    return window.I18N.ru[key] !== undefined ? window.I18N.ru[key] : '';
  }

  function applyLang(next, persist) {
    lang = next === 'uz' ? 'uz' : 'ru';
    var uz = window.I18N.uz;

    document.querySelectorAll('[data-i18n], [data-i18n-attr]').forEach(function (el) {
      snapshot(el);
      var orig = originals.get(el);
      var key = el.getAttribute('data-i18n');
      if (key) {
        var html = lang === 'uz' && key in uz ? uz[key] : orig.html;
        if (el.tagName === 'TITLE') el.textContent = html; else el.innerHTML = html;
      }
      var spec = el.getAttribute('data-i18n-attr');
      if (spec) spec.split(';').forEach(function (pair) {
        var parts = pair.split(':');
        var name = parts[0].trim();
        var k = (parts[1] || '').trim();
        el.setAttribute(name, lang === 'uz' && k in uz ? uz[k] : orig.attrs[name]);
      });
    });

    doc.lang = lang;
    document.querySelectorAll('.lang button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
    document.querySelectorAll('.review').forEach(function (r) {
      var name = r.querySelector('.review__name');
      var avatar = r.querySelector('.review__avatar');
      if (name && avatar) avatar.textContent = name.textContent.trim().charAt(0);
    });
    document.querySelectorAll('a[data-keep-lang]').forEach(function (a) {
      var base = a.getAttribute('href').split('?')[0];
      a.setAttribute('href', lang === 'uz' ? base + '?lang=uz' : base);
    });
    updateWaLinks();
    if (currentDetail) fillDetail(currentDetail);
    langListeners.forEach(function (fn) { fn(lang); });

    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
      try {
        var url = new URL(location.href);
        if (lang === 'uz') url.searchParams.set('lang', 'uz'); else url.searchParams.delete('lang');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (e) {}
    }
  }

  function initialLang() {
    try {
      var p = new URLSearchParams(location.search).get('lang');
      if (p === 'uz' || p === 'ru') return p;
      return localStorage.getItem(STORAGE_KEY) || 'ru';
    } catch (e) { return 'ru'; }
  }

  document.querySelectorAll('.lang button').forEach(function (b) {
    b.addEventListener('click', function () { applyLang(b.dataset.lang, true); });
  });

  /* ------------------------------------------------------------------
     WhatsApp
     ------------------------------------------------------------------ */
  function waUrl(text) {
    return 'https://wa.me/' + CONFIG.whatsapp + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  function fill(tpl, data) {
    return tpl.replace(/\{(\w+)\}/g, function (_, k) { return data[k] || t('wa.empty'); });
  }
  function updateWaLinks() {
    document.querySelectorAll('[data-wa-link]').forEach(function (a) { a.href = waUrl(t('wa.hello')); });
  }
  document.querySelectorAll('[data-phone-link]').forEach(function (a) { a.href = 'tel:' + CONFIG.phone; });
  document.querySelectorAll('[data-phone-text]').forEach(function (s) { s.textContent = CONFIG.phoneText; });

  /* ------------------------------------------------------------------
     Header & mobile menu
     ------------------------------------------------------------------ */
  var header = document.querySelector('.header');
  var burger = document.querySelector('.burger');
  function onScroll() { if (header) header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    if (burger) burger.setAttribute('aria-expanded', String(open));
  }
  if (burger) burger.addEventListener('click', function () { setMenu(!document.body.classList.contains('menu-open')); });
  document.querySelectorAll('.mobile-menu a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });

  /* ------------------------------------------------------------------
     Reviews tabs
     ------------------------------------------------------------------ */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs [role="tab"]'));
  function selectTab(tab) {
    tabs.forEach(function (x) {
      var on = x === tab;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(x.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !on;
        if (on) panel.querySelectorAll('.reveal').forEach(function (r) { r.classList.add('is-in'); });
      }
    });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab); });
    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); selectTab(next);
    });
  });

  /* ------------------------------------------------------------------
     Modals
     ------------------------------------------------------------------ */
  var modals = {
    detail: document.getElementById('modal-detail'),
    order: document.getElementById('modal-order'),
    partner: document.getElementById('modal-partner'),
    result: document.getElementById('modal-result')
  };
  var currentDetail = null;
  var currentOrder = 'marine';

  function lockScroll() {
    var anyOpen = Object.keys(modals).some(function (k) { return modals[k] && modals[k].open; });
    document.body.style.overflow = anyOpen ? 'hidden' : '';
  }

  function fillDetail(id) {
    var p = PRODUCTS[id];
    var dlg = modals.detail;
    if (!p || !dlg) return;
    var scroll = dlg.querySelector('.detail');
    scroll.classList.remove('theme-blue', 'theme-red');
    scroll.classList.add(p.theme);
    dlg.querySelector('[data-detail-name]').textContent = p.name;
    dlg.querySelector('[data-detail-desc]').textContent = t('js.product.' + id + '.desc');
    dlg.querySelectorAll('[data-detail-img]').forEach(function (img) {
      img.src = p.images[+img.dataset.detailImg - 1];
      img.alt = 'WEGLOW ' + p.name;
    });
    dlg.querySelector('[data-detail-order]').dataset.product = id;
  }

  function resetForm(dlg) {
    var form = dlg.querySelector('form');
    if (!form) return;
    dlg.querySelector('.form-modal').classList.remove('is-sent');
    form.querySelectorAll('.is-invalid').forEach(function (el) { el.classList.remove('is-invalid'); });
    var out = form.querySelector('output[name="qty"]');
    if (out) out.value = '1';
  }

  function open(name, product) {
    var dlg = modals[name];
    if (!dlg) return;
    if (name === 'detail') { currentDetail = product || 'marine'; fillDetail(currentDetail); dlg.querySelector('.modal__scroll').scrollTop = 0; }
    if (name === 'order') {
      currentOrder = product || 'marine';
      dlg.querySelector('[data-order-name]').textContent = PRODUCTS[currentOrder].name;
    }
    if (name !== 'detail') resetForm(dlg);
    if (name === 'order' && W.payments) W.payments.reset();
    // Order opened from the details modal replaces it.
    if (name === 'order' && modals.detail.open) modals.detail.close();
    setMenu(false);
    showModal(dlg);
  }

  function showModal(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    lockScroll();
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-open]');
    if (trigger) { e.preventDefault(); open(trigger.dataset.open, trigger.dataset.product); return; }
    var closer = e.target.closest('[data-close]');
    if (closer) { closer.closest('dialog').close(); }
  });

  Object.keys(modals).forEach(function (k) {
    var dlg = modals[k];
    if (!dlg) return;
    // Click on the backdrop closes the dialog.
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', function () {
      if (k === 'detail') currentDetail = null;
      lockScroll();
    });
  });

  /* ------------------------------------------------------------------
     Forms → WhatsApp
     ------------------------------------------------------------------ */
  function formatPhone(raw) {
    var plus = raw.trim().charAt(0) === '+';
    var d = raw.replace(/\D/g, '');
    if (!d) return plus ? '+' : '';
    if (d.indexOf('998') === 0) {
      d = d.slice(0, 12);
      var parts = [d.slice(0, 3), d.slice(3, 5), d.slice(5, 8), d.slice(8, 10), d.slice(10, 12)].filter(Boolean);
      return '+' + parts.join(' ');
    }
    return '+' + d.slice(0, 15);
  }

  document.querySelectorAll('input[data-phone]').forEach(function (input) {
    input.addEventListener('focus', function () { if (!input.value) input.value = '+998 '; });
    input.addEventListener('blur', function () { if (input.value.replace(/\D/g, '') === '998') input.value = ''; });
    input.addEventListener('input', function () {
      var atEnd = input.selectionStart === input.value.length;
      input.value = formatPhone(input.value);
      if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
      input.closest('.field').classList.remove('is-invalid');
    });
  });

  document.querySelectorAll('.qty button').forEach(function (b) {
    b.addEventListener('click', function () {
      var out = b.parentNode.querySelector('output');
      out.value = String(Math.min(99, Math.max(1, (+out.value || 1) + (+b.dataset.qty))));
    });
  });

  document.querySelectorAll('form[data-form]').forEach(function (form) {
    form.addEventListener('input', function (e) {
      var f = e.target.closest('.field, .check');
      if (f) f.classList.remove('is-invalid');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = form.elements.name.value.trim();
      var phone = form.elements.phone.value.trim();
      var agree = form.elements.agree.checked;
      var ok = true;

      if (name.length < 2) { form.elements.name.closest('.field').classList.add('is-invalid'); ok = false; }
      if (phone.replace(/\D/g, '').length < 9) { form.elements.phone.closest('.field').classList.add('is-invalid'); ok = false; }
      if (!agree) { form.elements.agree.closest('.check').classList.add('is-invalid'); ok = false; }
      if (!ok) { var bad = form.querySelector('.is-invalid input'); if (bad) bad.focus(); return; }
      if (form.dataset.form === 'order' && W.payments && W.payments.submit({ name: name, phone: phone })) return;

      var text = form.dataset.form === 'order'
        ? fill(t('wa.order'), { product: PRODUCTS[currentOrder].name, qty: form.querySelector('output[name="qty"]').value, name: name, phone: phone })
        : fill(t('wa.partner'), { name: name, phone: phone, city: (form.elements.city.value || '').trim() });

      var url = waUrl(text);
      var wrap = form.closest('.form-modal');
      wrap.querySelector('[data-success-link]').href = url;
      wrap.classList.add('is-sent');
      wrap.scrollTop = 0;
      window.open(url, '_blank', 'noopener');
      form.reset();
    });
  });

  /* ------------------------------------------------------------------
     Reveal on scroll
     ------------------------------------------------------------------ */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ------------------------------------------------------------------
     Shared with pay.js
     ------------------------------------------------------------------ */
  var W = window.Weglow = {
    config: CONFIG,
    t: t,
    lang: function () { return lang; },
    product: function () { return currentOrder; },
    onLang: function (fn) { langListeners.push(fn); },
    showModal: showModal,
    payments: null
  };

  applyLang(initialLang(), false);
})();
