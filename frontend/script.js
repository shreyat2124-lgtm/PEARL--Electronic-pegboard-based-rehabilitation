/**
 * PEARL — Rehabilitation Patient Display
 * Web Serial + Firebase session controller
 *
 * Architecture:
 *   FirebaseService   — wraps Firestore writes
 *   SerialManager     — Web Serial connect / read-loop / write
 *   ModalController   — loading / success / error modal states
 *   HomeController    — index.html: connect + start-therapy flow
 *   TherapyController — therapy.html: grid, timers, game logic, summary
 */

(() => {
  "use strict";

  /* ──────────────────────────────────────────────────────
     Constants
     ────────────────────────────────────────────────────── */

  const STORAGE = {
    connected: "pearl.connected",
    sessionSummary: "pearl.sessionSummary",
    userId: "pearl.userId",
  };

  /** Baud rate must match Arduino sketch */
  const BAUD_RATE = 115200;

  /**
   * Threshold in ms for colour-coding reaction times.
   *   ≤ FAST_MS → green
   *   ≥ SLOW_MS → red
   */
  const FAST_MS = 1200;
  const SLOW_MS = 3000;

  /** Auto-dismiss success modal after this many ms */
  const SUCCESS_DISMISS_MS = 2200;

  /* ──────────────────────────────────────────────────────
     Firebase Configuration
     ────────────────────────────────────────────────────── */

  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAVGpKAtuGnze0ReuFnfmXulRoCOWoKuI0",
    authDomain: "embs-hackathon.firebaseapp.com",
    projectId: "embs-hackathon",
    storageBucket: "embs-hackathon.firebasestorage.app",
    messagingSenderId: "538695074132",
    appId: "1:538695074132:web:ebfc159c42a07be25cc8c1",
    measurementId: "G-TLC1S0J8T7",
  };

  /* ══════════════════════════════════════════════════════
     AuthService
     ══════════════════════════════════════════════════════ */

  class AuthService {
    #auth = null;
    
    initialize() {
      if (!window.firebase || !window.firebase.auth) return;
      this.#auth = window.firebase.auth();
    }

    onAuthStateChanged(cb) {
      if (this.#auth) this.#auth.onAuthStateChanged(cb);
    }

    async login(email, password) {
      return await this.#auth.signInWithEmailAndPassword(email, password);
    }

    async logout() {
      return await this.#auth.signOut();
    }

    get currentUser() {
      return this.#auth ? this.#auth.currentUser : null;
    }
  }

  /* ══════════════════════════════════════════════════════
     FirebaseService
     ══════════════════════════════════════════════════════ */

  class FirebaseService {
    #db = null;
    #ready = false;

    initialize() {
      if (this.#ready) return;
      this.#ready = true;

      const fb = window.firebase;
      if (!fb) {
        console.warn("Firebase SDK not loaded — session data will not be saved.");
        return;
      }

      try {
        if (!fb.apps.length) {
          fb.initializeApp(FIREBASE_CONFIG);
        }
        this.#db = fb.firestore ? fb.firestore() : null;
        console.info("Firebase initialised.");
      } catch (err) {
        console.warn("Firebase init failed:", err);
      }
    }

    async saveSession(data) {
      if (!this.#db) {
        console.warn("Firebase not available — skipping session save.");
        return;
      }

      try {
        const ref = await this.#db.collection("therapySessions").add(data);
        console.info("Session saved:", ref.id);
      } catch (err) {
        console.warn("Session save failed:", err);
      }
    }

    async getPatients(doctorId) {
      if (!this.#db) return [];
      const snap = await this.#db.collection("patients").where("doctorId", "==", doctorId).orderBy("createdAt", "desc").get();
      return snap.docs.map(d => ({ docId: d.id, ...d.data() }));
    }

    async addPatient(data) {
      if (!this.#db) return null;
      const ptId = "PT-" + Math.floor(1000 + Math.random() * 9000);
      const payload = { ...data, patientId: ptId, createdAt: new Date().toISOString() };
      const ref = await this.#db.collection("patients").add(payload);
      return { docId: ref.id, patientId: ptId, ...payload };
    }

    async updatePatientProgress(docId, updates) {
      if (!this.#db) return;
      await this.#db.collection("patients").doc(docId).update(updates);
    }
  }

  /* ══════════════════════════════════════════════════════
     SerialManager
     ══════════════════════════════════════════════════════ */

  class SerialManager {
    #port = null;
    #reader = null;
    #writer = null;
    #buffer = "";
    #readActive = false;
    #lineListeners = new Set();
    #statusListeners = new Set();

    get isOpen() {
      return this.#port !== null && (this.#reader !== null || this.#writer !== null);
    }

    /** Subscribe to complete inbound lines. Returns unsubscribe fn. */
    onLine(fn) {
      this.#lineListeners.add(fn);
      return () => this.#lineListeners.delete(fn);
    }

    /** Subscribe to connection status strings. Returns unsubscribe fn. */
    onStatus(fn) {
      this.#statusListeners.add(fn);
      return () => this.#statusListeners.delete(fn);
    }

    #emitLine(line) {
      for (const fn of this.#lineListeners) fn(line);
    }

    #emitStatus(status) {
      for (const fn of this.#statusListeners) fn(status);
    }

    /** Prompt user to select a port, open it and start read loop. */
    async requestAndOpen() {
      if (!navigator.serial) {
        throw new Error(
          "Web Serial is not available. Please use Chrome or Edge on desktop and ensure the site is served over HTTPS or localhost."
        );
      }

      this.#port = await navigator.serial.requestPort();
      await this.#openPort(this.#port);
    }

    /**
     * Silently reconnect to the last-granted port (used on therapy.html load).
     * Returns true if reconnected.
     */
    async reconnectKnownPort() {
      if (!navigator.serial) return false;

      const ports = await navigator.serial.getPorts();
      if (!ports.length) return false;

      this.#port = ports[0];
      await this.#openPort(this.#port);
      return true;
    }

    /** Send a UTF-8 string to the device. */
    async write(message) {
      if (!this.#writer) {
        console.warn("Serial write skipped — no writer available.");
        return;
      }
      await this.#writer.write(new TextEncoder().encode(message));
    }

    /** Close port and clean up. */
    async close() {
      this.#readActive = false;

      try { this.#reader?.releaseLock(); } catch (_) { /* ignore */ }
      try { this.#writer?.releaseLock(); } catch (_) { /* ignore */ }

      this.#reader = null;
      this.#writer = null;

      try { await this.#port?.close(); } catch (_) { /* ignore */ }
      this.#port = null;

      this.#emitStatus("disconnected");
    }

    /* ── private ─────────────────────────────────────── */

    async #openPort(port) {
      // Only call open() if the port is not already open
      if (!port.readable) {
        await port.open({ baudRate: BAUD_RATE });
      } else {
        try {
          await port.open({ baudRate: BAUD_RATE });
        } catch (err) {
          if (!String(err?.message ?? err).includes("already open")) throw err;
        }
      }

      this.#reader = port.readable?.getReader?.() ?? null;
      this.#writer = port.writable?.getWriter?.() ?? null;
      this.#readActive = true;
      this.#startReadLoop();
      this.#emitStatus("connected");
    }

    async #startReadLoop() {
      if (!this.#reader) return;
      const decoder = new TextDecoder();

      try {
        while (this.#readActive) {
          const { value, done } = await this.#reader.read();
          if (done) break;
          if (value) this.#handleChunk(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (this.#readActive) {
          console.warn("Serial read loop terminated:", err);
          this.#emitStatus("error");
        }
      }
    }

    #handleChunk(chunk) {
      this.#buffer += chunk;
      const lines = this.#buffer.split(/\r?\n/);
      this.#buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          console.debug("Serial ←", trimmed);
          this.#emitLine(trimmed);
        }
      }
    }
  }

  /* ══════════════════════════════════════════════════════
     ModalController  (index.html only)
     ══════════════════════════════════════════════════════ */

  class ModalController {
    #overlay = document.getElementById("connectionModal");
    #loading = document.getElementById("modalLoadingState");
    #success = document.getElementById("modalSuccessState");
    #error = document.getElementById("modalErrorState");
    #errorMsg = document.getElementById("modalErrorText");

    constructor() {
      // Close on overlay background click
      this.#overlay?.addEventListener("click", (e) => {
        if (e.target === this.#overlay) this.hide();
      });

      // Close on Escape
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.#overlay?.classList.contains("is-open")) {
          this.hide();
        }
      });
    }

    showLoading(text = "Connecting to device…") {
      this.#setState("loading");
      const h2 = this.#loading?.querySelector("h2");
      if (h2) h2.textContent = text;
      this.#setOpen(true);
    }

    showSuccess() {
      this.#setState("success");
      this.#setOpen(true);
    }

    showError(message) {
      this.#setState("error");
      if (this.#errorMsg) this.#errorMsg.textContent = message;
      this.#setOpen(true);
    }

    hide() {
      this.#setOpen(false);
    }

    onClose(fn) {
      document.getElementById("modalCloseButton")?.addEventListener("click", fn);
      document.getElementById("modalSuccessClose")?.addEventListener("click", fn);
    }

    /* ── private ─────────────────────────────────────── */

    #setState(name) {
      const map = { loading: this.#loading, success: this.#success, error: this.#error };
      for (const [key, el] of Object.entries(map)) {
        if (el) el.hidden = key !== name;
      }
    }

    #setOpen(open) {
      this.#overlay?.classList.toggle("is-open", open);
      this.#overlay?.setAttribute("aria-hidden", String(!open));
      if (open) {
        // Move focus into the modal for accessibility
        requestAnimationFrame(() => {
          const focusable = this.#overlay?.querySelector(
            "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
          );
          focusable?.focus();
        });
      }
    }
  }

  /* ══════════════════════════════════════════════════════
     LoginController  (login.html)
     ══════════════════════════════════════════════════════ */

  class LoginController {
    #auth;
    constructor(auth) { this.#auth = auth; }
    
    init() {
      const form = document.getElementById("loginForm");
      const errEl = document.getElementById("loginError");
      
      this.#auth.onAuthStateChanged((user) => {
        if (user) window.location.href = "dashboard.html";
      });

      form?.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (errEl) errEl.style.display = "none";
        const btn = form.querySelector("button");
        if (btn) btn.disabled = true;
        
        try {
          await this.#auth.login(document.getElementById("email").value, document.getElementById("password").value);
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message;
            errEl.style.display = "block";
          }
          if (btn) btn.disabled = false;
        }
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     DashboardController  (index.html)
     ══════════════════════════════════════════════════════ */

  class DashboardController {
    #serial;
    #auth;
    #firebase;

    constructor(serial, auth, firebase) {
      this.#serial = serial;
      this.#auth = auth;
      this.#firebase = firebase;
    }

    init() {
      this.#auth.onAuthStateChanged((user) => {
        if (!user) window.location.href = "index.html";
        else {
          const docEmail = document.getElementById("docEmail");
          if (docEmail) docEmail.textContent = user.email;
          this.#loadPatients(user.uid);
        }
      });

      document.getElementById("logoutBtn")?.addEventListener("click", () => this.#auth.logout());
      
      const connBtn = document.getElementById("connectionStatus");
      const connectModal = document.getElementById("connectModal");
      const cancelBtn = document.getElementById("cancelConnectBtn");
      const confirmBtn = document.getElementById("confirmConnectBtn");
      const disconnectModal = document.getElementById("disconnectModal");
      const confirmDisconnectBtn = document.getElementById("confirmDisconnectBtn");

      if (connBtn && connectModal) {
        connBtn.addEventListener("click", async () => {
          if (this.#serial.isOpen) {
            disconnectModal.style.display = "flex";
            return;
          }
          connectModal.style.display = "flex";
        });
        
        confirmDisconnectBtn?.addEventListener("click", async () => {
          await this.#serial.close();
          sessionStorage.removeItem(STORAGE.connected);
          this.#updateConnectionUI(false);
          disconnectModal.style.display = "none";
        });
        
        cancelBtn?.addEventListener("click", () => {
          connectModal.style.display = "none";
        });
        
        confirmBtn?.addEventListener("click", async () => {
          const step1 = document.getElementById("connectStep1");
          const step2 = document.getElementById("connectStep2");
          const step3 = document.getElementById("connectStep3");

          step1.style.display = "none";
          step2.style.display = "block";
          
          try {
            await this.#serial.requestAndOpen();
            await this.#serial.write("CONNECTED\n");
            sessionStorage.setItem(STORAGE.connected, "1");
            this.#updateConnectionUI(true);
            
            step2.style.display = "none";
            step3.style.display = "block";
            
            setTimeout(() => {
              connectModal.style.display = "none";
              // Reset modal state for next time
              step3.style.display = "none";
              step1.style.display = "block";
            }, 1200);

          } catch(e) {
            console.error(e);
            // Revert on error or cancel
            step2.style.display = "none";
            step1.style.display = "block";
            connectModal.style.display = "none";
          }
        });
      }

      if (sessionStorage.getItem(STORAGE.connected)) {
        this.#serial.reconnectKnownPort().then(ok => this.#updateConnectionUI(ok));
      }
    }

    #updateConnectionUI(connected) {
      const txt = document.getElementById("connectionStatusText");
      const dot = document.getElementById("statusDot");
      const kpiTxt = document.getElementById("kpiConnText");
      
      if (txt) txt.textContent = connected ? "Connected" : "Disconnected (Click to Connect)";
      if (dot) dot.parentElement.parentElement.classList.toggle("is-connected", connected);
      
      if (kpiTxt) {
        kpiTxt.textContent = connected ? "Online" : "Offline";
        kpiTxt.style.color = connected ? "#1b5e20" : "#c00";
        kpiTxt.style.fontWeight = "bold";
      }
    }

    async #loadPatients(uid) {
      const pts = await this.#firebase.getPatients(uid);
      
      const kpiPts = document.getElementById("kpiPatients");
      if (kpiPts) kpiPts.textContent = pts.length;
      
      let totalSess = 0;
      pts.forEach(p => totalSess += (p.sessionsCompleted || 0));
      const kpiSess = document.getElementById("kpiSessions");
      if (kpiSess) kpiSess.textContent = totalSess;

      const tbody = document.getElementById("patientTableBody");
      if (!tbody) return;

      if (pts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-3);">No patients found. Click New Patient to start.</td></tr>';
        return;
      }

      tbody.innerHTML = pts.map(p => {
        let accBadges = '—';
        if (p.last3Accuracies && p.last3Accuracies.length > 0) {
           accBadges = p.last3Accuracies.map(a => `<span class="badge ${a >= 80 ? 'badge-good' : (a < 50 ? 'badge-bad' : 'badge-warn')}" style="margin-right: 4px; padding: 4px 6px; font-size: 0.8rem;">${a}%</span>`).join('');
        }
        
        let rtBadges = '—';
        if (p.last3ReactionTimes && p.last3ReactionTimes.length > 0) {
           rtBadges = p.last3ReactionTimes.map(rt => `<span style="font-variant-numeric: tabular-nums; background: #f8fafc; padding: 4px 6px; border-radius: 4px; font-size: 0.8rem; border: 1px solid #cbd5e1; margin-right: 4px; color: #475569;">${(rt/1000).toFixed(2)}s</span>`).join('');
        }

        return `
        <tr>
          <td><strong style="color: #0f172a;">${p.name}</strong><br><span style="font-family: monospace; font-size: 0.75rem; color: #64748b;">${p.patientId}</span></td>
          <td><span class="condition-pill">${p.condition}</span></td>
          <td><span class="badge badge-level">Lvl ${p.currentLevel ?? 0}</span></td>
          <td><strong style="color: #475569;">${p.sessionsCompleted ?? 0}</strong></td>
          <td>${accBadges}</td>
          <td>${rtBadges}</td>
          <td>
            <button class="win-btn start-therapy-btn" data-doc="${p.docId}" data-ptid="${p.patientId}" data-name="${p.name}" data-level="${p.currentLevel ?? 1}" style="font-weight: bold; border-color: #3c7fb1; padding: 4px 10px; display: inline-flex; align-items: center; margin-right:5px;">
              <svg viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" stroke-width="2" style="margin-right: 5px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              Resume Session
            </button>
            <button class="win-btn new-visit-btn" data-doc="${p.docId}" data-ptid="${p.patientId}" data-name="${p.name}" data-level="1" style="font-weight: bold; border-color: #3c7fb1; padding: 4px 10px; display: inline-flex; align-items: center; margin-left:5px;">
              <svg viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" stroke-width="2" style="margin-right: 5px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              Start Over
            </button>
          </td>
        </tr>
      `}).join("");

      tbody.querySelectorAll('.start-therapy-btn, .new-visit-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          try {
            const ports = await navigator.serial.getPorts();
            if (ports.length === 0) {
              alert("Hardware not connected! Please click 'Connect Hardware' first.");
              return;
            }
          } catch(err) {}

          const ds = e.target.dataset;
          sessionStorage.setItem("pearl.ptDocId", ds.doc);
          sessionStorage.setItem("pearl.ptId", ds.ptid);
          sessionStorage.setItem("pearl.ptName", ds.name);
          sessionStorage.setItem("pearl.level", ds.level);
          window.location.href = "therapy.html";
        });
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     NewPatientController  (new_patient.html)
     ══════════════════════════════════════════════════════ */

  class NewPatientController {
    #auth;
    #firebase;

    constructor(auth, firebase) {
      this.#auth = auth;
      this.#firebase = firebase;
    }

    init() {
      this.#auth.onAuthStateChanged((user) => {
        if (!user) window.location.href = "index.html";
      });

      const form = document.getElementById("newPatientForm");
      const radios = document.querySelectorAll('input[type="radio"]');
      const resultCard = document.getElementById("resultCard");
      const suggestedLabel = document.getElementById("suggestedLevelDisplay");
      const suggestedNote = document.getElementById("suggestedLevelNote");
      const overrideSelect = document.getElementById("overrideLevel");
      const startBtn = document.getElementById("saveStartBtn");
      const printBtn = document.getElementById("printReportBtn");

      let suggestedLevel = 1;

      // Report UI Updaters
      const updateReportText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val || "—";
      };

      const dateEl = document.getElementById("reportDate");
      if (dateEl) {
        dateEl.textContent = `Generated: ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
      }

      ['ptName', 'ptAge', 'ptCondition', 'ptHand', 'ptNotes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('input', () => {
            let val = el.value;
            if (id === 'ptCondition' && val) val = el.options[el.selectedIndex].text;
            updateReportText('rp' + id.replace('pt', ''), val);
          });
        }
      });

      const updateReportLevel = () => {
        let finalLevel = suggestedLevel;
        if (overrideSelect && overrideSelect.value !== "auto") {
          finalLevel = parseInt(overrideSelect.value, 10);
        }
        updateReportText('rpLevel', `Level ${finalLevel}`);
      };

      overrideSelect?.addEventListener('change', updateReportLevel);
      printBtn?.addEventListener('click', () => window.print());

      const calculateScore = () => {
        const checked = document.querySelectorAll('input[type="radio"]:checked');
        
        // Update report for radios
        checked.forEach(r => {
          const label = r.getAttribute('data-label') || r.nextElementSibling.textContent;
          updateReportText('rp' + r.name.toUpperCase(), label);
        });

        if (checked.length < 5) return;

        let total = 0;
        checked.forEach(r => total += parseInt(r.value, 10));

        if (total <= 3) {
          suggestedLevel = 2;
          suggestedNote.textContent = "Random Targets";
        } else if (total <= 7) {
          suggestedLevel = 1;
          suggestedNote.textContent = "Sequential Targeting";
        } else if (total <= 11) {
          suggestedLevel = 0;
          suggestedNote.textContent = "Orientation";
        } else {
          suggestedLevel = 0;
          suggestedNote.textContent = "Orientation (Supervised use recommended)";
        }

        if (suggestedLabel) suggestedLabel.textContent = `Level ${suggestedLevel}`;
        if (resultCard) {
          resultCard.hidden = false;
          resultCard.style.display = 'block';
        }
        if (startBtn) startBtn.disabled = false;
        
        // Also update the report print side
        updateReportLevel();
      };

      radios.forEach(r => r.addEventListener("change", calculateScore));

      form?.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (startBtn) {
          startBtn.disabled = true;
          startBtn.textContent = "Saving...";
        }

        let finalLevel = suggestedLevel;
        if (overrideSelect && overrideSelect.value !== "auto") {
          finalLevel = parseInt(overrideSelect.value, 10);
        }

        const data = {
          doctorId: this.#auth.currentUser.uid,
          name: document.getElementById("ptName").value,
          age: parseInt(document.getElementById("ptAge").value, 10),
          condition: document.getElementById("ptCondition").value,
          currentLevel: finalLevel,
          sessionsCompleted: 0,
          progressScore: 0
        };

        try {
          const ports = await navigator.serial.getPorts();
          if (ports.length === 0) {
            alert("Hardware not connected! Please connect the PEARL device before starting.");
            if (startBtn) {
              startBtn.disabled = false;
              startBtn.textContent = "Confirm Intake & Start Session";
            }
            return;
          }
        } catch(err) {}

        try {
          const pt = await this.#firebase.addPatient(data);
          sessionStorage.setItem("pearl.ptDocId", pt.docId);
          sessionStorage.setItem("pearl.ptId", pt.patientId);
          sessionStorage.setItem("pearl.ptName", pt.name);
          sessionStorage.setItem("pearl.level", String(finalLevel));
          window.location.href = "therapy.html";
        } catch(err) {
          console.error(err);
          if (startBtn) startBtn.textContent = "Error saving";
        }
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     TherapyController  (therapy.html)
     ══════════════════════════════════════════════════════ */

  class TherapyController {
    #serial;
    #firebase;

    // DOM refs
    #grid = document.getElementById("therapyGrid");
    #statusEl = document.getElementById("sessionStatus");
    #statusDot = document.getElementById("statusDot");
    #hitScoreEl = document.getElementById("hitScore");
    #lastRTEl = document.getElementById("lastRT");
    #noConnNotice = document.getElementById("noConnectionNotice");
    #reactionBarWrap = document.getElementById("reactionBarWrap");
    #reactionBarFill = document.getElementById("reactionBarFill");
    #reactionBarLbl = document.getElementById("reactionBarLabel");
    #nextLevelBtn = document.getElementById("nextLevelBtn");
    #skipModal = document.getElementById("skipModal");
    #cancelSkipBtn = document.getElementById("cancelSkipBtn");
    #confirmSkipBtn = document.getElementById("confirmSkipBtn");
    #abortSessionBtn = document.getElementById("abortSessionBtn");

    // State
    #cells = [];
    #currentTarget = null;   // index 0–15
    #targetAt = null;   // performance.now() when target was set
    #reactionTimes = [];     // { index, ms }
    #hitCount = 0;
    #wrongCount = 0;
    #sessionStart = Date.now();
    #reactionTimer = null;   // requestAnimationFrame id for the bar
    #sessionId = crypto?.randomUUID?.() ?? String(Date.now());
    #sessionEnded = false;
    #levelPlayed = 1;

    constructor(serial, firebase) {
      this.#serial = serial;
      this.#firebase = firebase;
    }

    async init() {
      this.#levelPlayed = parseInt(sessionStorage.getItem("pearl.level") || "1", 10);
      this.#buildGrid();
      this.#serial.onLine((line) => this.#processLine(line));

      if (this.#levelPlayed === 0 && this.#nextLevelBtn) {
        this.#nextLevelBtn.hidden = false;
        this.#nextLevelBtn.addEventListener("click", () => this.#showSkipModal());
      }
      
      if (this.#cancelSkipBtn) {
        this.#cancelSkipBtn.addEventListener("click", () => this.#hideSkipModal());
      }
      if (this.#confirmSkipBtn) {
        this.#confirmSkipBtn.addEventListener("click", () => this.#advanceToLevel1());
      }
      if (this.#abortSessionBtn) {
        this.#abortSessionBtn.addEventListener("click", () => this.#abortSession());
      }

      const reconnected = await this.#tryReconnect();

      if (!reconnected) {
        this.#setStatus("No hardware connection — please return to dashboard.");
      }
    }

    async #abortSession() {
      if (this.#sessionEnded) return;
      
      const confirmAbort = confirm("Are you sure you want to abort the session? Partial data will be saved.");
      if (!confirmAbort) return;

      this.#setStatus("Session Aborted", "idle");
      
      try {
        await this.#serial.write("END\n"); 
      } catch(e) {}

      await this.#onSessionEnd(true);
    }

    /* ── Grid ────────────────────────────────────────── */

    #buildGrid() {
      if (!this.#grid) return;
      this.#grid.innerHTML = "";
      this.#cells = Array.from({ length: 16 }, (_, i) => {
        const cell = document.createElement("div");
        cell.className = "therapy-cell is-inactive";
        cell.dataset.index = String(i);
        cell.dataset.num = String(i + 1);
        cell.setAttribute("role", "img");
        cell.setAttribute("aria-label", `Position ${i + 1}`);
        this.#grid.appendChild(cell);
        return cell;
      });
    }

    /* ── Modal logic ────────────────────────────── */

    #showSkipModal() {
      if (this.#skipModal) {
        this.#skipModal.classList.add("is-open");
        this.#skipModal.setAttribute("aria-hidden", "false");
        this.#skipModal.hidden = false;
      }
    }

    #hideSkipModal() {
      if (this.#skipModal) {
        this.#skipModal.classList.remove("is-open");
        this.#skipModal.setAttribute("aria-hidden", "true");
        this.#skipModal.hidden = true;
      }
    }

    async #advanceToLevel1() {
      this.#hideSkipModal();
      this.#levelPlayed = 1;
      sessionStorage.setItem("pearl.level", "1");
      if (this.#nextLevelBtn) this.#nextLevelBtn.hidden = true;
      this.#hitCount = 0;
      this.#wrongCount = 0;
      this.#reactionTimes = [];
      if (this.#hitScoreEl) this.#hitScoreEl.textContent = "0";
      
      try {
        await this.#serial.write(`LEVEL:1\n`);
        await this.#serial.write("START\n");
      } catch (e) {}
      
      this.#setStatus("Advanced to Level 1", "idle");
      this.#sessionStart = Date.now();
    }

    /* ── Serial reconnect ────────────────────────────── */

    async #tryReconnect() {
      try {
        const ok = await this.#serial.reconnectKnownPort();
        if (ok) {
          try {
            await this.#serial.write(`LEVEL:${this.#levelPlayed}\n`);
            await this.#serial.write("START\n");
          } catch(e) {
            console.warn("Failed to send start commands", e);
          }
          this.#setStatus("Connected — waiting for target");
          this.#sessionStart = Date.now();
          return true;
        }
      } catch (err) {
        console.warn("Reconnect failed:", err);
      }
      return false;
    }

    /* ── Reaction-time progress bar ──────────────────── */

    #startReactionBar() {
      this.#reactionBarWrap?.classList.add("is-active");
      const MAX_MS = SLOW_MS;
      const origin = performance.now();

      const frame = () => {
        if (this.#currentTarget === null) return; // target cleared — stop
        const elapsed = performance.now() - origin;
        const pct = Math.min((elapsed / MAX_MS) * 100, 100);
        if (this.#reactionBarFill) this.#reactionBarFill.style.width = `${pct}%`;
        if (this.#reactionBarLbl) this.#reactionBarLbl.textContent = `${Math.round(elapsed)} ms`;
        this.#reactionTimer = requestAnimationFrame(frame);
      };

      cancelAnimationFrame(this.#reactionTimer);
      this.#reactionTimer = requestAnimationFrame(frame);
    }

    #stopReactionBar() {
      cancelAnimationFrame(this.#reactionTimer);
      this.#reactionBarWrap?.classList.remove("is-active");
      if (this.#reactionBarFill) this.#reactionBarFill.style.width = "0%";
      if (this.#reactionBarLbl) this.#reactionBarLbl.textContent = "0 ms";
    }

    /* ── Hardware Mapping ────────────────────────────── */

    #mapIndex(physicalIndex) {
      const sensorMap = [
        0, 2, 4, 6,
        1, 3, 5, 7,
        8, 10, 12, 14,
        9, 11, 13, 15
      ];
      const logicalIndex = sensorMap.indexOf(physicalIndex);
      return logicalIndex !== -1 ? logicalIndex : physicalIndex;
    }

    /* ── Serial line parser ──────────────────────────── */

    #processLine(line) {
      if (this.#sessionEnded) return;

      const tMatch = line.match(/^T:(\d{1,2})$/);
      const hMatch = line.match(/^H:(\d{1,2})$/);
      const wMatch = line.match(/^W:(\d{1,2})$/);

      if (tMatch) return this.#onTarget(Number(tMatch[1]));
      if (hMatch) return this.#onCorrectHit(Number(hMatch[1]));
      if (wMatch) return this.#onWrongHit(Number(wMatch[1]));
      if (line === "PROCEED") return this.#advanceToLevel1();
      if (line === "END") return this.#onSessionEnd();
      if (line === "RESTART") return this.#handleRestart();
    }

    #handleRestart() {
      this.#hitCount = 0;
      this.#wrongCount = 0;
      this.#reactionTimes = [];
      this.#currentTarget = null;
      this.#targetAt = null;
      this.#sessionStart = Date.now(); // Reset total time!
      
      if (this.#hitScoreEl) this.#hitScoreEl.textContent = "0";
      this.#updateLiveAccuracy();
      this.#stopReactionBar();
      this.#clearPreviousTarget();
      
      this.#setStatus("Target timeout! Restarting level...", "wrong");
      
      // Inject prominent visual overlay
      const gridWrap = document.querySelector(".therapy-grid-wrapper") || document.body;
      if (gridWrap !== document.body) gridWrap.style.position = "relative";
      
      const overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.backgroundColor = "rgba(220, 38, 38, 0.95)"; // Deep red, slight transparency
      overlay.style.color = "white";
      overlay.style.display = "flex";
      overlay.style.flexDirection = "column";
      overlay.style.justifyContent = "center";
      overlay.style.alignItems = "center";
      overlay.style.zIndex = "9999";
      overlay.style.borderRadius = gridWrap !== document.body ? "24px" : "0px";
      overlay.style.animation = "pulse 1s infinite alternate";
      
      overlay.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" width="80" height="80" stroke="currentColor" stroke-width="2" style="margin-bottom: 20px;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <h2 style="font-size: 2.5rem; margin-bottom: 12px; font-weight: 800;">Time Limit Exceeded</h2>
        <p style="font-size: 1.2rem; font-weight: 500; opacity: 0.9;">Restarting Level ${this.#levelPlayed}...</p>
      `;
      
      gridWrap.appendChild(overlay);
      
      // Remove overlay after the Arduino finishes its 2.8s restart animation
      setTimeout(() => {
         if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
         this.#setStatus("Level Restarted — Waiting for Target", "idle");
      }, 3000);
    }

    /* ── Game events ─────────────────────────────────── */

    #onTarget(index) {
      if (index < 0 || index > 15) return;

      // Clear previous target visual without removing its state
      this.#clearPreviousTarget();

      // Activate new target
      this.#currentTarget = index;
      this.#targetAt = performance.now();

      const cell = this.#cells[index];
      if (cell) {
        cell.classList.remove("is-inactive", "is-hit", "is-wrong");
        cell.classList.add("is-target");
        cell.setAttribute("aria-label", `Target: Position ${index + 1}`);
      }

      this.#setStatus(`Place peg at position ${index + 1}`, "active");
      this.#startReactionBar();
    }

    #onCorrectHit(index) {
      if (index < 0 || index > 15) return;

      const cell = this.#cells[index];
      if (cell) {
        cell.classList.remove("is-target", "is-wrong", "is-inactive");
        cell.classList.add("is-hit");
        cell.setAttribute("aria-label", `Hit: Position ${index + 1}`);
      }

      if (this.#currentTarget === index && this.#targetAt !== null) {
        const ms = Math.max(0, Math.round(performance.now() - this.#targetAt));
        this.#reactionTimes.push({ index, ms });
        this.#hitCount++;
        this.#updateLiveAccuracy();
        if (this.#hitScoreEl) this.#hitScoreEl.textContent = String(this.#hitCount);
        if (this.#lastRTEl) this.#lastRTEl.textContent = `${ms} ms`;
      }

      this.#currentTarget = null;
      this.#targetAt = null;
      this.#stopReactionBar();
      this.#setStatus("Waiting for next target…", "idle");
    }

    #updateLiveAccuracy() {
      const total = this.#hitCount + this.#wrongCount;
      if (total === 0) return;
      const acc = Math.round((this.#hitCount / total) * 100);
      const accEl = document.getElementById("liveAccuracy");
      if (accEl) accEl.textContent = `${acc}%`;
    }

    #onWrongHit(index) {
      if (index < 0 || index > 15) return;

      this.#wrongCount++;
      this.#updateLiveAccuracy();

      const cell = this.#cells[index];
      if (!cell) return;

      const wasTarget = cell.classList.contains("is-target");
      cell.classList.remove("is-wrong");
      void cell.offsetWidth;
      cell.classList.add("is-wrong");
      this.#setStatus(`Wrong — peg position ${(this.#currentTarget ?? 0) + 1}`, "wrong");

      setTimeout(() => {
        cell.classList.remove("is-wrong");
        if (wasTarget) cell.classList.add("is-target");
        else cell.classList.add("is-inactive");
        if (this.#currentTarget !== null) this.#setStatus(`Place peg at position ${this.#currentTarget + 1}`, "active");
      }, 700);
    }

    #clearPreviousTarget() {
      if (this.#currentTarget === null) return;
      const prev = this.#cells[this.#currentTarget];
      if (prev) {
        prev.classList.remove("is-target");
        prev.classList.add("is-inactive");
        prev.setAttribute("aria-label", `Position ${this.#currentTarget + 1}`);
      }
    }

    /* ── Session end ─────────────────────────────────── */

    async #onSessionEnd(isAborted = false) {
      if (this.#sessionEnded) return;
      this.#sessionEnded = true;

      this.#stopReactionBar();
      this.#clearPreviousTarget();
      this.#currentTarget = null;
      this.#setStatus("Session complete", "idle");

      for (const cell of this.#cells) {
        cell.classList.remove("is-target", "is-wrong");
        if (!cell.classList.contains("is-hit")) cell.classList.add("is-inactive");
      }
      
      // Show Windows 7 Loading Overlay
      const overlay = document.createElement("div");
      overlay.style.position = "fixed";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
      overlay.style.zIndex = "9999";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      
      overlay.innerHTML = `
        <div class="win-panel" style="width: 400px; padding: 0; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
          <div class="win-panel-title" style="background: linear-gradient(180deg, #95b3d7 0%, #547cc4 50%, #3e68b8 50%, #5c85cc 100%); color: white; border-bottom: 1px solid #111; padding: 6px 10px;">
            Compiling Analytics
          </div>
          <div class="win-panel-body" style="background: #f0f0f0; padding: 25px; text-align: center;">
            <svg viewBox="0 0 24 24" fill="none" width="48" height="48" stroke="#3c7fb1" stroke-width="1.5" style="margin-bottom: 15px;">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            <div style="font-weight: bold; margin-bottom: 5px;">Synchronizing Session Data...</div>
            <div style="color: #666; font-size: 11px; margin-bottom: 15px;">Saving clinical metrics securely to database. Please wait.</div>
            <div class="win-progress">
              <div class="win-progress-bar"></div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Build initial payload
      const payload = this.#buildPayload(isAborted);

      let patientAge = 0;
      let patientCondition = "Unknown";

      // Update Patient Progress
      const docId = sessionStorage.getItem("pearl.ptDocId");
      if (docId) {
        try {
          const ptRef = window.firebase.firestore().collection("patients").doc(docId);
          const docSnap = await ptRef.get();
          if (docSnap.exists) {
            const data = docSnap.data();
            patientAge = data.age || 0;
            patientCondition = data.condition || "Unknown";
            const currSess = data.sessionsCompleted || 0;
            const newProg = Math.round(((data.progressScore || 0) * currSess + payload.accuracy) / (currSess + 1));
            
            let accQueue = data.last3Accuracies || [];
            let rtQueue = data.last3ReactionTimes || [];

            if (!isAborted) {
              accQueue.push(payload.accuracy);
              if (accQueue.length > 3) accQueue.shift();
              
              rtQueue.push(payload.averageReactionMs);
              if (rtQueue.length > 3) rtQueue.shift();
            }

            let accTrend = 0;
            if (accQueue.length >= 2) {
              const prevAvg = accQueue.slice(0, -1).reduce((a,b)=>a+b,0) / (accQueue.length - 1);
              accTrend = payload.accuracy - prevAvg;
            }

            let rtTrend = 0;
            if (rtQueue.length >= 2) {
              const prevRtAvg = rtQueue.slice(0, -1).reduce((a,b)=>a+b,0) / (rtQueue.length - 1);
              rtTrend = payload.averageReactionMs - prevRtAvg;
            }

            payload.accTrend = Number(accTrend.toFixed(2));
            payload.timeTrend = Number(rtTrend.toFixed(2));
            
            // --- ML MODEL DECISION TREE ---
            const acc3 = accQueue.length > 0 ? accQueue.reduce((a,b)=>a+b,0) / accQueue.length : 0;
            const currentLevel = this.#levelPlayed;
            const sessionsOnLevel = (data.sessionsOnCurrentLevel || 0) + (!isAborted ? 1 : 0);
            let action = isAborted ? 'aborted' : 'stay';
            let advLvl = currentLevel;
            
            if (!isAborted) {
              if (currentLevel >= 5) {
                if (acc3 < 50 && sessionsOnLevel >= 3 && accTrend <= 0) action = 'demote';
              } else if (currentLevel <= 1) {
                if (acc3 >= 80 && accTrend >= 0 && sessionsOnLevel >= 2) action = 'promote';
              } else {
                if (acc3 >= 80 && accTrend >= 0 && sessionsOnLevel >= 2 && payload.wrongs <= 3) {
                  action = 'promote';
                } else if (acc3 < 50 && sessionsOnLevel >= 3 && accTrend <= 0) {
                  action = 'demote';
                } else if (payload.accuracy < 40 && payload.averageReactionMs > 3500 && payload.wrongs >= 6) {
                  action = 'demote';
                }
              }
              
              if (action === 'promote') advLvl = Math.min(5, currentLevel + 1);
              if (action === 'demote') advLvl = Math.max(1, currentLevel - 1);
            }

            payload.sessionsOnCurrentLevel = data.currentLevel === advLvl ? sessionsOnLevel : 1;
            payload.sessionNumber = currSess + 1;
            payload.mlAction = action;

            await ptRef.update({
              sessionsCompleted: payload.sessionNumber,
              sessionsOnCurrentLevel: payload.sessionsOnCurrentLevel,
              progressScore: newProg,
              currentLevel: advLvl,
              last3Accuracies: accQueue,
              last3ReactionTimes: rtQueue
            });
          }
        } catch(e) { console.warn("Patient progress update failed", e); }
      }
      
      // Finalize payload for DB and Export
      const finalPayload = {
         ...payload,
         patientId: sessionStorage.getItem("pearl.ptId"),
         doctorId: window.firebase.auth().currentUser?.uid || "Unknown",
         age: patientAge,
         condition: patientCondition
      };
      
      // Save full session to Firebase
      await this.#firebase.saveSession(finalPayload);
      
      const appsScriptUrl = "https://script.google.com/macros/s/AKfycbydQYmQ-ZsVauqTdk93tfbYlBwG8TUufrYea5KeYOppMiPJTYc7GPHSWvqJNDNU6XvX/exec";
      if (appsScriptUrl && appsScriptUrl !== "YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL") {
        fetch(appsScriptUrl, {
          method: "POST",
          mode: "no-cors",
          headers: {
            "Content-Type": "text/plain"
          },
          body: JSON.stringify(finalPayload)
        }).catch(err => console.warn("GAS Log Error:", err));
      }

      // We pass the full payload to session storage so result.html can display it
      sessionStorage.removeItem(STORAGE.connected);
      sessionStorage.setItem(STORAGE.sessionSummary, JSON.stringify(finalPayload));
      
      // Short delay so the patient sees the final grid state
      await new Promise(r => setTimeout(r, 600));

      window.location.href = "result.html";
    }

    /* ── Summary ─────────────────────────────────────── */

    #averageMs() {
      if (!this.#reactionTimes.length) return null;
      const total = this.#reactionTimes.reduce((s, e) => s + e.ms, 0);
      return Math.round(total / this.#reactionTimes.length);
    }

    #bestMs() {
      if (!this.#reactionTimes.length) return null;
      return Math.min(...this.#reactionTimes.map((e) => e.ms));
    }

    #buildPayload(isAborted = false) {
      const totalTime = Date.now() - this.#sessionStart;
      const totalAttempts = this.#hitCount + this.#wrongCount;
      const accuracy = totalAttempts > 0 ? Math.round((this.#hitCount / totalAttempts) * 100) : 0;
      
      const rts = this.#reactionTimes.map((e) => e.ms);
      const avgMs = this.#averageMs() || 0;
      
      let varianceRT = 0;
      if (rts.length > 1) {
        const sumSq = rts.reduce((sum, rt) => sum + Math.pow(rt - avgMs, 2), 0);
        varianceRT = Math.round(Math.sqrt(sumSq / rts.length));
      }

      let fatigueIndex = 1.0;
      if (rts.length >= 4) {
        const mid = Math.floor(rts.length / 2);
        const firstHalf = rts.slice(0, mid);
        const secondHalf = rts.slice(mid);
        const avgFirst = firstHalf.reduce((a,b)=>a+b,0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a,b)=>a+b,0) / secondHalf.length;
        if (avgFirst > 0) fatigueIndex = Number((avgSecond / avgFirst).toFixed(2));
      }

      return {
        sessionId: this.#sessionId,
        levelPlayed: this.#levelPlayed,
        userId: sessionStorage.getItem("pearl.ptId") ?? null,
        startedAt: new Date(this.#sessionStart).toISOString(),
        endedAt: new Date().toISOString(),
        totalTimeMs: totalTime,
        totalTargets: this.#reactionTimes.length,
        hits: this.#hitCount,
        wrongs: this.#wrongCount,
        accuracy: accuracy,
        averageReactionMs: avgMs,
        bestReactionMs: this.#bestMs(),
        reactionTimes: rts,
        varianceRT: varianceRT,
        fatigueIndex: fatigueIndex,
        detailedResponses: this.#reactionTimes,
        isAborted: isAborted
      };
    }

    /* ── Helpers ─────────────────────────────────────── */

    #setStatus(text, state = "idle") {
      if (this.#statusEl) this.#statusEl.textContent = text;
      if (this.#statusDot) {
        this.#statusDot.className = "t-status-dot";
        if (state === "active") this.#statusDot.classList.add("is-active");
        if (state === "wrong") this.#statusDot.classList.add("is-wrong");
        if (state === "hit") this.#statusDot.classList.add("is-hit");
      }
    }
  }

  /* ══════════════════════════════════════════════════════
     ResultController  (result.html)
     ══════════════════════════════════════════════════════ */

  class ResultController {
    init() {
      const summaryData = sessionStorage.getItem(STORAGE.sessionSummary);
      if (!summaryData) {
        console.warn("No session data found.");
        return;
      }
      const payload = JSON.parse(summaryData);
      
      const levelEl = document.getElementById("levelPlayedDisplay");
      const avgEl = document.getElementById("averageReaction");
      const bestEl = document.getElementById("bestReaction");
      const accEl = document.getElementById("summaryAccuracy");
      const hitsEl = document.getElementById("summaryHits");
      const totalEl = document.getElementById("summaryTotal");
      const timeEl = document.getElementById("totalTimeDisplay");
      
      if (levelEl) levelEl.textContent = `Level Played: ${payload.levelPlayed}`;
      if (avgEl) avgEl.textContent = payload.averageReactionMs !== null ? `${payload.averageReactionMs} ms` : "—";
      if (bestEl) bestEl.textContent = payload.bestReactionMs !== null ? `${payload.bestReactionMs} ms` : "—";
      if (accEl) accEl.textContent = `${payload.accuracy}%`;
      if (hitsEl) hitsEl.textContent = String(payload.hits);
      if (totalEl) totalEl.textContent = String(payload.hits + (payload.wrongs || 0));
      if (timeEl) timeEl.textContent = payload.totalTimeMs ? `${Math.round(payload.totalTimeMs / 1000)} s` : "—";

      this.#renderRecommendation(payload);
      this.#renderChart(payload);
      
      const playAgainBtn = document.getElementById("playAgainBtn");
      const nextLevelBtn = document.getElementById("nextLevelBtn");
      
      if (playAgainBtn) {
        playAgainBtn.addEventListener("click", () => {
          sessionStorage.setItem("pearl.level", payload.levelPlayed);
          window.location.href = "therapy.html";
        });
      }
      
      if (nextLevelBtn) {
        if (payload.levelPlayed < 5) {
          nextLevelBtn.style.display = "inline-flex";
          if (payload.mlAction === 'promote') {
            nextLevelBtn.classList.add("btn-primary");
            nextLevelBtn.style.background = "linear-gradient(180deg, #f2f2f2 0%, #d9f0fc 50%, #bee6fd 50%, #a7d9f5 100%)";
            nextLevelBtn.style.borderColor = "#3c7fb1";
          }
        }
        
        nextLevelBtn.addEventListener("click", () => {
          const nextLevel = Math.min(5, payload.levelPlayed + 1);
          sessionStorage.setItem("pearl.level", nextLevel);
          window.location.href = "therapy.html";
        });
      }
    }

    #renderRecommendation(payload) {
      const card = document.getElementById("mlDecisionCard");
      const title = document.getElementById("recTitle");
      const desc = document.getElementById("recDesc");
      const icon = document.getElementById("mlHeroIcon");
      if (!card || !title || !desc || !icon) return;

      const action = payload.mlAction || 'stay';

      if (action === 'promote') {
        card.className = "ml-hero-card is-advance";
        title.textContent = "PROMOTE";
        desc.textContent = "Recommendation: Patient is ready to advance to the next therapy level.";
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="32" height="32"><path d="M5 10l7-7m0 0l7 7m-7-7v18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      } else if (action === 'demote') {
        card.className = "ml-hero-card is-demote";
        title.textContent = "DEMOTE";
        desc.textContent = "Recommendation: Regress to the previous level to rebuild foundational skills.";
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="32" height="32"><path d="M19 14l-7 7m0 0l-7-7m7 7V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      } else {
        card.className = "ml-hero-card is-stay";
        title.textContent = "STAY";
        desc.textContent = "Recommendation: Repeat this level to continue building motor memory and speed.";
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="32" height="32" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
      }
    }

    #renderChart(payload) {
      const canvas = document.getElementById("reactionChart");
      if (!canvas || !window.Chart) return;
      
      const labels = payload.reactionTimes.map((_, i) => `T${i + 1}`);
      const data = payload.reactionTimes;

      new Chart(canvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Reaction Time (ms)',
            data: data,
            borderColor: 'rgba(26, 86, 219, 1)',
            backgroundColor: 'rgba(26, 86, 219, 0.1)',
            borderWidth: 2,
            tension: 0.3,
            fill: true,
            pointBackgroundColor: 'rgba(26, 86, 219, 1)'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: { beginAtZero: true, suggestedMax: 2000 }
          }
        }
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     DataController  (data.html)
     ══════════════════════════════════════════════════════ */

  class DataController {
    #auth;
    #allSessions = [];
    
    constructor(auth) {
      this.#auth = auth;
    }

    init() {
      this.#auth.onAuthStateChanged(async (user) => {
        if (!user) {
          window.location.href = "index.html";
          return;
        }
        await this.#loadData(user.uid);
      });
    }

    async #loadData(uid) {
      try {
        const snap = await window.firebase.firestore().collection("therapySessions")
          .where("doctorId", "==", uid)
          .orderBy("endedAt", "desc")
          .get();
          
        this.#allSessions = snap.docs.map(d => d.data());
        this.#renderTable(this.#allSessions);
        this.#setupExport(this.#allSessions);
        this.#setupFilters();
      } catch (err) {
        console.error("Failed to load sessions:", err);
        document.getElementById("loadingState").textContent = "Error loading data. Check console.";
      }
    }

    #setupFilters() {
      const searchInput = document.getElementById("searchInput");
      const conditionFilter = document.getElementById("conditionFilter");
      const levelFilter = document.getElementById("levelFilter");

      const applyFilters = () => {
        const query = searchInput?.value.toLowerCase().trim() || "";
        const cond = conditionFilter?.value || "all";
        const lvl = levelFilter?.value || "all";

        const filtered = this.#allSessions.filter(s => {
          // Check search (by ID or condition as proxy for name)
          const searchMatch = !query || 
                              (s.patientId && s.patientId.toLowerCase().includes(query)) ||
                              (s.condition && s.condition.toLowerCase().includes(query));
          
          // Check condition
          const condMatch = cond === "all" || (s.condition && s.condition === cond);
          
          // Check level
          const lvlMatch = lvl === "all" || (s.levelPlayed !== undefined && s.levelPlayed == lvl);

          return searchMatch && condMatch && lvlMatch;
        });

        this.#renderTable(filtered);
        this.#setupExport(filtered); // Update export to only export filtered data if desired
      };

      searchInput?.addEventListener("input", applyFilters);
      conditionFilter?.addEventListener("change", applyFilters);
      levelFilter?.addEventListener("change", applyFilters);
    }

    #renderTable(sessions) {
      document.getElementById("loadingState").style.display = "none";
      const table = document.getElementById("dataTable");
      const tbody = document.getElementById("dataTableBody");
      
      if (!table || !tbody) return;
      table.style.display = "table";

      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="14" style="text-align:center; padding:40px; color: var(--text-3);">No clinical records found.</td></tr>';
        return;
      }

      tbody.innerHTML = sessions.map(s => {
        const acc = s.accuracy ?? 0;
        let accBadge = 'badge-warn';
        if (acc >= 80) accBadge = 'badge-good';
        if (acc < 50) accBadge = 'badge-bad';
        
        const trend = s.accTrend ?? 0;
        const trendSymbol = trend > 0 ? '↗' : (trend < 0 ? '↘' : '—');
        const trendColor = trend > 0 ? '#16a34a' : (trend < 0 ? '#dc2626' : '#94a3b8');

        return `
        <tr>
          <td style="font-weight: 500;">${new Date(s.endedAt).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'})}</td>
          <td style="font-family: monospace; font-size: 0.8rem; color: #64748b; letter-spacing: 0.05em;">${s.patientId ? s.patientId.substring(0,8) + '...' : '—'}</td>
          <td><span class="condition-pill">${s.condition || 'Unknown'}</span></td>
          <td><span class="badge badge-level">Lvl ${s.levelPlayed ?? 0}</span></td>
          <td style="color: #64748b;">Session ${s.sessionNumber ?? 1}</td>
          <td style="font-variant-numeric: tabular-nums; font-weight: 500;">${((s.totalTimeMs || 0)/1000).toFixed(2)}</td>
          <td>${s.totalTargets ?? 0}</td>
          <td style="color: ${s.wrongs > 5 ? '#dc2626' : 'inherit'}; font-weight: ${s.wrongs > 5 ? '600' : 'normal'};">${s.wrongs ?? 0}</td>
          <td><span class="badge ${accBadge}">${acc}%</span></td>
          <td style="color: ${trendColor}; font-weight: 600;">${trendSymbol} ${Math.abs(trend)}%</td>
          <td style="font-variant-numeric: tabular-nums;">${((s.averageReactionMs ?? 0)/1000).toFixed(2)}</td>
          <td style="font-variant-numeric: tabular-nums; color: #64748b;">${((s.bestReactionMs ?? 0)/1000).toFixed(2)}</td>
          <td style="font-variant-numeric: tabular-nums; color: #64748b;">${((s.varianceRT ?? 0)/1000).toFixed(2)}</td>
          <td style="color: ${(s.fatigueIndex ?? 1.0) > 1.2 ? '#dc2626' : 'inherit'};">${(s.fatigueIndex ?? 1.0).toFixed(2)}</td>
        </tr>
      `}).join("");
    }

    #setupExport(sessions) {
      const btn = document.getElementById("exportCsvBtn");
      if (!btn) return;
      
      if (sessions.length === 0) return;
      btn.disabled = false;
      
      btn.addEventListener("click", () => {
        const baseHeaders = [
          "Timestamp", "Patient_ID", "Age", "Condition", "Level_Played", 
          "Session_Number", "Sessions_On_Current_Level", "Total_Targets", "Correct_Hits", "Wrong_Hits",
          "Accuracy_%", "Accuracy_Trend", "Session_Duration_s", "Avg_Reaction_Time_s",
          "Best_Reaction_Time_s", "Time_Trend_s", "Variance_RT_s", "Fatigue_Index", "ML_TARGET_Next_Level"
        ];
        
        for (let i = 1; i <= 16; i++) {
          baseHeaders.push(`T${i}_Total_RT_s`);
        }
        
        const rows = sessions.map(s => {
          const targetTimes = new Array(16).fill(0);
          
          if (s.detailedResponses && Array.isArray(s.detailedResponses)) {
            s.detailedResponses.forEach(r => {
              if (r.index >= 0 && r.index < 16) {
                targetTimes[r.index] += r.ms;
              }
            });
          }
          
          const targetTimesSec = targetTimes.map(ms => (ms / 1000).toFixed(2));
          
          return [
            s.endedAt,
            s.patientId || "Unknown",
            s.age || 0,
            s.condition || "Unknown",
            s.levelPlayed ?? 0,
            s.sessionNumber ?? 1,
            s.sessionsOnCurrentLevel ?? 1,
            s.totalTargets ?? 0,
            s.hits ?? 0,
            s.wrongs ?? 0,
            s.accuracy ?? 0,
            s.accTrend ?? 0,
            ((s.totalTimeMs || 0) / 1000).toFixed(2),
            ((s.averageReactionMs ?? 0) / 1000).toFixed(2),
            ((s.bestReactionMs ?? 0) / 1000).toFixed(2),
            ((s.timeTrend ?? 0) / 1000).toFixed(2),
            ((s.varianceRT ?? 0) / 1000).toFixed(2),
            s.fatigueIndex ?? 1.0,
            "",
            ...targetTimesSec
          ];
        });
        
        const csvContent = [
          baseHeaders.join(","),
          ...rows.map(row => row.join(","))
        ].join("\n");
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `pearl_ml_dataset_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }
  }

  /* ══════════════════════════════════════════════════════
     ManagePatientsController
     ══════════════════════════════════════════════════════ */
  class ManagePatientsController {
    #auth;
    
    constructor(auth) {
      this.#auth = auth;
    }

    init() {
      this.#auth.onAuthStateChanged(async (user) => {
        if (!user) {
          window.location.href = "index.html";
          return;
        }
        await this.#loadPatients(user.uid);
      });

      const searchInput = document.getElementById("searchInput");
      if (searchInput) {
        searchInput.addEventListener("input", (e) => {
          const query = e.target.value.toLowerCase();
          document.querySelectorAll("#patientsTableBody tr").forEach(tr => {
            const text = tr.textContent.toLowerCase();
            tr.style.display = text.includes(query) ? "" : "none";
          });
        });
      }

      document.getElementById("cancelEditBtn")?.addEventListener("click", () => {
        document.getElementById("editModal").style.display = 'none';
      });

      document.getElementById("closeEditModalCross")?.addEventListener("click", () => {
        document.getElementById("editModal").style.display = 'none';
      });
    }

    async #loadPatients(uid) {
      const tbody = document.getElementById("patientsTableBody");
      try {
        const snap = await window.firebase.firestore().collection("patients")
          .where("doctorId", "==", uid)
          .orderBy("createdAt", "desc")
          .get();
        
        if (snap.empty) {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #666;">No patients found.</td></tr>';
          return;
        }

        tbody.innerHTML = snap.docs.map(doc => {
          const p = doc.data();
          return `
            <tr id="row-${doc.id}">
              <td style="font-family: monospace;">${p.patientId}</td>
              <td style="font-weight: bold;">${p.name}</td>
              <td>${p.age}</td>
              <td><span style="display:inline-block; padding: 2px 6px; background: #e0e0e0; border: 1px solid #ccc; border-radius: 2px; font-size: 11px; color: #333; font-weight: 600;">${p.condition}</span></td>
              <td><span style="display:inline-block; padding: 2px 6px; background: #e8f4f8; border: 1px solid #bce8f1; color: #31708f; font-weight: bold; border-radius: 2px; font-size: 11px;">Level ${p.currentLevel ?? 1}</span></td>
              <td style="color: #666; font-weight: bold;">${p.sessionsCompleted ?? 0}</td>
              <td style="display: flex; gap: 5px;">
                <button class="win-btn edit-btn" data-id="${doc.id}" data-name="${p.name}" data-age="${p.age}" data-condition="${p.condition}">
                  <svg viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                  Edit
                </button>
                <button class="win-btn danger del-btn" data-id="${doc.id}" style="color: #c00;">
                  <svg viewBox="0 0 24 24" fill="none" width="12" height="12" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                  Delete
                </button>
              </td>
            </tr>
          `;
        }).join("");

        tbody.querySelectorAll('.edit-btn').forEach(btn => {
          btn.addEventListener('click', (e) => this.#openEditModal(e.target.dataset));
        });

        tbody.querySelectorAll('.del-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            if (confirm("Are you sure you want to permanently delete this patient?")) {
              const docId = e.target.dataset.id;
              await window.firebase.firestore().collection("patients").doc(docId).delete();
              document.getElementById(`row-${docId}`).remove();
            }
          });
        });
      } catch(e) {
        console.error(e);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #cc0000;">Error loading patients.</td></tr>';
      }
    }

    #openEditModal(data) {
      const modal = document.getElementById("editModal");
      const form = document.getElementById("editForm");
      
      document.getElementById("editName").value = data.name;
      document.getElementById("editAge").value = data.age;
      document.getElementById("editCondition").value = data.condition;
      
      modal.style.display = 'flex';
      
      form.onsubmit = async (e) => {
        e.preventDefault();
        const saveBtn = document.getElementById("saveEditBtn");
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";
        
        try {
          const newName = document.getElementById("editName").value;
          const newAge = document.getElementById("editAge").value;
          const newCondition = document.getElementById("editCondition").value;
          
          await window.firebase.firestore().collection("patients").doc(data.id).update({
            name: newName,
            age: parseInt(newAge, 10),
            condition: newCondition
          });
          
          modal.style.display = 'none';
          this.#loadPatients(this.#auth.currentUser.uid); // reload
        } catch(err) {
          console.error(err);
          alert("Error saving changes.");
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save Changes";
        }
      };
    }
  }

  /* ══════════════════════════════════════════════════════
     Bootstrap — route to correct controller by page attr
     ══════════════════════════════════════════════════════ */

  async function bootstrap() {
    const page = document.body.dataset.page;
    const serial = new SerialManager();
    const auth = new AuthService();
    const firebase = new FirebaseService();
    
    firebase.initialize();
    auth.initialize();

    if (page === "login") {
      const login = new LoginController(auth);
      login.init();
      return;
    }

    if (page === "dashboard") {
      const dash = new DashboardController(serial, auth, firebase);
      dash.init();
      return;
    }

    if (page === "new_patient") {
      const np = new NewPatientController(auth, firebase);
      np.init();
      return;
    }

    if (page === "therapy") {
      const therapy = new TherapyController(serial, firebase);
      await therapy.init();
      return;
    }

    if (page === "result") {
      const result = new ResultController();
      result.init();
      return;
    }

    if (page === "data") {
      const dataCtrl = new DataController(auth);
      dataCtrl.init();
      return;
    }

    if (page === "manage_patients") {
      const mpCtrl = new ManagePatientsController(auth);
      mpCtrl.init();
      return;
    }

    console.warn("PEARL: unknown page —", page);
  }

  document.addEventListener("DOMContentLoaded", () => {
    bootstrap().catch((err) => console.error("PEARL bootstrap failed:", err));
  });
})();
