import { h, icon, state, get, post, put, del, act, toast, confirmBox, pageHead, TILE_COLORS, applyMe, mount, append, publicOrigin, pushSubscriptionStatus, enablePush, disablePush, opt } from './core.js';
import { installBlock, pushUnsupportedNode } from './install.js';

let integrationToken; // chargé à la demande (jeton sensible, jamais inclus dans /me)
let pushStatus; // 'unsupported' | 'denied' | 'unsubscribed' | 'subscribed' | undefined (pas encore vérifié)
let smtpConfig; // chargé à la demande (admin uniquement), undefined = pas encore demandé
let publicUrlInfo; // idem, pour l'adresse publique (PUBLIC_URL)
let addonsList; // idem, pour les addons de réservation périscolaire

export async function reglages(root) {
  const box = h('div', { class: 'stack big' });
  append(root, pageHead('Réglages'), box);

  function pushSection() {
    const body = (() => {
      if (pushStatus === undefined) { pushStatus = 'checking'; pushSubscriptionStatus().then((s) => { pushStatus = s; draw(); }); }
      if (pushStatus === 'checking') return h('p', { class: 'muted' }, 'Vérification…');
      if (pushStatus === 'unsupported') return pushUnsupportedNode();
      if (pushStatus === 'denied') return h('p', { class: 'hint' }, "Les notifications ont été bloquées pour ce site dans votre navigateur. Autorisez-les dans les réglages du navigateur pour les activer ici.");
      const subscribed = pushStatus === 'subscribed';
      return h('div', { class: 'row between center' },
        h('div', null, h('p', { class: 'muted' }, subscribed ? 'Activées sur cet appareil : vous recevrez une alerte même application fermée.' : "Recevez une alerte sur ce téléphone/ordinateur même quand Mosaïque n'est pas ouvert.")),
        h('div', { class: 'row gap' },
          subscribed ? h('button', { class: 'btn small', onclick: () => act(async () => { await post('/push/test'); toast('Notification de test envoyée'); }) }, 'Tester') : null,
          h('button', { class: 'btn small' + (subscribed ? '' : ' primary'), onclick: () => act(async () => {
            if (subscribed) { await disablePush(); toast('Notifications push désactivées sur cet appareil'); }
            else { await enablePush(); toast('Notifications push activées sur cet appareil'); }
            pushStatus = undefined; draw();
          }) }, subscribed ? 'Désactiver' : 'Activer')));
    })();
    return h('div', { style: { marginTop: '1rem' } }, h('strong', null, 'Notifications push sur cet appareil'), h('div', { style: { marginTop: '.3rem' } }, body),
      !state.settings.public_url ? h('p', { class: 'hint', style: { marginTop: '.4rem' } }, "Adresse publique non configurée : les notifications push échoueront probablement sur iPhone (Apple exige une adresse https réelle comme identifiant). Un administrateur peut la renseigner plus bas dans cette page.") : null);
  }

  function publicUrlSection() {
    if (publicUrlInfo === undefined) { publicUrlInfo = 'loading'; get('/settings/public-url').then((r) => { publicUrlInfo = r; draw(); }); }
    if (publicUrlInfo === 'loading') return h('section', { class: 'card' }, h('h2', null, 'Adresse publique'), h('p', { class: 'muted' }, 'Chargement…'));
    const r = publicUrlInfo;
    return h('section', { class: 'card' }, h('h2', null, 'Adresse publique'),
      h('p', { class: 'muted' }, r.url
        ? `Utilisée pour les liens partagés (invitations, agenda, présence…) : ${r.url}${r.source === 'env' ? ' (via la variable PUBLIC_URL du docker-compose.yml)' : ''}.`
        : "Non configurée : les liens partagés reprennent l'adresse depuis laquelle vous êtes connecté·e, ce qui peut ne pas fonctionner depuis l'extérieur. Les notifications push échoueront aussi sur iPhone."),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); act(async () => {
        publicUrlInfo = await put('/settings/public-url', { url: e.target.elements.public_url.value });
        toast('Adresse publique enregistrée'); await refresh();
      }); } },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Adresse (https de préférence)'), h('input', { name: 'public_url', value: r.url || '', placeholder: 'https://mafamille.exemple.fr' })),
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'),
          (r.url && r.source === 'app') ? h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await confirmBox("Retirer cette adresse ? La variable d'environnement PUBLIC_URL, si définie, reprendra le relais.", 'Réinitialiser')) act(async () => { publicUrlInfo = await del('/settings/public-url'); toast('Adresse retirée'); await refresh(); }); } }, 'Réinitialiser') : null)));
  }

  function smtpSection() {
    if (smtpConfig === undefined) { smtpConfig = 'loading'; get('/settings/smtp').then((c) => { smtpConfig = c; draw(); }); }
    if (smtpConfig === 'loading') return h('section', { class: 'card' }, h('h2', null, 'Serveur SMTP (envoi des e-mails)'), h('p', { class: 'muted' }, 'Chargement…'));
    const c = smtpConfig;
    return h('section', { class: 'card' }, h('h2', null, 'Serveur SMTP (envoi des e-mails)'),
      h('p', { class: 'muted' }, c.configured
        ? `Configuré : ${c.host}:${c.port}${c.secure ? ' (SSL/TLS direct)' : ''}.`
        : "Non configuré : les notifications par e-mail et les récapitulatifs ne peuvent pas être envoyés."),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); act(async () => {
        const f = e.target.elements;
        smtpConfig = await put('/settings/smtp', {
          host: f.smtp_host.value, port: Number(f.smtp_port.value) || 587,
          user: f.smtp_user.value, pass: f.smtp_pass.value, from: f.smtp_from.value, secure: f.smtp_secure.checked,
        });
        toast('Configuration SMTP enregistrée'); await refresh();
      }); } },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Serveur (host)'), h('input', { name: 'smtp_host', value: c.host || '', placeholder: 'smtp.exemple.fr', required: true })),
        h('div', { class: 'row gap' },
          h('label', { class: 'field', style: { flex: 1 } }, h('span', { class: 'field-label' }, 'Port'), h('input', { name: 'smtp_port', type: 'number', value: c.port || 587, min: 1, max: 65535 })),
          h('label', { class: 'check-field', style: { alignSelf: 'center', marginTop: '1.3rem' } }, h('input', { type: 'checkbox', name: 'smtp_secure', checked: c.secure }), h('span', null, 'SSL/TLS direct (port 465)'))),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Utilisateur'), h('input', { name: 'smtp_user', value: c.user || '', autocomplete: 'off' })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mot de passe'), h('input', { name: 'smtp_pass', type: 'password', placeholder: c.has_password ? 'Laisser vide pour ne pas changer' : '', autocomplete: 'new-password' })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, "Adresse d'expéditeur (From)"), h('input', { name: 'smtp_from', value: c.from || '', placeholder: 'famille@exemple.fr' })),
        h('div', { class: 'row gap wrap', style: { marginTop: '.3rem' } },
          h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'),
          c.configured ? h('button', { class: 'btn small', type: 'button', onclick: async () => { if (await confirmBox("Retirer cette configuration ? Les variables d'environnement, si définies, reprendront le relais.", 'Réinitialiser')) act(async () => { smtpConfig = await del('/settings/smtp'); toast('Configuration retirée'); await refresh(); }); } }, 'Réinitialiser') : null),
      c.configured ? h('p', { class: 'hint' }, 'Pour vérifier que l\'envoi fonctionne, utilisez « Envoyer un e-mail de test » dans la section « Mon compte » ci-dessous.') : null));
  }

  function addonCard(a) {
    return h('div', { class: 'stack', style: { borderTop: '1px solid var(--border)', paddingTop: '.8rem', marginTop: '.8rem' } },
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); act(async () => {
        const f = e.target.elements;
        const config = {}; for (const field of a.fields) config[field.key] = f[`${a.id}_${field.key}`].value;
        const updated = await put(`/addons/${a.id}`, { enabled: f[`${a.id}_enabled`].checked, config });
        addonsList = addonsList.map((x) => (x.id === a.id ? updated : x));
        toast('Configuration enregistrée'); draw();
      }); } },
        h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: `${a.id}_enabled`, checked: a.enabled }), h('span', null, h('strong', null, a.label))),
        a.fields.map((field) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, field.label),
          field.type === 'circle'
            ? h('select', { name: `${a.id}_${field.key}` },
                h('option', { value: '' }, 'Détection automatique (si un seul cercle)'),
                state.circles.map((c) => h('option', { value: c.id, selected: String(c.id) === String(a.config[field.key] || '') }, c.name)))
            : h('input', {
                name: `${a.id}_${field.key}`, type: field.type === 'password' ? 'password' : 'text',
                value: field.type === 'password' ? '' : (a.config[field.key] || ''),
                placeholder: field.type === 'password' ? (a.config[field.key] ? 'Laisser vide pour ne pas changer' : '') : (field.placeholder || ''),
                autocomplete: field.type === 'password' ? 'new-password' : 'off',
              }))),
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'),
          a.enabled ? h('button', { class: 'btn small', type: 'button', onclick: () => act(async () => {
            try {
              const r = await post(`/addons/${a.id}/sync`, {});
              const nOk = (r.reservations || []).filter((x) => x.ok).length + (r.invoices || []).filter((x) => x.ok).length;
              const nErr = (r.reservations || []).filter((x) => !x.ok).length + (r.invoices || []).filter((x) => !x.ok).length;
              toast(`Synchronisation : ${nOk} élément(s) importé(s)${nErr ? `, ${nErr} erreur(s)` : ''}`);
            } finally {
              // Même en cas d'échec : la dernière erreur, elle, reste affichée tant qu'on ne
              // resynchronise pas avec succès (contrairement au toast, qu'on peut manquer).
              addonsList = await get('/addons'); draw();
            }
          }) }, 'Synchroniser maintenant') : null)),
      a.last_sync_at ? h('p', { class: 'hint' }, `Dernière synchronisation : ${new Date(a.last_sync_at).toLocaleString('fr-FR')}`) : null,
      a.last_error ? h('p', { class: 'form-error' }, `Dernière erreur : ${a.last_error}`) : null);
  }

  function addonsSection() {
    if (addonsList === undefined) { addonsList = 'loading'; get('/addons').then((r) => { addonsList = r; draw(); }); }
    if (addonsList === 'loading') return h('section', { class: 'card' }, h('h2', null, 'Modules complémentaires'), h('p', { class: 'muted' }, 'Chargement…'));
    if (!addonsList.length) return null;
    return h('section', { class: 'card' }, h('h2', null, 'Modules complémentaires (réservations et factures périscolaires)'),
      h('p', { class: 'muted' }, "Récupère automatiquement vos réservations (garderie, cantine, ALSH…) et vos factures depuis le portail de votre mairie ou de votre collectivité. Vos identifiants restent dans Mosaïque, jamais transmis ailleurs qu'au site concerné."),
      addonsList.map(addonCard));
  }

  function draw() {
    const me = state.me.user;
    const sections = [];

    sections.push(h('section', { class: 'card' }, h('h2', null, 'Mon compte'), h('p', { class: 'muted' }, me.email),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); act(async () => {
        const f = e.target.elements;
        const body = { name: f.name.value, partner_id: f.partner_id ? (f.partner_id.value || null) : undefined };
        if (f.new_password.value) { body.current_password = f.current_password.value; body.new_password = f.new_password.value; }
        await put('/me', body); toast('Compte mis à jour'); f.current_password.value = ''; f.new_password.value = ''; refresh();
      }); } },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nom'), h('input', { name: 'name', value: me.name, maxlength: 80, required: true })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Couleur'), h('div', { class: 'swatch-row' }, TILE_COLORS.map((x) => h('button', { type: 'button', class: 'swatch-btn' + (x === me.color ? ' sel' : ''), style: { background: x }, 'aria-label': x, onclick: () => act(async () => { await put('/me', { color: x }); toast('Couleur mise à jour'); refresh(); }) })))),
      state.users.filter((u) => u.id !== me.id).length ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Conjoint·e à notifier aussi (facultatif)'), h('select', { name: 'partner_id' }, h('option', { value: '' }, 'Personne'), state.users.filter((u) => u.id !== me.id).map((u) => h('option', { value: u.id, selected: u.id === me.partner_id }, u.name))),
        h('span', { class: 'hint' }, "Cette personne recevra aussi vos notifications (nouvel événement dont vous êtes responsable, etc.) — pratique pour qu'un beau-parent qui vit avec vous soit tenu au courant, sans avoir à faire partie des mêmes cercles.")) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mot de passe actuel'), h('input', { name: 'current_password', type: 'password', autocomplete: 'current-password' })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nouveau mot de passe'), h('input', { name: 'new_password', type: 'password', autocomplete: 'new-password' })),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer'))),
      state.settings.smtp_configured ? h('div', { class: 'row between center', style: { marginTop: '1rem' } },
        h('label', { class: 'check-field' }, h('input', { type: 'checkbox', checked: me.email_notify, onchange: (e) => act(async () => { await put('/me', { email_notify: e.target.checked }); toast('Préférence enregistrée'); refresh(); }) }), h('span', null, 'Recevoir aussi mes notifications par e-mail')),
        h('button', { class: 'btn small', onclick: () => act(async () => { await post('/me/test-email'); toast(`E-mail de test envoyé à ${me.email}`); }) }, "Envoyer un e-mail de test"))
        : h('p', { class: 'hint', style: { marginTop: '1rem' } }, "Aucun serveur SMTP n'est configuré sur ce serveur : les notifications par e-mail ne sont pas disponibles (voir le README)."),
      (state.settings.smtp_configured && state.settings.pronote_enabled) ? h('label', { class: 'check-field', style: { marginTop: '.6rem' } },
        h('input', { type: 'checkbox', checked: me.homework_recap, onchange: (e) => act(async () => { await put('/me', { homework_recap: e.target.checked }); toast('Préférence enregistrée'); refresh(); }) }),
        h('span', null, "Recevoir le récapitulatif quotidien École (devoirs, mots) par e-mail en cas de nouveauté")) : null,
      pushSection(),
      installBlock(),
      h('div', { class: 'row between center', style: { marginTop: '1rem' } },
        h('div', null, h('strong', null, 'Abonnement agenda'), h('p', { class: 'muted' }, 'Ajoutez votre planning à votre application de calendrier habituelle.')),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn small', onclick: (e) => { navigator.clipboard.writeText(`${publicOrigin()}/ical/${me.ical_token}.ics`); e.target.textContent = 'Copié !'; } }, icon('copy', 14), ' Copier le lien'),
          h('button', { class: 'btn small', onclick: async () => { if (await confirmBox('Régénérer le lien invalidera les abonnements existants (agenda et présence). Continuer ?', 'Régénérer')) act(async () => { const r = await post('/me/ical-token'); me.ical_token = r.ical_token; toast('Lien régénéré'); draw(); }); } }, 'Régénérer'))),
      h('div', { class: 'row between center', style: { marginTop: '1rem' } },
        h('div', null, h('strong', null, 'Présence (Home Assistant, automatisations…)'), h('p', { class: 'muted' }, "Indique, pour chaque enfant, s'il est chez vous ce soir d'après la garde renseignée. Utilise le même lien que l'agenda.")),
        h('button', { class: 'btn small', onclick: (e) => { navigator.clipboard.writeText(`${publicOrigin()}/presence/${me.ical_token}.json`); e.target.textContent = 'Copié !'; } }, icon('copy', 14), ' Copier le lien')),
      !state.settings.public_url ? h('p', { class: 'hint', style: { marginTop: '.4rem' } }, "Adresse publique non configurée : les liens ci-dessus reprennent l'adresse depuis laquelle vous êtes connecté·e, qui peut ne pas fonctionner depuis l'extérieur. Un administrateur peut la renseigner plus bas dans cette page.") : null));

    if (me.is_admin) {
      sections.push(h('h2', { class: 'admin-divider' }, icon('gear', 16), ' Administration'));

      sections.push(h('section', { class: 'card' }, h('h2', null, 'Préférences de la famille'),
      h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); act(async () => {
        await put('/settings', {
          family_name: e.target.elements.family_name.value,
          fil_familial: e.target.elements.fil_familial.checked,
          messages_enabled: e.target.elements.messages_enabled.checked,
          courses_enabled: e.target.elements.courses_enabled.checked,
          pronote_enabled: e.target.elements.pronote_enabled.checked,
          recap_hour: e.target.elements.recap_hour.value,
          recipes_enabled: e.target.elements.recipes_enabled.checked,
          ...(state.settings.pronote_enabled ? {
            reservation_recap_hour: e.target.elements.reservation_recap_hour.value,
            holiday_notice_weeks: e.target.elements.holiday_notice_weeks.value,
          } : {}),
        });
        toast('Réglages enregistrés'); refresh();
      }); } },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Nom de la famille'), h('input', { name: 'family_name', value: state.settings.family_name, maxlength: 80 })),
      h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'fil_familial', checked: state.settings.fil_familial }), h('span', null, 'Activer le fil familial (partage de photos et de nouvelles)')),
      h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'messages_enabled', checked: state.settings.messages_enabled }), h('span', null, 'Activer la messagerie')),
      h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'courses_enabled', checked: state.settings.courses_enabled }), h('span', null, 'Activer la liste de courses')),
      h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'pronote_enabled', checked: state.settings.pronote_enabled }), h('span', null, "Activer École (devoirs et mots, via Pronote ou une autre source externe)")),
      h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'recipes_enabled', checked: state.settings.recipes_enabled }), h('span', null, 'Activer les recettes de cuisine')),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Heure du récapitulatif quotidien par e-mail'), h('select', { name: 'recap_hour' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === state.settings.recap_hour }, `${String(i).padStart(2, '0')}h`)))),
      state.settings.pronote_enabled ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Heure du rappel du jeudi soir (réservations périscolaires de la semaine suivante)'), h('select', { name: 'reservation_recap_hour' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === state.settings.reservation_recap_hour }, `${String(i).padStart(2, '0')}h`)))) : null,
      state.settings.pronote_enabled ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Vacances réservables : notifier combien de semaines avant leur début'),
        h('input', { type: 'number', name: 'holiday_notice_weeks', min: 1, max: 12, value: state.settings.holiday_notice_weeks }),
        h('span', { class: 'hint' }, "Estimation seulement : le portail de réservation ne permet pas de savoir avec certitude quand les réservations ouvrent. Un rappel supplémentaire est envoyé une semaine plus tard si rien n'est encore réservé.")) : null,
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer')))));

      sections.push(h('section', { class: 'card' }, h('h2', null, 'Sauvegarde'),
        h('p', { class: 'muted' }, "Télécharge une archive .zip avec une copie de la base de données et de tous les fichiers envoyés (documents, photos du fil familial...). À faire de temps en temps et à ranger en lieu sûr, en complément d'une vraie sauvegarde du serveur."),
        h('a', { class: 'btn primary', href: '/api/admin/backup' }, icon('download', 16), ' Télécharger une sauvegarde')));

      sections.push(publicUrlSection());
      sections.push(smtpSection());

      if (state.settings.pronote_enabled) {
        if (integrationToken === undefined) { integrationToken = null; get('/settings/integration-token').then((r) => { integrationToken = r.token; draw(); }); }
        sections.push(h('section', { class: 'card' }, h('h2', null, 'Intégration École'),
          h('p', { class: 'muted' }, "Ce jeton, propre à toute la famille, permet à une source externe (par exemple une automatisation Home Assistant reliée à Pronote) d'envoyer des devoirs et des mots dans Mosaïque. Voir le README pour un exemple complet."),
          integrationToken ? h('div', { class: 'stack' },
            h('div', { class: 'copy-row' }, h('input', { readonly: true, value: integrationToken, onclick: (e) => e.target.select() }),
              h('button', { class: 'btn', type: 'button', onclick: (e) => { navigator.clipboard.writeText(integrationToken); e.target.textContent = 'Copié !'; } }, 'Copier')),
            h('p', { class: 'hint' }, `Adresses d'envoi : ${publicOrigin()}/import/${integrationToken}/homework et /note`),
            h('button', { class: 'btn small', onclick: async () => { if (await confirmBox("Régénérer invalidera l'ancien jeton pour toute intégration déjà branchée. Continuer ?", 'Régénérer')) act(async () => { const r = await post('/settings/integration-token'); integrationToken = r.token; toast('Jeton régénéré'); draw(); }); } }, 'Régénérer'))
            : h('button', { class: 'btn primary', onclick: async () => { const r = await post('/settings/integration-token'); integrationToken = r.token; draw(); } }, 'Générer un jeton')));

        sections.push(addonsSection());
      }
    }

    mount(box, sections);
  }

  async function refresh() { applyMe(await get('/me')); draw(); }
  draw();
}
