# Addons de réservation périscolaire

Chaque fichier `.js` de ce dossier est un addon découvert automatiquement au démarrage (voir
`server/addon-manager.js`) et configurable depuis Réglages → Administration → « Modules
complémentaires » — sans toucher au docker-compose.yml.

Pour prendre en charge un autre site de réservation (une autre collectivité, un autre éditeur de
portail), copiez `eportail.js` comme point de départ et adaptez-le. Un addon doit exporter :

```js
module.exports = {
  id: 'identifiant-unique',           // utilisé en interne (clé de réglage) : ne pas changer une fois en usage
  label: 'Nom affiché dans Réglages',
  fields: [                           // les champs affichés et demandés à l'administrateur
    { key: 'url', label: 'Adresse du portail', type: 'text', placeholder: '…' },
    { key: 'username', label: 'Identifiant', type: 'text' },
    { key: 'password', label: 'Mot de passe', type: 'password' }, // jamais renvoyé en clair au client
    { key: 'circle', label: 'Cercle', type: 'circle' }, // affiché comme un menu déroulant des cercles existants ; la valeur enregistrée est l'id du cercle
  ],
  async sync(config) {
    // config = { url, username, password, ... } tel que renseigné dans Réglages.
    // Doit retourner { reservations: [...], invoices: [...] } au même format que les points
    // d'entrée /import/:token/reservation et /import/:token/facture (voir le README principal,
    // section « Réservations et factures périscolaires ») : { child, title, date, ... } et
    // { label, number, date, amount, circle, ... }. Une erreur lancée ici est journalisée côté
    // serveur et affichée dans Réglages (dernière erreur) ; elle n'interrompt pas le reste de
    // Mosaïque.
    //
    // openSlots (facultatif) : liste de { child, title, date } pour les créneaux ACTUELLEMENT
    // visibles mais pas encore réservés (ex. isOuvert===true côté e-portail) — permet une détection
    // réelle du moment où une période (vacances/ALSH) devient réservable : voir extractOpenSlots et
    // maybeSendHolidayNotices dans server/index.js. N'a de sens que si votre portail distingue, pour
    // un même créneau, « pas encore visible » (absence totale) de « visible, pas encore réservé ».
    return { reservations: [], invoices: [], openSlots: [] };
  },

  // syncHistory (facultatif) : import complet de l'historique, bien plus large que ce que sync()
  // peut remonter (souvent limité à quelques semaines par le portail lui-même). Signature :
  //   async syncHistory(config, { sinceRef, onProgress, onBatch }) -> { newestRef, reachedEnd }
  // - sinceRef : jusqu'où le dernier parcours complet est déjà allé (0 au premier parcours) — permet
  //   de ne reprendre que les nouveautés plutôt que tout refaire à chaque fois.
  // - onProgress({ processed, total }) : à appeler régulièrement, pour l'avancement affiché dans
  //   Réglages pendant que ça tourne.
  // - onBatch(items) : à appeler au fil de l'eau (pas tout à la fin) avec des réservations au même
  //   format que reservations ci-dessus — appliquées immédiatement, pour ne rien perdre si le
  //   parcours est interrompu en cours de route.
  // Un parcours complet peut représenter des centaines de requêtes : toujours réservé au
  // déclenchement manuel et exécuté en tâche de fond (voir runAddonHistory dans server/index.js),
  // avec une pause entre chaque requête pour rester correct avec le serveur distant.
};
```

Mosaïque se charge ensuite de rattacher chaque élément à l'enfant (`child`/`child_id`) ou au cercle
(`circle`/`circle_id`) correspondant et d'éviter les doublons (`external_id`), exactement comme pour
un import manuel — un addon n'a pas besoin de connaître la base de données de Mosaïque.

La synchronisation automatique tourne environ une fois par heure pour tout addon activé (voir
`maybeSyncAddons()` dans `server/index.js`), et peut aussi être déclenchée manuellement depuis
Réglages (« Synchroniser maintenant »), qui lance aussi, en tâche de fond, l'import d'historique
(`syncHistory`) pour les addons qui le proposent.

Si vous préférez ne pas confier d'identifiants à Mosaïque, ou que votre site n'a pas d'addon dédié,
vous pouvez toujours envoyer vos propres données normalisées directement aux points d'entrée
`/import/:token/reservation` et `/import/:token/facture` depuis un script externe (cron, Home
Assistant…) — voir le README principal.
