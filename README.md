# Bloom — Writing & Grammar

A gentle, private, daily Writing & Grammar coach that lives on your iPhone home screen. No login, no accounts, no server — everything runs in the browser and your progress is saved on your device.

- A 40-question placement test (grammar/sentence errors, word choice, vocabulary, reading comprehension) that you can pause and resume across multiple sittings.
- A single **Grammar & Punctuation** module, unlocked at the level your placement test determined.
- Lessons sized to a duration you pick (2–60 minutes), with instant right/wrong feedback and an explanation after every question.
- A detailed results summary after every lesson, with the option to repeat it or move on.
- A full history of every lesson you've ever taken — every question, your answer, and the explanation — so you can go back and review anything.

It's a static site: plain HTML, CSS, and JavaScript, no build step, no dependencies.

## Run it locally

```
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a browser.

## Put it on your iPhone home screen

This repo deploys itself to **GitHub Pages** automatically via `.github/workflows/deploy-pages.yml` on every push to `main` — no manual setup needed. Once merged, the app is live at:

```
https://deepo333.github.io/braingym/
```

(Check the repo's **Actions** tab for the "Deploy to GitHub Pages" run, and **Settings → Pages** for the exact URL once it's live.)

1. Open that URL in **Safari** on your iPhone (it must be Safari — other browsers don't support this).
2. Tap the **Share** icon, then **Add to Home Screen**.
3. Open Bloom from your home screen — it launches full-screen, like a native app.

Your placement results, current level, and full lesson history are stored locally in that Safari installation (via `localStorage`), so they'll be there every time you open the app — nothing is uploaded anywhere.

## Project structure

```
index.html        App shell + iOS home-screen meta tags
manifest.json      Web app manifest (standalone display, icons)
sw.js              Minimal offline app-shell cache
css/styles.css     Design system (light + dark) and components
js/data.js         Placement test + Grammar & Punctuation question bank
js/app.js          App logic, screens, and localStorage persistence
icons/             App icons (generated, no external assets)
```
