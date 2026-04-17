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
| `POST` | `/resources/{id}/reports` | Submit a report (`{ "status": "up" }` or `"down"`) |

### Rate Limiting

Each user (identified by IP + User-Agent hash) can submit one report per resource per hour. The server returns `429` with a `retry_after_seconds` field when rate-limited. The client also mirrors the cooldown locally and shows a countdown timer.

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
- **Report buttons** — "It's Working" / "It's Down" with a cooldown timer after submission.
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
