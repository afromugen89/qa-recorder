# qa-recorder

A recording browser for QA. Open a site, test it by hand, and qa-recorder captures everything needed for a bug report and a Playwright test:

- **User actions:** clicks, typing, selects, radios, checkboxes, key presses and file uploads. This includes elements inside open and closed shadow DOM and inside same-origin and cross-origin iframes.
- **API calls:** method, URL, status code, response time, time to first byte, and request body. Failed calls (4xx, 5xx, network errors) also keep the response body. Calls slower than a threshold are flagged.
- **Errors:** console errors and warnings, plus uncaught JavaScript exceptions.
- **Evidence:** a screenshot after each action and a full HAR file.

Each API call is linked to the user action that triggered it, so a report can say "Clicking *Save* sent `POST /api/orders`, which returned 500 in 1.2 s".

## Setup

```bash
npm install
npm run setup     # downloads Playwright's Chromium
```

## Recording

```bash
npm run record -- https://your-app.example.com
```

A Chromium window opens. Test as normal. The terminal shows each action live, with failed and slow API calls and console errors highlighted. To finish, close the window or press Ctrl+C.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `-o, --out <dir>` | `recordings` | Where sessions are saved |
| `--slow <ms>` | `1000` | Flag API calls slower than this |
| `--no-screenshots` | | Skip the screenshot after each action |
| `--keep-secrets` | | Record password and card values instead of masking them |
| `--no-warnings` | | Log console errors only |
| `--include-documents` | | Also log full page loads, not just XHR and fetch |
| `--headless` | | No window (for CI) |
| `--executable <path>` | | Use a specific Chrome or Chromium binary |
| `--no-panel` | | Hide the test data panel |
| `--profiles <file>` | `.qa-recorder/profiles.json` | Where data profiles are saved |
| `--seed <n>` | random | Faker seed, to reproduce generated data |

## Test data panel

While recording, press **Alt+Shift+D** or click **Test data** at the bottom right of the page. Click into any field on the page (including fields in iframes and shadow DOM), then choose what goes in it. The panel is hidden from screenshots, isn't recorded, and Playwright locators can't see it.

| Tab | What it does | ISTQB technique tagged |
| --- | --- | --- |
| **Faker** | Pick a data type (name, email, phone, address, company, price, number range, dates, card numbers, regex pattern, template, or any Faker method) and a locale, then fill the field or preview 5 values. | Random testing |
| **Boundaries** | Reads the field's `maxlength`, `minlength`, `min`, `max` and `type` and suggests cases. You can also enter your own number, text-length or date range, choose 2-value or 3-value BVA, and add equivalence partitions. Each case is labelled valid or invalid. | Boundary value analysis, equivalence partitioning |
| **Edge cases** | Empty, spaces, special characters, Unicode, emoji, RTL text, HTML/script, SQL quotes and injection, very long input, number overflow. | Error guessing |
| **Profiles** | Save "which generator goes in which field" for a form, then fill the whole form with fresh data in one click. Saved to `.qa-recorder/profiles.json`, which you can commit and share. | Random testing |
| **Looper** | Start capturing, do a flow once (for example fill the form and click Add), then finish. For each field, choose to keep the recorded value or generate a new one (any Faker type, or a template like `Item {i}`). Then run it N times. API calls and errors from every iteration are captured. | Random testing |

Typing past `maxlength` is cut off the way a real user would see it. Tick **Ignore maxlength** to send the full value and test the server's validation instead.

Every value the panel puts on the page is tagged on the recorded action, so the bug report can say exactly what was entered and why:

```json
{
  "action": "fill",
  "value": "abcdefghi1abcdefghi2a",
  "testData": {
    "source": "boundary",
    "technique": "boundary-value-analysis",
    "label": "max + 1 (21 chars)",
    "expected": "invalid"
  }
}
```

Generated data is seeded, and the seed is saved in `session.json`. Start with `--seed <n>` to get the same values again.

### Test data in the terminal

```bash
npx qa-recorder data types                                      # list data types
npx qa-recorder data fake email -n 10 --locale de
npx qa-recorder data fake template --template "{{person.firstName}}.qa+{i}@test.com" -n 5
npx qa-recorder data fake pattern --pattern "[A-Z]{3}-[0-9]{4}"
npx qa-recorder data bva --min 1 --max 99 --three --partitions
npx qa-recorder data length --min 2 --max 50 --charset email
npx qa-recorder data date --min 2026-01-01 --max 2026-12-31
npx qa-recorder data edge
```

## Output

Each session is saved in `recordings/<timestamp>/`:

```
session.json      ordered timeline of every event, plus a summary
network.har       full network log (open in Chrome DevTools or any HAR viewer)
screenshots/      one PNG after each action
```

`session.json` holds one timeline. Each event has a `type` of `action`, `network`, `console`, `pageerror`, `navigation` or `loop`. Actions carry a Playwright locator in two forms:

```json
{
  "type": "action",
  "action": "click",
  "locator": {
    "strategy": "role",
    "selector": "internal:role=button[name=\"Save\"s]",
    "code": "getByRole(\"button\", { name: \"Save\", exact: true })"
  },
  "framePath": ["#checkout-frame"],
  "element": { "tag": "button", "inShadowDom": true, "inClosedShadowDom": false }
}
```

Locators are chosen in this order: test id (`data-testid`, `data-test`, `data-qa`, `data-cy`), then role with accessible name, label, placeholder, `name` attribute, stable `id`, and finally a CSS path. When several elements match, `.nth()` is added. Elements in closed shadow roots are recorded for the bug report, but Playwright can't replay them, so they are flagged with `inClosedShadowDom`.

## Using it from code

```ts
import { startRecording } from 'qa-recorder';

const recorder = await startRecording({ url: 'https://example.com', slowThresholdMs: 800 });
// ...drive recorder.page, or let a person use the window...
const session = await recorder.stop();
console.log(session.summary);
```

## How it works

qa-recorder launches Chromium through Playwright and injects a small recorder script into every page and frame (`src/injected/recorder.js`). That script listens for user events in the capture phase and reads the real target through `composedPath()`, which reaches inside open shadow roots. It also wraps `attachShadow` so it can listen inside closed shadow roots. It sends each action to Node through a Playwright binding. Network, console and error events come straight from Playwright, so they don't depend on the page cooperating.

## Development

```bash
npm test          # runs the recorder against a demo app in headless Chromium
npm run typecheck
npm run build
```

## Roadmap

1. Recorder core ✓
2. Test data tools ✓
3. Bug report: HTML and Markdown with steps, screenshots, API failures, console errors and the ISTQB test technique used
4. Playwright test script export
