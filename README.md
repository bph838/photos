# Family Photos

A private photo gallery for Windows that finds **people and pets** in your photos, lets you name them, and then search by name. Everything runs on the computer itself: no cloud, no accounts, and nothing leaves the house.

- **All photos**: a timeline grouped by month, with a filter by year
- **People / Pets**: look-alike faces are grouped automatically. Name a group once and every photo of that person gets the name. "Is this also Lily?" then finds more.
- **Search**: names, years and months, folder names, and descriptions such as `Lily beach`, `dogs 2019`, `birthday cake` or `Christmas`
- **Where is it?**: every photo shows its full file location, with a **Show in its folder** button
- **Print list**: collect photos, then copy them all to `Desktop\Photos to print\<date>` for the shop or a memory stick
- **Favourites**, HEIC (iPhone) support, and new photos picked up automatically

**The photos themselves are never changed, moved or deleted.** The app only reads them. Everything it creates is kept in `%LOCALAPPDATA%\FamilyPhotos`.

## Installing (on the family PC)

1. Copy this folder to the PC (USB stick, zip, or `git clone`).
2. Double-click **`install.bat`**. It needs the internet once, for about 5–10 minutes. It:
   - copies the app to `%LOCALAPPDATA%\Programs\FamilyPhotos` (no admin rights needed)
   - downloads a private copy of Node.js just for this app
   - downloads the AI models (about 350 MB), after which everything works offline
   - adds a **Family Photos** icon to the Desktop and Start menu, and can optionally start it quietly at login
3. The app opens. Click **Choose a photo folder...** and pick the photos folder.

The first pass over a large library runs in the background at low priority. On an i5-8500, expect roughly:
- thumbnails for 40,000 photos: under an hour, and the gallery is usable from the start
- finding faces and pets: a few hours. People groups appear as it goes, and progress shows bottom-left.

To **update**, copy the new version over and run `install.bat` again. Names and tags are kept.
To **remove**, run `uninstall.ps1` (right-click → Run with PowerShell). It asks before deleting names/tags.

## Developing

```sh
npm install
npm run setup-models   # one-off model download
npm start              # http://localhost:4321
```

Environment overrides: `FAMILY_PHOTOS_DATA` (data folder), `FAMILY_PHOTOS_PORT`, `FAMILY_PHOTOS_THREADS` (AI threads, default 3).

### How it works

| Part | What |
|---|---|
| `server/index.js` | Express server on `127.0.0.1` only. Serves the UI and API, opens Edge in app mode. |
| `server/indexer.js` | Separate below-normal-priority process: scan → thumbnails → AI. It watches folders for new photos. |
| `server/scanner.js` | Walks folders, reads EXIF dates. Missing files are flagged (not forgotten) so an unplugged drive doesn't lose tags. |
| `server/ai/faces.js` | InsightFace SCRFD detector + ArcFace (MobileFaceNet) recognition via ONNX Runtime, CPU |
| `server/ai/clip.js` | CLIP ViT-B/32 (description search, plus "is there an animal?" check) and DETR (dog/cat boxes) via transformers.js |
| `server/cluster.js` | Online clustering of face/pet embeddings. Naming a cluster names all of its faces. |
| `server/search.js` | Parses names, years, months and dog/cat, then ranks the rest by CLIP similarity and file/folder name |
| `server/db.js` | SQLite (Node's built-in `node:sqlite`, so nothing to compile): photos, faces, clusters, persons, print list |
| `public/` | Plain HTML/CSS/JS, no build step |

Model licences: the InsightFace `buffalo_s` models are for non-commercial use, which is fine for a family's personal photos. CLIP and DETR are MIT/Apache.

### Known limits / ideas for later
- Videos are not shown yet
- Telling pets apart is less reliable than faces (same-breed animals look alike), so confirm pet suggestions
- The timeline keeps adding to the page as you scroll. A virtualised grid would be smoother past ~10,000 photos.
- Possible extras: map view (GPS), slideshow, viewing from a phone or tablet on the home Wi-Fi, writing names into XMP sidecar files
