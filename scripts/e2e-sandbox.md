# Seller Shield - live judge walkthrough (E2E record)

- Date: 2026-11-10 (05:44-07:00 UTC)
- URL: https://seller-shield-id5n.onrender.com (Render free plan, auto-deploys `main`)
- Started on commit `94ed45c`; ended on `47041f2` plus this record (fix commits below were pushed to `build/seller-shield` and `main` during the run, and each step after a fix was re-run on the redeployed app)
- Browser: Playwright (Chrome) at 1280 px and 375 px for every app page; screenshots in `D:\Hackathons\Paypal\.playwright-mcp\e2e\` (outside the repo)
- Sandbox only. The buyer password and API keys are not written here.

## Summary

| Step | Result | Notes |
|---|---|---|
| 1. `/demo` loads | PASS | Buyer box, AI calls left, Reset all present; no horizontal scroll at 375 px |
| 2. Human purchase | PASS | Order `11547695GX409301J` ($118 moonstone ring) COMPLETED; on dashboard as Storefront / At risk (no tracking) |
| 3. Agent purchase | PASS after fix | Order `54K83914XS861230F` captured, Agent + verified, `custom_id ... (matches)`. AI path failed after ~20 calls/day until fix `5acb038` |
| 3b. Run without AI | PASS | Fresh mandate, approve buttons rendered in 1.1 s, not approved |
| 4. Prevent | PASS | Push tracking (200, 7.5 s) removed the gap; Mark delivered (Simulated) turned the order Protected |
| 5. Simulated dispute | PASS | Built with AI in 4.4 s, chips, PDF, confirm modal, simulated submit, resolved on `/demo` |
| 6. Real sandbox dispute | PASS after fix | `PP-R-EPP-10197892`: fetched by ID, 3 webhooks received, case built with Toolkit + AI in 25 s, submitted as supporting info (PayPal 200, `SUBMITTED_BY_SELLER` with `evidence.pdf`). Fix `3c59167` |
| 7. Reset | PASS | 3.6 s; agent order removed, real-dispute order kept, 6 baseline orders restored, 114 s cooldown shown |
| 8. Sweep | PASS | 28 routes x 2 widths: no raw errors, `undefined`, `NaN`, `[object Object]`, dev overlay or overflow; no console errors from the app |

## Step details

### 1. `/demo` - PASS
- Loads in ~2.4 s (warm). Sandbox test buyer box shows the email and password (fake money). "AI calls left today: 300 of 300" and the header pill both shown. Reset button present.
- Screenshots: `01-demo-desktop.png`, `01-demo-mobile.png`.

### 2. Human purchase - PASS
- `/product/moonstone-ring` -> PayPal button -> popup (6.2 s to the login page) -> sandbox buyer login (13.9 s to the review page) -> Complete Purchase -> `/order/11547695GX409301J` "Status COMPLETED" (8.8 s).
- Dashboard row: Storefront, At risk "No tracking yet", Evidence 50%, fix button "Add tracking". Webhooks `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` were recorded in `webhook_events`.
- Screenshots: `02-store-*.png`, `02-product-*.png`, `02-paypal-review.png`, `02-order-confirmed-*.png`, `02-dashboard-*.png`.
- Note: a full-page screenshot right after load can catch the PayPal iframe before it paints (blank area); the buttons render (`02-product-mobile-buttons.png`).

### 3. Agent purchase - PASS after fix
- `/wallet`: email prefilled with the sandbox buyer; signed "Silver hoop earrings ($60.00)", max $60, 24 h (3.2 s). "Give this to my AI assistant" -> `/agent`.
- "Please buy the silver hoop earrings for me" -> Gemini tool loop -> "Order ready: $60.00 ... Approve the payment in PayPal" with PayPal buttons. Approve popup 8.3 s, pay + capture 11.1 s -> `/order/54K83914XS861230F` COMPLETED.
- Dashboard: `Agent` + `verified`. Order page evidence: agent identity (signature verified: true), purchase mandate with `PayPal order custom_id = 2a7df694... (matches)`, payer approval "PayPal payer email matched the mandate shopper email", Purchase mandate panel.
- **Bug found:** the next three AI requests (fresh mandates) returned "The AI assistant is unavailable right now" in ~0.5 s while the app showed ~280 AI calls left. Root cause: Gemini free tier = 20 requests/day **per model** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, retry in ~2 h, i.e. midnight Pacific), and both tiers are pinned to `gemini-3.5-flash` in `render.yaml`. Every AI feature (shopper agent, gap explanations, case writer, toolkit gather) silently fell back. Fixed in `5acb038` (model fallback on 429/404 to `GEMINI_MODEL_FALLBACKS`, else newest stable flash-lite). After deploy: same request answered with a checkout in **9.3 s** on `gemini-3.5-flash-lite`.
- Run without AI (fresh mandate): response in 1.1 s, "Order ready: $60.00", PayPal buttons shown; not approved.
- Screenshots: `03-wallet-*.png`, `03-agent-*.png`, `03-agent-stuck.png` (the failure), `03-agent-after-fix-desktop.png`, `03-run-without-ai-*.png`.

### 4. Prevent - PASS
- `39B31452152166143` (tracking_not_pushed baseline): "Push tracking to PayPal" -> POST 200 in 7.5 s, "Tracking is now on PayPal."; after reload the "Tracking not on PayPal" gap was gone (badge stays Pending until delivery). The "Updating..." label stayed for 60 s on this one run, which overlapped the Render deploy of `5acb038`; the same refresh pattern later cleared in 2-8 s (Add tracking, Mark delivered), so it is recorded as deploy-related, not a code bug.
- "Mark delivered (Simulated)" on the same order: 0.35 s POST, page refreshed in 2.6 s, badge -> **Protected** "(delivery Simulated)".
- Screenshots: `04-prevent-*.png`.

### 5. Simulated dispute - PASS
- `/demo` -> order `54K83914` (agent order), reason "Unauthorized payment" -> `SIM-6B4D23AC` (CHARGEBACK, waiting for seller) in 3.5 s.
- Inbox shows it with Simulated tag. Build case: **4.4 s, AI** (`cases.used_fallback = false`). Recommendation Fight, 71%, expected $38.25. Timeline and argument entries carry citation chips (mandate, agent identity, payer approval, ship-to address); hover shows the cited record.
- PDF preview iframe renders 3 pages with the "SIMULATED DISPUTE" banner; `Open PDF` -> `application/pdf`, 4.2 KB.
- Submit evidence -> confirm modal lists evidence type, the PDF and the notes -> "Yes, submit evidence" -> `{submitted: true, simulated: true}` in 4.7 s.
- `/demo` Resolve in seller's favour -> `RESOLVED_SELLER_FAVOUR` (7.6 s incl. reload); case page shows Resolved and actions disabled.
- Bugs found (fixed in `720c821`): clicking a citation chip closed the tooltip that hover/focus had just opened (so tap on mobile showed nothing); a simulated case said "Evidence submitted ... PayPal will review it" directly under "nothing was sent to PayPal"; the case summary wrote "paypal payer approval".
- Screenshots: `05-*.png`.

### 8. Sweep - PASS
- 28 routes (storefront, 5 products, order page, wallet, agent, dashboard, every order and dispute page, inbox, demo, and unknown ids) at 1280 and 375 px: no `undefined`, `NaN`, `null`, `[object Object]`, `Invalid Date`, stack trace or Next.js dev overlay; `scrollWidth` never exceeded the viewport. Unknown dashboard ids show "We could not find that record". The only console errors were 404s for the deliberate unknown routes and PayPal's own pages (CSP-blocked trackers on sandbox.paypal.com).
- Every Simulated item seen carried the Simulated tag (demo carrier tracking, deliveries, simulated disputes, PDF banner).

### 6. Real sandbox dispute - PASS after fix (`3c59167`)
- Buyer side (headed Chrome, Playwright): sandbox sign-in -> Resolution Center -> the $118.00 "Test Store" transaction -> Report a Problem -> "I haven't received the item or service" -> **new step: "Describe your issue in detail"** (AI-assisted, required text; not in the spike note) -> item checkbox + Physical product + Jewelry + qty 1 -> "The item hasn't reached me or I refused delivery" -> expected refund 118.00 (the field's label covers the input; focus + type works) -> contacted seller: No -> documents/notes -> review -> Submit at 06:17:09Z. Result: **Case ID `PP-R-EPP-10197892`**, buyer transaction `1EB52212AR1513842`, seller capture `7PD41798KX5450119`. About 4 minutes of clicks.
- PayPal lifecycle observed (GET `/v1/customer/disputes/{id}`): 06:17:43 status OPEN, stage INQUIRY -> 06:18:03 UNDER_REVIEW / UNDER_PAYPAL_REVIEW, links `self` only -> **06:20:32 stage CHARGEBACK, UNDER_PAYPAL_REVIEW, links `self, provide_supporting_info`** (stable for the next 13 minutes). No WAITING_FOR_SELLER_RESPONSE state and no `provide_evidence` link, unlike the 2026-11-09 spike.
- `/demo` "Fetch dispute by ID" (06:18-06:19): 200 in 4.9 s, `created: true`, linked to order `11547695GX409301J`, "Open the case" link. "Refresh status from PayPal" later: "under review, chargeback stage".
- Webhooks (Neon `webhook_events`): `CUSTOMER.DISPUTE.CREATED` 06:20:35 (3 m 26 s after filing), `CUSTOMER.DISPUTE.UPDATED` 06:21:05 (escalation), `CUSTOMER.DISPUTE.UPDATED` 06:33:35 (after our submission).
- Before building, tracking was added from the order page as Maya would (UPS `1Z999AA10123456784`, "Add & push to PayPal": 1.2 s, real `/v2/checkout/orders/{id}/track`).
- Build case (real path): **25 s**, Agent Toolkit gather returned PayPal-side `dispute`, `order`, `capture`, `tracking`, `buyer_message` items (11 evidence items in total); case writer **AI** (`used_fallback = false`); Fight, 62%, expected $67.02; 2 timeline + 1 argument entries, all cited.
- **Bug found:** Submit evidence always called `provide-evidence`, which PayPal does not allow in this state, so the key path would fail for every judge who files a dispute today. Fix `3c59167`: submit reads the dispute's links and sends `provide-supporting-info` (same notes and PDF) when that is what PayPal allows, `provide-evidence` when allowed, or refuses with nothing sent; the confirm modal states which one goes out.
- Submit through the UI confirm modal (after the deploy, 06:33Z): response `{"submitted": true, "paypalStatus": "UNDER_REVIEW"}` in 8.7 s. PayPal now shows `supporting_info[0]`: source `SUBMITTED_BY_SELLER`, documents `["evidence.pdf"]`, notes = the case notes, provided 06:33:14Z. Dispute status after: UNDER_REVIEW / UNDER_PAYPAL_REVIEW, stage CHARGEBACK. The claim was **not** accepted.
- Screenshots: `06-rc-*.png` (buyer flow; `06-rc-12-submitted.png` shows the case ID), `06-fetch-dispute-desktop.png`, `06-refresh-status-desktop.png`, `06-add-tracking-desktop.png`, `06-real-case-*.png`, `06-real-submit-modal-*.png`, `06-real-submitted-desktop.png`.

### 7. Reset - PASS
- Reset on `/demo`: 3.6 s, `{deleted: {orders: 1, disputes: 2}, seeded: 6}`. Agent order `54K83914XS861230F` and its simulated dispute gone; order `11547695GX409301J` kept with its real dispute; the 6 baseline orders back in their scenarios (39B "Tracking not on PayPal", 14V "Ship-to address differs", 0CB awaiting delivery, 0FR with a fresh simulated INR dispute `SIM-9E783713`). Button shows "Reset demo (available in 114s)" and is disabled.
- After reset, "Push tracking to PayPal" on 39B: 200 in 1.3 s, refresh done in 2.4 s (confirms the step-4 "Updating..." stall was the deploy restart).
- The reset API returns a warning for 39B ("PayPal already holds tracking ... cannot demonstrate tracking not pushed"); the scenario still works because reset gives it a fresh number. Not shown in the UI.
- Screenshots: `07-reset-*.png`, `07-push-after-reset-desktop.png`.

## Timings (warm instance)

| Action | Time |
|---|---|
| Page loads (storefront, demo, dashboard) | 1.8-2.4 s |
| Order / case pages incl. client data | ~4 s |
| PayPal popup to login page / login to review / pay to order page | 6.2 s / 13.9 s / 8.8 s |
| Shopper agent (AI, fallback model) | 9.3 s |
| Run without AI | 1.1 s |
| Simulated dispute: create / build (AI) / submit | 3.5 s / 4.4 s / 4.7 s |
| Real dispute: fetch by ID / build (Toolkit + AI) / submit | 4.9 s / 25 s / 8.7 s |
| Reset | 3.6 s |

## AI outcomes

| Feature | Outcome |
|---|---|
| Shopper agent, first request | AI (gemini-3.5-flash) |
| Shopper agent, next 3 requests | **Template fallback** ("AI unavailable"): Gemini 429 daily quota |
| Shopper agent after `5acb038` | AI (gemini-3.5-flash-lite), 9.3 s |
| Gap explanations | AI when quota allowed; "AI unavailable - showing standard text" once during the quota outage |
| Case writer, simulated unauthorized dispute | AI (`used_fallback = false`) |
| Case writer + Toolkit gather, real INR dispute | AI (`used_fallback = false`); Toolkit items present |

## Bugs found and fixed

| Commit | Fix |
|---|---|
| `5acb038` | Gemini free tier is 20 requests/day per model and both tiers were pinned to one model, so all AI silently fell back after ~20 calls while the UI showed ~280 left. A model refused with 429/404 is now skipped until Gemini's retry time and the call moves to `GEMINI_MODEL_FALLBACKS` (default: newest stable flash-lite). Shopper agent and Toolkit gather retry once on the fallback before any tool ran. |
| `720c821` | Citation chip click/tap closed its own tooltip; simulated case said "PayPal will review it"; "paypal payer approval" casing; `/demo` results link to the case page; agent orders marked in the dispute picker; step 2 said "fund" instead of "sign". |
| `3c59167` | Real disputes under PayPal review only allow `provide_supporting_info`; submit now picks the allowed action from the dispute links (supporting info, evidence, or a clear refusal with nothing sent); modal says which. `/demo` buyer steps updated for PayPal's new "describe the problem" step. |
| `6a44fbd` | Evidence summary printed the enum ("status label"); now "label created" / "in transit". |
| `47041f2` | A 503 "overloaded" from a Gemini model now moves to the next fallback model (blocked ~30 s) instead of failing the call; Accept claim is disabled with a reason while PayPal reviews a real dispute (and refused server-side without an accept-claim link); the case page reads the dispute fresh from PayPal to pick the submit route. |

Every fix: `npm test` (416 tests), `npx tsc --noEmit`, `npm run lint`, `npm run build` passed before the push to `build/seller-shield` and `main`.

## Known limitations a judge might hit

- **Gemini free tier.** About 20 requests per day per model (resets at midnight Pacific). With the fallback chain (gemini-3.5-flash-lite, then gemini-3.1-flash-lite, which answered 503 overloaded when probed) the app gets roughly two to three times that; a busy judging day can still exhaust them, after which every AI feature shows its labelled standard text. The real fix is billing on the Gemini key (Tier 1), no code change needed. The header's "AI calls left" counts the app's own cap, not Google's quota.
- **Real disputes go to PayPal review fast.** In the sandbox today a new item-not-received case reached CHARGEBACK / UNDER_PAYPAL_REVIEW within about 3 minutes; the seller can then only add supporting information, and "Accept claim" / "Make offer" are not allowed by PayPal (Accept is still clickable in the UI; not tried, since the claim must stay open, but PayPal lists no accept_claim link, so expect its refusal message). Real disputes are never resolved by the demo.
- **Buyer UI drift.** PayPal's Resolution Center added a required "Describe your issue in detail" step on 2026-11-10; `/demo` now lists it. The refund amount field needs a click on its label area.
- **PayPal list lag.** The dispute list and the `CUSTOMER.DISPUTE.CREATED` webhook arrive ~3.5 minutes after filing; Fetch by ID works within a minute.
- **Simulated delivery.** "Mark delivered" is simulated (tagged); a real carrier delivery is not available in the sandbox.
- **Mobile orders grid.** At 375 px the AG Grid scrolls sideways inside its card; the protection column is off-screen until scrolled (the page itself does not overflow).
- **Render free plan.** A cold start after idle takes longer, and a deploy restart can leave a client "Updating..." label until the page is reloaded.
- **Unknown record URLs** return HTTP 200 with a friendly "We could not find that record" page rather than a 404 status.

## Screenshots

All in `D:\Hackathons\Paypal\.playwright-mcp\e2e\`:
`01-demo-{desktop,mobile}`, `02-store-*`, `02-product-*`, `02-paypal-review`, `02-order-confirmed-*`, `02-dashboard-*`, `03-wallet-*`, `03-agent-*`, `03-agent-stuck`, `03-agent-after-fix-desktop`, `03-run-without-ai-*`, `04-prevent-*`, `05-inbox-*`, `05-case-*`, `05-citation-*`, `05-pdf-preview`, `05-submit-modal-desktop`, `05-submitted-desktop`, `05-resolved-*`, `06-rc-1` ... `06-rc-12-submitted`, `06-fetch-dispute-desktop`, `06-refresh-status-desktop`, `06-add-tracking-desktop`, `06-real-case-*`, `06-real-submit-modal-*`, `06-real-submitted-desktop`, `07-reset-*`, `07-push-after-reset-desktop`, `08-chip-click-fixed-desktop`, `08-chip-tap-fixed-mobile` (all `.png`).

## Data left in the sandbox

- Orders `11547695GX409301J` (disputed, kept by reset) and `54K83914XS861230F` (captured, removed locally by reset). Approved-but-uncaptured agent orders from the timing runs were never approved and expire on PayPal's side.
- Dispute `PP-R-EPP-10197892` open, under PayPal review, with Seller Shield's supporting info. Do not accept it: it is the live example of a real dispute for judges.

