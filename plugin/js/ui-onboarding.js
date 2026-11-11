(function (global) {
  'use strict';
  var CN = (global.CN = global.CN || {});

  async function ensureRegistered() {
    if (CN.state.identity && CN.state.identity.userId && CN.state.identity.privateJwk) {
      return true;
    }
    return new Promise(function (resolve) {
      openRegistrationModal(resolve);
    });
  }

  function openRegistrationModal(done) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    var step = 1;
    var chosenName = '';
    var chosenInvite = '';
    var generatedKeys = null;
    var recoveryCode = '';
    var registeredUser = null;

    function renderStep() {
      box.textContent = '';

      if (step === 1) {
        box.appendChild(el('h3', { text: 'הצטרפות להערות הקהילה (1/3)' }));
        box.appendChild(el('p', {
          className: 'meta-time',
          text: 'בחר שם תצוגה שיוצג ליד ההערות שלך. הטיוטה שלך נשמרת ולא תאבד.',
        }));

        var nameInput = el('input', {
          className: 'input',
          type: 'text',
          placeholder: 'שם תצוגה (3 עד 20 תווים, ללא תארים)',
          value: chosenName,
          autofocus: true,
        });
        var availMsg = el('div', { className: 'validation-hint' });
        var inviteInput = el('input', {
          className: 'input',
          type: 'text',
          placeholder: 'קוד הזמנה לבטא (למשל OTZ-XXXX-XXXX)',
          value: chosenInvite,
        });
        if (CN.state.config && CN.state.config.inviteRequired === false) {
          inviteInput.placeholder = 'קוד הזמנה (אופציונלי)';
        }

        var nextBtn = el('button', {
          type: 'button',
          className: 'btn-primary',
          text: 'המשך',
          disabled: true,
          onClick: function () {
            chosenName = nameInput.value.trim();
            chosenInvite = inviteInput.value.trim();
            step = 2;
            renderStep();
          },
        });

        var checkTimer = null;
        nameInput.addEventListener('input', function () {
          nextBtn.disabled = true;
          var val = nameInput.value.trim();
          if (val.length < 3) {
            availMsg.textContent = 'לפחות 3 תווים';
            availMsg.className = 'validation-hint error';
            return;
          }
          if (checkTimer) clearTimeout(checkTimer);
          checkTimer = setTimeout(async function () {
            try {
              var res = await CN.api.request('GET', '/v1/users/availability?name=' + encodeURIComponent(val), {
                settings: CN.state.settings,
              });
              if (res.ok && res.data && res.data.available) {
                availMsg.textContent = 'השם פנוי!';
                availMsg.className = 'validation-hint ok';
                nextBtn.disabled = false;
              } else {
                availMsg.textContent = (res.data && res.data.message) || 'השם אינו זמין';
                availMsg.className = 'validation-hint error';
              }
            } catch (_) {
              availMsg.textContent = 'לא ניתן לבדוק זמינות כרגע';
              availMsg.className = 'validation-hint warning';
            }
          }, 300);
        });

        box.appendChild(nameInput);
        box.appendChild(availMsg);
        box.appendChild(inviteInput);
        box.appendChild(el('div', { className: 'card-actions-group' }, [
          nextBtn,
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: 'כבר יש לי קוד שחזור',
            onClick: function () {
              modal.classList.remove('open');
              openRecoveryImportModal(function (ok) { done(ok); });
            },
          }),
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: CN.ui.t('בטל'),
            onClick: function () { modal.classList.remove('open'); done(false); },
          }),
        ]));
        setTimeout(function () { nameInput.focus(); }, 0);
      } else if (step === 2) {
        box.appendChild(el('h3', { text: 'נוהל הקהילה (2/3)' }));
        var rules = el('div', { className: 'quote-box' }, [
          el('p', { text: '1. התוכן פומבי ונכלל בגיבוי הקהילתי היומי תחת רישיון CC BY-SA 4.0.' }),
          el('p', { text: '2. הערות הקהילה אינן פסק הלכה ואין בהן הוראה למעשה.' }),
          el('p', { text: '3. יש לכתוב לעניין הקטע בלבד, בלשון מכבדת, ללא לשון הרע, פוליטיקה או פרסום.' }),
          el('p', { text: '4. אין להדביק קטעים ארוכים מספרים מוגנים בזכויות יוצרים.' }),
          el('p', { text: '5. ההערות הראשונות של משתמש חדש עוברות אישור מודרטורים.' }),
        ]);
        var agreeChk = el('input', { type: 'checkbox', id: 'agree-guidelines' });
        var agreeLabel = el('label', { for: 'agree-guidelines', className: 'card-author-row' }, [
          agreeChk,
          el('span', { text: 'קראתי והסכמתי לנוהל הקהילה' }),
        ]);
        var errBox = el('div', { className: 'validation-hint error' });
        var createBtn = el('button', {
          type: 'button',
          className: 'btn-primary',
          text: 'צור זהות והמשך',
          disabled: true,
        });
        agreeChk.addEventListener('change', function () {
          createBtn.disabled = !agreeChk.checked;
        });

        createBtn.addEventListener('click', async function () {
          createBtn.disabled = true;
          createBtn.textContent = 'מייצר מפתח ומאמת...';
          errBox.textContent = '';
          try {
            generatedKeys = await CN.crypto.generateKeyPair();
            recoveryCode = CN.crypto.generateRecoveryCode();
            var recHash = await CN.crypto.sha256Hex(CN.crypto.normalizeRecoveryCode(recoveryCode));
            var pow = await CN.api.fetchSolvedChallenge(CN.state.settings);

            var res = await CN.api.request('POST', '/v1/users', {
              settings: CN.state.settings,
              bodyObj: {
                displayName: chosenName,
                pubkey: generatedKeys.pubkeySpki,
                recoveryHash: recHash,
                inviteCode: chosenInvite || undefined,
                acceptedGuidelines: true,
                challengeToken: pow.challengeToken,
                challengeNonce: pow.challengeNonce,
              },
            });
            if (!res.ok) {
              throw new Error((res.data && res.data.error && res.data.error.message) || 'ההרשמה נכשלה');
            }
            registeredUser = res.data.user;
            var identity = {
              userId: registeredUser.id,
              displayName: registeredUser.displayName,
              role: registeredUser.role,
              seq: Number(registeredUser.seq || 0),
              privateJwk: generatedKeys.privateJwk,
              pubkeySpki: generatedKeys.pubkeySpki,
              recoveryCode: recoveryCode,
              isNewUserHint: !chosenInvite,
              createdAt: registeredUser.createdAt,
            };
            CN.state.identity = identity;
            await CN.storage.set(CN.storage.KEYS.IDENTITY, identity);
            step = 3;
            renderStep();
          } catch (err) {
            createBtn.disabled = false;
            createBtn.textContent = 'צור זהות והמשך';
            errBox.textContent = err.message || 'שגיאה בהרשמה';
          }
        });

        box.appendChild(rules);
        box.appendChild(agreeLabel);
        box.appendChild(errBox);
        box.appendChild(el('div', { className: 'card-actions-group' }, [
          createBtn,
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: 'חזור',
            onClick: function () { step = 1; renderStep(); },
          }),
        ]));
      } else if (step === 3) {
        box.appendChild(el('h3', { text: 'שמור את קוד השחזור שלך (3/3)' }));
        box.appendChild(el('p', {
          text: 'המפתח נשמר מקומית במכשיר זה בלבד. כדי להעביר את החשבון למכשיר אחר, שמור קוד זה במקום בטוח:',
        }));
        box.appendChild(el('div', { className: 'recovery-code-box', text: recoveryCode }));
        box.appendChild(el('div', { className: 'card-actions-group' }, [
          el('button', {
            type: 'button',
            className: 'btn-secondary',
            text: 'העתק קוד',
            onClick: async function () {
              try {
                await navigator.clipboard.writeText(recoveryCode);
                CN.ui.showToast('קוד השחזור הועתק');
              } catch (_) {
                CN.ui.showToast('העתק ידנית את הקוד מהתיבה');
              }
            },
          }),
          el('button', {
            type: 'button',
            className: 'btn-primary',
            text: 'שמרתי אותו — המשך',
            onClick: function () {
              modal.classList.remove('open');
              CN.app.renderChrome();
              done(true);
            },
          }),
        ]));
      }
    }

    renderStep();
    modal.classList.add('open');
  }

  function openRecoveryImportModal(onComplete) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    box.textContent = '';

    var nameInput = el('input', { className: 'input', type: 'text', placeholder: 'שם התצוגה הקיים שלך', autofocus: true });
    var codeInput = el('input', { className: 'input', type: 'text', placeholder: 'קוד שחזור (XXXX-XXXX-...)' });
    var errBox = el('div', { className: 'validation-hint error' });
    var submitBtn = el('button', { type: 'button', className: 'btn-primary', text: 'שחזר זהות למכשיר זה' });

    submitBtn.addEventListener('click', async function () {
      errBox.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'משחזר...';
      try {
        var newKp = await CN.crypto.generateKeyPair();
        var pow = await CN.api.fetchSolvedChallenge(CN.state.settings);
        var res = await CN.api.request('POST', '/v1/users/recover', {
          settings: CN.state.settings,
          bodyObj: {
            displayName: nameInput.value.trim(),
            recoveryCode: codeInput.value.trim(),
            newPubkey: newKp.pubkeySpki,
            challengeToken: pow.challengeToken,
            challengeNonce: pow.challengeNonce,
          },
        });
        if (!res.ok) {
          throw new Error((res.data && res.data.error && res.data.error.message) || 'השחזור נכשל');
        }
        var u = res.data.user;
        var identity = {
          userId: u.id,
          displayName: u.displayName,
          role: u.role,
          seq: Number(u.seq || 0),
          privateJwk: newKp.privateJwk,
          pubkeySpki: newKp.pubkeySpki,
          recoveryCode: codeInput.value.trim(),
          createdAt: u.createdAt,
        };
        CN.state.identity = identity;
        await CN.storage.set(CN.storage.KEYS.IDENTITY, identity);
        modal.classList.remove('open');
        CN.ui.showToast('הזהות שוחזרה בהצלחה');
        CN.app.renderChrome();
        if (onComplete) onComplete(true);
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'שחזר זהות למכשיר זה';
        errBox.textContent = err.message || 'שגיאה בשחזור';
      }
    });

    box.appendChild(el('h3', { text: 'שחזור זהות ממכשיר אחר' }));
    box.appendChild(nameInput);
    box.appendChild(codeInput);
    box.appendChild(errBox);
    box.appendChild(el('div', { className: 'card-actions-group' }, [
      submitBtn,
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: CN.ui.t('בטל'),
        onClick: function () {
          modal.classList.remove('open');
          if (onComplete) onComplete(false);
        },
      }),
    ]));
    modal.classList.add('open');
    setTimeout(function () { nameInput.focus(); }, 0);
  }

  function openReasonModal(title, choices, onSubmit, opts) {
    var el = CN.ui.el;
    var modal = document.getElementById('modal-backdrop');
    var box = document.getElementById('modal-dialog');
    box.textContent = '';

    var selected = choices && choices.length > 0 ? choices[0][0] : '';
    var radios = el('div', { className: 'container-narrow' });
    for (var i = 0; i < choices.length; i++) {
      (function (code, label, idx) {
        var r = el('input', { type: 'radio', name: 'reason-choice', value: code, checked: idx === 0 });
        r.addEventListener('change', function () { selected = code; });
        radios.appendChild(el('label', { className: 'card-author-row' }, [r, el('span', { text: label })]));
      })(choices[i][0], choices[i][1], i);
    }

    var details = (opts && opts.withDetails)
      ? el('textarea', { className: 'textarea', placeholder: (opts.detailsPlaceholder || 'פרטים נוספים (אופציונלי)') })
      : null;

    box.appendChild(el('h3', { text: title }));
    if (choices.length > 0) box.appendChild(radios);
    if (details) box.appendChild(details);
    box.appendChild(el('div', { className: 'card-actions-group' }, [
      el('button', {
        type: 'button',
        className: 'btn-primary',
        text: 'שלח',
        onClick: function () {
          modal.classList.remove('open');
          onSubmit(selected, details ? details.value : '');
        },
      }),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: CN.ui.t('בטל'),
        onClick: function () { modal.classList.remove('open'); },
      }),
    ]));
    modal.classList.add('open');
  }

  async function maybeTriggerBackgroundPrompt(publishedFirstNote) {
    var dismissed = await CN.storage.get(CN.storage.KEYS.BG_PROMPT_DISMISSED, false);
    if (dismissed) return false;
    if (CN.state.permissions.indexOf('app.run_on_startup') !== -1) return false;
    var visits = Number(await CN.storage.get(CN.storage.KEYS.VISIT_COUNT, 0));
    return Boolean(publishedFirstNote || visits >= 3);
  }

  function buildBackgroundPromptCard(onDismiss) {
    var el = CN.ui.el;
    return el('div', { className: 'status-banner info' }, [
      el('div', {}, [
        el('div', { className: 'settings-row-title', text: 'רוצה לראות סימון בטקסט ולקבל התראות?' }),
        el('div', {
          className: 'settings-row-subtitle',
          text: 'זה דורש להפעיל ריצת רקע ב"הגדרות ← כלים ← תוספים מותקנים ← הערות הקהילה".',
        }),
      ]),
      el('button', {
        type: 'button',
        className: 'btn-secondary',
        text: CN.ui.t('סגור'),
        onClick: async function () {
          await CN.storage.set(CN.storage.KEYS.BG_PROMPT_DISMISSED, true);
          if (onDismiss) onDismiss();
        },
      }),
    ]);
  }

  CN.ui.openReasonModal = openReasonModal;
  CN.onboarding = {
    ensureRegistered: ensureRegistered,
    openRecoveryImportModal: openRecoveryImportModal,
    maybeTriggerBackgroundPrompt: maybeTriggerBackgroundPrompt,
    buildBackgroundPromptCard: buildBackgroundPromptCard,
  };
})(typeof window !== 'undefined' ? window : globalThis);
