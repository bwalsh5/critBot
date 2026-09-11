# Design Crit-Bot

Upload a design, choose which principles you want it judged on, and read a
written critique that appears a few seconds later. It runs on your own computer.

This guide assumes you have never opened a terminal before. Every step is
spelled out. The instructions are for a Mac; there are Windows notes at the end.

---

## What you need first

**About 15 minutes**, and an **Anthropic API key**. The key is what lets the app
send your design off to be critiqued. Getting one:

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up.
2. Add a small amount of credit under **Billing**. Each critique costs a few
   cents, and the credit is drawn down as you use it.
3. Go to **API keys** → **Create key**. Copy the key it shows you and paste it
   somewhere safe for a moment. It is only displayed once.

The key is a long line of text starting with `sk-ant-`. Treat it like a
password — anyone who has it can spend your credit.

---

## Step 1 — Install Node.js

Node.js is the engine the app runs on. No terminal needed for this part.

1. Go to [nodejs.org](https://nodejs.org).
2. Download the version labelled **LTS**.
3. Open the downloaded file and click through the installer, accepting the
   defaults.

---

## Step 2 — Download Crit-Bot

1. Go to [the project page](https://github.com/bwalsh5/critBot).
2. Click the green **Code** button, then **Download ZIP**.
3. Find the downloaded file (usually in your Downloads folder) and double-click
   it. That creates a folder called `critBot-main`.
4. Drag that folder somewhere you will remember, such as Documents.

---

## Step 3 — Open the terminal

The terminal is a window where you type instructions one line at a time and
press Enter after each. It looks unfriendly but you only need four commands.

1. Hold **Command** and press **Space**.
2. Type `Terminal` and press **Enter**.

A window opens with a line of text and a blinking cursor. That is normal.

Now tell it to look inside the Crit-Bot folder. Type this, **including the
space at the end**, but do not press Enter yet:

```
cd 
```

Then drag the `critBot-main` folder from Finder directly onto the terminal
window. It will fill in the location for you. Now press Enter.

Nothing visible happens. That is success — the terminal is now working inside
that folder.

---

## Step 4 — Install the parts it needs

Type this and press Enter:

```
npm install
```

This downloads the pieces the app depends on. It takes a minute or two and
prints a lot of text. Messages mentioning warnings are normal and can be
ignored. Wait until the blinking cursor comes back.

---

## Step 5 — Add your API key

Create the file that holds your key:

```
cp .env.example .env
```

Then open it:

```
open -e .env
```

TextEdit opens showing a couple of lines. Replace `sk-ant-...` with the key you
copied earlier, so the line reads something like:

```
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
```

Save with **Command-S** and close the window. This file stays on your computer.

---

## Step 6 — Start it

```
npm start
```

You should see:

```
🚀 Critique engine live on http://localhost:3000
```

Open a web browser and go to **http://localhost:3000**. Crit-Bot is now running.

**Leave the terminal window open.** The app only works while it is running. If
you close that window, the app stops.

---

## Using it

Drag an image onto the page, or use the camera button to take a photo. You can
crop and straighten it before submitting. Tick the design principles you want
covered, add a note if there is context the image does not show, and submit. The
critique writes itself out on screen as it is generated.

Supported image types are JPEG, PNG, GIF, and WebP, up to 12 MB. Photos taken on
a phone are converted automatically.

---

## Stopping and starting again

To stop the app, click the terminal window and press **Control-C**.

To start it again later, you do not need to repeat the whole setup. Open the
terminal, then just steps 3 and 6: `cd `, drag the folder in, press Enter, then
type `npm start`.

---

## Opening it on a phone

The address `localhost:3000` only works on the computer running the app. To use
Crit-Bot on a phone, you create a temporary web link that points at it.

1. Leave the app running in its terminal window.
2. Open a **second** terminal window with **Command-N**.
3. Type this and press Enter:

```
npx -y cloudflared tunnel --url http://localhost:3000
```

4. The first time, it downloads a small tool — say yes to anything it asks.
   After a few seconds it prints a box containing a web address ending in
   **trycloudflare.com**, like `https://random-words-here.trycloudflare.com`.
5. Open that address on your phone, or send it to whoever needs it. It works
   from anywhere, on any network.

Things worth knowing:

- The link only works while **both** terminal windows stay open. Close them and
  it stops.
- You get a **different link every time** you run the command.
- **Anyone with the link can use the app and spend your API credit.** Only share
  it with people you mean to, and press Control-C in the second window when you
  are finished.

If you would rather not use an outside service and everyone is on the same
Wi-Fi, you can instead find your computer's local address in **System Settings →
Network** and have people visit that address followed by `:3000`.

---

## If something goes wrong

**`command not found: npm`**
Node.js did not install, or the terminal was open before you installed it. Quit
the terminal completely (**Command-Q**), reopen it, and try step 3 again.

**`ANTHROPIC_API_KEY is missing`**
The key was not saved. Repeat step 5 and check you saved the file before closing
it.

**`EADDRINUSE` or `address already in use`**
The app is already running in another terminal window. Find that window and
press Control-C, or just use the one that is already going.

**`cd: no such file or directory`**
The folder location did not come through. Type `cd ` with a space again and drag
the folder onto the window rather than typing its name.

**The page will not load**
Check the terminal still shows the rocket line and has not stopped or shown an
error.

---

## Windows

The steps are the same, with three differences. Use **PowerShell** instead of
Terminal (press Start, type `PowerShell`). To move into the folder, type `cd `
and then paste the folder path from the File Explorer address bar. In step 5,
use these two commands instead:

```
copy .env.example .env
notepad .env
```
