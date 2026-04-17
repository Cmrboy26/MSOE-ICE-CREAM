"""
Seed 90 days of historical DAYSUMMARY records into DynamoDB.

Every day is marked as down except April 7, 2026 which is up.

Usage:
    pip install boto3   (if not already installed)
    python seed_history.py
"""

import datetime
from decimal import Decimal

import boto3

TABLE_NAME = "uptime-tracker-table"
RESOURCE_ID = "msoe-ice-cream"
HISTORY_DAYS = 90

UP_DAY = datetime.date(2026, 4, 7)

dynamodb = boto3.resource("dynamodb", region_name="us-east-1")
table = dynamodb.Table(TABLE_NAME)

today = datetime.date.today()

for i in range(HISTORY_DAYS - 1, -1, -1):
    day = today - datetime.timedelta(days=i)
    day_str = day.strftime("%Y-%m-%d")

    if day == UP_DAY:
        up_count, down_count = 1, 0
    else:
        up_count, down_count = 0, 1

    total = up_count + down_count
    up_pct = round(up_count / total * 100, 1)

    table.put_item(Item={
        "pk": f"RESOURCE#{RESOURCE_ID}",
        "sk": f"DAYSUMMARY#{day_str}",
        "date": day_str,
        "up_count": up_count,
        "down_count": down_count,
        "up_pct": Decimal(str(up_pct)),
        "total_reports": total,
    })

    status = "UP" if day == UP_DAY else "DOWN"
    print(f"  {day_str}  {status}")

print(f"\nDone — seeded {HISTORY_DAYS} days for {RESOURCE_ID}.")
