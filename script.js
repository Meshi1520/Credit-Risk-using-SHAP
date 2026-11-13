(() => {
  "use strict";

  const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ───────── Elements ───────── */
  const form = $("#form");
  const submitBtn = $("#submit");
  const panel = $("#panel");
  const gaugeFill = $("#gaugeFill");
  const pctEl = $("#pct");
  const pctSign = $("#pctSign");
  const verdictEl = $("#verdict");
  const verdictSub = $("#verdictSub");
  const badge = $("#verdictBadge");
  const ltiVal = $("#ltiVal");
  const ltiBar = $("#ltiBar");
  const historyEl = $("#history");
  const clearHistoryBtn = $("#clearHistory");
  const toastEl = $("#toast");
  const statusEl = $("#status");
  const statusText = $("#statusText");

  /* ───────── Numeric fields (number input + slider, kept in sync) ───────── */
  const fields = $$(".field").map((el) => ({
    el,
    key: el.dataset.field,
    isInt: el.dataset.int === "1",
    num: $('input[type="number"]', el),
    range: $('input[type="range"]', el),
    initial: $('input[type="number"]', el).value,
  }));
  const F = Object.fromEntries(fields.map((f) => [f.key, f]));

  const paintRange = (r) => {
    const min = +r.min, max = +r.max;
    const pct = Math.min(100, Math.max(0, ((+r.value - min) / (max - min)) * 100));
    r.style.setProperty("--p", pct + "%");
  };

  fields.forEach((f) => {
    paintRange(f.range);
    f.range.addEventListener("input", () => {
      f.num.value = f.range.value;
      paintRange(f.range);
      updateLti();
    });
    f.num.addEventListener("input", () => {
      if (f.num.value !== "") {
        f.range.value = f.num.value;
        paintRange(f.range);
      }
      updateLti();
    });
  });

  const numVal = (key) => parseFloat(F[key].num.value);
  const radioVal = (name) => $(`input[name="${name}"]:checked`).value;
  const setRadio = (name, value) => {
    const el = $(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };

  /* ───────── Loan-to-income (derived field the API expects) ───────── */
  function currentLti() {
    const income = numVal("person_income");
    const amount = numVal("loan_amnt");
    return income > 0 && Number.isFinite(amount) ? amount / income : NaN;
  }

  function updateLti() {
    const lti = currentLti();
    if (!Number.isFinite(lti)) {
      ltiVal.textContent = "–";
      ltiBar.style.width = "0%";
      return;
    }
    ltiVal.textContent = Math.round(lti * 100) + "%";
    ltiBar.style.width = Math.min(100, (lti / 0.6) * 100) + "%";
    ltiBar.classList.toggle("warn", lti >= 0.3 && lti < 0.45);
    ltiBar.classList.toggle("hot", lti >= 0.45);
  }

  /* ───────── Presets ───────── */
  const PRESETS = {
    low: {
      person_age: 38, person_income: 95000, person_emp_length: 12,
      loan_amnt: 8000, loan_int_rate: 7.5, cb_person_cred_hist_length: 14,
      home: "MORTGAGE", intent: "HOMEIMPROVEMENT", grade: "A", dflt: "N",
    },
    high: {
      person_age: 23, person_income: 28000, person_emp_length: 1,
      loan_amnt: 15000, loan_int_rate: 18.5, cb_person_cred_hist_length: 3,
      home: "RENT", intent: "MEDICAL", grade: "E", dflt: "Y",
    },
  };

  function applyValues(values) {
    Object.entries(values).forEach(([key, value]) => {
      if (F[key]) {
        F[key].num.value = value;
        F[key].range.value = value;
        paintRange(F[key].range);
      } else {
        setRadio(key, value);
      }
    });
    updateLti();
  }

  $$("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => applyValues(PRESETS[btn.dataset.preset]))
  );

  $("#reset").addEventListener("click", () => {
    fields.forEach((f) => {
      f.num.value = f.initial;
      f.range.value = f.initial;
      paintRange(f.range);
    });
    setRadio("home", "RENT");
    setRadio("intent", "PERSONAL");
    setRadio("grade", "B");
    setRadio("dflt", "N");
    updateLti();
    resetResult();
  });

  /* ───────── Payload ───────── */
  function buildPayload() {
    const int = (k) => Math.round(numVal(k));
    return {
      person_age: int("person_age"),
      person_income: int("person_income"),
      person_home_ownership: radioVal("home"),
      person_emp_length: numVal("person_emp_length"),
      loan_intent: radioVal("intent"),
      loan_grade: radioVal("grade"),
      loan_amnt: int("loan_amnt"),
      loan_int_rate: numVal("loan_int_rate"),
      loan_percent_income: Number(currentLti().toFixed(2)),
      cb_person_default_on_file: radioVal("dflt"),
      cb_person_cred_hist_length: int("cb_person_cred_hist_length"),
    };
  }

  /* ───────── API ───────── */
  async function predict(payload) {
    const res = await fetch(`${API_BASE}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (Array.isArray(body.detail) && body.detail[0]) {
          const d = body.detail[0];
          detail = `${(d.loc || []).slice(-1)[0] || "Input"}: ${d.msg}`;
        } else if (typeof body.detail === "string") {
          detail = body.detail;
        }
      } catch (_) { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  }

  async function checkApi() {
    try {
      const res = await fetch(`${API_BASE}/openapi.json`, { cache: "no-store" });
      setStatus(res.ok ? "online" : "offline");
    } catch (_) {
      setStatus("offline");
    }
  }

  function setStatus(state) {
    statusEl.dataset.state = state;
    statusText.textContent =
      state === "online" ? "API online" : state === "offline" ? "API unreachable" : "Connecting to API…";
  }

  /* ───────── Rendering the result ───────── */
  let shownValue = 0;

  function countTo(target, duration = 1300) {
    const from = shownValue;
    shownValue = target;
    if (REDUCED || duration === 0) {
      pctEl.textContent = (target * 100).toFixed(1);
      return;
    }
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      pctEl.textContent = ((from + (target - from) * ease(t)) * 100).toFixed(1);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function retrigger(el) {
    el.classList.remove("pop");
    void el.offsetWidth; // restart the animation
    el.classList.add("pop");
  }

  function renderResult(res, payload) {
    const p = Math.min(1, Math.max(0, res.default_probability));
    const high = res.default_prediction === 1;

    panel.dataset.state = high ? "high" : "low";
    badge.textContent = high ? "High risk" : "Low risk";
    pctSign.hidden = false;

    gaugeFill.style.strokeDashoffset = String(100 - p * 100);
    countTo(p);

    verdictEl.textContent = high ? "Likely to default" : "Likely to repay";
    verdictSub.textContent = high
      ? "The model flags this application as high risk. It applies its own tuned decision threshold, so the verdict can differ from a plain 50% cut-off."
      : "The model classifies this application as low risk. It applies its own tuned decision threshold, so the verdict can differ from a plain 50% cut-off.";
    retrigger(verdictEl);
    retrigger(verdictSub);

    addHistory({ p, high, payload });
  }

  function resetResult() {
    panel.dataset.state = "idle";
    badge.textContent = "Waiting";
    gaugeFill.style.strokeDashoffset = "100";
    pctSign.hidden = true;
    shownValue = 0;
    pctEl.textContent = "--";
    verdictEl.textContent = "No assessment yet";
    verdictSub.innerHTML = "Enter an application and press <b>Assess risk</b>. Your result will appear here.";
  }

  /* ───────── History ───────── */
  const history = [];
  const money = (n) => "$" + n.toLocaleString("en-US");

  function addHistory(entry) {
    history.unshift(entry);
    history.length = Math.min(history.length, 5);
    renderHistory();
  }

  function renderHistory() {
    historyEl.innerHTML = "";
    clearHistoryBtn.hidden = history.length === 0;
    if (!history.length) {
      historyEl.innerHTML = '<li class="empty">Nothing yet.</li>';
      return;
    }
    history.forEach(({ p, high, payload }) => {
      const li = document.createElement("li");
      li.dataset.high = high ? "1" : "0";
      const meta = document.createElement("span");
      meta.className = "h-meta";
      meta.textContent = `${money(payload.loan_amnt)} · Grade ${payload.loan_grade}`;
      const tag = document.createElement("span");
      tag.className = "h-tag";
      tag.innerHTML = "<i></i>";
      tag.append(`${(p * 100).toFixed(1)}%`);
      li.append(meta, tag);
      historyEl.append(li);
    });
  }

  clearHistoryBtn.addEventListener("click", () => {
    history.length = 0;
    renderHistory();
  });

  /* ───────── Submit ───────── */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (!Number.isFinite(currentLti())) {
      showToast("Please enter a valid income and loan amount.");
      return;
    }

    const payload = buildPayload();
    submitBtn.classList.add("loading");
    try {
      // A short minimum delay keeps the loading state from flickering.
      const [res] = await Promise.all([predict(payload), sleep(550)]);
      renderResult(res, payload);
      setStatus("online");
      if (window.matchMedia("(max-width: 920px)").matches) {
        panel.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
      }
    } catch (err) {
      showToast(err instanceof TypeError ? "Couldn't reach the API. Is the server running?" : err.message);
      if (err instanceof TypeError) setStatus("offline");
    } finally {
      submitBtn.classList.remove("loading");
    }
  });

  /* ───────── Toast ───────── */
  let toastTimer;
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4200);
  }

  /* ───────── Cursor glow ───────── */
  if (!REDUCED) {
    let raf = 0, mx = 0, my = 0;
    window.addEventListener("pointermove", (e) => {
      mx = e.clientX; my = e.clientY;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          document.documentElement.style.setProperty("--mx", mx + "px");
          document.documentElement.style.setProperty("--my", my + "px");
          raf = 0;
        });
      }
    });
  }

  /* ───────── Init ───────── */
  updateLti();
  requestAnimationFrame(() => $$("[data-reveal]").forEach((el) => el.classList.add("in")));
  checkApi();
  setInterval(checkApi, 30000);
})();
