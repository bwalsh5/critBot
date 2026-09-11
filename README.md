# Design Crit-Bot

Upload a design, pick the lenses you want applied, and get a streamed critique
back from Claude. Every run is logged locally with its token usage and cost so
you can analyse the results later.

## Setup

```bash
npm install
cp .env.example .env   # then paste in your Anthropic API key
npm start
```

The server listens on `http://localhost:3000` (override with `PORT`).

## Usage

Open the page, drop in an image (JPEG, PNG, GIF, or WebP), optionally narrow the
critique to specific design principles, and add a note if there is context the
image does not carry. The critique streams in as it is generated.

`npm run costs` prints a summary of what you have spent so far.

## Logged data

Each run writes to `logs/`:

- `logs/images/NNNN.<ext>` — the uploaded image
- `logs/critiques/NNNN.md` — the critique text
- `logs/usage.jsonl` — one JSON record per run (tokens, cost, timing, settings)

`logs/` is gitignored, so uploads and critiques stay on your machine.

Two export endpoints pull it back out:

- `GET /api/export.csv` — one flat row per run, with a 0/1 indicator column per
  design lens. Built to be read straight into R with `read.csv()`.
- `GET /api/export.zip` — the CSV plus every image and critique file.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/aspects` | The list of design lenses the UI offers |
| `POST /api/critique` | Runs a critique, streamed over SSE |
| `GET /api/runs` | Metadata for past runs |
| `GET /api/export.csv` | All runs as CSV |
| `GET /api/export.zip` | CSV plus images and critiques |

## Notes

- Uploads are capped at 12 MB, and the format is detected from the file's magic
  bytes rather than the browser-reported MIME type, which is derived from the
  file extension and often wrong.
- The model is `claude-opus-5`.
