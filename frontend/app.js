/* global API_BASE_URL */
(function () {
  "use strict";

  var container = document.getElementById("resources-container");
  var resourcesCache = [];

  // ─── API helpers ────────────────────────────────────────────
  function fetchJSON(path) {
    return fetch(API_BASE_URL + path).then(function (r) {
      return r.json();
    });
  }

  function postJSON(path, body) {
    return fetch(API_BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (data) {
        return { ok: r.ok, status: r.status, data: data };
      });
    });
  }

  // ─── Local rate-limit helpers (client-side mirror) ──────────
  function rlKey(id) {
    return "ut_rl_" + id;
  }

  function isLocallyLimited(id) {
    var until = localStorage.getItem(rlKey(id));
    if (!until) return false;
    if (Date.now() < parseInt(until, 10)) return true;
    localStorage.removeItem(rlKey(id));
    return false;
  }

  function setLocalLimit(id, seconds) {
    localStorage.setItem(rlKey(id), String(Date.now() + seconds * 1000));
  }

  function remainingSeconds(id) {
    var until = localStorage.getItem(rlKey(id));
    if (!until) return 0;
    return Math.max(0, Math.ceil((parseInt(until, 10) - Date.now()) / 1000));
  }

  function fmtTime(s) {
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + "m " + sec + "s";
  }

  // ─── Render helpers ─────────────────────────────────────────
  function esc(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function statusMessage(status, upPct, confidence) {
    if (status === "unknown" || confidence < 20) {
      return "Not enough recent reports to determine status.";
    }
    if (status === "up" && upPct >= 90) {
      return "All systems operational.";
    }
    if (status === "up") {
      return "Mostly operational — some recent downtime reports.";
    }
    if (upPct <= 10) {
      return "Major outage reported by users.";
    }
    return "Downtime reported — users are experiencing issues.";
  }

  function dayColor(day) {
    if (day.reports === 0 && !day.predicted) return "no-data";
    if (day.up_pct == null) return "no-data";
    var base;
    if (day.up_pct >= 90) base = "great";
    else if (day.up_pct >= 50) base = "degraded";
    else base = "down";
    return day.predicted ? base + " predicted" : base;
  }

  function formatDate(ds) {
    var parts = ds.split("-");
    var months = [
      "Jan","Feb","Mar","Apr","May","Jun",
      "Jul","Aug","Sep","Oct","Nov","Dec"
    ];
    return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10) + ", " + parts[0];
  }

  // ─── Build history bar HTML ─────────────────────────────────
  function renderHistoryBar(days) {
    if (!days || !days.length) {
      return '<div class="history-section"><p class="history-empty">No history data available.</p></div>';
    }

    var bars = "";
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var cls = dayColor(d);
      var tooltip;
      if (d.predicted) {
        tooltip = formatDate(d.date) + "\nPredicted: " + d.up_pct + "% uptime (no reports)";
      } else if (d.reports === 0) {
        tooltip = formatDate(d.date) + "\nNo data";
      } else {
        tooltip = formatDate(d.date) + "\n" + d.up_pct + "% uptime (" + d.reports + " report" + (d.reports !== 1 ? "s" : "") + ")";
      }
      bars += '<div class="history-bar ' + cls + '" title="' + esc(tooltip) + '"></div>';
    }

    var firstDate = formatDate(days[0].date);
    var lastDate = formatDate(days[days.length - 1].date);

    return (
      '<div class="history-section">' +
      '  <div class="history-label-row">' +
      '    <span class="history-label">90-day uptime history</span>' +
      "  </div>" +
      '  <div class="history-bars">' + bars + "</div>" +
      '  <div class="history-dates">' +
      '    <span>' + firstDate + "</span>" +
      '    <span>' + lastDate + "</span>" +
      "  </div>" +
      "</div>"
    );
  }

  // ─── Shame comparisons ───────────────────────────────────────
  var SHAME_TIERS = {
    // < 10% — brutal roasts
    brutal: [
      function(v) { return "AWS guarantees 99.99% uptime. The MSOE ice cream machine delivers " + v.uptime + "%."; },
      function(v) { return "NASA\u2019s Voyager 1, launched in 1977, has better uptime from 15 billion miles away than the ice cream machine."; },
      function(v) { return "The ice cream machine has been up for " + v.hours_up + " hours in 90 days. Most servers would be decommissioned for that."; },
      function(v) { return "Internet Explorer was discontinued and still had better availability than the ice cream machine at " + v.uptime + "%."; },
      function(v) { return "The average vending machine has 99% uptime. The ice cream machine has " + v.uptime + "%. That\u2019s not a rounding error \u2014 that\u2019s a cry for help."; },
      function(v) { return "You\u2019re more likely to find a four-leaf clover on your first try than to walk into the dining hall and find the ice cream machine working."; },
      function(v) { return "A fruit fly lives 40\u201350 days. The ice cream machine has been up " + v.days_up + " days out of 90. The fruit fly wins."; },
      function(v) { return "A broken clock is right 0.14% of the day. The ice cream machine works " + v.uptime + "% of the time. Barely beating a broken clock."; },
      function(v) { return "The tarp on the ice cream machine has higher uptime than the ice cream machine itself."; },
      function(v) { return "If the ice cream machine were a student, it would have " + v.uptime + "% attendance and be expelled by now."; },
      function(v) { return "The ice cream machine has been down for " + v.days_down + " of the last 90 days. The machine is basically on sabbatical."; },
      function(v) { return "You could flip a coin and get heads 6 times in a row (1.6% chance) \u2014 about the same odds as finding the ice cream machine working."; },
      function(v) { return "You pay $2,807/semester for the meal plan. At " + v.uptime + "% ice cream machine uptime, that\u2019s $" + v.cost_per_hour + " per hour of availability."; },
      function(v) { return "Your meal plan costs $" + v.cost_per_day + " for each day the ice cream machine actually works this semester."; },
      function(v) { return "A double in MLH is $4,001/semester. Your $2,807 meal plan comes with an ice cream machine that works " + v.uptime + "% of the time. Great deal."; },
      function(v) { return "$2,807/semester for \u201Cunlimited dining.\u201D The ice cream machine has worked " + v.days_up + " days out of 90. That\u2019s not unlimited \u2014 that\u2019s barely limited."; },
      function(v) { return "A Viets double costs $5,335/semester and at least the door opens every day. The ice cream machine works " + v.uptime + "% of the time."; },
      function(v) { return "A pint of Ben & Jerry\u2019s costs $6 and is available 24/7. Your meal plan costs $2,807 and the ice cream machine works " + v.uptime + "% of the time. Do the math."; },
      function(v) { return v.uptime + "% uptime means the ice cream machine worked roughly " + v.hours_up + " hours total in 90 days. That\u2019s less than a single weekend."; },
      function(v) { return "In the " + v.hours_down + " hours the ice cream machine has been down, you could\u2019ve driven to every Dairy Queen in Wisconsin and back. Twice."; },
      function(v) { return "The ice cream machine has been down " + v.days_down + " of the last 90 days. That\u2019s longer than summer break."; },
      function(v) { return "At " + v.uptime + "% uptime across a 4-year degree, the ice cream machine will have worked a grand total of ~" + v.grad_days + " days."; },
      function(v) { return "The ice cream machine has been up for " + v.days_up + " days. You spend more time in a single finals week."; },
      function(v) { return "Campus WiFi drops less often than the ice cream machine is operational. Let that sink in."; },
      function(v) { return "The campus parking lot has better availability than the ice cream machine at " + v.uptime + "%. And that\u2019s saying something."; },
      function(v) { return "Even the MLH elevator is more reliable than the ice cream machine."; },
      function(v) { return "The ice cream machine at " + v.uptime + "% uptime is less reliable than the MSOE printers. Read that again."; },
      function(v) { return "McDonald\u2019s ice cream machines are famously broken ~10% of the time. At " + v.uptime + "%, the MSOE ice cream machine makes McDonald\u2019s look world-class."; },
      function(v) { return "The Titanic had a longer operational run than the ice cream machine has had in the past 90 days."; },
      function(v) { return "If the ice cream machine were a Netflix show at " + v.uptime + "% viewership, it\u2019d be canceled after one episode."; },
    ],
    // 10–50% — moderate shade
    shade: [
      function(v) { return "The ice cream machine is up " + v.uptime + "% of the time. That\u2019s a D- in any class at MSOE."; },
      function(v) { return "At " + v.uptime + "% uptime, the ice cream machine wouldn\u2019t pass the FE exam."; },
      function(v) { return "The ice cream machine has worked " + v.days_up + " days out of 90. That\u2019s not even half credit."; },
      function(v) { return "You pay $2,807/semester for the meal plan. The ice cream machine delivers " + v.uptime + "% of the time. You\u2019d get a refund on anything else."; },
      function(v) { return "The ice cream machine at " + v.uptime + "% uptime is less reliable than Milwaukee public transit. And that\u2019s saying something."; },
      function(v) { return "If you showed up to work " + v.uptime + "% of the time like the ice cream machine, you\u2019d be fired in a week."; },
      function(v) { return "The ice cream machine works " + v.days_up + " days out of 90. Your meal plan works all 90. One of these is pulling its weight."; },
      function(v) { return "At " + v.uptime + "% uptime, the ice cream machine has been working roughly " + v.hours_up + " hours in 90 days. That\u2019s a part-time job at best."; },
      function(v) { return "McDonald\u2019s ice cream machines work about 90% of the time. The MSOE ice cream machine works " + v.uptime + "%. We\u2019re getting closer though."; },
      function(v) { return "The ice cream machine is improving, but " + v.uptime + "% uptime still wouldn\u2019t pass a code review."; },
      function(v) { return "$2,807/semester and the ice cream machine works " + v.uptime + "% of the time. Your Viets double at $5,335 at least has consistent heat."; },
      function(v) { return "The ice cream machine has been up " + v.hours_up + " hours out of 2,160. Not great, not terrible. Actually, no \u2014 it\u2019s terrible."; },
      function(v) { return "At " + v.uptime + "%, the ice cream machine is technically more reliable than it used to be. The bar was underground."; },
      function(v) { return "If the ice cream machine\u2019s uptime were a GPA, " + v.uptime + "% would put it on academic probation."; },
      function(v) { return "The ice cream machine works " + v.uptime + "% of the time. That\u2019s less than a coin flip. You\u2019d literally be better off guessing."; },
    ],
    // 50–90% — backhanded compliments
    backhanded: [
      function(v) { return "The ice cream machine is working " + v.uptime + "% of the time. Is this what progress looks like?"; },
      function(v) { return "The ice cream machine has been up " + v.days_up + " of the last 90 days. We\u2019re not saying it\u2019s reliable. We\u2019re saying it\u2019s trying."; },
      function(v) { return "At " + v.uptime + "% uptime, the ice cream machine would almost pass an MSOE class. Almost."; },
      function(v) { return v.uptime + "% uptime. The ice cream machine is now more reliable than the campus WiFi. Low bar, but credit where it\u2019s due."; },
      function(v) { return "The ice cream machine at " + v.uptime + "% uptime \u2014 still worse than every other appliance in the dining hall, but making strides."; },
      function(v) { return "The ice cream machine has worked " + v.hours_up + " hours in 90 days. That\u2019s almost a respectable number. We said almost."; },
      function(v) { return "Your $2,807 meal plan now comes with an ice cream machine that works " + v.uptime + "% of the time. The value is\u2026 improving."; },
      function(v) { return "The ice cream machine works more often than not. Someone at MSOE dining deserves a participation trophy."; },
      function(v) { return "At " + v.uptime + "% uptime, the ice cream machine has graduated from \u201Ccompletely broken\u201D to \u201Coccasionally functional.\u201D Congratulations."; },
      function(v) { return "The ice cream machine is up " + v.uptime + "% of the time. That\u2019s enough to give you hope but not enough to give you confidence."; },
      function(v) { return "We\u2019re at " + v.uptime + "% ice cream machine uptime. McDonald\u2019s is starting to sweat."; },
      function(v) { return "The tarp is off more than it\u2019s on. At " + v.uptime + "%, we\u2019re witnessing what some might call \u201Cimprovement.\u201D"; },
      function(v) { return v.uptime + "% uptime across a 4-year degree means ~" + v.grad_days + " days of ice cream. That\u2019s\u2026 honestly not that bad. Don\u2019t let them know we said that."; },
      function(v) { return "The ice cream machine is working " + v.uptime + "% of the time. Dare we dream of 90%?"; },
      function(v) { return "At " + v.uptime + "%, the ice cream machine works most days. We\u2019re cautiously optimistic and fully skeptical."; },
    ],
    // > 90% — sarcastic celebration
    celebration: [
      function(v) { return "The ice cream machine is at " + v.uptime + "% uptime. This is not a drill. Someone pinch us."; },
      function(v) { return v.uptime + "% uptime. The ice cream machine is now more reliable than most MSOE group project members."; },
      function(v) { return "The ice cream machine has been working " + v.days_up + " out of 90 days. We never thought we\u2019d see this day. We\u2019re suspicious."; },
      function(v) { return "At " + v.uptime + "%, the ice cream machine has achieved what engineers call \u201Cactually working.\u201D Mark your calendars."; },
      function(v) { return "The ice cream machine uptime is " + v.uptime + "%. Quick, someone check if it\u2019s plugged in or if this is a simulation."; },
      function(v) { return "The MSOE ice cream machine now has " + v.uptime + "% uptime. AWS should be taking notes."; },
      function(v) { return v.uptime + "% ice cream machine uptime. Your $2,807 meal plan is finally delivering. Savor it \u2014 literally."; },
      function(v) { return "The ice cream machine is working almost every day. This is the best timeline."; },
      function(v) { return "At " + v.uptime + "% uptime, the ice cream machine has officially outperformed McDonald\u2019s. We did it, MSOE."; },
      function(v) { return "The tarp is a distant memory. " + v.uptime + "% uptime. Get your ice cream while it lasts \u2014 we don\u2019t trust this."; },
      function(v) { return "The ice cream machine is at " + v.uptime + "% uptime. Either it got fixed or the tracker is broken. Both seem equally likely."; },
      function(v) { return v.uptime + "% uptime across 90 days. The ice cream machine is now the most reliable thing on campus. Seriously."; },
      function(v) { return "Is this a prank? " + v.uptime + "% ice cream machine uptime. Someone is definitely getting a raise. Or shouldn\u2019t be."; },
      function(v) { return "The ice cream machine works " + v.days_up + " out of 90 days. At this rate, MSOE will need a new thing to complain about."; },
      function(v) { return "At " + v.uptime + "%, the ice cream machine has gone from campus meme to campus miracle."; },
    ],
  };

  var SHAME_TIER_META = {
    brutal:      { label: "Reality check",        css: "shame-brutal" },
    shade:       { label: "Room for improvement",  css: "shame-shade" },
    backhanded:  { label: "Getting there\u2026",   css: "shame-backhanded" },
    celebration: { label: "Wait, really?",          css: "shame-celebration" },
  };

  function getShameTier(upPct) {
    if (upPct < 10) return "brutal";
    if (upPct < 50) return "shade";
    if (upPct < 90) return "backhanded";
    return "celebration";
  }

  function computeShameVars(upPct) {
    var up = upPct || 0;
    var down = 100 - up;
    var semesterDays = 120;
    return {
      uptime: up,
      downtime: Math.round(down * 10) / 10,
      days_up: Math.round(up / 100 * 90 * 10) / 10,
      days_down: Math.round(down / 100 * 90 * 10) / 10,
      hours_up: Math.round(up / 100 * 90 * 24),
      hours_down: Math.round(down / 100 * 90 * 24),
      cost_per_hour: Math.round(2807 / Math.max(up / 100 * semesterDays * 24, 1)),
      cost_per_day: Math.round(2807 / Math.max(up / 100 * semesterDays, 1)),
      grad_days: Math.round(up / 100 * 365 * 4 * 10) / 10,
    };
  }

  function pickDailyComparisons(poolSize, count) {
    var today = new Date().toISOString().slice(0, 10);
    var hash = 0;
    for (var i = 0; i < today.length; i++) {
      hash = ((hash << 5) - hash + today.charCodeAt(i)) | 0;
    }
    hash = Math.abs(hash);
    var indices = [];
    var used = {};
    for (var j = 0; j < count; j++) {
      var idx = (hash + j * 7 + j * j * 13) % poolSize;
      while (used[idx]) {
        idx = (idx + 1) % poolSize;
      }
      used[idx] = true;
      indices.push(idx);
    }
    return indices;
  }

  function renderComparisons(upPct) {
    if (upPct == null) return "";
    var tier = getShameTier(upPct);
    var pool = SHAME_TIERS[tier];
    var meta = SHAME_TIER_META[tier];
    var v = computeShameVars(upPct);
    var indices = pickDailyComparisons(pool.length, 3);
    var items = "";
    for (var i = 0; i < indices.length; i++) {
      items += '<div class="shame-item">' + pool[indices[i]](v) + '</div>';
    }
    return (
      '<div class="shame-comparisons ' + meta.css + '">' +
      '  <div class="shame-label">' + meta.label + '</div>' +
      items +
      '</div>'
    );
  }

  // ─── Build a resource card ──────────────────────────────────
  function renderCard(resource, sd, history) {
    var status = (sd && sd.status) || "unknown";
    var confidence = (sd && sd.confidence) || 0;
    var upPct = sd ? sd.up_percentage : 50;
    var totalReports = (sd && sd.total_reports) || 0;
    var limited = isLocallyLimited(resource.id);

    var overallUpPct = (history && history.overall_up_pct != null)
      ? history.overall_up_pct + "%"
      : "—";
    var days = (history && history.days) || [];
    var msg = statusMessage(status, upPct, confidence);

    var card = document.createElement("div");
    card.className = "resource-card";
    card.id = "resource-" + resource.id;

    card.innerHTML =
      '<div class="resource-header">' +
      '  <div class="status-dot ' + status + '"></div>' +
      '  <span class="resource-name">' + esc(resource.name) + "</span>" +
      "</div>" +
      '<p class="status-message ' + status + '">' + esc(msg) + "</p>" +
      '<div class="stats-grid">' +
      '  <div class="stat">' +
      '    <div class="stat-value ' + status + '">' + capitalize(status) + "</div>" +
      '    <div class="stat-label">Current</div>' +
      "  </div>" +
      '  <div class="stat">' +
      '    <div class="stat-value">' + upPct + "%</div>" +
      '    <div class="stat-label">Uptime (24h)</div>' +
      "  </div>" +
      '  <div class="stat">' +
      '    <div class="stat-value">' + overallUpPct + "</div>" +
      '    <div class="stat-label">Uptime (90d)</div>' +
      "  </div>" +
      '  <div class="stat">' +
      '    <div class="stat-value">' + totalReports + "</div>" +
      '    <div class="stat-label">Reports (24h)</div>' +
      "  </div>" +
      "</div>" +
      renderHistoryBar(days) +
      renderComparisons(history && history.overall_up_pct) +
      '<div class="report-buttons">' +
      '  <button class="report-btn up" data-resource="' +
      resource.id +
      '" data-status="up"' +
      (limited ? " disabled" : "") +
      ">It's Working</button>" +
      '  <button class="report-btn down" data-resource="' +
      resource.id +
      '" data-status="down"' +
      (limited ? " disabled" : "") +
      ">It's Down</button>" +
      "</div>" +
      '<div class="user-streak" id="streak-' + resource.id + '"></div>' +
      '<div class="feedback" id="feedback-' + resource.id + '"></div>';

    var btns = card.querySelectorAll(".report-btn");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () {
          handleReport(resource.id, btn.getAttribute("data-status"));
        });
      })(btns[i]);
    }

    return card;
  }

  // ─── Feedback ───────────────────────────────────────────────
  function showFeedback(id, msg, type) {
    var el = document.getElementById("feedback-" + id);
    if (!el) return;
    el.textContent = msg;
    el.className = "feedback show " + type;
    if (type === "success") {
      setTimeout(function () {
        el.className = "feedback";
      }, 5000);
    }
  }

  // ─── Cooldown timer ─────────────────────────────────────────
  var cooldownTimers = {};

  function startCooldown(id) {
    if (cooldownTimers[id]) clearInterval(cooldownTimers[id]);

    var card = document.getElementById("resource-" + id);
    if (!card) return;

    var el = document.getElementById("cooldown-" + id);
    if (!el) {
      el = document.createElement("div");
      el.id = "cooldown-" + id;
      el.className = "feedback show info";
      card.appendChild(el);
    }

    function tick() {
      var rem = remainingSeconds(id);
      if (rem <= 0) {
        clearInterval(cooldownTimers[id]);
        delete cooldownTimers[id];
        if (el.parentNode) el.parentNode.removeChild(el);
        var btns = card.querySelectorAll(".report-btn");
        for (var i = 0; i < btns.length; i++) btns[i].disabled = false;
        return;
      }
      el.textContent = "Cooldown: " + fmtTime(rem);
      el.className = "feedback show info";
    }

    tick();
    cooldownTimers[id] = setInterval(tick, 1000);
  }

  // ─── Submit report ──────────────────────────────────────────
  function handleReport(id, status) {
    if (isLocallyLimited(id)) {
      showFeedback(id, "Please wait before submitting again.", "info");
      return;
    }

    var card = document.getElementById("resource-" + id);
    var btns = card.querySelectorAll(".report-btn");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;

    var savedName = localStorage.getItem("ut_username") || "";
    var payload = { status: status };
    if (savedName) payload.username = savedName;

    postJSON("/resources/" + encodeURIComponent(id) + "/reports", payload)
      .then(function (result) {
        if (result.ok) {
          setLocalLimit(id, 10800);
          startCooldown(id);
          setTimeout(function () {
            refreshResource(id);
          }, 1000);
          fetchReportsToday();

          if (savedName) {
            showReturningModal(savedName, result.data.leaderboard_score || 0, result.data.leaderboard_streak || 0);
          } else {
            showFirstTimeModal();
          }
        } else if (result.status === 429) {
          var retry = result.data.retry_after_seconds || 3600;
          setLocalLimit(id, retry);
          showFeedback(
            id,
            "Rate limited. Try again in " + fmtTime(retry) + ".",
            "error"
          );
          startCooldown(id);
        } else {
          showFeedback(id, result.data.error || "Submission failed.", "error");
          for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
        }
      })
      .catch(function () {
        showFeedback(id, "Network error. Please try again.", "error");
        for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
      });
  }

  // ─── Post-report modals ─────────────────────────────────────
  var reportModal = document.getElementById("report-modal");
  var reportModalBody = document.getElementById("report-modal-body");

  function closeReportModal() {
    reportModal.classList.remove("open");
  }

  function showFirstTimeModal() {
    reportModalBody.innerHTML =
      '<div class="modal-heading">Thanks for reporting! &#127881;</div>' +
      '<p class="modal-text">Drop your name to claim your spot on the global reporter leaderboard.</p>' +
      '<div class="name-input-wrap">' +
      '  <input type="text" id="lb-name-input" maxlength="30" placeholder="Your name" autocomplete="off" />' +
      '  <span class="char-count" id="lb-char-count">0/30</span>' +
      '</div>' +
      '<div class="modal-error" id="lb-error"></div>' +
      '<div class="modal-actions">' +
      '  <button class="modal-btn-primary" id="lb-join-btn">Join Leaderboard</button>' +
      '  <button class="modal-btn-skip" id="lb-skip-btn">Skip</button>' +
      '</div>';

    reportModal.classList.add("open");

    var input = document.getElementById("lb-name-input");
    var charCount = document.getElementById("lb-char-count");
    var errorEl = document.getElementById("lb-error");
    var joinBtn = document.getElementById("lb-join-btn");
    var skipBtn = document.getElementById("lb-skip-btn");

    input.addEventListener("input", function () {
      var len = input.value.length;
      charCount.textContent = len + "/30";
      charCount.className = len >= 28 ? "char-count warn" : "char-count";
      errorEl.textContent = "";
    });

    skipBtn.addEventListener("click", closeReportModal);

    joinBtn.addEventListener("click", function () {
      var name = input.value.trim();
      if (!name) {
        errorEl.textContent = "Please enter a name.";
        return;
      }
      if (!/^[a-zA-Z0-9 _-]+$/.test(name)) {
        errorEl.textContent = "Letters, numbers, spaces, hyphens, and underscores only.";
        return;
      }

      joinBtn.disabled = true;
      joinBtn.textContent = "Joining\u2026";

      postJSON("/leaderboard", { username: name })
        .then(function (result) {
          if (result.ok) {
            localStorage.setItem("ut_username", name);
            showReturningModal(name, result.data.score || 1, result.data.streak || 1);
          } else {
            errorEl.textContent = result.data.error || "Something went wrong.";
            joinBtn.disabled = false;
            joinBtn.textContent = "Join Leaderboard";
          }
        })
        .catch(function () {
          errorEl.textContent = "Network error. Try again.";
          joinBtn.disabled = false;
          joinBtn.textContent = "Join Leaderboard";
        });
    });

    setTimeout(function () { input.focus(); }, 100);
  }

  function showReturningModal(name, score, streak) {
    var streakHtml = streak > 0
      ? '<p class="modal-text">&#128293; ' + streak + '-day streak!</p>'
      : '';
    reportModalBody.innerHTML =
      '<div class="modal-heading">Report logged! &#9989;</div>' +
      '<p class="modal-text">Reported as <strong>' + esc(name) + '</strong>.<br>Your score: <strong>' + score + ' report' + (score !== 1 ? 's' : '') + '</strong></p>' +
      streakHtml +
      '<div class="modal-actions">' +
      '  <button class="modal-btn-dismiss" id="lb-dismiss-btn">Nice!</button>' +
      '  <button class="modal-btn-skip" id="lb-view-btn">View Leaderboard</button>' +
      '</div>';

    reportModal.classList.add("open");

    document.getElementById("lb-dismiss-btn").addEventListener("click", closeReportModal);
    document.getElementById("lb-view-btn").addEventListener("click", function () {
      closeReportModal();
      openLeaderboard();
    });
  }

  // Close modal on overlay click
  reportModal.addEventListener("click", function (e) {
    if (e.target === reportModal) closeReportModal();
  });

  // ─── Leaderboard modal ─────────────────────────────────────
  var lbModal = document.getElementById("leaderboard-modal");
  var lbContent = document.getElementById("leaderboard-content");
  var lbClose = document.getElementById("leaderboard-close");

  // Expose globally for the onclick handler
  window.openLeaderboard = function () {
    lbModal.classList.add("open");
    lbContent.innerHTML = '<div class="loading">Loading&hellip;</div>';

    var username = localStorage.getItem("ut_username") || "";
    var url = "/leaderboard";
    if (username) url += "?username=" + encodeURIComponent(username);

    fetchJSON(url)
      .then(function (data) {
        var lb = (data && data.leaderboard) || [];

        if (lb.length === 0 && !data.user) {
          lbContent.innerHTML = '<div class="lb-empty">No reporters yet. Be the first!</div>';
          return;
        }

        var html = '<ul class="lb-list">';
        for (var i = 0; i < lb.length; i++) {
          var entry = lb[i];
          var rankCls = "";
          if (entry.rank === 1) rankCls = " gold";
          else if (entry.rank === 2) rankCls = " silver";
          else if (entry.rank === 3) rankCls = " bronze";
          var isMe = username && entry.username.toLowerCase() === username.toLowerCase();
          var streakBadge = entry.streak > 0 ? ' <span class="lb-streak">&#128293;' + entry.streak + '</span>' : '';
          html +=
            '<li class="lb-row' + (isMe ? ' highlight' : '') + '">' +
            '  <span class="lb-rank' + rankCls + '">#' + entry.rank + '</span>' +
            '  <span class="lb-name">' + esc(entry.username) + streakBadge + '</span>' +
            '  <span class="lb-count">' + entry.report_count + '</span>' +
            '</li>';
        }
        html += '</ul>';

        if (data.user && data.user.rank > 10) {
          var userStreakBadge = data.user.streak > 0 ? ' &#128293;' + data.user.streak : '';
          html += '<hr class="lb-separator">';
          html += '<div class="lb-user-row">Your rank: <strong>#' + data.user.rank + '</strong> &mdash; ' + esc(data.user.username) + userStreakBadge + ' &mdash; ' + data.user.report_count + ' report' + (data.user.report_count !== 1 ? 's' : '') + '</div>';
        }

        if (!username) {
          html += '<div class="lb-cta">Submit a report to join the leaderboard!</div>';
        }

        lbContent.innerHTML = html;

        updateReportsTodayBadge(data.reports_today || 0);
      })
      .catch(function () {
        lbContent.innerHTML = '<div class="lb-empty">Failed to load leaderboard.</div>';
      });
  };

  lbClose.addEventListener("click", function () {
    lbModal.classList.remove("open");
  });

  lbModal.addEventListener("click", function (e) {
    if (e.target === lbModal) lbModal.classList.remove("open");
  });

  // ─── Reports-today badge ─────────────────────────────────
  function updateReportsTodayBadge(count) {
    var el = document.getElementById("reports-today");
    if (!el) return;
    if (count > 0) {
      el.textContent = "\uD83D\uDCCA " + count + " reporter" + (count !== 1 ? "s" : "") + " contributed today";
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  function fetchReportsToday() {
    var username = localStorage.getItem("ut_username") || "";
    var url = "/leaderboard";
    if (username) url += "?username=" + encodeURIComponent(username);
    fetchJSON(url)
      .then(function (data) {
        updateReportsTodayBadge((data && data.reports_today) || 0);
        if (data && data.user) {
          updateMainPageStreak(data.user);
        }
      })
      .catch(function () { /* silent */ });
  }

  function updateMainPageStreak(user) {
    var els = document.querySelectorAll(".user-streak");
    for (var i = 0; i < els.length; i++) {
      if (user.streak > 0) {
        els[i].innerHTML = "&#128293; " + user.streak + "-day streak &middot; " + user.report_count + " total report" + (user.report_count !== 1 ? "s" : "");
        els[i].style.display = "block";
      } else {
        els[i].style.display = "none";
      }
    }
  }

  // ─── Fetch both status + history for a resource ─────────────
  var historyCache = {};

  function fetchResourceData(id) {
    var enc = encodeURIComponent(id);
    return Promise.all([
      fetchJSON("/resources/" + enc + "/status").catch(function () { return null; }),
      fetchJSON("/resources/" + enc + "/history").catch(function () { return null; })
    ]).then(function (arr) {
      if (arr[1]) historyCache[id] = arr[1];
      return { status: arr[0], history: arr[1] || historyCache[id] || null };
    });
  }

  // ─── Refresh a single card ─────────────────────────────────
  function refreshResource(id) {
    fetchResourceData(id)
      .then(function (data) {
        var existing = document.getElementById("resource-" + id);
        if (!existing) return;
        var resource = null;
        for (var i = 0; i < resourcesCache.length; i++) {
          if (resourcesCache[i].id === id) {
            resource = resourcesCache[i];
            break;
          }
        }
        if (!resource) return;

        var newCard = renderCard(resource, data.status, data.history);
        existing.parentNode.replaceChild(newCard, existing);
        if (isLocallyLimited(id)) startCooldown(id);
      })
      .catch(function () {
        /* silent */
      });
  }

  // ─── Init ──────────────────────────────────────────────────
  function init() {
    container.innerHTML = '<div class="loading">Loading&hellip;</div>';

    fetchJSON("/resources")
      .then(function (data) {
        var resources = (data && data.resources) || [];
        resourcesCache = resources;

        if (resources.length === 0) {
          container.innerHTML =
            '<div class="loading">No resources found.</div>';
          return;
        }

        return Promise.all(
          resources.map(function (r) {
            return fetchResourceData(r.id);
          })
        ).then(function (allData) {
          container.innerHTML = "";
          resources.forEach(function (r, i) {
            var card = renderCard(r, allData[i].status, allData[i].history);
            container.appendChild(card);
            if (isLocallyLimited(r.id)) startCooldown(r.id);
          });

          // Auto-refresh every 30 s
          setInterval(function () {
            resources.forEach(function (r) {
              refreshResource(r.id);
            });
          }, 30000);

          // Fetch reports-today count
          fetchReportsToday();
        });
      })
      .catch(function () {
        container.innerHTML =
          '<div class="loading">Failed to load. Please refresh.</div>';
      });
  }

  init();
})();
