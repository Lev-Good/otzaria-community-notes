(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  function t(s, vars) {
    return CN.i18n.t(s, vars);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'className') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'dataset' && typeof v === 'object') {
          var dKeys = Object.keys(v);
          for (var j = 0; j < dKeys.length; j++) {
            node.dataset[dKeys[j]] = String(v[dKeys[j]]);
          }
        } else {
          node.setAttribute(k, v === true ? '' : String(v));
        }
      }
    }
    if (children !== undefined && children !== null) {
      var list = Array.isArray(children) ? children : [children];
      for (var c = 0; c < list.length; c++) {
        var child = list[c];
        if (child === undefined || child === null || child === false) continue;
        if (typeof child === 'string' || typeof child === 'number') {
          node.appendChild(document.createTextNode(String(child)));
        } else {
          node.appendChild(child);
        }
      }
    }
    return node;
  }

  function hexToRgba(hex, alpha) {
    var clean = String(hex || '').replace('#', '');
    if (clean.length === 3) clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    if (clean.length < 6) return 'rgba(103, 80, 164, ' + alpha + ')';
    var r = parseInt(clean.slice(0, 2), 16);
    var g = parseInt(clean.slice(2, 4), 16);
    var b = parseInt(clean.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function applyTheme(theme) {
    if (!theme || !theme.colorScheme) return;
    CN.state.theme = theme;
    var cs = theme.colorScheme;
    var r = document.documentElement;

    r.style.setProperty('--color-primary', cs.primary);
    r.style.setProperty('--color-on-primary', cs.onPrimary);
    r.style.setProperty('--color-secondary', cs.secondary);
    r.style.setProperty('--color-on-secondary', cs.onSecondary);
    if (cs.primaryContainer) r.style.setProperty('--color-primary-container', cs.primaryContainer);
    if (cs.onPrimaryContainer) r.style.setProperty('--color-on-primary-container', cs.onPrimaryContainer);
    if (cs.secondaryContainer) r.style.setProperty('--color-secondary-container', cs.secondaryContainer);
    if (cs.onSecondaryContainer) r.style.setProperty('--color-on-secondary-container', cs.onSecondaryContainer);
    if (cs.tertiary) r.style.setProperty('--color-tertiary', cs.tertiary);
    if (cs.onTertiary) r.style.setProperty('--color-on-tertiary', cs.onTertiary);
    if (cs.tertiaryContainer) r.style.setProperty('--color-tertiary-container', cs.tertiaryContainer);
    if (cs.onTertiaryContainer) r.style.setProperty('--color-on-tertiary-container', cs.onTertiaryContainer);

    r.style.setProperty('--color-surface', cs.surface);
    r.style.setProperty('--color-on-surface', cs.onSurface);
    if (cs.onSurfaceVariant) r.style.setProperty('--color-on-surface-variant', cs.onSurfaceVariant);
    if (cs.surfaceContainerLowest) r.style.setProperty('--color-surface-container-lowest', cs.surfaceContainerLowest);
    if (cs.surfaceContainerLow) r.style.setProperty('--color-surface-container-low', cs.surfaceContainerLow);
    if (cs.surfaceContainer) r.style.setProperty('--color-surface-container', cs.surfaceContainer);
    if (cs.surfaceContainerHigh) r.style.setProperty('--color-surface-container-high', cs.surfaceContainerHigh);
    r.style.setProperty('--color-surface-container-highest', cs.surfaceContainerHighest);
    r.style.setProperty('--color-error', cs.error);
    r.style.setProperty('--color-on-error', cs.onError);
    if (cs.outlineVariant) r.style.setProperty('--color-outline-variant', cs.outlineVariant);
    r.style.setProperty('--color-outline', cs.outline);
    if (cs.scrim) r.style.setProperty('--color-scrim', cs.scrim);

    r.style.setProperty('--color-primary-subtle', hexToRgba(cs.primary, 0.12));
    r.style.setProperty('--color-secondary-subtle', hexToRgba(cs.secondary, 0.12));
    r.style.setProperty('--color-tertiary-subtle', hexToRgba(cs.tertiary || cs.secondary, 0.14));
    r.style.setProperty('--color-error-subtle', hexToRgba(cs.error, 0.12));

    document.body.classList.toggle('dark-mode', theme.mode === 'dark');

    if (theme.typography) {
      var ty = theme.typography;
      var uiFam = ty.uiFont || (ty.uiFontFamily ? ("'" + ty.uiFontFamily + "', system-ui, sans-serif") : null);
      if (uiFam) r.style.setProperty('--font-ui', uiFam);
      if (ty.fontFamily) r.style.setProperty('--font-main', "'" + ty.fontFamily + "', 'David', serif");
      if (ty.fontSize) r.style.setProperty('--font-size-base', Math.min(20, Math.max(14, Number(ty.fontSize) * 0.72)) + 'px');
      if (ty.lineHeight) r.style.setProperty('--line-height', String(ty.lineHeight));
    }

    if (theme.surfaces) {
      r.style.setProperty('--surface-panel', theme.surfaces.panel);
      r.style.setProperty('--surface-card', theme.surfaces.card);
      r.style.setProperty('--surface-top-bar', theme.surfaces.topBar);
    }
    if (theme.radius != null) {
      r.style.setProperty('--radius', theme.radius + 'px');
    }
    if (theme.density && theme.density.topBarHeight) {
      r.style.setProperty('--top-bar-height', theme.density.topBarHeight + 'px');
    }
  }

  function applyUserDisplaySettings() {
    var settings = CN.state.settings;
    document.body.classList.toggle('density-compact', settings.density === 'compact');
    var cardSize = '0.96em';
    if (settings.cardTextSize === 'small') cardSize = '0.86em';
    else if (settings.cardTextSize === 'medium') cardSize = '1.0em';
    else if (settings.cardTextSize === 'large') cardSize = '1.16em';
    else if (CN.state.otzariaSettings && CN.state.otzariaSettings.fontSize) {
      var fs = Number(CN.state.otzariaSettings.fontSize);
      if (fs > 0) cardSize = (Math.min(1.3, Math.max(0.85, fs / 22))).toFixed(2) + 'em';
    }
    document.documentElement.style.setProperty('--card-text-size', cardSize);
  }

  function formatQuoteText(text) {
    var mode = CN.state.settings ? CN.state.settings.nikudMode : 'otzaria';
    var effective = mode;
    if (mode === 'otzaria' && CN.state.otzariaSettings) {
      effective = CN.state.otzariaSettings.defaultNikud === false ? 'never' : 'always';
    }
    return CN.anchors.stripNikudAndTeamim(text || '', effective);
  }

  /**
   * Safe plain-text body renderer:
   * - Never injects HTML
   * - Isolates LTR/numeric runs with <bdi>
   * - Renders ONLY otzaria://open/book/... links; replaces any other otzaria:// link!
   */
  function renderSafeNoteBody(container, text) {
    container.textContent = '';
    var src = String(text || '');
    var tokenRe = /(otzaria:\/\/[^\s<>"'`]+)/gi;
    var lastIdx = 0;
    var match;

    while ((match = tokenRe.exec(src)) !== null) {
      if (match.index > lastIdx) {
        appendTextWithBdi(container, src.slice(lastIdx, match.index));
      }
      var uri = match[1];
      if (CN.filter.OTZARIA_BOOK_LINK_RE.test(uri)) {
        var parsedLabel = parseBookLinkLabel(uri);
        var a = el('a', {
          className: 'note-book-link',
          href: uri,
          text: parsedLabel,
          onClick: function (ev) {
            ev.preventDefault();
            openBookLink(uri);
          },
        });
        container.appendChild(a);
      } else {
        container.appendChild(document.createTextNode('[קישור הוסר]'));
      }
      lastIdx = tokenRe.lastIndex;
    }
    if (lastIdx < src.length) {
      appendTextWithBdi(container, src.slice(lastIdx));
    }
  }

  function appendTextWithBdi(container, text) {
    // Isolate ASCII runs/numbers in <bdi> for proper RTL bidi rendering
    var bdiRe = /([A-Za-z0-9][A-Za-z0-9._:/-]{1,})/g;
    var last = 0;
    var m;
    while ((m = bdiRe.exec(text)) !== null) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      container.appendChild(el('bdi', { text: m[1] }));
      last = bdiRe.lastIndex;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
  }

  function parseBookLinkLabel(uri) {
    try {
      var withoutScheme = uri.replace(/^otzaria:\/\/open\/book\/?/i, '');
      var parts = withoutScheme.split('?');
      var bookPart = decodeURIComponent(parts[0] || '');
      var params = new URLSearchParams(parts[1] || '');
      var title = params.get('title') || bookPart || 'ספר באוצריא';
      var ref = params.get('ref') || '';
      return ref ? (title + ' (' + ref + ')') : title;
    } catch (_) {
      return 'קישור לספר באוצריא';
    }
  }

  async function openBookLink(uri) {
    try {
      var withoutScheme = uri.replace(/^otzaria:\/\/open\/book\/?/i, '');
      var parts = withoutScheme.split('?');
      var bookPart = decodeURIComponent(parts[0] || '');
      var params = new URLSearchParams(parts[1] || '');
      var ref = params.get('ref') || '';
      var title = params.get('title') || '';
      var payload = {};
      if (/^\d+$/.test(bookPart)) payload.id = Number(bookPart);
      else if (bookPart) payload.bookId = bookPart;
      if (title && !payload.bookId) payload.bookId = title;
      if (ref) {
        payload.ref = ref;
        payload.highlight = true;
        await global.Otzaria.call('reader.openBookAtRef', payload);
      } else {
        await global.Otzaria.call('reader.openBook', payload);
      }
    } catch (_) {
      showToast(t('לא הצלחנו לפתוח את הקישור'));
    }
  }

  function formatRelativeTime(ts) {
    var diffSec = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
    if (diffSec < 60) return 'עכשיו';
    var mins = Math.floor(diffSec / 60);
    if (mins < 60) return 'לפני ' + mins + ' דק׳';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs === 1 ? 'לפני שעה' : 'לפני ' + hrs + ' שעות';
    var days = Math.floor(hrs / 24);
    if (days === 1) return 'אתמול';
    if (days < 7) return 'לפני ' + days + ' ימים';
    return new Date(Number(ts)).toLocaleDateString('he-IL');
  }

  var toastTimer = null;
  function showToast(message, opts) {
    var toastEl = document.getElementById('toast');
    if (!toastEl) return;
    toastEl.textContent = '';
    toastEl.appendChild(el('span', { text: message }));
    if (opts && opts.actionLabel && typeof opts.onAction === 'function') {
      toastEl.appendChild(el('button', {
        className: 'toast-undo',
        type: 'button',
        text: opts.actionLabel,
        onClick: function () {
          toastEl.classList.remove('open');
          opts.onAction();
        },
      }));
    }
    toastEl.classList.add('open');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('open');
    }, 5000);
  }

  function getSvgIcon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    var paths = {
      settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
      bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>',
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>',
      back: '<polyline points="9 18 15 12 9 6"></polyline>',
      plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
    };
    svg.innerHTML = paths[name] || '';
    return svg;
  }

  CN.ui = CN.ui || {};
  CN.ui.t = t;
  CN.ui.el = el;
  CN.ui.applyTheme = applyTheme;
  CN.ui.applyUserDisplaySettings = applyUserDisplaySettings;
  CN.ui.formatQuoteText = formatQuoteText;
  CN.ui.renderSafeNoteBody = renderSafeNoteBody;
  CN.ui.formatRelativeTime = formatRelativeTime;
  CN.ui.showToast = showToast;
  CN.ui.getSvgIcon = getSvgIcon;
  CN.ui.openBookLink = openBookLink;
})(typeof window !== 'undefined' ? window : globalThis);
