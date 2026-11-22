# Truck Work Diary

A work and rest counter for Australian heavy vehicle drivers, with paperwork tools: invoices, safe driving forms, notes and documents.

**This is a counting helper. It is not an NHVR approved Electronic Work Diary. You must still fill in your written work diary.**

## Put it on GitHub Pages

1. Make a new repository on GitHub (for example `Truck-Work-Diary`). It must be public for free GitHub Pages.
2. Upload everything in this folder to the repository root. Keep the `fonts`, `icons` and `templates` folders. The `.nojekyll` file must be there too (it may be hidden on your computer).
3. In the repository open **Settings → Pages**. Under **Build and deployment** choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then Save.
4. After a minute or two the app is at `https://YOUR-USERNAME.github.io/Truck-Work-Diary/`.

## Put it on your phone

Open the link, then:

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu → Install app (or Add to Home screen).

Open it from the home screen icon from then on. Open the **Paperwork** tab once while online so it can finish its offline download. After that everything works with no internet, including PDFs.

## Today screen

The app opens on **Today**. It shows one line in green, amber or red ("Drive until 2:00", "Rest until 6:00"), and one big button.

- **Start work / Start rest:** tap it when the truck is stopped. It records the time, then asks for the odometer and finds the place by GPS. You can also type the place, or save without it.
- **Coming up:** the next stop, when your long rest must start, and the hours you have left.
- **Needs attention:** days with no entry (confirm they were rest days), changes with no place, an odometer that goes backwards, and a reminder when you have not saved a backup for 7 days.
- **Alerts:** while the app is open it warns about 30 minutes before a limit, and tells you when a long rest is complete. It cannot alert you when the app is closed.

On the Diary tab, **Book view** shows the day as a work diary sheet, to copy into your written diary. Day details now have the daily check time, a fit for duty box and the two-up driver's name and licence number.

## Plan ahead

The **Plan** tab uses your diary to look forward.

- **Your usual shift:** the app takes the average start time and length from your last 4 weeks of recorded shifts (it needs at least 3). You can type your own numbers.
- **If you work every usual shift:** the next 14 days, one shift a day. A shift is made shorter or left out when it would break a limit, and the reason is shown.
- **Coming up:** work left in the 24-hour period, hours left before a 24-hour rest, long/night hours left, and the 14-day total.
- **Trips:** save your trips with the number of shifts each needs. The app shows the earliest day each trip can start.
- **Send availability:** a one-page report for 3 days, one week or two weeks. Send it by the phone's share menu, WhatsApp, text message, copy and paste, or PDF.

Each line of the report means "if I do no other work before that day". It is a forecast of the legal limits only. Keep the diary up to date or the plan will be wrong.

## Send diary pages

On the **Diary** tab, **Send pages** makes a PDF of your diary in the work diary sheet layout. Choose one day or a date range (up to 31 days). Each page is one day, with the work and rest line, the changes with place and odometer, and total work and rest. Add your name and licence number under **More** so they print on each page.

These pages are a copy for your employer. They do not replace the written work diary.

## Smart tips

When you add work for today or a later day (on the sheet, with Add shift, or with Start work), the app checks the rest just before it.

- **Popup:** when the rest is within 2 hours of your 7-hour rest, or within 6 hours of a 24-hour rest, and you still need that rest. You choose "Keep resting until ..." or "Start work anyway".
- **Warning popup:** when starting at that time would break a limit. It shows the earliest start that fits.
- **Quiet tip line:** a night rest break you are about to miss by a little, starting just before 6am when long/night hours are low, and 70 of 84 hours worked.

Tips never stop you from recording work. They do not show for past days. Turn them off under **More → Smart tips**.

## Paperwork

- **Invoices:** loads, odometer km, saved rates, fixed C/O amounts, miscellaneous items, CSV, Excel and PDF. Issued invoices are locked; use **Create revision** to change one. **+ From diary** builds a load from two diary changes that have a place and an odometer reading.
- **Forms:** the two-page Safe Driving Plan and Vehicle Daily Checklist. Save your name, licence and signature under **Form defaults** first. A signed form is read only; **Edit** makes a new revision.
- **Notes:** text, tags and a small table. A note can be hidden until revealed, or encrypted with a passphrase. A lost passphrase cannot be recovered.
- **Documents:** PDF, JPG, PNG or WebP, up to 8 MB each and 24 MB in total, with type, expiry date and pin.

The invoice and form PDFs are made by the original APS Logbook code, fonts and form template, bundled unchanged in `aps-core.js`, `fonts/WorkspaceSans-*.ttf` and `templates/`.

## Place lookup (GPS)

In **Work and rest changes**, tap **Choose place → Find places near me**. The first time, the phone asks to allow location.

- It needs internet. With no signal, type the name. Names you use are remembered.
- Names come from OpenStreetMap. Some rest areas are missing or have no name, so check the name against the sign.
- Your location is read only when you tap the button. It is sent to nominatim.openstreetmap.org and overpass-api.de to get the names. Nothing else leaves the phone.

## Your records

Everything is kept on the phone, in the browser that runs the app. Nothing is sent anywhere unless you turn on Google Drive sync.

- Use **More → Save a backup file** often. The file holds the diary, invoices, forms, notes and document files. Clearing browser data, or removing the app, deletes the records.
- The backup file is not encrypted. It contains bank details, your signature and your documents, so keep it somewhere safe.
- Use **More → Load a backup** to bring records back, or to move them to a new phone.
- The home screen app and the browser tab can keep separate records on iPhone. Pick one and stay with it.

## Google Drive sync (optional)

With this on, the app keeps your diary, invoices, forms, notes and documents in a **Truck Work Diary** folder in your own Google Drive. Sign in with the same Google account on another phone or computer and the same records appear there. It also keeps one backup copy a day (the newest 10).

You set this up once. It is free.

1. Go to <https://console.cloud.google.com> and sign in. Make a new project (any name).
2. Open **APIs & Services → Library**, find **Google Drive API** and press **Enable**.
3. Open **Google Auth Platform** (older screens call it **OAuth consent screen**). Choose **External**, enter an app name and your email, and save.
4. Under **Audience**, either add your own Google address as a **test user**, or press **Publish app**. Publishing saves you from signing in again every week. The app only asks for the "files this app created" permission (`drive.file`).
5. Open **Clients** (or **Credentials → Create credentials → OAuth client ID**). Choose **Web application**.
   - **Authorised JavaScript origins:** `https://YOUR-USERNAME.github.io`
   - **Authorised redirect URIs:** the full address of your app, with the slash at the end, for example `https://YOUR-USERNAME.github.io/Truck-Work-Diary/`. The app shows the exact address under **More → Google Drive sync**.
6. Copy the **Client ID** (it ends with `.apps.googleusercontent.com`).
7. In the app open **More → Google Drive sync**, paste the Client ID and press **Connect Google Drive**. Do the same on each device.

How it behaves:

- It syncs when you open the app and about 12 seconds after a change. **Sync now** does it straight away.
- Google's sign-in lasts about one hour. When the button at the top says **Drive: sign in**, tap it. It normally signs in again without asking anything.
- If the same record was changed on two devices, the newest change wins. A delete on one device removes it on the others.
- If Google shows a "Google hasn't verified this app" screen, choose **Advanced → Go to (your app)**. It is your own app.
- The files in Drive are not encrypted. Anyone who can open your Google Drive can read them. Encrypted notes stay encrypted.
- The Client ID is not a secret, but it only works from the addresses you entered in step 5.

## Updating the app

Upload the new files over the old ones and commit. On the phone, open the app, close it, and open it again.

## Later: App Store

The same files can be wrapped as an iPhone app with [Capacitor](https://capacitorjs.com) and Xcode. You need a Mac and a paid Apple Developer account. Before you submit:

- Add the location permission text (`NSLocationWhenInUseUsageDescription`) in Xcode.
- Write a privacy policy page.
- The public OpenStreetMap servers are for light use. For an app with many users, use a paid geocoding service or your own server.
- Do not describe the app as an Electronic Work Diary. Only NHVR approved systems can be used in place of the written diary.

## Files

- `index.html`, `app.css`, `app.js` – the diary app
- `engine.js` – the fatigue rules (National Driver Work Diary v1.4, Parts 3 and 4)
- `office.js` – paperwork screens
- `drive.js` – Google Drive sync
- `plan.js` – plan ahead and the availability report
- `coach.js` – smart tips
- `aps-core.js` – original APS Logbook invoice, form, PDF, Excel and encryption code, with pdf-lib
- `templates/` – the original safe driving form (PDF and page images)
- `fonts/` – Barlow (app), WorkspaceSans (PDFs; see `LICENSE-DejaVu.txt`)
- `service-worker.js`, `manifest.webmanifest`, `icons/` – install and offline support
