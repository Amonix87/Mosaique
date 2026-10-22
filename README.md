# Mosaïque

Application d'organisation familiale **auto-hébergée**, pensée pour les familles recomposées — une alternative à [Shared](https://share-d.com) que vous installez et gardez chez vous, sur votre propre serveur.

## Fonctionnalités

- **Agenda partagé** — événements ponctuels ou récurrents, abonnement iCal (Google Calendar, Apple Calendar, Outlook…)
- **Garde alternée** — mosaïque visuelle par enfant, génération automatique (semaine sur deux, 2‑2‑3, 2‑2‑5‑5, week-ends alternés, séquence personnalisée), demandes d'échange de garde avec validation, statistiques de répartition des nuits
- **SOS remplacement** — signalez un imprévu, le premier membre disponible prend le relais
- **Tâches** avec assignation, échéance et rappel
- **Liste de courses** partagée
- **Budget partagé** — dépenses avec répartition personnalisée (%), calcul automatique des remboursements minimaux, historique par catégorie
- **Documents** partagés (carnets de santé, jugements, factures…)
- **Contacts** (médecins, école, baby-sitters…)
- **Fil familial** (photos et nouvelles) et **messagerie** par cercle
- **Cercles** — regroupez les bonnes personnes autour du bon contenu (ex. : « Famille » pour tout le monde, « Coparents » pour les seuls parents)
- **Vacances scolaires** (zones A/B/C) intégrées au planning de garde
- Notifications en temps réel, thème clair/sombre, utilisable au téléphone comme à l'ordinateur
- Point d'accès de présence pour Home Assistant (savoir si un enfant est chez vous ce soir, pour des automatisations)
- Dates et heures toujours au format français (jj/mm/aaaa, 24h), quelle que soit la langue du navigateur
- Installable comme une application sur le téléphone (icône sur l'écran d'accueil, plein écran)
- Vraies notifications push, même application fermée

Tout tourne sur votre serveur : aucune donnée n'est envoyée à un tiers.

## Installation avec Docker (recommandé)

Prérequis : [Docker](https://docs.docker.com/get-docker/) et Docker Compose.

Téléchargez seulement `docker-compose.yml` (pas besoin de cloner le dépôt) puis :

```bash
docker compose up -d
```

Par défaut, il récupère l'image déjà construite et publiée sur `ghcr.io/amonix87/mosaique` (voir
« Mettre à jour » ci-dessous) — rien à compiler sur votre serveur.

Puis ouvrez `http://votre-serveur:3000`. Le premier écran vous guide pour créer votre famille et votre compte administrateur.

Les données (base SQLite + fichiers envoyés) sont stockées dans un volume Docker nommé `mosaique-data`, qui survit aux mises à jour et redémarrages.

### Mettre à jour

```bash
docker compose pull
docker compose up -d
```

À chaque mise à jour poussée sur la branche `main` du dépôt, une image à jour est reconstruite et
publiée automatiquement sur `ghcr.io/amonix87/mosaique:latest` par GitHub Actions
(`.github/workflows/docker-publish.yml`) — `docker compose pull` suffit donc.

Deux alternatives sont commentées dans `docker-compose.yml`, pour qui préfère construire soi-même
l'image plutôt que de récupérer celle déjà publiée : directement depuis le dépôt GitHub
(`build: https://github.com/...#main`), ou depuis un clone local existant (`build: .`, puis
`git pull` avant chaque `docker compose build`).

## Installation sans Docker

Prérequis : [Node.js](https://nodejs.org/) 20 ou plus récent.

```bash
npm install
npm start
```

L'application écoute par défaut sur `http://localhost:3000`. Les données sont stockées dans `./data` (créé automatiquement).

Pour un usage durable, faites-la tourner via un gestionnaire de process comme `systemd` ou `pm2` afin qu'elle redémarre automatiquement avec le serveur.

## Rendre l'application accessible depuis l'extérieur

Mosaïque n'intègre pas de certificat HTTPS : utilisez un reverse proxy devant elle (recommandé), par exemple [Caddy](https://caddyserver.com/) (HTTPS automatique) :

```
monfamille.exemple.fr {
  reverse_proxy localhost:3000
}
```

Si vous utilisez un reverse proxy HTTPS, ajoutez la variable d'environnement `TRUST_PROXY=1` (déjà présente dans `docker-compose.yml`) pour que les cookies de session soient correctement sécurisés.

Pour un accès simple entre les foyers sans exposer votre serveur sur Internet, un réseau privé comme [Tailscale](https://tailscale.com/) ou [WireGuard](https://www.wireguard.com/) fonctionne très bien.

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute HTTP |
| `DATA_DIR` | `./data` | Dossier de stockage (base de données + fichiers envoyés) |
| `TRUST_PROXY` | *(non défini)* | À définir (`1`) si l'application est derrière un reverse proxy HTTPS |
| `MEDIA_DIR` | `DATA_DIR/uploads/posts` | Dossier de stockage des photos du fil familial (peut être un emplacement séparé, voir `docker-compose.yml`) |
| `SMTP_HOST` | *(non défini)* | Serveur SMTP pour les notifications par e-mail — laissez vide pour désactiver la fonctionnalité |
| `SMTP_PORT` | `587` | Port SMTP |
| `SMTP_USER` / `SMTP_PASS` | *(non défini)* | Identifiants SMTP, si votre serveur en demande |
| `SMTP_FROM` | valeur de `SMTP_USER` | Adresse (et nom) affichés comme expéditeur |
| `SMTP_SECURE` | *(non défini)* | Mettre à `1` pour une connexion SSL/TLS directe (port 465 typiquement) |
| `PUBLIC_URL` | *(non défini)* | Adresse publique de votre instance (voir aussi Réglages → Adresse publique, qui prend le dessus si renseigné) |
| `NOMINATIM_URL` | Service public OpenStreetMap | Adresse d'une instance Nominatim pour l'aide à la saisie d'adresse (voir plus bas) |

## Sauvegarde

Tout est contenu dans le dossier `DATA_DIR` (ou le volume Docker `mosaique-data`) :
- `mosaique.db`, `mosaique.db-wal`, `mosaique.db-shm` — la base de données
- `uploads/` — les documents et photos envoyés

Sauvegarder ce dossier régulièrement suffit à tout sauvegarder. Avec Docker :

```bash
docker run --rm -v mosaique-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/mosaique-backup-$(date +%F).tar.gz -C /data .
```

Chaque enfant doit avoir une couleur distincte (la mosaïque de garde et l'agenda s'appuient dessus pour les distinguer d'un coup d'œil) : la liste déroulante ne propose que les couleurs encore libres.

## Ajouter un membre de la famille

Dans **Famille → Ajouter un membre**, la personne est créée immédiatement (nom, couleur, cercles) et devient tout de suite utilisable partout — assignation de tâches, désignation comme parent d'un enfant, planning de garde — même avant d'avoir activé son propre accès. Un badge « En attente d'activation » s'affiche à côté de son nom tant qu'elle n'a pas défini son e-mail et son mot de passe via le lien fourni. L'administrateur peut à tout moment modifier son nom/sa couleur, ou générer un nouveau lien (bouton « Lien ») si le premier a expiré ou a été perdu — valable 7 jours.

## Personnaliser les vacances scolaires

La zone scolaire (A, B ou C) se règle **par enfant**, dans sa fiche (**Famille → Enfants → Modifier**) — utile quand deux enfants d'une même famille recomposée ne sont pas dans la même zone. L'agenda de garde affiche alors les bonnes périodes de vacances pour chacun.

Les dates par défaut (zones A/B/C) couvrent l'année scolaire en cours dans le code (`server/holidays.js`). Pour les années suivantes, créez un fichier `holidays.json` dans votre dossier de données avec cette forme, il sera automatiquement utilisé à la place :

```json
{
  "periods": [
    { "name": "Toussaint", "zones": ["A", "B", "C"], "start": "2027-10-16", "end": "2027-11-02" }
  ]
}
```

`start` est le premier jour de vacances, `end` le jour de la reprise (exclu).

## Développement

```bash
npm install
npm test     # suite de tests automatisés (backend)
npm start    # démarrage en local
```

Structure du projet :
```
server/   API Express + base SQLite (better-sqlite3)
public/   Application front-end (JavaScript natif, sans framework)
test/     Test de bout en bout de l'API
```

## Limites connues

- Une seule langue (français) et un seul fuseau horaire (celui du serveur)
- Pas d'application native sur les magasins d'applications (App Store / Play Store) — mais installable comme une application depuis le navigateur (voir plus haut)
- Les notifications push nécessitent une session de navigation normale (pas privée), et sur iPhone, que l'application ait été ajoutée à l'écran d'accueil au préalable

## Dépannage

**Le conteneur redémarre en boucle avec un code de sortie 139 (SIGSEGV)** : ce comportement a été observé sur certaines combinaisons noyau/hyperviseur (notamment KVM) avec la version 13 du module natif `better-sqlite3`. Le projet est désormais épinglé sur la version 11, éprouvée et stable, qui utilise un binaire précompilé au lieu d'une compilation locale. Si vous rencontrez malgré tout ce problème, vérifiez que `package.json` référence bien `"better-sqlite3": "^11.10.0"` et reconstruisez avec `docker compose build --no-cache`.

## École (devoirs et mots — Pronote via une source externe)

Mosaïque n'intègre pas Pronote directement : Pronote n'a pas d'API officielle, et toute connexion directe serait un contournement fragile nécessitant vos identifiants Pronote. À la place, Mosaïque expose un **point d'entrée qui reçoit** des devoirs et des mots depuis l'extérieur — à vous de les lui envoyer depuis une source qui, elle, sait déjà parler à Pronote.

**Activation** : Réglages → Préférences de la famille → « Activer École ». Un administrateur génère ensuite un jeton dans la section « Intégration École » qui apparaît juste en dessous.

### Format d'envoi

```
POST http://votre-serveur:3000/import/VOTRE_JETON/homework
POST http://votre-serveur:3000/import/VOTRE_JETON/note
Content-Type: application/json
```

Corps (un objet, ou un tableau pour plusieurs d'un coup) :
```json
{ "child": "Léo", "subject": "Maths", "title": "Exercices p.42", "description": "Facultatif",
  "due_date": "2026-10-05", "external_id": "un-identifiant-stable-cote-pronote" }
```
`child` doit correspondre exactement au prénom de l'enfant dans Mosaïque (ou utilisez `child_id` si vous connaissez l'identifiant interne). `external_id` est facultatif mais recommandé : le renvoyer à l'identique met à jour l'entrée existante au lieu d'en créer une nouvelle en double. Pour un mot, mêmes champs avec `body` à la place de `description`/`due_date`, et `date` à la place de `due_date`.

### Exemple avec Home Assistant

Si vous utilisez déjà (ou installez) une intégration Pronote côté Home Assistant (par exemple celle disponible via HACS), elle expose des capteurs pour les devoirs et les mots. Il suffit ensuite d'un `rest_command` et d'une automatisation :

```yaml
# configuration.yaml
rest_command:
  mosaique_devoir:
    url: "http://IP-DE-VOTRE-SERVEUR:3000/import/VOTRE_JETON/homework"
    method: POST
    content_type: "application/json"
    payload: >-
      {"child": "Léo", "subject": "{{ subject }}", "title": "{{ title }}",
       "due_date": "{{ due_date }}", "external_id": "{{ external_id }}"}
```

```yaml
# automations.yaml — déclenchée à chaque mise à jour du capteur Pronote
automation:
  - alias: "Envoyer les devoirs de Léo vers Mosaïque"
    trigger:
      - platform: state
        entity_id: sensor.leo_devoirs   # nom exact selon votre intégration Pronote
    action:
      - repeat:
          for_each: "{{ state_attr('sensor.leo_devoirs', 'devoirs') }}"
          sequence:
            - service: rest_command.mosaique_devoir
              data:
                subject: "{{ repeat.item.matiere }}"
                title: "{{ repeat.item.description }}"
                due_date: "{{ repeat.item.date }}"
                external_id: "{{ repeat.item.id }}"
```

Les noms exacts des attributs (`devoirs`, `matiere`, `id`…) dépendent de l'intégration Pronote choisie : vérifiez-les dans **Outils de développement → États** de Home Assistant sur votre capteur, et adaptez le gabarit `payload` en conséquence. Le même principe s'applique à un mot de l'école, avec `rest_command` pointant vers `.../note`.

### Récapitulatif quotidien par e-mail

Si un serveur SMTP est configuré, chaque personne peut activer dans Réglages → Mon compte « Recevoir le récapitulatif quotidien École ». Un seul e-mail est envoyé par jour, à l'heure choisie (Réglages, par défaut 18h), **uniquement s'il y a une nouveauté** ce jour-là (nouveau devoir, mise à jour, nouveau mot) — jamais d'e-mail vide. Chacun ne reçoit que ce qui concerne les enfants qu'il ou elle peut voir.

## Réservations et factures périscolaires (garderie, cantine, ALSH)

À la différence de Pronote (qui n'a pas d'API officielle du tout), certains portails de
réservation périscolaire peuvent être synchronisés **directement depuis Mosaïque**, sans script
externe ni cron à gérer vous-même : Réglages → Administration → « Modules complémentaires ».
Activez le module correspondant à votre portail, renseignez son adresse et vos identifiants, et
Mosaïque se charge lui-même de la synchronisation (environ une fois par heure, ou tout de suite
via « Synchroniser maintenant »).

Vos identifiants sont alors conservés dans la base de Mosaïque (comme l'est déjà, par exemple, le
mot de passe du serveur SMTP) — jamais transmis ailleurs qu'au portail concerné. Si vous préférez
ne pas les lui confier, le point d'entrée manuel ci-dessous reste disponible.

Un module existe aujourd'hui pour les portails **e-portail** (Berger-Levrault — garderie, cantine,
ALSH). Si votre commune utilise un autre système, deux options :
- demander/écrire un module pour celui-ci : voir `server/addons/README.md`, qui explique comment en
  ajouter un (un simple fichier à déposer dans `server/addons/`, découvert automatiquement) ;
- ou envoyer vos propres données déjà normalisées, depuis un script ou une automatisation externe,
  vers les points d'entrée bruts ci-dessous — avec le **même jeton d'intégration École** que Pronote :

```
POST http://votre-serveur:3000/import/VOTRE_JETON/reservation
POST http://votre-serveur:3000/import/VOTRE_JETON/facture
Content-Type: application/json
```

Une réservation (visible par enfant, comme les devoirs) :
```json
{ "child": "Léo", "title": "Garderie matin", "date": "2026-11-10",
  "start_time": "07:30", "end_time": "08:30", "status": "confirmée",
  "external_id": "un-identifiant-stable-cote-portail" }
```

Une facture (rattachée à un cercle plutôt qu'à un enfant — une facture de collectivité couvre en général plusieurs enfants/prestations à la fois) :
```json
{ "label": "Cantine novembre", "number": "F-2026-11", "date": "2026-11-01",
  "due_date": "2026-11-30", "amount": 42.50, "status": "à payer",
  "circle": "Famille", "external_id": "un-identifiant-stable-cote-portail" }
```
`circle` (nom du cercle) ou `circle_id` sont facultatifs si vous n'avez qu'un seul cercle dans Mosaïque. `amount` s'exprime en euros (ou `amount_cents` directement en centimes). Comme pour les devoirs, `external_id` évite les doublons en mettant à jour l'entrée existante plutôt que d'en créer une nouvelle — c'est d'ailleurs exactement ce que font les modules eux-mêmes, en interne.

Un enfant peut être exclu du suivi de garde s'il n'en a pas besoin (il vit toujours au même endroit) : décochez « Concerné par une garde partagée » dans sa fiche (Famille → Enfants → Modifier). Il disparaît alors de l'onglet Garde — planning, statistiques, vacances scolaires — sans que rien d'autre ne change pour lui (agenda, contacts, budget restent inchangés). Réactivable à tout moment.

Chaque attribution de garde est indépendante par enfant : toucher un jour dans la mosaïque d'un enfant ne présélectionne que lui, jamais les autres — pratique quand chaque enfant suit un rythme différent (garde partagée pour l'un, arrangement différent pour l'autre). Vous pouvez toujours cocher manuellement d'autres enfants dans la barre d'action si vous voulez appliquer la même période à plusieurs d'entre eux à la fois.

Une fois des parents désignés pour un enfant, les listes d'attribution de garde (planning, attribution rapide d'une nuit, demandes d'échange) ne proposent plus qu'eux — impossible d'attribuer par erreur la garde de cet enfant à quelqu'un d'autre, même à un administrateur qui ne serait pas lui-même désigné comme parent.

## Confidentialité par enfant (familles recomposées)

Dans **Famille → Enfants → Modifier**, un administrateur peut désigner deux niveaux d'accès pour chaque enfant :
- **Parents / tuteurs** (2 maximum) : voient et modifient tout ce qui concerne cet enfant (agenda, garde, contacts). Cocher un troisième nom grise automatiquement les autres membres tant qu'un des deux premiers n'est pas décoché.
- **Lecteurs** : voient la même chose, mais ne peuvent rien modifier — pensé pour le ou la compagnon·ne d'un parent, qui a besoin de connaître le planning de garde ou les contacts médicaux d'un enfant qui n'est pas le sien, sans pouvoir y toucher. Cette liste ne propose que les membres non désignés comme parents (les deux listes s'excluent mutuellement).

Par défaut (aucun parent désigné), l'enfant reste visible **et modifiable** par tout le cercle, comme avant. Dès qu'au moins un parent est désigné, la restriction s'applique aux événements, à la garde et aux contacts liés à cet enfant — un ex sans lien avec l'enfant, même dans le même cercle « Famille », n'y a plus accès.

## Fonctionnalités optionnelles

Dans **Famille → Réglages**, un administrateur peut activer ou désactiver :
- le **fil familial** (photos et nouvelles) — désactivé par défaut
- la **messagerie** — activée par défaut
- la **liste de courses** — activée par défaut

Désactiver une fonctionnalité la masque simplement de la navigation ; les données existantes ne sont jamais supprimées et réapparaissent si vous la réactivez plus tard.

## Agenda et synchronisation (iCal)

L'abonnement iCal (**Famille → Mon compte → Abonnement agenda**) fonctionne **à sens unique** : votre application de calendrier (téléphone, Google Calendar, Outlook…) lit régulièrement le planning de Mosaïque, mais rien de ce que vous ajoutez depuis cette application externe ne remonte vers Mosaïque. Pour une synchronisation dans les deux sens, il faudrait un protocole différent (CalDAV), non fourni par défaut.

## Notifications par e-mail

Le serveur SMTP se configure désormais directement dans l'application : **Réglages → Serveur SMTP (envoi des e-mails)**, réservé aux administrateurs. Le mot de passe n'est jamais réaffiché une fois enregistré (laissez le champ vide pour ne pas le changer), et un bouton « Réinitialiser » permet de revenir aux variables d'environnement si vous préférez cette méthode. Les variables d'environnement (voir le tableau plus haut) restent utilisables et servent de repli tant qu'aucune configuration n'a été enregistrée depuis cette page — pratique pour les installations existantes.

Une fois un serveur configuré (par l'une ou l'autre méthode), chaque membre peut activer, dans **Famille → Mon compte**, la case « Recevoir aussi mes notifications par e-mail ». Un bouton « Envoyer un e-mail de test » (à la fois dans la section admin et dans Mon compte) permet de vérifier rapidement que la configuration fonctionne. Sans serveur SMTP renseigné, ces options restent simplement invisibles — aucune configuration n'est nécessaire pour continuer à utiliser Mosaïque normalement.

Les e-mails sont envoyés un par un, en temps réel, pour chaque notification (nouvel événement, tâche assignée, SOS, demande d'échange de garde, etc.) — il n'y a pas encore de résumé groupé (« digest ») quotidien ou hebdomadaire (sauf pour École, qui a son propre récapitulatif quotidien, voir plus haut).

## Budget cloisonné par relation

Le budget est cloisonné **par cercle**, pas directement par enfant : deux cercles distincts ont chacun leurs propres dépenses, soldes et remboursements, totalement indépendants l'un de l'autre. C'est le bon outil pour séparer complètement les finances de deux relations de coparentalité différentes — par exemple un cercle « Alice + Bob » pour les frais de leur enfant, et un cercle « Alice + Carla » pour les frais de l'enfant d'Alice avec Carla : chacun ne verra jamais les dépenses ni les soldes de l'autre cercle.

Chaque dépense peut en plus être associée à un enfant précis (champ facultatif « Enfant concerné »). Si cet enfant a des parents désignés (Famille → Enfants), **seuls eux se partagent alors la dépense** — une autre personne (beau-parent, grand-parent...) reste sélectionnable comme ayant payé dans « Payé par », sans faire partie du partage : elle peut avancer l'argent et être remboursée sans être elle-même redevable. Sans enfant rattaché, ou sans parent désigné pour lui, le partage reste ouvert à tout le cercle, comme avant. Ce rattachement n'affecte en revanche jamais qui peut *voir* la dépense (contrairement à l'agenda et à la garde) : les soldes et l'historique restent visibles par tout le cercle, pour que chacun garde une vue d'ensemble cohérente des comptes.

## Adresses depuis le carnet de contacts

Le champ « Lieu » d'un événement propose aussi, en plus des suggestions OpenStreetMap, les adresses déjà enregistrées dans vos contacts (dès qu'un contact en a une renseignée) — pratique pour retrouver en un clic le cabinet du pédiatre ou l'école sans retaper l'adresse.

## Supprimer une seule occurrence d'un événement récurrent

En supprimant un événement qui se répète, Mosaïque propose trois choix :
- **Cette occurrence seulement** : retire uniquement cette date-là, le reste de la série continue normalement.
- **Cette occurrence et les suivantes** : garde les occurrences passées, arrête la série à partir de cette date (pratique après un changement d'emploi du temps).
- **Toute la série** : supprime l'événement entièrement, occurrences passées comprises.

## Lieu et heure pour un échange de garde

Une demande d'échange de garde peut préciser un lieu et une heure de transition différents de l'habitude (facultatif) — utile quand l'échange s'accompagne d'un changement d'endroit ou d'horaire ponctuel. Affiché à la personne sollicitée avant qu'elle n'accepte.

## Installation sur l'écran d'accueil et notifications push

Sur téléphone et tablette (jamais sur ordinateur), Mosaïque invite à s'installer, puis à activer les notifications — chaque fenêtre au plus une fois par visite, avec « Plus tard » (revient dans quelques jours) et « Ne plus me le proposer ». Ce choix est mémorisé par navigateur (stockage local), pas par compte.

**Ce que le navigateur permet de savoir, et ce qu'il ne permet pas** : détecter que l'application est *lancée* depuis l'écran d'accueil (mode « standalone ») fonctionne sur iPhone comme sur Android. Détecter, depuis un onglet, qu'elle est installée *ailleurs* ne fonctionne nulle part de façon fiable (aucune API sur iPhone) : c'est donc l'application installée elle-même qui le signale au serveur, une fois par personne, pour ne plus la solliciter ensuite dans son navigateur — ce repère suit la personne, pas l'appareil : installée sur un premier téléphone, l'invitation peut réapparaître sur un second tant qu'elle n'y a pas aussi été vue installée.

- **Android** (Chrome, Edge, Samsung Internet) : le navigateur propose un vrai bouton « Installer », qui déclenche sa fenêtre native. Les notifications, elles, fonctionnent déjà sans installation.
- **iPhone et iPad** : aucune installation déclenchable par un site ; seulement des instructions détaillées (Partager → Sur l'écran d'accueil). Les notifications, elles, exigent l'installation, iOS 16.4 ou plus récent, **et** une adresse publique en https configurée (Réglages → Administration) — sans elle, l'invitation ne promet jamais de notifications, pour ne rien annoncer qui échouerait.

Réglages → Mon compte → « Application sur cet appareil » reprend ces mêmes explications à la demande, et indique si l'appareil utilise déjà l'application installée. Le message affiché quand le push est indisponible s'adapte aussi (iOS trop ancien, pas encore installée...) au lieu du générique « non pris en charge par ce navigateur ».

## Recherche dans l'agenda

Le champ de recherche en haut de l'Agenda cherche dans **tout le calendrier**, passé comme à venir : titre, lieu, notes, catégorie, responsable et enfants concernés, sans tenir compte des accents ni des majuscules (« ecole » trouve « École »). Plusieurs mots se combinent : tous doivent correspondre. Les résultats sont classés « À venir » puis « Passés » ; une série récurrente n'apparaît qu'une fois, avec sa prochaine occurrence (ou la dernière si elle est terminée). La recherche remplace le calendrier tant qu'au moins deux caractères sont saisis ; un résultat s'ouvre comme n'importe quel événement, et l'icône calendrier ramène au jour concerné. Elle applique exactement les mêmes règles de confidentialité que le calendrier (cercles, enfants dont vous n'êtes pas parent désigné) : on ne trouve que ce qu'on a le droit de voir.

## Filtres du Budget

Sous les cercles, une **période** (par mois, par année, ou toute la période) et une **catégorie** filtrent le détail par catégorie et l'historique, qui indique le nombre de dépenses et leur total. Cliquer une catégorie dans le détail filtre aussi l'historique. Les lignes de remboursement n'ont pas de catégorie : elles disparaissent quand une catégorie est choisie. Les **comptes** (qui doit combien à qui) portent toujours sur l'ensemble des dépenses, quels que soient les filtres — sinon ils indiqueraient un solde faux. Par défaut, le mois courant est affiché.

## Documents : filtres et aperçu sans téléchargement

- **Filtres** par catégorie et par période (mois, année, ou toute la période — par défaut), sur la date d'ajout du document. Le nombre de documents correspondants est indiqué, et « Réinitialiser » efface tout.
- **Aperçu** : cliquer un document (ou l'œil) affiche directement les **PDF et images**, dans une grande fenêtre sur ordinateur, ou dans le lecteur du navigateur (nouvel onglet) sur téléphone, où un PDF incrusté s'afficherait mal. « Ouvrir dans un onglet » et « Télécharger » restent proposés. Les autres types de fichiers se téléchargent. Les factures des dépenses s'ouvrent de la même façon.
- **Sécurité** : le serveur reconnaît un PDF ou une image d'après le **contenu** du fichier, jamais d'après le type annoncé à l'envoi (non fiable). Un « PDF » qui n'en est pas un, un SVG ou une page HTML (qui pourraient contenir des scripts) ne sont jamais affichés : ils repartent en téléchargement. Seule la réponse d'aperçu autorise l'incrustation par l'application elle-même ; l'interdiction d'incrustation reste en vigueur partout ailleurs.

## Aide : niveau utilisateur et niveau administration

La section « Installer l'application » et les entrées détaillées de « Notifications » (étapes numérotées, dépannage : autorisation refusée, rien ne s'affiche malgré « Tester ») font partie du niveau utilisateur, visibles par tout le monde.

La page Aide sépare ce qui concerne tout le monde de ce qui relève de l'administration (membres et cercles, enfants, fonctionnalités, e-mails et adresse publique, sauvegarde). Les **administrateurs** voient un bloc « Administration » distinct, sous les rubriques courantes ; les autres membres ne voient jamais ces entrées, et la recherche ne les leur révèle pas non plus.

## Vérification du code (développement)

`node --check` ne détecte pas un import oublié : l'erreur n'apparaît qu'en ouvrant la page concernée. `tools/lint.sh` lance ESLint (règle « identifiant non défini ») sur le client, le serveur et les tests, sans rien ajouter aux dépendances du projet (il télécharge ESLint à la demande, connexion Internet requise) :

```bash
./tools/lint.sh
```

## Dépenses : modification, récurrence, remboursements

- **Modifier une dépense** : crayon dans l'Historique (montant, date, catégorie, payeur, enfant, partage, facture). Les autres membres du cercle sont prévenus.
- **Seul le créateur modifie ou supprime** une dépense, une dépense récurrente ou une ligne de remboursement (vérifié côté serveur, pas seulement masqué dans l'interface). Exception de secours : si le créateur n'existe plus, un administrateur peut la gérer.
- **Dépenses récurrentes** : un modèle (chaque semaine, mois, trimestre ou an, avec date de fin facultative) qui crée une vraie dépense à chaque échéance — les soldes, statistiques et historique n'ont donc affaire qu'à des dépenses ordinaires. Le rattrapage est automatique si le serveur est resté éteint. Modifier le modèle ne change que les échéances à venir ; le supprimer conserve celles déjà créées ; une échéance isolée peut être supprimée sans revenir. Le début et la fréquence ne se modifient pas (supprimer puis recréer). Une facture ne se joint pas au modèle mais à l'une de ses échéances.
- **Lignes de remboursement** : « Remboursement » (ou « Rembourser » à côté d'une somme due, qui préremplit) enregistre qui a rendu combien à qui, à quelle date, avec une note. Le montant est libre, donc un remboursement partiel est possible. Ces lignes figurent dans l'Historique avec les dépenses ; il faut être l'un des deux intéressés pour en enregistrer une.

## Catégories et prix des événements

Les pastilles de choix de cercle (Budget, Messages...) sont désormais partagées : la surbrillance suit le cercle choisi, qui reste le même d'une page à l'autre.

Chaque événement peut avoir une catégorie (Rendez-vous, Santé, École, Activité, Famille, Autre), affichée comme étiquette. Renseigner un **prix** crée une dépense dans Budget : le champ « Payé par » désigne qui a payé (par défaut celui qui saisit le prix, mais n'importe quel membre du cercle est possible — un beau-parent peut avancer l'argent sans faire partie du partage), le partage se fait entre les parents désignés du premier enfant concerné (à défaut, tout le cercle), et la catégorie suit (Santé→Santé, École→École, Activité→Activités, Famille→Loisirs, sinon Autre). Prix, payeur et dépense restent synchronisés dans les deux sens ; retirer le prix supprime la dépense, mais supprimer l'événement la conserve (jamais de suppression silencieuse d'une écriture financière). Seul le créateur de l'événement peut poser ou changer le prix et le payeur, qui ne sont pas disponibles pour un événement récurrent — pour un paiement régulier, utiliser une dépense récurrente.

## Conjoint·e notifié·e automatiquement

Dans Réglages → Mon compte, chacun peut désigner un « Conjoint·e à notifier aussi ». Une fois ce lien fait, cette personne reçoit automatiquement les mêmes notifications que vous (nouvel événement dont vous êtes responsable, etc.), sans avoir à faire partie des mêmes cercles ni à multiplier les cercles pour y arriver — pratique pour qu'un beau-parent qui vit avec vous soit tenu au courant.

## Responsable d'événement notifié seul

Créer un événement notifie uniquement son responsable désigné (manuel ou automatique via la garde du jour), plus son éventuel conjoint·e — pas tout le cercle. Sans responsable identifiable (« Personne en particulier », ou mode automatique sans garde renseignée ce jour-là), tout le cercle est notifié comme avant.

## Rappels d'événements

Comme dans un rendez-vous Google Agenda, chaque événement peut avoir un rappel (aucun, au moment même, de 5 minutes à une semaine avant). Il est envoyé au responsable désigné (et à son éventuel conjoint·e), ou à tout le cercle si aucun responsable n'est identifiable — par notification interne, e-mail et push, selon ce que chacun a activé. Un événement récurrent reçoit un rappel indépendant à chaque occurrence, pas une seule fois pour toute la série. Modifier l'heure, la répétition ou le délai de rappel après coup permet de recevoir le rappel à nouveau si nécessaire.

## Détail de la répartition des nuits

Dans Garde, à côté de « Répartition des nuits », le bouton **+** ouvre le détail complet : les 12 mois de l'année affichée, et un total par année pour chaque année où au moins une nuit a été enregistrée (ce second bloc n'apparaît qu'à partir de la deuxième année de données).

## Responsable automatique d'un événement

Dans le formulaire d'événement, le champ « Responsable » propose « Automatique (selon la garde) » — c'est la valeur par défaut pour un nouvel événement. Dans ce mode, la personne affichée comme responsable n'est pas figée : elle est recalculée à chaque affichage d'après qui a la garde du premier enfant coché ce jour-là. Si vous modifiez la garde (échange, nouveau planning...), le responsable affiché sur l'événement suit automatiquement, sans rien à modifier sur l'événement lui-même. Vous pouvez toujours choisir un responsable fixe (« Personne en particulier » ou un membre précis) si vous préférez qu'il ne change jamais tout seul.

## Aide à la saisie d'adresse

Le champ « Lieu » d'un événement propose des suggestions d'adresses (OpenStreetMap/Nominatim) pendant la frappe, pour éviter les fautes ou les adresses incomplètes. Chaque suggestion est reformatée en adresse postale courte (« 12 rue de la Santé, 75013 Paris ») plutôt que la hiérarchie administrative complète renvoyée par le service — bien plus fiable une fois collée dans Waze, Google Maps ou Plans. Cliquez une suggestion pour la reprendre telle quelle, ou ignorez-les et gardez votre propre texte libre (« chez papi », « école »...). Aucune clé API n'est nécessaire : les requêtes sont relayées par votre serveur vers le service public de recherche d'adresses d'OpenStreetMap.

En choisissant une suggestion, les coordonnées GPS du lieu sont conservées avec l'événement : un bouton « Itinéraire » apparaît alors sur sa fiche, pointant directement sur ces coordonnées plutôt que sur le texte de l'adresse — le moyen le plus fiable d'ouvrir l'application de navigation de votre choix sans dépendre de la façon dont elle interprète le texte. Un lieu tapé à la main (sans reprendre de suggestion) n'a pas de coordonnées : le bouton « Itinéraire » retombe alors sur une recherche texte classique.

Si le service de recherche d'adresses est indisponible (mauvaise configuration, service injoignable), un message distinct l'indique clairement au lieu d'afficher silencieusement « aucun résultat » — plus simple à diagnostiquer.

L'aide à la saisie s'applique aussi au champ Adresse des contacts, avec les mêmes suggestions courtes.

## Vacances scolaires

Les dates sont récupérées automatiquement auprès de l'API officielle du ministère de l'Éducation nationale (data.education.gouv.fr) au démarrage, puis une fois par jour — rien à faire chaque nouvelle année scolaire. En cas d'échec (API injoignable, serveur sans accès Internet...), Mosaïque réutilise la dernière copie obtenue avec succès, mise en cache sur disque ; à défaut, une liste figée de secours (jusqu'à l'été 2027) prend le relais pour ne jamais laisser cet onglet vide. Si vous préférez tout maîtriser à la main, créez `data/holidays.json` (même structure : une liste `periods` avec `name`, `zones`, `start`, `end`) — ce fichier, s'il existe, est toujours prioritaire et désactive la récupération automatique.

## Numéros de semaine et modèle de garde par parité

L'agenda et la grille de garde affichent désormais le numéro de semaine ISO de chaque ligne. Le générateur de planning propose en plus un modèle « Une semaine sur deux (par numéro de semaine pair/impair) » : plutôt que de partir d'une date de cycle, vous choisissez directement si le parent A a les semaines paires ou impaires — pratique pour un rythme calé sur le calendrier plutôt que sur une date de départ précise.

## Lieu et heure de transition

Dans la fiche de chaque enfant (Famille → Enfants → Modifier), vous pouvez renseigner un lieu de transition habituel (avec des suggestions rapides : école, domicile de chaque membre de la famille — ou votre propre texte) et une heure habituelle. Cette information s'affiche en rappel discret au-dessus du planning de garde de cet enfant, dans l'onglet Garde. Les deux champs sont facultatifs et indépendants l'un de l'autre.

## Notifications push

En plus des notifications internes et par e-mail, Mosaïque peut envoyer de vraies notifications push sur votre téléphone ou ordinateur — reçues même quand l'application n'est pas ouverte, exactement comme une application native. Aucune configuration n'est nécessaire : les clés nécessaires (VAPID) sont générées automatiquement au premier démarrage.

**Activation** : Réglages → Mon compte → « Notifications push sur cet appareil » → Activer. Le navigateur demande alors l'autorisation d'afficher des notifications ; une fois acceptée, cet appareil reçoit une alerte à chaque notification (tâche assignée, dépense ajoutée, échange de garde, nouveauté École...). Chaque appareil s'active indépendamment : activez-le sur votre téléphone et sur votre ordinateur séparément si vous voulez les deux. Un bouton « Tester » envoie une notification immédiate pour vérifier que tout fonctionne.

Quelques points à savoir :
- **Sur iPhone**, les notifications push ne fonctionnent que si Mosaïque a d'abord été ajoutée à l'écran d'accueil (voir la section PWA plus haut) — c'est une restriction d'Apple, pas de Mosaïque.
- **Une adresse publique `https://` réelle doit être configurée** (Réglages → Adresse publique, ou variable `PUBLIC_URL`) pour qu'Apple accepte les notifications envoyées à un iPhone : sans ça, l'envoi échoue systématiquement avec l'erreur `BadJwtToken`, car Apple refuse l'identifiant de secours utilisé en son absence. Réglages → Notifications push affiche un avertissement tant que ce n'est pas fait. Chrome/Android et les ordinateurs ne sont pas concernés par cette restriction.
- **La navigation privée bloque cette fonctionnalité** dans tous les navigateurs (restriction volontaire des navigateurs, pas de Mosaïque) : utilisez une fenêtre normale.
- On ne reçoit jamais de notification pour ses propres actions (créer sa propre dépense ne se notifie pas soi-même), comme pour les notifications par e-mail.

## Installer Mosaïque comme une application (PWA)

Mosaïque n'est pas disponible sur l'App Store ou le Play Store — développer et publier une vraie application native serait un projet à part entière, avec un compte développeur payant et une maintenance séparée. En revanche, l'application peut s'installer sur le téléphone comme une application classique, avec sa propre icône et sans barre de navigateur :

- **Android (Chrome)** : ouvrez Mosaïque, menu ⋮ → « Installer l'application » (ou un bandeau d'installation apparaît automatiquement).
- **iPhone/iPad (Safari)** : ouvrez Mosaïque, bouton Partager → « Sur l'écran d'accueil ».

Une fois installée, l'application s'ouvre en plein écran avec sa propre icône, exactement comme une application native, et se recharge plus vite grâce à un cache local léger (qui ne concerne que l'habillage de l'application — vos données restent toujours à jour, jamais mises en cache). L'icône a un fond crème plutôt que transparent : iOS remplit de toute façon les zones transparentes d'une icône d'écran d'accueil, généralement en noir, donc autant choisir la couleur nous-mêmes.

## Facture jointe à une dépense

Lors de l'ajout d'une dépense (Budget), vous pouvez joindre un justificatif au format PDF. Il est automatiquement rangé dans Documents, sous la catégorie « Facture », et reste accessible en un clic depuis la ligne de la dépense elle-même. Remplacer le fichier (en le renvoyant depuis le formulaire d'une nouvelle dépense) retire l'ancien ; supprimer la dépense retire aussi sa facture jointe.

## Recettes et planificateur de repas (optionnel)

Activable dans Réglages (« Activer les recettes de cuisine »), cette section permet de garder vos recettes de famille, avec une note globale (1 à 5 étoiles) et une note distincte par enfant — pratique pour repérer d'un coup d'œil les plats qui plaisent à tout le monde. Comme le fil familial ou les courses, elle est désactivée par défaut et n'apparaît dans la navigation qu'une fois activée.

Chaque recette peut préciser un nombre de portions de base et une liste d'ingrédients structurée (nom, quantité, unité, catégorie — les mêmes catégories que la liste de courses). La quantité et l'unité sont facultatives, mais nécessaires pour profiter du planificateur de repas.

**Le planificateur (onglet Repas)** affiche une semaine avec un créneau déjeuner et un créneau dîner par jour, à assigner à une recette existante ou à un titre libre (« Restes », « Pizza »...). Un indice au-dessus de chaque jour rappelle, à titre informatif, le nombre d'enfants gardés ce jour-là d'après le planning de garde — le nombre de portions de chaque repas reste toujours à ajuster à la main, Mosaïque ne connaissant pas le nombre d'adultes présents.

Le bouton « Générer la liste de courses » additionne les ingrédients de toutes les recettes planifiées sur la semaine affichée (mis à l'échelle selon les portions prévues comparées aux portions de base de la recette) et les ajoute à Courses, groupés par catégorie. Les repas au titre libre (sans recette liée) n'ont pas d'ingrédients à additionner et sont donc ignorés par cette génération.

## Liste de courses par catégorie

Les articles de la liste de courses (Courses) sont regroupés par catégorie (Fruits & légumes, Épicerie, Viande & poisson, Crémerie & œufs, Boulangerie, Surgelés, Boissons, Hygiène & entretien, Autre). Un article ajouté à la main atterrit dans « Autre » ; ceux générés depuis le planificateur de repas reprennent la catégorie choisie sur l'ingrédient correspondant de la recette.

## Home Assistant (présence des enfants)

Chaque parent peut interroger un point d'accès qui indique, pour chaque enfant qu'il peut voir, s'il est chez lui ce soir d'après la garde renseignée dans Mosaïque — pratique pour déclencher le chauffage de sa chambre uniquement quand il est là.

L'adresse se trouve dans **Famille → Réglages → Mon compte → Présence**, sous la forme :
```
http://votre-serveur:3000/presence/VOTRE_JETON.json
```
Elle répond par exemple :
```json
{ "family": "Les Dupont-Martin", "as": "Alice", "date": "2026-09-24",
  "children": [
    { "id": 3, "name": "Léo", "home": true, "with": "Alice" },
    { "id": 4, "name": "Mia", "home": null, "with": null }
  ] }
```
`home` vaut `true` ou `false` selon que la nuit d'aujourd'hui vous est attribuée ou non, et `null` si rien n'a encore été renseigné pour aujourd'hui (volontairement neutre, pour éviter qu'une automatisation ne se déclenche à tort).

### Configuration Home Assistant

Dans `configuration.yaml` (adaptez l'IP, le port et le nom de l'enfant) :

```yaml
binary_sensor:
  - platform: rest
    name: "Léo à la maison"
    resource: "http://IP-DE-VOTRE-SERVEUR:3000/presence/VOTRE_JETON.json"
    device_class: presence
    value_template: >-
      {{ (value_json.children | selectattr('name', 'eq', 'Léo') | first).home }}
    scan_interval: 300
```

Ce capteur devient alors utilisable comme déclencheur d'automatisation classique, par exemple :

```yaml
automation:
  - alias: "Chauffage chambre de Léo"
    trigger:
      - platform: state
        entity_id: binary_sensor.leo_a_la_maison
        to: "on"
    action:
      - service: climate.set_temperature
        target:
          entity_id: climate.chambre_leo
        data:
          temperature: 20
```

Un capteur par enfant suffit ; répétez le bloc `binary_sensor` avec un nom différent pour chaque enfant à suivre. Le jeton étant personnel, chaque parent utilise le sien dans sa propre installation Home Assistant : `home` reflète alors automatiquement « chez moi », sans rien configurer de plus.

## Licence

MIT — libre à vous de l'adapter à votre famille.
