#!/bin/sh
# Détecte les identifiants non définis (imports oubliés...) dans le client, le serveur et les tests.
# Nécessite un accès à Internet la première fois (npx télécharge ESLint, sans rien ajouter au projet).
cd "$(dirname "$0")/.." || exit 1
exec npx --yes -p eslint@9 eslint -c tools/eslint.config.mjs public/js public/sw.js server test
