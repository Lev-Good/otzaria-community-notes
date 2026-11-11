(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  var subtle = (global.crypto && global.crypto.subtle) ? global.crypto.subtle : null;
  var encoder = new TextEncoder();

  function toBase64Url(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var bin = '';
    for (var i = 0; i < arr.length; i++) {
      bin += String.fromCharCode(arr[i]);
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function toHex(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var out = '';
    for (var i = 0; i < arr.length; i++) {
      out += arr[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  async function sha256Hex(input) {
    var data = typeof input === 'string' ? encoder.encode(input) : input;
    var buf = await subtle.digest('SHA-256', data);
    return toHex(new Uint8Array(buf));
  }

  async function sha256Bytes(input) {
    var data = typeof input === 'string' ? encoder.encode(input) : input;
    var buf = await subtle.digest('SHA-256', data);
    return new Uint8Array(buf);
  }

  function countLeadingZeroBits(bytes) {
    var zeros = 0;
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 0) {
        zeros += 8;
        continue;
      }
      for (var bit = 7; bit >= 0; bit--) {
        if ((b & (1 << bit)) === 0) zeros++;
        else return zeros;
      }
    }
    return zeros;
  }

  async function solveChallenge(challenge) {
    var prefix = challenge.prefix;
    var difficulty = Number(challenge.difficulty || 14);
    var nonce = 0;
    while (true) {
      var candidate = String(nonce);
      var digest = await sha256Bytes(prefix + ':' + candidate);
      if (countLeadingZeroBits(digest) >= difficulty) {
        return candidate;
      }
      nonce++;
      if (nonce % 2000 === 0) {
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }
  }

  function generateRecoveryCode() {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var bytes = new Uint8Array(24);
    global.crypto.getRandomValues(bytes);
    var raw = '';
    for (var i = 0; i < bytes.length; i++) {
      if (i > 0 && i % 4 === 0) raw += '-';
      raw += alphabet[bytes[i] % alphabet.length];
    }
    return raw;
  }

  function normalizeRecoveryCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  async function generateKeyPair() {
    var kp = await subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    var privateJwk = await subtle.exportKey('jwk', kp.privateKey);
    var spki = await subtle.exportKey('spki', kp.publicKey);
    return {
      privateJwk: privateJwk,
      pubkeySpki: toBase64Url(new Uint8Array(spki)),
    };
  }

  async function signRequest(privateJwk, method, pathWithQuery, seq, timestamp, bodyText) {
    var privKey = await subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    var bodyHash = await sha256Hex(bodyText || '');
    var canonical = method.toUpperCase() + '\n' + pathWithQuery + '\n' + String(seq) + '\n' + String(timestamp) + '\n' + bodyHash;
    var sigBuf = await subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privKey,
      encoder.encode(canonical)
    );
    return toBase64Url(new Uint8Array(sigBuf));
  }

  CN.crypto = {
    toBase64Url: toBase64Url,
    sha256Hex: sha256Hex,
    solveChallenge: solveChallenge,
    generateRecoveryCode: generateRecoveryCode,
    normalizeRecoveryCode: normalizeRecoveryCode,
    generateKeyPair: generateKeyPair,
    signRequest: signRequest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
