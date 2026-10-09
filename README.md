# Split Four Ways — Google Sheets backed

A shared expense splitter whose data lives in **your own Google Sheet**.
The frontend (`index.html`) is a static page you deploy to **Vercel or Render**.
It talks to the Sheet through a free **Google Apps Script** web app — so you
never run a server, and nothing gets lost.

```
  Browser (index.html on Vercel/Render)
        │  fetch()
        ▼
  Google Apps Script web app  ──►  your Google Sheet (People / Expenses / Settings)
```

Why Apps Script and not "frontend straight to Sheets"? A browser-only page can't
hold a Google credential safely — it would be visible to anyone who opens the
page. The Apps Script is a tiny gatekeeper that Google hosts for free and that
keeps the write access on its side.

---

## Part 1 — Create the Sheet + backend (10 min, once)

1. Go to <https://sheets.google.com> and create a **blank spreadsheet**. Name it
   e.g. *Split Four Ways*. You don't need to add any tabs — the script makes them.
2. In the Sheet: **Extensions → Apps Script**.
3. Delete the sample `function myFunction() {}`, then **paste the entire
   `Code.gs`** file from this folder. Click the **Save** icon.
4. Click **Deploy → New deployment**.
   - Click the gear next to "Select type" → choose **Web app**.
   - **Description:** anything (e.g. `v1`).
   - **Execute as:** **Me**.
   - **Who has access:** **Anyone**.
   - Click **Deploy**.
5. The first time, Google asks you to **Authorize access** → pick your account →
   "Advanced" → "Go to (project) (unsafe)" → **Allow**. (It's your own script
   touching your own Sheet; this screen is normal for personal scripts.)
6. Copy the **Web app URL** it shows. It ends in **`/exec`**. Keep it handy.

> Test it: paste `YOUR_EXEC_URL?action=load` into a browser tab. You should see
> JSON with Akshay, Praney, Vivek, Logesh. If you do, the backend works.

---

## Part 2 — Point the frontend at your Sheet

Open `index.html` and edit the two lines near the top of the `<script>`:

```js
var API_URL   = "https://script.google.com/macros/s/XXXXX/exec";  // your /exec URL
var API_TOKEN = "";                                               // leave "" for now
```

Save. That's the only change needed.

---

## Part 3 — Deploy the frontend

### Option A — Vercel (easiest)
1. Put this folder in a GitHub repo (or just the `index.html`).
2. Go to <https://vercel.com> → **Add New → Project** → import the repo.
3. Framework preset: **Other**. No build command, no output dir needed — it's a
   static file. Click **Deploy**.
4. You get a URL like `https://split-four-ways.vercel.app`. Share it with the
   other three.

*No GitHub?* Install the CLI (`npm i -g vercel`), run `vercel` inside this
folder, follow the prompts.

### Option B — Render
1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Static Site** → connect the repo.
3. **Build command:** leave blank. **Publish directory:** `.` (a single dot).
4. **Create Static Site** → you get a URL to share.

---

## How it works day to day

- Everyone opens the same deployed URL. Each expense they add writes a row to the
  **Expenses** tab; the page re-reads the Sheet every ~10 seconds so all four see
  updates within a few seconds.
- Each expense can have a **category**, a **date**, and **multiple items**
  (the total is the sum of the items). Use the **month filter** at the top of
  the Expenses list to see a month's spending and the **by-category** breakdown
  ("we spent ₹8k on food this month").
- Rename people, add a person, or change currency under **People & currency** —
  it all saves to the Sheet.
- **Tap any person's balance tile** to open their profile: how much they paid
  out, their share, their overall net, and a **person-by-person** breakdown —
  for each other person, who owes whom (mutual debts are netted / subtracted).
- **Settle up:** when someone pays a debt back, tap **Mark paid** on the
  settle-up row (or record it manually under **Payments & settle-ups**). The
  payment clears that much of the balance so old debts don't linger. Every
  payment is logged in the Settlements tab and can be deleted.

### Tabs the sheet keeps
`People`, `Expenses`, `Settings`, and `Settlements`. New columns
(category, date, items on Expenses) are added automatically — an older sheet
keeps working and just gains the new columns.

### Updating the backend
After pasting a new `Code.gs`, you must **Deploy → Manage deployments →
(edit the pencil) → Deploy** to publish it to the same `/exec` URL. Just
saving in the editor is not enough.
- You can open the Google Sheet directly any time to see or fix the raw data.
  Columns: `Expenses` = id, desc, amount, paidBy, splitAmong, createdAt;
  `People` = id, name, order.

## Optional — lock it down with a shared token

"Who has access: Anyone" means anyone with the `/exec` URL could read/write it.
For a friends' tracker that's usually fine. To add a light shared password:

1. In `Code.gs` set `var SHARED_TOKEN = "some-long-random-string";` → **Deploy →
   Manage deployments → edit → Deploy** again (redeploy the same web app).
2. In `index.html` set `var API_TOKEN = "some-long-random-string";` (the same
   value) → redeploy the frontend.

Now requests without the token are rejected. (This is obfuscation, not real
auth — the token still ships in the frontend — but it stops casual URL sharing.)

## Updating the backend later

If you change `Code.gs`, you must **Deploy → Manage deployments → (edit) →
Deploy** to publish the new version to the same `/exec` URL. Just saving isn't
enough.

## Troubleshooting

- **Page says "Couldn't reach the Google Sheet"** — the `API_URL` is wrong, or
  the web app wasn't deployed to **Anyone**. Re-check Part 1 steps 4–6.
- **Changes don't appear for others** — they will within ~10s; a hard refresh
  forces it. Make sure everyone uses the same deployed URL.
- **"unauthorized"** — token mismatch: `SHARED_TOKEN` (Code.gs) and `API_TOKEN`
  (index.html) must be identical, and you must redeploy both after changing them.
