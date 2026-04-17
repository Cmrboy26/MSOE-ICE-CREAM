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

    postJSON("/resources/" + encodeURIComponent(id) + "/reports", {
      status: status,
    })
      .then(function (result) {
        if (result.ok) {
          setLocalLimit(id, 3600);
          showFeedback(id, "Report submitted! Thank you.", "success");
          startCooldown(id);
          setTimeout(function () {
            refreshResource(id);
          }, 1000);
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
        });
      })
      .catch(function () {
        container.innerHTML =
          '<div class="loading">Failed to load. Please refresh.</div>';
      });
  }

  init();
})();
