# QA Recorder: specification

| | |
| --- | --- |
| Version | 0.1.0 (state of `main` after PR #6) |
| Last updated | 2026-11-04 |
| Owner | Kein (`afromugen89`) |
| Related | [README](../README.md) (reference), [User guide](USER_GUIDE.md) (how-to for testers) |

This document describes what QA Recorder does and what it is planned to do. Every requirement has a status:

- **Built** means it is on `main` and covered by the automated tests unless stated otherwise.
- **Partly built** means some of it is on `main`; the gap is described.
- **Not built** means it is planned but no code exists yet.

## 1. Purpose and users

QA Recorder is a standalone recording browser for manual QA testers. A tester opens a site, tests it by hand, and the tool captures everything needed to report a defect and, later, to automate the flow.

The goals, in priority order:

1. **Comprehensive bug reports** that name the ISTQB test technique used.
2. **API response time and status capture** for every call made while testing.
3. **Test data tools** so testers can apply boundary value analysis, equivalence partitioning and error guessing quickly.
4. **Replayable Playwright test scripts** generated from a recording (low priority, not built).

Primary users are QA testers. A secondary user is the automation engineer who runs the same checks headless in CI or calls the library from Playwright tests.

### Out of scope

- A browser extension. The tool controls its own browser instead, because that gives full access to network timing, console output and closed shadow roots.
- Browsers other than Chromium (Chrome can be used through `--executable`).
- Generating tests in the conventions of an existing private framework. Script export, when built, will use conventions designed for this tool.

## 2. Feature status at a glance

| Area | Status | Delivered in |
| --- | --- | --- |
| Recorder core: user actions, iframes, shadow DOM | Built | PR #1 |
| API call capture: status, response time, failures | Built | PR #1 |
| Console errors, warnings and uncaught exceptions | Built | PR #1 |
| Screenshots and HAR file | Built | PR #1 |
| QA tools in their own window | Built | PR #2, extended in #3, #4, #6 |
| Test data: Faker, boundaries, partitions, edge cases | Built | PR #2 |
| Data profiles | Built | PR #2 |
| Looper (repeat a flow with random data) | Built | PR #2 |
| Test data CLI | Built | PR #2 |
| Bug reports with ISTQB technique (HTML, Markdown, JSON) | Built | PR #3 |
| API response times per endpoint in reports | Built | PR #3 |
| API mocking (request and response editing) | Built | PR #4 |
| User guide | Built | PR #5 |
| Accessibility scan (axe-core, WCAG level) | Built | PR #6 |
| Responsive layout check and breakpoint BVA | Built | PR #6 |
| Record as a phone or tablet (`--device`) | Built | PR #6 |
| Headless `check` command for CI | Built | PR #6 |
| Library API (`startRecording`, `runA11yScan`, `runLayoutCheck`) | Built | PR #1, #6 |
| Playwright test script export | Not built | |
| Response-time assertions in generated tests | Not built | |
| In-browser Start / Stop / Export controls | Partly built | |
| Branded desktop app (Electron shell) and installer | Not built | |

## 3. Architecture

- **Runtime:** Node.js 20 or later, TypeScript, Playwright 1.63 driving Chromium. `@faker-js/faker` for generated data and `axe-core` for accessibility rules.
- **Browser control:** the recorder launches Chromium through Playwright with one browser context. Network, console, page error and navigation events come from Playwright, so they do not depend on the page cooperating.
- **Injected scripts** (added to every page and frame with `addInitScript`):
  - `src/injected/recorder.js` listens for user events in the capture phase, finds the real target through `composedPath()`, builds a locator, and sends the action to Node through a Playwright binding (`__qaRecord`).
  - `src/injected/panel.js` is the QA tools page. The recorder serves it at `http://qa-recorder.tools/` in a browser context of its own (no recorder script, mocks or HAR) and it talks to Node through `__qaPanel`. Commands act on the app tab the tester used last. Field focus arrives from the app through `__qaFocus`; Alt+Shift+D in the app calls `__qaShowTools`.
  - `src/injected/audit.js` runs the layout checks inside the page.
- **Services in Node:** `DataService` (test data, profiles, looper), `MockService` (API mocking), `AuditService` (accessibility and layout), and the report builder (`src/report`).
- **Storage:** one folder per session, plus shared team files under `.qa-recorder/` (profiles and mocks) that can be committed.

## 4. Functional requirements

### 4.1 Recording user actions

| ID | Requirement | Status |
| --- | --- | --- |
| REC-01 | Record clicks, double clicks, typing (`fill`), check and uncheck of checkboxes and radios, select options, key presses (Enter, Tab, Escape and shortcuts) and file uploads (file names only). | Built |
| REC-02 | Record actions on elements inside **open shadow DOM** by reading the event's `composedPath()`. | Built |
| REC-03 | Record actions inside **closed shadow DOM** by wrapping `attachShadow` before page scripts run. These actions are flagged `inClosedShadowDom`, because Playwright cannot replay them. | Built |
| REC-04 | Record actions inside **same-origin and cross-origin iframes**, with a `framePath` of frame selectors from the top page down. | Built |
| REC-05 | Give every action a Playwright locator, in both selector and readable `getBy…` form. Priority: test id (`data-testid`, `data-test`, `data-qa`, `data-cy`), role with accessible name, label, placeholder, `name` attribute, stable `id` (generated ids such as `ember123` or `:r1:` are skipped), then a CSS path. Add `.nth()` when several elements match. | Built |
| REC-06 | Record element details for the report: tag, type, id, name, role, accessible name and text. | Built |
| REC-07 | Mask values typed into password fields and card fields (`autocomplete="cc-*"`) as `********` unless `--keep-secrets` is set. | Built |
| REC-08 | Record navigations, and new tabs and popups, with a tab number (`pageId`) on every event. | Built |
| REC-09 | Take a screenshot after each action (can be turned off) without disturbing the page. The QA tools are in their own window, so these screenshots show only the app and nothing is hidden or restyled while they are taken. | Built |
| REC-10 | Never record clicks and typing in the QA tools, and add nothing to the app's page. | Built |
| REC-11 | Show each event live in the terminal, with failed calls, slow calls and errors highlighted. | Built |
| REC-12 | Record as a phone or tablet using a Playwright device name (`--device "iPhone 15 Pro"`), with its size, touch, pixel ratio and user agent. `qa-recorder devices` lists the names. | Built |

### 4.2 API calls and response times

| ID | Requirement | Status |
| --- | --- | --- |
| NET-01 | Log every XHR and fetch call with method, URL, status code and status text. Full page loads are added with `--include-documents`. | Built |
| NET-02 | Measure total response time (request start to last byte) and time to first byte for each call, plus response size. | Built |
| NET-03 | Keep the request body (up to 4,000 characters) for every call, and the response body (up to 10,000 characters) for failed calls. | Built |
| NET-04 | Mark a call as failed for 4xx and 5xx statuses and for network failures (with the failure reason). | Built |
| NET-05 | Mark a call as slow when it is over a threshold (default 1,000 ms, set with `--slow`). | Built |
| NET-06 | Link each call to the user action that most likely triggered it: the last action within 3 seconds before the request started (`triggeredBy`). | Built |
| NET-07 | Save a full HAR file of the session with embedded content. | Built |
| NET-08 | Summarise per endpoint (method plus URL with ids collapsed): number of calls, errors, average, p95 and maximum response time. Shown in bug reports. | Built |

### 4.3 Errors

| ID | Requirement | Status |
| --- | --- | --- |
| ERR-01 | Record console errors with their source location. | Built |
| ERR-02 | Record console warnings (can be turned off with `--no-warnings`). | Built |
| ERR-03 | Record uncaught JavaScript exceptions with their stack trace. | Built |
| ERR-04 | Link errors to the step that caused them in bug reports. | Built |

### 4.4 QA tools

| ID | Requirement | Status |
| --- | --- | --- |
| PNL-01 | The QA tools open in their own window when recording starts. **Alt+Shift+D** switches between the app and the QA tools, and reopens them if closed. `--no-panel` turns them off. | Built |
| PNL-02 | Tabs: Faker, Boundaries, Edge cases, Profiles, Looper, Mock, Accessibility, Responsive, Bug. | Built |
| PNL-03 | The QA tools act on the app tab the tester last used (shown as "Working on") and target the field last clicked into there, including fields in iframes and shadow DOM. | Built |
| PNL-04 | An orange line and the window title show a count while any API mock is on. | Built |

### 4.5 Test data

Every value the tool puts on the page is tagged on the recorded action (`testData`) with its source, ISTQB technique, label, the expected outcome (valid or invalid) and, where it applies, the generator so the value can be made again.

| ID | Requirement | Status |
| --- | --- | --- |
| DATA-01 | **Faker tab:** the tester picks the data type per field. 41 types in groups (person, internet, address, business, numbers, dates, finance, text), with options such as min, max, length and precision. Advanced types: a regex pattern, a template (for example `{{person.firstName}}.qa+{i}@test.com`), and any Faker method by path. Tagged as random testing. | Built |
| DATA-02 | Choose the Faker locale. Preview 5 values before filling. | Built |
| DATA-03 | **Boundaries tab:** read the focused field's `maxlength`, `minlength`, `min`, `max`, `step` and `type`, and suggest boundary cases. | Built |
| DATA-04 | Boundary value analysis for number ranges, text lengths and date ranges, in 2-value or 3-value mode, each case labelled valid or invalid. | Built |
| DATA-05 | Equivalence partitions for number and length ranges (valid middle, below, above, not a number, empty, decimal in a whole-number field, negative, too short, far too long). | Built |
| DATA-06 | Text of an exact length with a chosen character set (text, digits, email). | Built |
| DATA-07 | Typing past `maxlength` is cut off as a real user would see it, unless **Ignore maxlength** is ticked to test server-side validation. | Built |
| DATA-08 | **Edge cases tab** (error guessing): empty, spaces, special characters, Unicode, emoji, right-to-left text, HTML and script, SQL quotes and injection, very long input, number overflow. | Built |
| DATA-09 | **Profiles:** save which generator goes in which field of a form, then fill the whole form with new data in one click. Stored in `.qa-recorder/profiles.json` (`--profiles` to change), so it can be committed and shared. | Built |
| DATA-10 | Generated data is seeded. The seed is saved in `session.json`, and `--seed <n>` reproduces the same values. | Built |
| DATA-11 | Generate the same data in the terminal: `qa-recorder data types`, `fake`, `bva`, `length`, `date`, `edge`. | Built |

### 4.6 Looper

| ID | Requirement | Status |
| --- | --- | --- |
| LOOP-01 | Capture a flow once (for example fill a form and click Add) between Start and Finish. | Built |
| LOOP-02 | For each captured field, keep the recorded value or generate a new one with any Faker type or a template such as `Item {i}`. | Built |
| LOOP-03 | Replay the flow N times (1 to 1,000), with an optional pause between iterations and an optional reload of the start page before each one. | Built |
| LOOP-04 | Record each iteration's actions, API calls and errors, tagged with run and iteration numbers. Report pass or fail per iteration and allow stopping a run. | Built |
| LOOP-05 | A looper run is folded into one step in bug reports and tagged as use case testing. | Built |

### 4.7 Bug reports

| ID | Requirement | Status |
| --- | --- | --- |
| BUG-01 | Start a bug report from the **Bug** tab while recording, or afterwards with `qa-recorder report <session-folder>`. | Built |
| BUG-02 | Suggest a title from the most serious failure and the step that caused it, for example `GET /api/orders returns 500 after clicking "Save" button`. | Built |
| BUG-03 | Pre-fill the actual result with failed API calls and their responses, uncaught errors, console errors and slow calls. | Built |
| BUG-04 | **ISTQB technique:** detect the techniques from the test data used and say why (boundary value analysis, equivalence partitioning, error guessing, random testing, use case testing for the looper, checklist-based testing for accessibility and layout checks, boundary value analysis for breakpoint widths). If no generated data was used, the technique is exploratory testing. The tester can tick or untick any technique, including decision table and state transition testing. | Built |
| BUG-05 | Capture expected result, severity (critical, major, minor, trivial), priority (high, medium, low), reporter and notes. | Built |
| BUG-06 | Steps to reproduce in plain English, numbered, with the test data label, technique and expected valid or invalid for each generated value, and the frame or shadow DOM location. | Built |
| BUG-07 | Include the environment (URL, browser, user agent, viewport or device), failed calls with request and response bodies, slow calls, console and JavaScript errors linked to steps, API response times per endpoint, accessibility and layout results with annotated screenshots, and screenshots. The test data seed, the recording time and the full timeline are not in the report (they stay in `session.json`). | Built |
| BUG-08 | Warn in the report when API mocks were active and list which calls they changed. | Built |
| BUG-09 | A later bug in the same session can cover the whole session or only what happened since the previous bug. The CLI accepts `--from-seq` and `--to-seq`. | Built |
| BUG-10 | Write `report.html` (self-contained, screenshots embedded, printable), `report.md` (for GitHub or Azure DevOps), `jira.txt`, `attachments/` and `bug.json` to `recordings/<session>/bugs/<nn>-<title>/`. | Built |
| BUG-12 | Before creating a report, the tester picks which reproduction steps go in (remaining steps are renumbered; API calls and errors from a left-out step stay, under the step before it) and which screenshots go in (step, accessibility and layout screenshots, and the page screenshot taken on Create), with a preview of each. The CLI accepts `--skip-steps` and `--skip-screenshots`. | Built |
| BUG-13 | Failed API calls, slow API calls and API response times are optional sections. In the Bug tab the tester ticks which sections go in (failed and slow on, response times off by default) and can untick single calls or endpoints. The CLI accepts `--leave-out failed-calls,slow-calls,response-times`. | Built |
| BUG-14 | **Jira-ready:** each report also writes `jira.txt` (Jira wiki markup) and an `attachments/` folder with the kept screenshots under short names that the text refers to. `report.html` and the Bug tab have **Copy description for Jira** (puts rich text for Jira Cloud and wiki markup for Jira Server and Data Center on the clipboard) and **Copy summary**. | Built |
| BUG-15 | Screenshots in `report.html` open at their original size when clicked (or Enter); click or Esc closes them. | Built |
| BUG-11 | Send reports directly to Jira, GitHub Issues or Azure DevOps. | Not built |

### 4.8 API mocking

| ID | Requirement | Status |
| --- | --- | --- |
| MOCK-01 | Match calls by method (or any) and URL: plain text matches anywhere, `*` is a wildcard, `/regex/` is a regular expression. | Built |
| MOCK-02 | Edit the request before it is sent: set or remove headers, set or remove JSON fields by path (`items[0].price = -1`, `-coupon`), or replace the whole body. | Built |
| MOCK-03 | Change the real response: status, headers, JSON fields or the whole body. | Built |
| MOCK-04 | Return a response without calling the server (for endpoints that don't exist yet). | Built |
| MOCK-05 | Simulate network failures: failed, timed out, connection refused, offline. | Built |
| MOCK-06 | Delay any matched call by N ms. | Built |
| MOCK-07 | "Only once" rules that switch off after one use. | Built |
| MOCK-08 | **Mock this** on a recent call in the Mock tab to start a rule from it. | Built |
| MOCK-09 | Store rules in `.qa-recorder/mocks.json` (`--mocks` to change) so the team can share them. | Built |
| MOCK-10 | Label every mocked call in the terminal, in `session.json` (`mock.rule`, `mock.changes`) and in bug reports. | Built |

### 4.9 Accessibility checks

| ID | Requirement | Status |
| --- | --- | --- |
| A11Y-01 | Run axe-core against a chosen WCAG version (2.0, 2.1, 2.2) and level (A, AA, AAA), optionally with best-practice rules. Defaults: WCAG 2.2 AA. | Built |
| A11Y-02 | Scan the page as it is now, including same-origin and cross-origin iframes and open shadow DOM. | Built |
| A11Y-03 | List each failed rule with impact, WCAG success criterion, affected elements and a fix hint. **Show** scrolls to an element and outlines it. | Built |
| A11Y-04 | List rules axe-core can't decide under "needs a manual check". | Built |
| A11Y-05 | Save an annotated screenshot with numbered boxes on failing elements, and add the result to the timeline and the next bug report. | Built |

### 4.10 Responsive layout checks

| ID | Requirement | Status |
| --- | --- | --- |
| RESP-01 | Check the layout at device sizes: phones, tablets, laptop (1366 × 768), desktop (1920 × 1080), optional landscape and custom widths. Default set: iPhone SE (3rd gen), Pixel 7, iPad Mini and laptop. | Built |
| RESP-02 | Load each size in a separate hidden headless browser with real device emulation and the tab's cookies and local storage, so the recorded tab is not changed. | Built |
| RESP-03 | Report sideways scrolling and the elements causing it, overlapping tap targets, tap targets under 24 px (WCAG 2.5.8), text under 12 px, a missing viewport meta tag, and blocked pinch zoom (WCAG 1.4.4). Each issue is an error or a warning. | Built |
| RESP-04 | Save an annotated screenshot per size. | Built |
| RESP-05 | **Find breakpoints:** read the page's `@media` rules (fetching cross-origin stylesheets) and check the widths on both sides of each breakpoint, tagged as boundary value analysis. | Built |
| RESP-06 | **Resize this tab** to a device size for manual testing, recorded as a step, and restore it. | Built |

### 4.11 Command line

| ID | Requirement | Status |
| --- | --- | --- |
| CLI-01 | `qa-recorder record [url]` with options `--out`, `--slow`, `--no-screenshots`, `--keep-secrets`, `--no-warnings`, `--include-documents`, `--headless`, `--executable`, `--no-panel`, `--profiles`, `--mocks`, `--seed`, `--device`. Stop by closing the window or Ctrl+C. | Built |
| CLI-02 | `qa-recorder check <url>` runs the accessibility and layout checks with no window (`--wcag`, `--level`, `--best-practices`, `--sizes`, `--widths`, `--breakpoints`, `--no-a11y`, `--no-layout`, `--out`, `--device`), writes a bug report, and exits with code 1 on any accessibility violation or layout error. | Built |
| CLI-03 | `qa-recorder report <session-folder>` writes a bug report from a saved session (`--title`, `--expected`, `--actual`, `--notes`, `--severity`, `--priority`, `--technique`, `--reporter`, `--from-seq`, `--to-seq`, `--skip-steps`, `--skip-screenshots`). | Built |
| CLI-04 | `qa-recorder data …` generates test data (see DATA-11). | Built |
| CLI-05 | `qa-recorder devices` lists device names for `--device`. | Built |

### 4.12 Library API

| ID | Requirement | Status |
| --- | --- | --- |
| LIB-01 | `startRecording(options)` returns a recorder with the Playwright `page`, `stop()` (returns the session data) and `waitForClose()`. | Built |
| LIB-02 | `runA11yScan(page, options)` and `runLayoutCheck(page, request, options)` work on any Playwright page, for use in existing test suites. | Built |
| LIB-03 | Breakpoint helpers (`detectBreakpoints`, `parseBreakpoints`, `boundaryWidths`) and `VIEWPORT_PRESETS` are exported. | Built |

### 4.13 Playwright script export (planned, low priority)

| ID | Requirement | Status |
| --- | --- | --- |
| GEN-01 | Convert a session's actions into a Playwright test using the recorded locators and frame paths. | Not built |
| GEN-02 | Use a page object structure and fixtures designed for this tool. | Not built |
| GEN-03 | Turn generated test data back into generator calls, so the test makes fresh data on each run, and turn looper runs into data-driven tests. | Not built |
| GEN-04 | Optionally add response-time and status assertions for the captured API calls. | Not built |
| GEN-05 | Skip or comment steps in closed shadow DOM, which Playwright cannot replay. | Not built |

The data needed for this is already recorded: every action in `session.json` has a locator, frame path, value and test data generator.

### 4.14 Packaging and controls (planned)

| ID | Requirement | Status |
| --- | --- | --- |
| PKG-01 | Launch with one command (`npm run record -- <url>` or `npx qa-recorder record <url>`). | Built |
| PKG-02 | In-browser controls. Bug reports are started from the Bug tab; Start, Stop and Export buttons are not built (recording starts when the window opens and stops when it closes). | Partly built |
| PKG-03 | Publish to npm or ship an installer. | Not built |
| PKG-04 | Branded desktop app (Electron shell). | Not built |

## 5. Output format

Each session is saved in `recordings/<timestamp>/`:

| File | Contents |
| --- | --- |
| `session.json` | Version, metadata (start URL, times, browser, user agent, slow threshold, data seed, device, viewport), summary counts and the ordered timeline. |
| `network.har` | Full network log. |
| `screenshots/` | One PNG after each action, plus annotated check screenshots. |
| `bugs/<nn>-<title>/` | `report.html`, `report.md`, `bug.json` per bug. |

Timeline event types: `action`, `network`, `console`, `pageerror`, `navigation`, `loop`, `bug`, `a11y`, `layout`, `viewport`. Each event has a sequence number, timestamp, elapsed time and tab number. The full types are in `src/recorder/types.ts`.

Team files in `.qa-recorder/`: `profiles.json` and `mocks.json`.

## 6. Non-functional requirements

| ID | Requirement | Status |
| --- | --- | --- |
| NFR-01 | **Privacy:** passwords and card values are masked by default. | Built |
| NFR-02 | **Reproducibility:** generated data is seeded, and the seed is in `session.json` (not in the bug report, by request). | Built |
| NFR-03 | **Isolation:** the QA tools and layout checks do not change what is recorded; layout checks run in a separate browser. | Built |
| NFR-04 | **CI use:** headless recording and the `check` command with a non-zero exit code on failures. | Built |
| NFR-05 | **Trust in reports:** mocked calls are always labelled so no bug is filed against a mock. | Built |
| NFR-06 | **Tests:** `npm test` runs 82 tests across recorder, test data, panel, mocking, reports and audits against fixture pages in headless Chromium. `npm run typecheck` must pass. | Built |

## 7. Known limitations

- Actions inside closed shadow roots are recorded for the report but cannot be replayed by Playwright.
- Response bodies are kept only for failed calls, and bodies are truncated (request 4,000 and response 10,000 characters). The HAR file has the full content.
- The link between an API call and an action is a best guess: the last action within 3 seconds before the request.
- Chromium only.
- Accessibility results cover what axe-core can test automatically; items under "needs a manual check" still need a person.

## 8. Change history

| Date | PR | Change |
| --- | --- | --- |
| 2026-11-03 | #1 | Recorder core: actions, API calls, console errors |
| 2026-11-03 | #2 | Test data tools: Faker panel, boundaries, profiles, looper |
| 2026-11-04 | #3 | Bug reports with ISTQB technique, API failures and response times |
| 2026-11-04 | #4 | API mocking |
| 2026-11-04 | #5 | User guide |
| 2026-11-04 | #6 | Accessibility and responsive checks, `--device`, `check` command |
| 2026-11-04 | | This specification |
| 2026-11-05 | | QA tools move out of the page into their own window |
