// refilm — in-page virtual clock.
//
// Injected before any page script when a capture runs on --clock virtual (and, seeding only, on --clock real).
// Every time source a page can read is routed through one counter the capturer moves by hand, so frame k is
// exactly the state at t = k / fps however slow the machine renders it, and two captures of the same page
// pass through the same states.
//
// The counter is "held" from the first script on: nothing advances until the capturer calls step(ms). Inside
// step() the pending timers and animation frames are run in time order, yielding to the event loop between
// callbacks so promise chains and MessageChannel schedulers keep running.
(function (cfg) {
  const root = self;
  if (root.__filmClock) return;

  // ---- seeded Math.random: the same seed lays out the same particles, arcs and noise on every run
  if (cfg.seed !== null && cfg.seed !== undefined) {
    let x = (cfg.seed >>> 0) || 1;
    Math.random = function random() {
      x = (x + 0x6d2b79f5) | 0;
      let r = Math.imul(x ^ (x >>> 15), 1 | x);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  if (!cfg.virtual) {
    root.__filmClock = { virtual: false, seed: cfg.seed === undefined ? null : cfg.seed };
    return;
  }

  const nat = {
    timeout: root.setTimeout.bind(root),
    clearTimeout: root.clearTimeout.bind(root),
    frame: root.requestAnimationFrame.bind(root),
    cancelFrame: root.cancelAnimationFrame.bind(root),
    now: performance.now.bind(performance),
    epoch: Date.now,
    Date: Date,
  };
  const stampDesc = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp");
  const timelineDesc =
    root.AnimationTimeline && Object.getOwnPropertyDescriptor(AnimationTimeline.prototype, "currentTime");

  // The virtual clock counts integer microseconds from a fixed origin of 0. Floats are what made this
  // nondeterministic: a fractional rAF grid anchored on the wall clock meant step(100) ran 5 or 6 callbacks
  // depending on the phase of that anchor, so the same capture drew a frame one rAF early or late. With an
  // integer base and an integer tick, "how many animation frames fall inside step(ms)" is a pure function of
  // ms, and frame k is exactly the state at t = k/fps on every run.
  const HZ = cfg.hz || 60;
  const TICK_US = Math.round(1e6 / HZ); // exact microseconds per virtual animation frame
  const st = {
    held: false,
    us: 0, // virtual time, integer microseconds, origin 0
    skew: nat.epoch() - nat.now(), // wall clock -> Date mapping (only used before the clock is held)
    heldAtEpoch: 0, // Date.now() value the virtual origin corresponds to
    ids: 1,
    seq: 0,
    depth: 0,
    timers: new Map(),
    frames: new Map(),
    tick: 1000 / HZ, // milliseconds per animation frame, for display only
    nextTickUs: 0,
    anims: new Map(),
    videos: new Map(),
    frameNo: 0,
    startedAt: null,
    keeper: 0,
    log: [],
  };
  const clockNow = () => (st.held ? st.us / 1000 : nat.now());
  /** Now in integer microseconds: virtual once held, wall clock before that. */
  const nowUs = () => (st.held ? st.us : Math.round(nat.now() * 1000));

  function invoke(cb, args) {
    try {
      if (typeof cb === "string") (0, eval)(cb);
      else if (typeof cb === "function") cb.apply(root, args);
    } catch (err) {
      nat.timeout(function () {
        throw err;
      });
    }
  }

  // ---------------------------------------------------------------- timers
  function arm(timer) {
    timer.native = nat.timeout(function () {
      if (st.timers.get(timer.id) === timer && !st.held) fire(timer);
    }, Math.max(0, Math.round(timer.dueUs / 1000) - nat.now()));
  }

  function addTimer(cb, delay, args, repeat) {
    const id = st.ids++;
    const depth = st.depth + 1;
    let ms = Math.max(0, Number(delay) || 0);
    // browsers clamp: intervals to 1 ms, deeply nested timers to 4 ms
    if (depth > 5) ms = Math.max(ms, 4);
    else if (repeat) ms = Math.max(ms, 1);
    const timer = { id, cb, args, delay: ms, repeat, dueUs: nowUs() + Math.round(ms * 1000), seq: st.seq++, depth, native: null };
    st.timers.set(id, timer);
    if (!st.held) arm(timer);
    return id;
  }

  function fire(timer) {
    if (timer.repeat) {
      // an interval keeps its cadence: the next firing is one delay after the previous due time, never a
      // drift-free catch-up from "now", which would make the sequence depend on how late we ran it
      timer.dueUs = timer.dueUs + Math.round(timer.delay * 1000);
      timer.seq = st.seq++;
      if (!st.held) arm(timer);
    } else st.timers.delete(timer.id);
    const outer = st.depth;
    st.depth = timer.depth;
    invoke(timer.cb, timer.args);
    st.depth = outer;
  }

  function dropTimer(id) {
    const timer = st.timers.get(id);
    if (!timer) return;
    if (timer.native !== null) nat.clearTimeout(timer.native);
    st.timers.delete(id);
  }

  root.setTimeout = function setTimeout(cb, delay) {
    return addTimer(cb, delay, Array.prototype.slice.call(arguments, 2), false);
  };
  root.setInterval = function setInterval(cb, delay) {
    return addTimer(cb, delay, Array.prototype.slice.call(arguments, 2), true);
  };
  root.clearTimeout = function clearTimeout(id) {
    dropTimer(id);
  };
  root.clearInterval = function clearInterval(id) {
    dropTimer(id);
  };
  root.requestIdleCallback = function requestIdleCallback(cb, opts) {
    const budget = Math.min(50, (opts && opts.timeout) || 1);
    return addTimer(
      function () {
        cb({ didTimeout: false, timeRemaining: () => 10 });
      },
      budget,
      [],
      false,
    );
  };
  root.cancelIdleCallback = function cancelIdleCallback(id) {
    dropTimer(id);
  };

  // ---------------------------------------------------------------- animation frames
  root.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = st.ids++;
    const entry = { cb, native: null };
    if (!st.held) {
      entry.native = nat.frame(function (ts) {
        if (st.frames.get(id) === entry) {
          st.frames.delete(id);
          invoke(cb, [ts]);
        }
      });
    }
    st.frames.set(id, entry);
    return id;
  };
  root.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const entry = st.frames.get(id);
    if (!entry) return;
    if (entry.native !== null) nat.cancelFrame(entry.native);
    st.frames.delete(id);
  };

  function runFrame(ts) {
    st.frameNo++;
    syncAnimations();
    syncVideos();
    const due = Array.from(st.frames.values());
    st.frames.clear(); // callbacks queued from inside these belong to the next frame
    for (const entry of due) invoke(entry.cb, [ts]);
  }

  // ---------------------------------------------------------------- animations
  // Every running animation on the document timeline is paused the first time it is seen, then seeked to
  // base + (virtual now - first seen) * playbackRate. Finite ones are finished at their end so `finished`
  // promises and finish events still fire (animation libraries wait on those).
  function syncAnimations() {
    let list;
    try {
      list = document.getAnimations();
    } catch (e) {
      return;
    }
    for (const a of list) {
      if (a.timeline && a.timeline !== document.timeline) continue; // scroll / view timelines follow scroll
      let rec = st.anims.get(a);
      if (!rec || a.playState === "running") {
        if (!rec && a.playState !== "running") continue; // paused or finished by the page itself
        rec = { base: a.currentTime || 0, from: st.us / 1000 };
        st.anims.set(a, rec);
        try {
          a.pause();
        } catch (e) {
          continue;
        }
      }
      if (!st.held) continue;
      const rate = a.playbackRate || 1;
      const at = rec.base + (st.us / 1000 - rec.from) * rate;
      let end = Infinity;
      try {
        end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
      } catch (e) {}
      if ((rate > 0 && at >= end) || (rate < 0 && at <= 0)) {
        st.anims.delete(a);
        try {
          a.finish();
        } catch (e) {}
        continue;
      }
      try {
        a.currentTime = at;
      } catch (e) {}
    }
  }

  // <video> decodes on its own real clock; pause it and seek with the virtual clock instead.
  function syncVideos() {
    let list;
    try {
      list = document.querySelectorAll("video");
    } catch (e) {
      return;
    }
    for (const v of list) {
      let rec = st.videos.get(v);
      if (!rec) {
        if (v.paused) continue;
        rec = { base: v.currentTime, from: st.us / 1000 };
        st.videos.set(v, rec);
        try {
          v.pause();
        } catch (e) {}
      }
      if (!st.held) continue;
      let at = rec.base + ((st.us / 1000 - rec.from) / 1000) * (v.playbackRate || 1);
      if (v.loop && v.duration > 0) at %= v.duration;
      else if (v.duration > 0) at = Math.min(at, v.duration);
      if (Math.abs(v.currentTime - at) > 0.001) {
        try {
          v.currentTime = at;
        } catch (e) {}
      }
    }
  }

  // While held but not stepping (page load), keep catching animations that appear so they start near 0
  // instead of running on the real clock.
  function keeper() {
    if (!st.held) return;
    syncAnimations();
    st.keeper = nat.frame(keeper);
  }

  // ---------------------------------------------------------------- time sources
  performance.now = function now() {
    return clockNow();
  };

  function FilmDate() {
    const args = Array.prototype.slice.call(arguments);
    if (!new.target) return new nat.Date(nat.epoch()).toString();
    return args.length ? new nat.Date(...args) : new nat.Date(st.held ? st.heldAtEpoch + st.us / 1000 : nat.epoch());
  }
  FilmDate.prototype = nat.Date.prototype;
  FilmDate.now = function now() {
    return st.held ? Math.round(st.heldAtEpoch + st.us / 1000) : nat.epoch();
  };
  FilmDate.parse = nat.Date.parse;
  FilmDate.UTC = nat.Date.UTC;
  try {
    Object.defineProperty(FilmDate.prototype, "constructor", { value: FilmDate, writable: true, configurable: true });
  } catch (e) {}
  root.Date = FilmDate;

  if (stampDesc && stampDesc.get) {
    try {
      Object.defineProperty(Event.prototype, "timeStamp", {
        configurable: true,
        get() {
          return st.held ? st.us / 1000 : stampDesc.get.call(this);
        },
      });
    } catch (e) {}
  }
  if (timelineDesc && timelineDesc.get) {
    try {
      Object.defineProperty(AnimationTimeline.prototype, "currentTime", {
        configurable: true,
        get() {
          return st.held && this === document.timeline ? st.us / 1000 : timelineDesc.get.call(this);
        },
      });
    } catch (e) {}
  }

  // ---------------------------------------------------------------- workers
  // A worker answers on its own real clock. The capturer waits for posted-but-unanswered messages before
  // each frame, so a reply always lands on the same virtual frame. A worker that never answers stops
  // counting after 2 s.
  if (root.Worker) {
    const post = root.Worker.prototype.postMessage;
    root.Worker.prototype.postMessage = function () {
      if (!this.__filmMute) {
        st.pending = st.pending || new Map();
        st.pending.set(this, nat.now());
      }
      if (!this.__filmListen) {
        this.__filmListen = true;
        this.addEventListener("message", () => st.pending && st.pending.delete(this));
        this.addEventListener("error", () => st.pending && st.pending.delete(this));
      }
      return post.apply(this, arguments);
    };
  }

  function busy() {
    let n = 0;
    for (const v of st.videos.keys()) if (v.seeking) n++;
    for (const [worker, at] of st.pending || []) {
      if (nat.now() - at > 2000) {
        worker.__filmMute = true;
        st.pending.delete(worker);
      } else n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- control
  const mailbox = new MessageChannel();
  const waiters = [];
  mailbox.port1.onmessage = function () {
    const next = waiters.shift();
    if (next) next();
  };
  const breathe = () =>
    new Promise(function (resolve) {
      waiters.push(resolve);
      mailbox.port2.postMessage(0);
    });

  function hold() {
    if (st.held) return st.us / 1000;
    // Take over from the wall clock at the fixed origin 0. Pending timers were queued against wall-clock
    // microseconds, so each one is rebased: it keeps the delay it was asked for, measured from the origin.
    // (Rebasing is what the obvious "just set t = 0" patch misses: without it, every pending timer is due
    //  millions of milliseconds in the future and step() never reaches it — the hang.)
    const wallUs = Math.round(nat.now() * 1000);
    st.held = true;
    st.us = 0;
    st.heldAtEpoch = st.skew + wallUs / 1000;
    st.nextTickUs = TICK_US;
    for (const timer of st.timers.values()) {
      timer.dueUs = Math.max(0, timer.dueUs - wallUs);
      if (timer.native !== null) {
        nat.clearTimeout(timer.native);
        timer.native = null;
      }
    }
    for (const entry of st.frames.values()) {
      if (entry.native !== null) {
        nat.cancelFrame(entry.native);
        entry.native = null;
      }
    }
    syncAnimations();
    keeper();
    return 0;
  }

  async function step(ms) {
    if (!st.held) hold();
    if (st.startedAt === null) st.startedAt = st.us;
    nat.cancelFrame(st.keeper);
    const targetUs = st.us + Math.round(Math.max(0, ms) * 1000);
    for (let guard = 0; guard < 200000; guard++) {
      let soonest = null;
      for (const timer of st.timers.values()) {
        if (!soonest || timer.dueUs < soonest.dueUs || (timer.dueUs === soonest.dueUs && timer.seq < soonest.seq)) soonest = timer;
      }
      const nextAtUs = Math.min(soonest ? soonest.dueUs : Infinity, st.nextTickUs);
      if (nextAtUs > targetUs) break;
      if (soonest && soonest.dueUs <= st.nextTickUs) {
        st.us = Math.max(st.us, soonest.dueUs);
        fire(soonest);
      } else {
        st.us = st.nextTickUs;
        st.nextTickUs += TICK_US;
        runFrame(st.us / 1000);
      }
      await breathe();
    }
    st.us = targetUs;
    syncAnimations();
    syncVideos();
    keeper();
    if (st.log.length < 20000) st.log.push([nat.now(), st.us / 1000]);
    return st.us / 1000;
  }

  /**
   * Lets the real compositor take one tick without moving the virtual clock.
   *
   * A canvas is drawn into a GPU back buffer; the compositor copies it to the screen on its own real-clock
   * tick. Screenshotting straight after a virtual step can therefore read the previous composite. Awaiting a
   * real animation frame (the native one, not the virtualised requestAnimationFrame) makes the capture wait
   * for that tick. Virtual time does not move, so this cannot change what the page draws.
   */
  function present() {
    return new Promise(function (resolve) {
      nat.frame(function () {
        nat.frame(function () {
          resolve(true);
        });
      });
    });
  }

  root.__filmClock = {
    virtual: true,
    present,
    seed: cfg.seed === undefined ? null : cfg.seed,
    hold,
    step,
    busy,
    now: clockNow,
    history: () => st.log,
    state: () => ({
      held: st.held,
      t: st.us / 1000,
      timers: st.timers.size,
      frames: st.frames.size,
      frameNo: st.frameNo,
      animations: st.anims.size,
      // how many time sources the page has registered so far: it stops moving once the page has booted,
      // which is how the capturer knows frame 0 will not race the page's own start-up
      signups: st.ids,
    }),
  };
  if (cfg.holdAtStart) hold();
});
