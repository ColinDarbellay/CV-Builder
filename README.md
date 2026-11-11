# CV Builder

Éditeur de CV personnel : une version par candidature, score ATS par rapport à l'offre, reformulations proposées par Claude (copier-coller), aperçu et export PDF fidèle au modèle, suivi des candidatures.

Le code ne contient aucune donnée personnelle et peut donc être public. Le CV, la photo et les candidatures vivent dans Supabase, lisibles uniquement après connexion, par le seul e-mail autorisé. L'app est servie par GitHub Pages, comme WA-Trip.

Mise en place : environ 30 minutes, une seule fois.

## 1. La base de données (Supabase)

1. Sur [supabase.com](https://supabase.com), **New project**. Nom au choix, un mot de passe de base de données, région **Central EU (Frankfurt)** ou **Central EU (Zurich)**.
2. Quand le projet est prêt : **SQL Editor → New query**.
3. Ouvre `supabase/schema.sql`, remplace `YOUR_EMAIL_HERE` (ligne 6) par l'e-mail avec lequel tu te connecteras, colle le tout et clique **Run**.
4. **Authentication → Sign In / Providers → Email** : désactive **Confirm email** et enregistre.
5. **Project Settings → API Keys** : copie la clé **Publishable key** (`sb_publishable_…`) et la **Project URL**. Jamais la *Secret key*.
6. Dans `config.js`, remplace `YOUR_SUPABASE_URL` et `YOUR_SUPABASE_PUBLISHABLE_KEY`, puis commite.

## 2. La mise en ligne (GitHub Pages)

1. **Settings → General → Danger Zone → Change visibility → Make public** (GitHub Pages gratuit exige un dépôt public).
2. **Settings → Pages** : *Source* **Deploy from a branch**, branche **main**, dossier **/ (root)**, **Save**.
3. Après une minute, l'adresse de l'app s'affiche en haut de la page **Pages**.

## 3. Ce qui est visible publiquement

- Le code et l'écran de connexion de l'app : aucune donnée personnelle.
- La clé publique Supabase dans `config.js` : elle est faite pour être publique ; les règles RLS n'ouvrent les données qu'à l'e-mail de la table `members`.
- Jamais : ton CV, ta photo, tes candidatures, ni le fichier `cv-base.json` (dossier `private/`, ignoré par Git).

## 4. Premier lancement

1. Ouvre l'app, saisis ton e-mail et un mot de passe (6 caractères min.), puis **Créer le compte**.
2. Dans Supabase, **Authentication → Sign In / Providers** : désactive **Allow new users to sign up**. Ton compte existe, personne d'autre ne pourra en créer.
3. Dans l'app, **Importer le CV de base** et choisis `cv-base.json` (fourni à part, à garder hors du dépôt : le dossier `private/` est ignoré par Git).

## Utilisation

- **Éditer** : ouvre un modèle, **+ Nouvelle candidature** (entreprise, poste), puis adapte titre, résumé et puces. Une puce par ligne ; décoche un poste pour le masquer dans cette version.
- **ATS** : colle l'offre complète. *Analyse rapide* donne une première estimation hors ligne. *Analyse avec Claude* : copie le prompt, colle-le dans une nouvelle conversation sur claude.ai, recolle la réponse. Tu obtiens les mots-clés réels de l'offre (avec synonymes FR/DE/EN), des reformulations à appliquer ou ignorer une par une, et les exigences que ton parcours ne couvre pas.
- **Aperçu & PDF** : rendu exact du PDF, et le texte tel qu'un parser ATS le lit, avec contrôles (nom, e-mail, téléphone, intitulés, score recalculé sur le texte extrait).
- **Candidatures** : statut, date d'envoi, lien de l'offre, notes, score ATS de chaque version.

## Bon à savoir

- Avant chaque commit de l'app, lance `./bump-version.sh` : il date la version et force les navigateurs à recharger les fichiers (GitHub Pages les garde 10 minutes en cache). L'app propose « Reload » quand une version plus récente est en ligne ; la date de la version chargée s'affiche à côté du nom de l'app.

- Le PDF utilise la police Rubik intégrée avec une table Unicode : le texte reste sélectionnable et extractible, sans ligatures. La colonne principale est écrite avant la barre latérale.
- Le score ATS mesure la couverture des mots-clés de l'offre, pas la note d'un logiciel précis.
- Le navigateur garde une copie locale de tes données pour un affichage rapide ; « Se déconnecter » l'efface. Utilise l'app sur ton ordinateur personnel.
- Police Rubik : SIL Open Font License 1.1. Bibliothèques : jsPDF, pdf.js, supabase-js.
