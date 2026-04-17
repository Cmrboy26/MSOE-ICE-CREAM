"""
Uptime Tracker – AWS Lambda handler.

Routes:
    GET  /resources                          -> list tracked resources
    GET  /resources/{resource_id}/status     -> current weighted status
    GET  /resources/{resource_id}/history    -> 90-day daily uptime history
    POST /resources/{resource_id}/reports    -> submit a user report
    GET  /leaderboard                        -> top reporters
    POST /leaderboard                        -> register a reporter name
    GET  /resources/{resource_id}/daily-poll -> today's poll question + results
    POST /resources/{resource_id}/daily-poll -> submit a poll vote
"""

import datetime
import json
import hashlib
import math
import os
import re
import time
from decimal import Decimal

import boto3

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TABLE_NAME = os.environ["TABLE_NAME"]
RATE_LIMIT_SECONDS = int(os.environ.get("RATE_LIMIT_SECONDS", "10800"))
REPORT_TTL_DAYS = 90
HISTORY_DAYS = 90
STATUS_WINDOW_HOURS = 24
TIME_DECAY_LAMBDA = 0.5        # exponential‑decay rate  (half‑life ≈ 1.4 h)
CONSENSUS_BOOST = 1.3           # multiplier for reports agreeing w/ majority
MAX_REPORTS_QUERY = 1000        # safety cap on DynamoDB query results

RESOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
USERNAME_RE = re.compile(r"^[a-zA-Z0-9 _-]+$")
USERNAME_MAX_LEN = 30

# Central Time (US) offsets: CST = UTC-6, CDT = UTC-5
_CST = datetime.timedelta(hours=-6)
_CDT = datetime.timedelta(hours=-5)

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


def _central_utc_offset(d):
    """Return the UTC offset for US Central time on a given date.
    CDT: second Sunday in March to first Sunday in November.
    """
    year = d.year
    # Second Sunday in March
    mar1 = datetime.date(year, 3, 1)
    dst_start = mar1 + datetime.timedelta(days=(6 - mar1.weekday()) % 7 + 7)
    # First Sunday in November
    nov1 = datetime.date(year, 11, 1)
    dst_end = nov1 + datetime.timedelta(days=(6 - nov1.weekday()) % 7)
    if dst_start <= (d if isinstance(d, datetime.date) else d.date()) < dst_end:
        return _CDT
    return _CST


def _ts_to_central_date(ts):
    """Convert a UTC unix timestamp to a YYYY-MM-DD string in Central time."""
    utc_dt = datetime.datetime.utcfromtimestamp(ts)
    d = utc_dt.date()
    offset = _central_utc_offset(d)
    central_dt = utc_dt + offset
    return central_dt.strftime("%Y-%m-%d")


def _central_today(now_ts):
    """Return today's date in Central time as a datetime.date."""
    utc_dt = datetime.datetime.utcfromtimestamp(now_ts)
    offset = _central_utc_offset(utc_dt.date())
    return (utc_dt + offset).date()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class _DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        return super().default(o)


def _resp(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(body, cls=_DecimalEncoder),
    }


def _user_hash(source_ip, user_agent):
    raw = f"{source_ip}:{user_agent}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _valid_resource_id(rid):
    return bool(rid) and RESOURCE_ID_RE.match(rid)


# ---------------------------------------------------------------------------
# Status calculation  (recency + consensus weighting)
# ---------------------------------------------------------------------------
def _calculate_status(reports, now):
    if not reports:
        return {
            "status": "unknown",
            "confidence": 0,
            "up_percentage": 50,
            "total_reports": 0,
            "recent_reports": 0,
        }

    # --- Pass 1: pure recency weighting ---
    entries = []
    up_w = down_w = 0.0
    for r in reports:
        ts = float(r.get("timestamp", 0))
        hours_ago = max((now - ts) / 3600.0, 0)
        tw = math.exp(-TIME_DECAY_LAMBDA * hours_ago)
        is_up = r.get("status") == "up"
        entries.append({"tw": tw, "is_up": is_up})
        if is_up:
            up_w += tw
        else:
            down_w += tw

    total_w = up_w + down_w
    raw_up_ratio = up_w / total_w if total_w else 0.5
    majority_up = raw_up_ratio > 0.5

    # --- Pass 2: consensus adjustment ---
    adj_up = adj_down = 0.0
    for e in entries:
        w = e["tw"]
        if e["is_up"] == majority_up:
            w *= CONSENSUS_BOOST
        if e["is_up"]:
            adj_up += w
        else:
            adj_down += w

    adj_total = adj_up + adj_down
    up_pct = (adj_up / adj_total * 100) if adj_total else 50.0

    # Confidence: based on how many "fresh" reports exist
    recent_count = sum(1 for e in entries if e["tw"] > 0.5)
    confidence = min(100, recent_count * 20)

    if confidence < 20:
        status = "unknown"
    elif up_pct > 50:
        status = "up"
    else:
        status = "down"

    return {
        "status": status,
        "confidence": confidence,
        "up_percentage": round(up_pct, 1),
        "total_reports": len(reports),
        "recent_reports": recent_count,
    }


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------
def _list_resources():
    result = table.query(
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": "RESOURCES"},
    )
    resources = [
        {
            "id": item["sk"],
            "name": item.get("name", ""),
            "description": item.get("description", ""),
        }
        for item in result.get("Items", [])
    ]
    return _resp(200, {"resources": resources})


def _get_status(resource_id):
    if not _valid_resource_id(resource_id):
        return _resp(400, {"error": "Invalid resource_id"})

    meta = table.get_item(
        Key={"pk": f"RESOURCE#{resource_id}", "sk": "#METADATA"}
    ).get("Item")
    if not meta:
        return _resp(404, {"error": "Resource not found"})

    now = time.time()
    window_start = now - STATUS_WINDOW_HOURS * 3600

    result = table.query(
        KeyConditionExpression="pk = :pk AND sk BETWEEN :sk_start AND :sk_end",
        ExpressionAttributeValues={
            ":pk": f"RESOURCE#{resource_id}",
            ":sk_start": f"REPORT#{int(window_start):010d}",
            ":sk_end": f"REPORT#{int(now):010d}~",
        },
        ScanIndexForward=False,
        Limit=MAX_REPORTS_QUERY,
    )
    reports = result.get("Items", [])
    status_info = _calculate_status(reports, now)

    return _resp(200, {
        "resource_id": resource_id,
        "name": meta.get("name", ""),
        "description": meta.get("description", ""),
        **status_info,
    })


def _get_history(resource_id):
    """Return per-day uptime percentages for the last HISTORY_DAYS days."""
    if not _valid_resource_id(resource_id):
        return _resp(400, {"error": "Invalid resource_id"})

    meta = table.get_item(
        Key={"pk": f"RESOURCE#{resource_id}", "sk": "#METADATA"}
    ).get("Item")
    if not meta:
        return _resp(404, {"error": "Resource not found"})

    now = time.time()
    window_start = now - HISTORY_DAYS * 86400

    # Query all reports in the history window (paginated)
    reports = []
    query_kwargs = {
        "KeyConditionExpression": "pk = :pk AND sk BETWEEN :sk_start AND :sk_end",
        "ExpressionAttributeValues": {
            ":pk": f"RESOURCE#{resource_id}",
            ":sk_start": f"REPORT#{int(window_start):010d}",
            ":sk_end": f"REPORT#{int(now):010d}~",
        },
        "ScanIndexForward": True,
    }
    while True:
        result = table.query(**query_kwargs)
        reports.extend(result.get("Items", []))
        last_key = result.get("LastEvaluatedKey")
        if not last_key or len(reports) >= 10000:
            break
        query_kwargs["ExclusiveStartKey"] = last_key

    # Bucket reports by calendar day (Central time)
    buckets = {}   # "YYYY-MM-DD" -> {"up": count, "down": count}
    for r in reports:
        ts = int(r.get("timestamp", 0))
        day_str = _ts_to_central_date(ts)
        if day_str not in buckets:
            buckets[day_str] = {"up": 0, "down": 0}
        if r.get("status") == "up":
            buckets[day_str]["up"] += 1
        else:
            buckets[day_str]["down"] += 1

    # Load compacted daily summaries for days outside the report window
    summary_result = table.query(
        KeyConditionExpression="pk = :pk AND sk BETWEEN :sk_start AND :sk_end",
        ExpressionAttributeValues={
            ":pk": f"RESOURCE#{resource_id}",
            ":sk_start": "DAYSUMMARY#",
            ":sk_end": "DAYSUMMARY#~",
        },
    )
    for item in summary_result.get("Items", []):
        ds = item["sk"].replace("DAYSUMMARY#", "")
        if ds not in buckets:
            buckets[ds] = {
                "up": int(item.get("up_count", 0)),
                "down": int(item.get("down_count", 0)),
            }

    # Build ordered list of last HISTORY_DAYS days
    today = _central_today(now)
    days = []
    total_up = 0
    total_reports = 0
    last_known_up_pct = None
    for i in range(HISTORY_DAYS - 1, -1, -1):
        d = today - datetime.timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")
        b = buckets.get(ds)
        if b and (b["up"] + b["down"]) > 0:
            total = b["up"] + b["down"]
            up_pct = round(b["up"] / total * 100, 1)
            total_up += b["up"]
            total_reports += total
            last_known_up_pct = up_pct
            days.append({"date": ds, "up_pct": up_pct, "reports": total, "predicted": False})
        elif last_known_up_pct is not None:
            days.append({"date": ds, "up_pct": last_known_up_pct, "reports": 0, "predicted": True})
        else:
            days.append({"date": ds, "up_pct": None, "reports": 0, "predicted": False})

    overall_up_pct = round(total_up / total_reports * 100, 1) if total_reports else None

    return _resp(200, {
        "resource_id": resource_id,
        "name": meta.get("name", ""),
        "days": days,
        "overall_up_pct": overall_up_pct,
        "total_reports": total_reports,
    })


# ---------------------------------------------------------------------------
# Compaction  (called nightly by EventBridge)
# ---------------------------------------------------------------------------
def _compact_yesterday():
    """Summarize yesterday's reports into a DAYSUMMARY record per resource."""
    now = time.time()
    yesterday = _central_today(now) - datetime.timedelta(days=1)
    yesterday_str = yesterday.strftime("%Y-%m-%d")

    # Get all resources
    res = table.query(
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": "RESOURCES"},
    )
    resources = [item["sk"] for item in res.get("Items", [])]

    for rid in resources:
        # Determine the UTC timestamp range for yesterday in Central time
        ct_offset = _central_utc_offset(yesterday)
        # Midnight Central = midnight UTC minus the Central offset
        midnight_central = datetime.datetime(yesterday.year, yesterday.month, yesterday.day)
        midnight_utc = midnight_central - ct_offset
        day_start_utc = int((midnight_utc - datetime.datetime(1970, 1, 1)).total_seconds())
        day_end_utc = day_start_utc + 86400

        # Query yesterday's reports
        reports = []
        query_kwargs = {
            "KeyConditionExpression": "pk = :pk AND sk BETWEEN :sk_start AND :sk_end",
            "ExpressionAttributeValues": {
                ":pk": f"RESOURCE#{rid}",
                ":sk_start": f"REPORT#{day_start_utc:010d}",
                ":sk_end": f"REPORT#{day_end_utc:010d}",
            },
        }
        while True:
            result = table.query(**query_kwargs)
            reports.extend(result.get("Items", []))
            last_key = result.get("LastEvaluatedKey")
            if not last_key:
                break
            query_kwargs["ExclusiveStartKey"] = last_key

        up_count = sum(1 for r in reports if r.get("status") == "up")
        down_count = len(reports) - up_count

        if up_count + down_count == 0:
            continue

        up_pct = round(up_count / (up_count + down_count) * 100, 1)

        # Write summary (no TTL — kept forever)
        table.put_item(Item={
            "pk": f"RESOURCE#{rid}",
            "sk": f"DAYSUMMARY#{yesterday_str}",
            "date": yesterday_str,
            "up_count": up_count,
            "down_count": down_count,
            "up_pct": Decimal(str(up_pct)),
            "total_reports": up_count + down_count,
        })

        print(f"Compacted {rid} for {yesterday_str}: {up_count} up, {down_count} down")

    return {"compacted": len(resources), "date": yesterday_str}


def _validate_username(username):
    """Return a cleaned username or None if invalid."""
    if not username or not isinstance(username, str):
        return None
    username = username.strip()
    if not username or len(username) > USERNAME_MAX_LEN:
        return None
    if not USERNAME_RE.match(username):
        return None
    return username


def _increment_leaderboard(username):
    """Increment a leaderboard entry and update streak. Returns dict with score and streak."""
    key = {"pk": "LEADERBOARD", "sk": f"USER#{username.lower()}"}
    today_str = _central_today(time.time()).strftime("%Y-%m-%d")
    yesterday_str = (_central_today(time.time()) - datetime.timedelta(days=1)).strftime("%Y-%m-%d")

    existing = table.get_item(Key=key).get("Item")
    if existing:
        last_date = existing.get("last_report_date", "")
        current_streak = int(existing.get("current_streak", 0))
        if last_date == today_str:
            new_streak = current_streak  # already reported today
        elif last_date == yesterday_str:
            new_streak = current_streak + 1
        else:
            new_streak = 1
    else:
        new_streak = 1

    result = table.update_item(
        Key=key,
        UpdateExpression="SET display_name = :dn, last_report_date = :ld, current_streak = :cs ADD report_count :one",
        ExpressionAttributeValues={
            ":dn": username,
            ":one": 1,
            ":ld": today_str,
            ":cs": new_streak,
        },
        ReturnValues="ALL_NEW",
    )
    attrs = result["Attributes"]
    return {
        "score": int(attrs["report_count"]),
        "streak": int(attrs.get("current_streak", 1)),
    }


def _submit_report(resource_id, body, source_ip, user_agent):
    if not _valid_resource_id(resource_id):
        return _resp(400, {"error": "Invalid resource_id"})

    status = body.get("status")
    if status not in ("up", "down"):
        return _resp(400, {"error": 'status must be "up" or "down"'})

    meta = table.get_item(
        Key={"pk": f"RESOURCE#{resource_id}", "sk": "#METADATA"}
    ).get("Item")
    if not meta:
        return _resp(404, {"error": "Resource not found"})

    uhash = _user_hash(source_ip, user_agent)

    # Rate‑limit check
    rate_item = table.get_item(
        Key={"pk": f"RATELIMIT#{uhash}", "sk": f"RESOURCE#{resource_id}"}
    ).get("Item")
    if rate_item:
        ttl_val = int(rate_item.get("ttl", 0))
        now_int = int(time.time())
        if ttl_val > now_int:
            return _resp(429, {
                "error": "Rate limited. Try again later.",
                "retry_after_seconds": ttl_val - now_int,
            })

    now = time.time()
    now_int = int(now)

    # Store report
    table.put_item(Item={
        "pk": f"RESOURCE#{resource_id}",
        "sk": f"REPORT#{now_int:010d}#{uhash}",
        "status": status,
        "user_hash": uhash,
        "timestamp": Decimal(str(now_int)),
        "ttl": Decimal(str(now_int + REPORT_TTL_DAYS * 86400)),
    })

    # Set rate‑limit marker
    table.put_item(Item={
        "pk": f"RATELIMIT#{uhash}",
        "sk": f"RESOURCE#{resource_id}",
        "ttl": Decimal(str(now_int + RATE_LIMIT_SECONDS)),
    })

    # Increment daily report counter
    today_str = _central_today(now).strftime("%Y-%m-%d")
    table.update_item(
        Key={"pk": "DAYSTATS", "sk": today_str},
        UpdateExpression="ADD report_count :one",
        ExpressionAttributeValues={":one": 1},
    )

    # Leaderboard: increment score if username provided
    username = _validate_username(body.get("username", ""))
    response_body = {"message": "Report submitted", "status": status}
    if username:
        lb = _increment_leaderboard(username)
        response_body["leaderboard_score"] = lb["score"]
        response_body["leaderboard_streak"] = lb["streak"]

    return _resp(201, response_body)


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------
def _register_reporter(body, source_ip, user_agent):
    """First-time registration: claim the most recent report for a username."""
    username = _validate_username(body.get("username", ""))
    if not username:
        return _resp(400, {"error": "Invalid username. Max 30 characters, letters/numbers/spaces/hyphens/underscores."})

    # Anti-abuse: verify a recent report from this IP+UA
    uhash = _user_hash(source_ip, user_agent)
    now_int = int(time.time())
    recent_cutoff = now_int - 300  # 5 minutes

    # Check if any rate-limit marker exists (means they submitted recently)
    rate_items = table.query(
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": f"RATELIMIT#{uhash}"},
        Limit=1,
    )
    if not rate_items.get("Items"):
        return _resp(400, {"error": "No recent report found. Submit a report first."})

    lb = _increment_leaderboard(username)
    return _resp(200, {"username": username, "score": lb["score"], "streak": lb["streak"]})


def _get_leaderboard(query_params):
    """Return the top reporters and optionally a specific user's rank."""
    result = table.query(
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={
            ":pk": "LEADERBOARD",
            ":prefix": "USER#",
        },
    )
    items = result.get("Items", [])

    # Sort by report_count descending
    items.sort(key=lambda x: int(x.get("report_count", 0)), reverse=True)

    top_10 = []
    for i, item in enumerate(items[:10]):
        top_10.append({
            "rank": i + 1,
            "username": item.get("display_name", ""),
            "report_count": int(item.get("report_count", 0)),
            "streak": int(item.get("current_streak", 0)),
        })

    # Fetch today's report count
    today_str = _central_today(time.time()).strftime("%Y-%m-%d")
    stats_item = table.get_item(
        Key={"pk": "DAYSTATS", "sk": today_str}
    ).get("Item")
    reports_today = int(stats_item.get("report_count", 0)) if stats_item else 0

    response = {
        "leaderboard": top_10,
        "total_reporters": len(items),
        "reports_today": reports_today,
    }

    # If a username is requested, find their rank
    requested = (query_params.get("username") or "").strip()
    if requested:
        user_entry = None
        for i, item in enumerate(items):
            if item.get("display_name", "").lower() == requested.lower():
                user_entry = {
                    "rank": i + 1,
                    "username": item.get("display_name", ""),
                    "report_count": int(item.get("report_count", 0)),
                    "streak": int(item.get("current_streak", 0)),
                }
                break
        response["user"] = user_entry

    return _resp(200, response)


# ---------------------------------------------------------------------------
# Daily poll
# ---------------------------------------------------------------------------
POLL_QUESTIONS_DOWN = [
    {"q": "What do you miss most about the ice cream machine?", "type": "mc", "options": ["Soft serve", "The variety", "Having dessert at all", "The principle of the thing"]},
    {"q": "How many days until you just buy a pint from the store?", "type": "mc", "options": ["Already did", "This week", "Holding out hope", "I refuse on principle"]},
    {"q": "If the tarp could talk, what would it say?", "type": "free"},
    {"q": "What's your coping mechanism for no ice cream?", "type": "free"},
    {"q": "On a scale of 1\u20135, how much do you trust the ice cream machine?", "type": "mc", "options": ["1 - Not at all", "2 - Barely", "3 - It's complicated", "4 - Cautiously", "5 - Unwavering faith"]},
    {"q": "The ice cream machine has been down for a while. What should replace it?", "type": "free"},
    {"q": "What flavor would make the downtime worth it?", "type": "free"},
    {"q": "If the ice cream machine wrote an out-of-office reply, what would it say?", "type": "free"},
    {"q": "How do you explain the ice cream machine situation to visitors?", "type": "mc", "options": ["I don't", "Awkward laugh", "Show them this tracker", "Start a support group"]},
    {"q": "Which stage of grief are you in about the ice cream machine?", "type": "mc", "options": ["Denial", "Anger", "Bargaining", "Depression", "Acceptance"]},
]

POLL_QUESTIONS_SHAKY = [
    {"q": "Will the ice cream machine be working when you go to dinner tonight?", "type": "mc", "options": ["Definitely", "Probably", "Doubt it", "No chance"]},
    {"q": "Cone or cup \u2014 if you even get the chance?", "type": "mc", "options": ["Cone", "Cup", "Bowl", "Whatever's available"]},
    {"q": "Best strategy for catching the machine while it's up?", "type": "free"},
    {"q": "Rate your confidence in the ice cream machine today", "type": "mc", "options": ["Very confident", "Somewhat confident", "Not confident", "What confidence?"]},
    {"q": "What time of day is the ice cream machine most likely to work?", "type": "mc", "options": ["Breakfast", "Lunch", "Dinner", "Late night", "No pattern"]},
    {"q": "Do you check this tracker before going to the dining hall?", "type": "mc", "options": ["Every time", "Sometimes", "Never thought to", "I live dangerously"]},
    {"q": "What's your backup dessert when the machine is down?", "type": "free"},
    {"q": "How many trips to the dining hall before you get ice cream?", "type": "mc", "options": ["1 (lucky)", "2-3", "4+", "I've lost count"]},
    {"q": "If the ice cream machine were a group project partner, what grade would you give it?", "type": "mc", "options": ["A", "B", "C", "D", "F"]},
    {"q": "Describe the ice cream machine's personality in a few words", "type": "free"},
]

POLL_QUESTIONS_UP = [
    {"q": "What flavor are you getting today?", "type": "mc", "options": ["Chocolate", "Vanilla", "Strawberry", "Whatever's loaded"]},
    {"q": "Rate today's ice cream experience", "type": "mc", "options": ["\u2b50", "\u2b50\u2b50", "\u2b50\u2b50\u2b50", "\u2b50\u2b50\u2b50\u2b50", "\u2b50\u2b50\u2b50\u2b50\u2b50"]},
    {"q": "How many times have you gone for ice cream this week?", "type": "mc", "options": ["0 (going now)", "1-2", "3-5", "I've lost count"]},
    {"q": "Describe the ice cream machine's redemption arc in a few words", "type": "free"},
    {"q": "If the ice cream machine were an MSOE major, what would it be?", "type": "free"},
    {"q": "How do you celebrate the machine being up?", "type": "mc", "options": ["Get ice cream immediately", "Tell a friend", "Report it here", "All of the above"]},
    {"q": "Quick \u2014 go get ice cream before it goes down again?", "type": "mc", "options": ["Already on my way", "Just got some", "Saving it for later", "I don't trust it yet"]},
    {"q": "What ice cream topping should the dining hall add?", "type": "free"},
    {"q": "Does the ice cream taste better when you know the machine could go down any second?", "type": "mc", "options": ["Absolutely", "A little", "Same as always", "I savor every bite"]},
    {"q": "What would you name the ice cream machine now that it's working?", "type": "free"},
]

POLL_QUESTIONS_UNIVERSAL = [
    {"q": "Favorite ice cream flavor of all time?", "type": "free"},
    {"q": "Unpopular opinion: the ice cream machine is ___", "type": "free"},
    {"q": "What would you name the ice cream machine?", "type": "free"},
    {"q": "Ice cream is best enjoyed...", "type": "mc", "options": ["After a meal", "As a meal", "Late at night", "Any time", "For breakfast"]},
    {"q": "How often do you check this tracker?", "type": "mc", "options": ["First time here", "Occasionally", "Daily", "Multiple times a day"]},
    {"q": "Should MSOE get a second ice cream machine as backup?", "type": "mc", "options": ["Absolutely", "Probably", "One is enough", "Fix the first one first"]},
    {"q": "What's the best dining hall item besides ice cream?", "type": "free"},
    {"q": "If you could add one thing to the dining hall, what would it be?", "type": "free"},
    {"q": "How would you rate the dining hall overall?", "type": "mc", "options": ["\u2b50", "\u2b50\u2b50", "\u2b50\u2b50\u2b50", "\u2b50\u2b50\u2b50\u2b50", "\u2b50\u2b50\u2b50\u2b50\u2b50"]},
    {"q": "Do you eat ice cream year-round or only in warm weather?", "type": "mc", "options": ["Year-round obviously", "Mostly warm weather", "Only summer", "Wisconsin has warm weather?"]},
]

POLL_MAX_FREE_LEN = 100


def _poll_trailing_uptime(resource_id, now_ts):
    """Return the average uptime% over the last 3 days from DAYSUMMARY records."""
    today = _central_today(now_ts)
    pcts = []
    for i in range(1, 4):
        d = today - datetime.timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")
        item = table.get_item(
            Key={"pk": f"RESOURCE#{resource_id}", "sk": f"DAYSUMMARY#{ds}"}
        ).get("Item")
        if item and "up_pct" in item:
            pcts.append(float(item["up_pct"]))
    return sum(pcts) / len(pcts) if pcts else None


def _select_daily_question(resource_id, now_ts):
    """Pick today's question deterministically from the appropriate tier."""
    avg = _poll_trailing_uptime(resource_id, now_ts)
    if avg is None or avg < 30:
        tier_pool = POLL_QUESTIONS_DOWN
    elif avg < 70:
        tier_pool = POLL_QUESTIONS_SHAKY
    else:
        tier_pool = POLL_QUESTIONS_UP
    pool = tier_pool + POLL_QUESTIONS_UNIVERSAL

    today_str = _central_today(now_ts).strftime("%Y-%m-%d")
    h = hashlib.md5((today_str + ":" + resource_id).encode()).hexdigest()
    idx = int(h, 16) % len(pool)
    return pool[idx]


def _get_daily_poll(resource_id, query_params):
    if not _valid_resource_id(resource_id):
        return _resp(400, {"error": "Invalid resource_id"})

    meta = table.get_item(
        Key={"pk": f"RESOURCE#{resource_id}", "sk": "#METADATA"}
    ).get("Item")
    if not meta:
        return _resp(404, {"error": "Resource not found"})

    now = time.time()
    today_str = _central_today(now).strftime("%Y-%m-%d")
    question = _select_daily_question(resource_id, now)

    # Query all votes for today
    poll_pk = f"DAILYPOLL#{resource_id}#{today_str}"
    result = table.query(
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={
            ":pk": poll_pk,
            ":prefix": "VOTE#",
        },
    )
    votes = result.get("Items", [])

    username = (query_params.get("username") or "").strip().lower()
    user_voted = False
    user_choice = None

    if question["type"] == "mc":
        tallies = [0] * len(question["options"])
        for v in votes:
            ci = int(v.get("choice", 0))
            if 0 <= ci < len(tallies):
                tallies[ci] += 1
            if username and v.get("sk", "").lower() == f"vote#{username}":
                user_voted = True
                user_choice = ci
        response = {
            "date": today_str,
            "question": question["q"],
            "type": "mc",
            "options": question["options"],
            "tallies": tallies,
            "total_votes": sum(tallies),
            "user_voted": user_voted,
            "user_choice": user_choice,
        }
    else:
        responses = []
        for v in votes:
            display = v.get("display_name", v.get("sk", "").replace("VOTE#", ""))
            responses.append({"text": v.get("choice", ""), "username": display})
            if username and v.get("sk", "").lower() == f"vote#{username}":
                user_voted = True
                user_choice = v.get("choice", "")
        response = {
            "date": today_str,
            "question": question["q"],
            "type": "free",
            "responses": responses,
            "total_votes": len(responses),
            "user_voted": user_voted,
            "user_choice": user_choice,
        }

    return _resp(200, response)


def _get_poll_history(resource_id, query_params):
    """Return the last 7 days of poll results (excluding today)."""
    if not _valid_resource_id(resource_id):
        return _resp(400, {"error": "Invalid resource_id"})

    meta = table.get_item(
        Key={"pk": f"RESOURCE#{resource_id}", "sk": "#METADATA"}
    ).get("Item")
    if not meta:
        return _resp(404, {"error": "Resource not found"})

    now = time.time()
    today = _central_today(now)
    polls = []

    for i in range(1, 8):  # last 7 days
        d = today - datetime.timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")

        # Reconstruct the question for that day by simulating the timestamp
        ct_offset = _central_utc_offset(d)
        noon_central = datetime.datetime(d.year, d.month, d.day, 12, 0, 0)
        noon_utc = noon_central - ct_offset
        past_ts = (noon_utc - datetime.datetime(1970, 1, 1)).total_seconds()
        question = _select_daily_question(resource_id, past_ts)

        # Fetch votes
        poll_pk = f"DAILYPOLL#{resource_id}#{ds}"
        result = table.query(
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={
                ":pk": poll_pk,
                ":prefix": "VOTE#",
            },
        )
        votes = result.get("Items", [])

        if not votes:
            continue  # skip days with no participation

        if question["type"] == "mc":
            tallies = [0] * len(question["options"])
            for v in votes:
                ci = int(v.get("choice", 0))
                if 0 <= ci < len(tallies):
                    tallies[ci] += 1
            polls.append({
                "date": ds,
                "question": question["q"],
                "type": "mc",
                "options": question["options"],
                "tallies": tallies,
                "total_votes": sum(tallies),
            })
        else:
            responses = []
            for v in votes:
                display = v.get("display_name", v.get("sk", "").replace("VOTE#", ""))
                responses.append({"text": v.get("choice", ""), "username": display})
            polls.append({
                "date": ds,
                "question": question["q"],
                "type": "free",
                "responses": responses,
                "total_votes": len(responses),
            })

    return _resp(200, {"polls": polls})


def _submit_daily_poll(resource_id, body):
    if not _valid_resource_id(resource_id):
        return _resp(400, {"error": "Invalid resource_id"})

    username = _validate_username(body.get("username", ""))
    if not username:
        return _resp(400, {"error": "Username is required to vote."})

    meta = table.get_item(
        Key={"pk": f"RESOURCE#{resource_id}", "sk": "#METADATA"}
    ).get("Item")
    if not meta:
        return _resp(404, {"error": "Resource not found"})

    now = time.time()
    today_str = _central_today(now).strftime("%Y-%m-%d")
    question = _select_daily_question(resource_id, now)
    poll_pk = f"DAILYPOLL#{resource_id}#{today_str}"
    vote_sk = f"VOTE#{username.lower()}"

    # Check if already voted (conditional put)
    choice = body.get("choice")
    if question["type"] == "mc":
        if not isinstance(choice, int) or choice < 0 or choice >= len(question["options"]):
            return _resp(400, {"error": "Invalid choice."})
        choice_val = choice
    else:
        if not isinstance(choice, str) or not choice.strip():
            return _resp(400, {"error": "Response cannot be empty."})
        choice = choice.strip()
        if len(choice) > POLL_MAX_FREE_LEN:
            return _resp(400, {"error": f"Response must be {POLL_MAX_FREE_LEN} characters or fewer."})
        choice_val = choice

    try:
        table.put_item(
            Item={
                "pk": poll_pk,
                "sk": vote_sk,
                "choice": choice_val if isinstance(choice_val, str) else Decimal(str(choice_val)),
                "display_name": username,
                "timestamp": Decimal(str(int(now))),
            },
            ConditionExpression="attribute_not_exists(pk)",
        )
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        return _resp(409, {"error": "You already voted today."})

    return _resp(201, {"message": "Vote recorded.", "choice": choice_val})


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------
def handler(event, context):
    # EventBridge scheduled event — run compaction
    if event.get("source") == "aws.events":
        result = _compact_yesterday()
        print(f"Compaction complete: {result}")
        return result

    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")
    path_params = event.get("pathParameters") or {}

    try:
        if method == "OPTIONS":
            return _resp(200, {})

        if path == "/resources" and method == "GET":
            return _list_resources()

        if path == "/leaderboard" and method == "GET":
            query_params = event.get("queryStringParameters") or {}
            return _get_leaderboard(query_params)

        if path == "/leaderboard" and method == "POST":
            body = json.loads(event.get("body") or "{}")
            source_ip = (
                event.get("requestContext", {})
                .get("http", {})
                .get("sourceIp", "0.0.0.0")
            )
            user_agent = event.get("headers", {}).get("user-agent", "unknown")
            return _register_reporter(body, source_ip, user_agent)

        resource_id = path_params.get("resource_id", "")

        if path.endswith("/status") and method == "GET":
            return _get_status(resource_id)

        if path.endswith("/history") and method == "GET":
            return _get_history(resource_id)

        if path.endswith("/reports") and method == "POST":
            body = json.loads(event.get("body") or "{}")
            source_ip = (
                event.get("requestContext", {})
                .get("http", {})
                .get("sourceIp", "0.0.0.0")
            )
            user_agent = event.get("headers", {}).get("user-agent", "unknown")
            return _submit_report(resource_id, body, source_ip, user_agent)

        if path.endswith("/daily-poll") and method == "GET":
            query_params = event.get("queryStringParameters") or {}
            return _get_daily_poll(resource_id, query_params)

        if path.endswith("/daily-poll") and method == "POST":
            body = json.loads(event.get("body") or "{}")
            return _submit_daily_poll(resource_id, body)

        if path.endswith("/poll-history") and method == "GET":
            query_params = event.get("queryStringParameters") or {}
            return _get_poll_history(resource_id, query_params)

        return _resp(404, {"error": "Not found"})

    except json.JSONDecodeError:
        return _resp(400, {"error": "Invalid JSON body"})
    except Exception as exc:
        print(f"Unhandled error: {exc}")
        return _resp(500, {"error": "Internal server error"})
