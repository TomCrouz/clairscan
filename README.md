# ClairScan

Scanner de documents installable (PWA), sans publicité, sans compte, sans envoi de données : tout reste sur l'appareil.

**En ligne : https://tomcrouz.github.io/clairscan/**

## Fonctions

- **Scan** depuis l'appareil photo ou import de plusieurs images de la galerie.
- **Détection automatique des bords** (OpenCV), coins ajustables au doigt avec loupe de précision.
- **Redressement de perspective** jusqu'à 2480 px (≈ A4 à 300 dpi).
- **Filtres** : Magique (fond blanc, ombres supprimées), Original, Gris, Noir & blanc ; rotation par quarts de tour.
- **Documents multi-pages** enregistrés localement (IndexedDB) : renommer, réordonner, supprimer, reprendre le recadrage d'une page (la photo d'origine est conservée).
- **Export PDF** : A4, Lettre ou ajusté à la page ; qualité haute ou compacte ; partage direct (WhatsApp, mail…) ou téléchargement.
- **Hors ligne** après la première ouverture (service worker).

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html`, `styles.css` | Interface |
| `app.js` | Navigation, recadrage, documents, export PDF |
| `scanner.js` | Détection des bords, redressement, filtres |
| `db.js` | Stockage local |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation et mode hors ligne |

## Essayer sur le PC

```bash
python -m http.server 8765
```

Puis ouvrir http://localhost:8765.

## Installer sur le téléphone

L'appareil photo et l'installation exigent une adresse **HTTPS**. Le plus simple : héberger le dossier gratuitement (GitHub Pages, Netlify Drop, Cloudflare Pages…), ouvrir l'adresse sur le téléphone puis :

- **Android (Chrome)** : menu ⋮ → *Ajouter à l'écran d'accueil*.
- **iPhone (Safari)** : bouton Partager → *Sur l'écran d'accueil*.

Le moteur de détection (≈ 10 Mo) est téléchargé une seule fois puis gardé en cache.
