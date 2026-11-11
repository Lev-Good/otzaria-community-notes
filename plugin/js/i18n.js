(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var activeDict = null;
  var activeLang = 'he';

  function setLanguage(lang, textDirection) {
    activeLang = lang || 'he';
    var all = global.TRANSLATIONS || {};
    activeDict = all[activeLang] || null;
    if (typeof document !== 'undefined' && document.documentElement) {
      var dir = textDirection === 'ltr' ? 'ltr' : 'rtl';
      document.documentElement.dir = dir;
      document.documentElement.lang = activeLang;
    }
  }

  function t(str, vars) {
    var out = (activeDict && Object.prototype.hasOwnProperty.call(activeDict, str))
      ? activeDict[str]
      : str;
    if (vars) {
      var keys = Object.keys(vars);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        out = out.split('{' + k + '}').join(String(vars[k]));
      }
    }
    return out;
  }

  function getLang() {
    return activeLang;
  }

  CN.i18n = {
    setLanguage: setLanguage,
    t: t,
    getLang: getLang,
  };
})(typeof window !== 'undefined' ? window : globalThis);
