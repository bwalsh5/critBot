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

## Opening it on a phone, temporarily

The address `localhost:3000` only works on the computer running the app. For a
quick test on a phone — a single class, with your laptop open — you can create a
temporary web link that points at it. For something that stays up without your
laptop, skip ahead to the next section instead.

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

## Putting it on a permanent web address

This puts Crit-Bot on a real web address that works whether or not your laptop
is on, protected by one passcode you give the class. Students add it to their
home screen and it opens like an app.

It takes about 20 minutes once. After that, every change you push to GitHub
redeploys itself.

### What this costs

Two separate bills:

- **Anthropic**, for the critiques themselves — a few cents each, the same as
  running it locally. This is the one that adds up with a class using it.
- **Fly.io**, for the server — roughly **$0–3 a month**. The server sleeps when
  nobody is using it and wakes on the next visit, so you pay for actual use.
  Storage for the usage log is about 15 cents a month.

Fly asks for a card. Set a spending limit under **Billing** if you want a hard
ceiling.

### Step A — Make a Fly.io account

1. Go to [fly.io](https://fly.io) and sign up.
2. Add a card under **Billing**.

Then install their command-line tool. In a terminal:

```
brew install flyctl
```

If that says `command not found: brew`, use this instead:

```
curl -L https://fly.io/install.sh | sh
```

Log in:

```
fly auth login
```

A browser window opens. Approve it and come back to the terminal.

### Step B — Create the app

Make sure you are in the Crit-Bot folder (step 3 above), then pick a name. It
has to be unique across all of Fly, so put something of your own in it:

```
fly apps create critbot-yourname
```

Open `fly.toml` in that folder and change the first setting to match the name
you just chose:

```
app = "critbot-yourname"
```

While you are in there, `primary_region = "ord"` is Chicago. Change it to the
airport code nearest you if you like — `fly platform regions` lists them.

### Step C — Make somewhere for the usage log to live

The server is rebuilt from scratch on every deploy, so anything written to it is
erased. This creates a small disk that survives:

```
fly volumes create critbot_data --size 1
```

It asks you to confirm; say yes.

### Step D — Set the key and the passcode

```
fly secrets set ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
fly secrets set APP_PASSCODE=pick-something-here
```

The passcode is what you read out to the class. Anything you can say aloud and
they can type on a phone works — `studio-fall-26` is the right shape. Anyone
without it gets a login screen and nothing else.

These are stored by Fly, not in the project folder, and never appear on GitHub.

### Step E — Deploy

```
fly deploy
```

The first one takes a few minutes. When it finishes:

```
fly open
```

Your browser opens the live app at `https://critbot-yourname.fly.dev`. You
should see the passcode screen.

### Step F — Put it on a phone's home screen

Send the address to whoever needs it, along with the passcode. On each phone:

**iPhone** — open the address in **Safari** (this does not work in Chrome), tap
the **Share** button, scroll down, tap **Add to Home Screen**.

**Android** — open it in Chrome, tap the **⋮** menu, tap **Add to Home screen**.

It now has its own icon and opens without any browser chrome around it.

One quirk: on iPhone, the home-screen version keeps its own separate login. The
first time you open it from the icon, expect to type the passcode once more.
After that it stays signed in for 30 days.

### Step G — Make it redeploy when you push

Give GitHub permission to deploy for you:

```
fly tokens create deploy -x 8760h
```

It prints a long line starting with `FlyV1`. Copy the whole thing, including
`FlyV1`.

Then, in a browser:

1. Go to your repository → **Settings** → **Secrets and variables** →
   **Actions**.
2. Click **New repository secret**.
3. Name it exactly `FLY_API_TOKEN`, paste the token into the value box, and
   click **Add secret**.

That is it. From now on, every push to `main` rebuilds and redeploys the live
app automatically. You can watch it happen under the **Actions** tab of your
repository. If a deploy fails, the previous version keeps running.

---

## Running the deployed app

**Change the passcode** (do this if it leaks, or between terms):

```
fly secrets set APP_PASSCODE=a-new-one
```

The server restarts and everyone is signed out and asked for the new one.

**See what it is doing:**

```
fly logs
```

**Get the usage data out.** The history panel in the app has export buttons, or
from a terminal:

```
fly ssh console -C "cat /data/usage.jsonl" > usage.jsonl
```

**Note what the server keeps.** The deployed version records one line per run —
timestamp, image dimensions, which principles were chosen, token counts and
cost. It deliberately does **not** keep the submitted artwork or the critique
text, so student work does not pile up on a server. A local run still keeps
both, in the `logs` folder.

**Stop it costing anything:**

```
fly apps destroy critbot-yourname
```

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
