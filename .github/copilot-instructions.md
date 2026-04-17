# Project Guidelines

## Overview

MSOE Ice Cream Machine Uptime Tracker — a serverless, community-powered status page. Originally built for the MSOE ice cream machine, extensible to any resource.

## Architecture

| Layer | Tech | Location |
|-------|------|----------|
| Frontend | Vanilla HTML/CSS/JS (static S3 site) | `frontend/` |
| Backend | Python 3.12 Lambda (single function) | `backend/lambda_function.py` |
| Infrastructure | Terraform (AWS free tier) | `terraform/` |
| Scripts | Python utilities | `scripts/` |

DynamoDB uses a single-table design with `pk`/`sk` keys. Key prefixes: `RESOURCES`, `RESOURCE#`, `REPORT#`, `DAYSUMMARY#`, `RATELIMIT#`.

## Build and Deploy

```bash
cd terraform
terraform init    # first time only
terraform apply   # deploy or update
terraform destroy # tear down everything
```

No build step for frontend — files are uploaded directly to S3 by Terraform.

## Conventions

- **Frontend**: Vanilla JS only (no frameworks, no bundler). IIFE pattern, `var` declarations, no ES6 modules.
- **Backend**: Single `lambda_function.py` file. All routes handled in one Lambda. No external dependencies beyond `boto3` (pre-installed in Lambda runtime).
- **Terraform**: One `.tf` file per AWS service (e.g., `dynamodb.tf`, `lambda.tf`, `s3.tf`). All resources prefixed with `var.project_name`.
- **Dates/times**: All user-facing dates use US Central time (CST/CDT). The backend handles DST transitions explicitly.

## Documentation

**Always update `README.md` when making functional changes.** This includes:
- New or changed API endpoints
- Changes to the status algorithm or history logic
- New infrastructure resources
- Changes to the frontend UI behavior
- New scripts or tooling

## Key Design Decisions

- Rate limiting: 1 report per user per resource per hour, using IP + User-Agent hash.
- Status algorithm: Two-pass — exponential time-decay weighting, then consensus boost (1.3×).
- History: Nightly compaction writes permanent `DAYSUMMARY` records; individual reports expire after 90 days via DynamoDB TTL.
- Days with no reports inherit the last known status and are marked as `predicted` in the API and displayed with reduced opacity + stripe pattern on the frontend.
