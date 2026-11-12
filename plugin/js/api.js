(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var cachedEtags = {};

  function getBaseUrl(settings) {
    var custom = settings && settings.apiBaseUrl ? String(settings.apiBaseUrl).trim() : '';
    return (custom || CN.config.DEFAULT_API_BASE).replace(/\/+$/, '');
  }

  async function streamRequest(url, options) {
    // Prefer Otzaria.call('network.fetchStream') when inside Otzaria host to avoid WebView CORS
    if (global.Otzaria && typeof global.Otzaria.call === 'function' && global.Otzaria.__isStub !== true) {
      try {
        var chunks = global.Otzaria.call('network.fetchStream', {
          url: url,
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body || undefined,
          timeoutMs: options.timeoutMs || 25000,
        });
        var status = 0;
        var ok = false;
        var respHeaders = {};
        var bodyText = '';
        for await (var chunk of chunks) {
          if (chunk.type === 'response') {
            status = chunk.status;
            ok = chunk.ok;
            respHeaders = chunk.headers || {};
          } else if (chunk.type === 'data') {
            bodyText += chunk.body || '';
          }
        }
        return { status: status, ok: ok, headers: respHeaders, text: bodyText };
      } catch (err) {
        var msg = (err && err.message) ? String(err.message) : String(err || '');
        if (msg.indexOf('error.forbidden') !== -1) {
          throw new Error('אוצריא חסמה את הגישה לשרת כי כתובתו אינה ברשימת ההיתר הפעילה (נדרש מיזוג PR או שימוש בגרסת הבדיקה המקומית)');
        }
        if (msg.indexOf('error.permission_denied') !== -1) {
          throw new Error('חסרה הרשאת רשת לתוסף בהגדרות אוצריא');
        }
        throw err;
      }
    }

    // Browser dev fallback
    var res = await global.fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || undefined,
    });
    var text = await res.text();
    var hObj = {};
    res.headers.forEach(function (v, k) { hObj[k.toLowerCase()] = v; });
    return { status: res.status, ok: res.ok, headers: hObj, text: text };
  }

  async function request(method, pathWithQuery, { bodyObj = null, auth = false, identity = null, settings = null, retry429 = true, retrySeq = true, headersExtra = {} } = {}) {
    var baseUrl = getBaseUrl(settings);
    var url = baseUrl + pathWithQuery;
    var bodyText = bodyObj !== null ? JSON.stringify(bodyObj) : '';
    var headers = Object.assign({}, headersExtra);

    if (bodyObj !== null) {
      headers['Content-Type'] = 'application/json';
    }

    var seqValue = null;
    var isWrite = method !== 'GET' && method !== 'HEAD';

    if (auth && identity && identity.userId && identity.privateJwk) {
      var ts = String(Date.now());
      if (isWrite) {
        identity.seq = Number(identity.seq || 0) + 1;
        await CN.storage.set(CN.storage.KEYS.IDENTITY, identity);
        seqValue = String(identity.seq);
      } else {
        seqValue = 'r:' + ts + ':' + Math.random().toString(36).slice(2, 8);
      }
      var sig = await CN.crypto.signRequest(identity.privateJwk, method, pathWithQuery, seqValue, ts, bodyText);
      headers['X-User-Id'] = identity.userId;
      headers['X-Timestamp'] = ts;
      headers['X-Seq'] = seqValue;
      headers['X-Signature'] = sig;
    }

    var resp = await streamRequest(url, {
      method: method,
      headers: headers,
      body: bodyText || undefined,
    });

    // Automatic single retry on 429 rate-limit after brief pause
    if (resp.status === 429 && retry429) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      return request(method, pathWithQuery, { bodyObj: bodyObj, auth: auth, identity: identity, settings: settings, retry429: false, retrySeq: retrySeq, headersExtra: headersExtra });
    }

    var parsed = null;
    if (resp.text) {
      try {
        parsed = JSON.parse(resp.text);
      } catch (_) {
        parsed = null;
      }
    }

    // Automatic self-healing on 409 SEQ_REPLAY (e.g. after restoring identity backup or multi-tab desync)
    if (resp.status === 409 && retrySeq && isWrite && auth && identity && parsed && parsed.error && parsed.error.code === 'SEQ_REPLAY') {
      var serverSeq = parsed.error.currentSeq != null ? Number(parsed.error.currentSeq) : null;
      if (serverSeq == null || isNaN(serverSeq)) {
        try {
          var meResp = await request('GET', '/v1/me', { auth: true, identity: identity, settings: settings, retry429: false, retrySeq: false });
          if (meResp.ok && meResp.data && meResp.data.seq != null) {
            serverSeq = Number(meResp.data.seq);
          }
        } catch (_) { /* ignore */ }
      }
      if (serverSeq != null && !isNaN(serverSeq)) {
        identity.seq = Math.max(Number(identity.seq || 0), serverSeq);
        await CN.storage.set(CN.storage.KEYS.IDENTITY, identity);
        return request(method, pathWithQuery, { bodyObj: bodyObj, auth: auth, identity: identity, settings: settings, retry429: retry429, retrySeq: false, headersExtra: headersExtra });
      }
    }

    return {
      status: resp.status,
      ok: resp.ok,
      headers: resp.headers,
      data: parsed,
    };
  }

  async function fetchConfig(settings) {
    return request('GET', '/v1/config', { settings: settings });
  }

  async function fetchSolvedChallenge(settings) {
    var res = await request('GET', '/v1/challenge', { settings: settings });
    if (!res.ok || !res.data) throw new Error('CHALLENGE_FETCH_FAILED');
    var nonce = await CN.crypto.solveChallenge(res.data);
    return { challengeToken: res.data.token, challengeNonce: nonce };
  }

  async function getBookIndex(bookUid, settings) {
    var path = '/v1/books/' + encodeURIComponent(bookUid) + '/index';
    var headersExtra = {};
    if (cachedEtags[bookUid]) {
      headersExtra['If-None-Match'] = cachedEtags[bookUid].etag;
    }
    var res = await request('GET', path, { settings: settings, headersExtra: headersExtra });
    if (res.status === 304 && cachedEtags[bookUid]) {
      return { ok: true, status: 304, data: cachedEtags[bookUid].data };
    }
    if (res.ok && res.data) {
      cachedEtags[bookUid] = { etag: res.headers.etag || res.data.etag, data: res.data };
    }
    return res;
  }

  CN.api = {
    request: request,
    fetchConfig: fetchConfig,
    fetchSolvedChallenge: fetchSolvedChallenge,
    getBookIndex: getBookIndex,
  };
})(typeof window !== 'undefined' ? window : globalThis);
