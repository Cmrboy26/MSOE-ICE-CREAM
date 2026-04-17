# MSOE Uptime Tracker

Community-powered uptime tracker with a Discord-style 90-day history bar. Originally built for the MSOE ice cream machine, extensible to any resource.

## Architecture

| Component | Service | Free-tier notes |
|-----------|---------|-----------------|
| Frontend | S3 static website hosting | 5 GB storage, 20 K GET/mo (12 months) |
| API | API Gateway HTTP API | 1 M requests/mo (12 months) |
| Compute | Lambda (Python 3.12) | 1 M invocations, 400 K GB-s/mo (always free) |
| Database | DynamoDB (provisioned 25 RCU / 25 WCU) | 25 GB storage (always free) || Scheduler | EventBridge (cron rule) | Always free |
All infrastructure is defined in Terraform. Total cost on free tier: **$0**.

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.0
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials (`aws configure`)
- An AWS account on the free tier

## Deploy

```bash
cd terraform

# First run
terraform init
terraform plan
terraform apply
```

Terraform will output:

| Output | Description |
|--------|-------------|
| `frontend_url` | Public URL of the website |
| `api_url` | API Gateway endpoint |
| `s3_bucket_name` | S3 bucket holding the frontend |

Open the `frontend_url` in your browser. The `config.js` file with the API URL is generated and uploaded automatically.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/resources` | List all tracked resources |
| `GET` | `/resources/{id}/status` | Weighted 24-hour status for a resource |
| `GET` | `/resources/{id}/history` | 90-day daily uptime history |
| `POST` | `/resources/{id}/reports` | Submit a report (`{ "status": "up" }` or `"down"`, optional `"username"`) |
| `GET` | `/leaderboard` | Top 10 reporters (optional `?username=X` for your rank) |
| `POST` | `/leaderboard` | Register a display name after first report (`{ "username": "..." }`) |
| `GET` | `/resources/{id}/daily-poll` | Today's poll question, results, and vote status (optional `?username=X`) |
| `POST` | `/resources/{id}/daily-poll` | Submit a poll vote (`{ "username": "...", "choice": 0 }` for MC or `{ "username": "...", "choice": "text" }` for free-text) |
| `GET` | `/resources/{id}/poll-history` | Last 7 days of poll results (skips days with no votes) |

### Rate Limiting

Each user (identified by IP + User-Agent hash) can submit one report per resource per 3 hours. The server returns `429` with a `retry_after_seconds` field when rate-limited. The client also mirrors the cooldown locally and shows a countdown timer.

## Status Algorithm

### Current status (`/status`)

1. Collect all reports from the last 24 hours.
2. **Recency weighting** — each report's weight decays exponentially: `w = e^(-0.5 × hours_ago)`.
3. **Consensus boost** — reports agreeing with the weighted majority receive a 1.3× multiplier.
4. Final up-percentage and confidence (based on count of fresh reports) are computed.
5. A human-readable status message is shown (e.g. "All systems operational", "Downtime reported — users are experiencing issues").

### History (`/history`)

1. Query live reports still within the 90-day TTL window.
2. Bucket by Central-time calendar day.
3. Merge in `DAYSUMMARY` records for older days whose individual reports have expired.
4. Return per-day uptime percentage, report count, and an overall 90-day uptime percentage.

### Nightly Compaction

An EventBridge cron rule fires at midnight Central time (06:00 UTC) and invokes the same Lambda. For each tracked resource it:

1. Queries all of yesterday's individual reports.
2. Tallies up/down counts and computes the uptime percentage.
3. Writes a permanent `DAYSUMMARY#YYYY-MM-DD` record (~100 bytes) with no TTL.

Individual reports still expire after 90 days via DynamoDB TTL, but the daily summaries are kept forever, giving you unlimited historical depth at negligible storage cost.

## Frontend

The frontend renders a Discord/Statuspage-style UI:

- **Status dot + banner message** — green/red/gray dot with a descriptive one-liner.
- **Stats grid** — current status, 24h uptime, 90-day uptime, 24h report count.
- **90-day history bar** — 90 colored bars, one per day. Green (≥ 90%), amber (50–89%), red (< 50%), gray (no data). Days with no reports inherit the last known status and are shown faded with a stripe pattern to indicate a prediction. Hover for details.
- **Report buttons** — "It's Working" / "It's Down" with a 3-hour cooldown timer after submission.
- **Shame comparisons** — A "Reality check" card below the history bar shows 3 daily-rotating comparisons that adapt to the current 90-day uptime. Four tiers change the tone and color:
  - **< 10%** (red) — Brutal roasts (30 comparisons). Cost breakdowns, absurd analogies, campus life burns.
  - **10–50%** (amber) — Moderate shade (15 comparisons). Grade analogies, part-time job jokes.
  - **50–90%** (blue) — Backhanded compliments (15 comparisons). Grudging acknowledgment of progress.
  - **> 90%** (green) — Sarcastic celebration (15 comparisons). Suspicion and disbelief that it actually works.
  Comparisons are picked deterministically by date so all users see the same 3 each day.
- **Daily poll** — A daily question card appears below the shame comparisons. Questions are selected deterministically based on the date and the trailing 3-day average uptime, split into tiers:
  - **< 30% uptime**: Commiseration questions ("What do you miss most about the ice cream machine?")
  - **30–70% uptime**: Hopeful/uncertain questions ("Will the machine be working when you go to dinner?")
  - **> 70% uptime**: Celebration questions ("What flavor are you getting today?")
  - **Universal**: Questions that work at any uptime level
  Questions are either multiple-choice (with live result bars visible before voting) or free-text (responses shown in a scrollable list). Each username can vote once per day. Votes are stored in DynamoDB (`pk: DAILYPOLL#{resource_id}#{date}`, `sk: VOTE#{username}`). A "Past polls" button toggles the last 7 days of results.
- **Leaderboard** — A flashy site-wide button opens a modal showing the top 10 reporters ranked by total report count, with medal styling for the top 3. After submitting a report, a modal prompts first-time users to enter a display name (max 30 characters) to join the leaderboard. Returning users see their updated score automatically. Names are stored in `localStorage` and tied to a permanent DynamoDB counter (`pk: LEADERBOARD`, `sk: USER#{name}`). The same name can be used across devices to share a single leaderboard entry.
- **Streaks** — Consecutive daily reporting streaks are tracked per user and displayed as a fire badge on the leaderboard and below the report buttons.
- **Reports-today badge** — A site-wide counter shows how many unique reporters have contributed today.
- Auto-refreshes every 30 seconds.

## Adding a New Resource

Insert two DynamoDB items (listing + metadata). You can add Terraform items or use the AWS console:

```
# Listing entry
pk = "RESOURCES"          sk = "<resource-id>"
name = "Friendly Name"    description = "..."

# Metadata entry
pk = "RESOURCE#<resource-id>"  sk = "#METADATA"
name = "Friendly Name"         description = "..."
```

The frontend automatically discovers all resources from the API.

## Local Development

Edit `frontend/config.js` to point at your deployed API Gateway URL, then open `frontend/index.html` in a browser.

## Teardown

```bash
cd terraform
terraform destroy
```
