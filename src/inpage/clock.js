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

  const st = {
    held: false,
    t: 0,
    skew: nat.epoch() - nat.now(),
    ids: 1,
    seq: 0,
    depth: 0,
    timers: new Map(),
    frames: new Map(),
    tick: 1000 / (cfg.hz || 60),
    nextTick: 0,
    anims: new Map(),
    videos: new Map(),
    frameNo: 0,
    startedAt: null,
    keeper: 0,
    log: [],
  };
  const clockNow = () => (st.held ? st.t : nat.now());

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
    }, Math.max(0, timer.due - nat.now()));
  }

  function addTimer(cb, delay, args, repeat) {
    const id = st.ids++;
    const depth = st.depth + 1;
    let ms = Math.max(0, Number(delay) || 0);
    // browsers clamp: intervals to 1 ms, deeply nested timers to 4 ms
    if (depth > 5) ms = Math.max(ms, 4);
    else if (repeat) ms = Math.max(ms, 1);
    const timer = { id, cb, args, delay: ms, repeat, due: clockNow() + ms, seq: st.seq++, depth, native: null };
    st.timers.set(id, timer);
    if (!st.held) arm(timer);
    return id;
  }

  function fire(timer) {
    if (timer.repeat) {
      timer.due = (st.held ? timer.due : nat.now()) + timer.delay;
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
        rec = { base: a.currentTime || 0, from: st.t };
        st.anims.set(a, rec);
        try {
          a.pause();
        } catch (e) {
          continue;
        }
      }
      if (!st.held) continue;
      const rate = a.playbackRate || 1;
      const at = rec.base + (st.t - rec.from) * rate;
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
        rec = { base: v.currentTime, from: st.t };
        st.videos.set(v, rec);
        try {
          v.pause();
        } catch (e) {}
      }
      if (!st.held) continue;
      let at = rec.base + ((st.t - rec.from) / 1000) * (v.playbackRate || 1);
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
    if (!new.target) return new nat.Date(st.skew + clockNow()).toString();
    return args.length ? new nat.Date(...args) : new nat.Date(st.held ? st.skew + st.t : nat.epoch());
  }
  FilmDate.prototype = nat.Date.prototype;
  FilmDate.now = function now() {
    return st.held ? Math.round(st.skew + st.t) : nat.epoch();
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
          return st.held ? st.t : stampDesc.get.call(this);
        },
      });
    } catch (e) {}
  }
  if (timelineDesc && timelineDesc.get) {
    try {
      Object.defineProperty(AnimationTimeline.prototype, "currentTime", {
        configurable: true,
        get() {
          return st.held && this === document.timeline ? st.t : timelineDesc.get.call(this);
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
    if (st.held) return st.t;
    st.t = nat.now();
    st.held = true;
    st.nextTick = st.t + st.tick;
    for (const timer of st.timers.values()) {
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
    return st.t;
  }

  async function step(ms) {
    if (!st.held) hold();
    if (st.startedAt === null) st.startedAt = st.t;
    nat.cancelFrame(st.keeper);
    const target = st.t + Math.max(0, ms);
    for (let guard = 0; guard < 200000; guard++) {
      let soonest = null;
      for (const timer of st.timers.values()) {
        if (!soonest || timer.due < soonest.due || (timer.due === soonest.due && timer.seq < soonest.seq)) soonest = timer;
      }
      const nextAt = Math.min(soonest ? soonest.due : Infinity, st.nextTick);
      if (nextAt > target) break;
      if (soonest && soonest.due <= st.nextTick) {
        st.t = Math.max(st.t, soonest.due);
        fire(soonest);
      } else {
        st.t = st.nextTick;
        st.nextTick += st.tick;
        runFrame(st.t);
      }
      await breathe();
    }
    st.t = target;
    syncAnimations();
    syncVideos();
    keeper();
    if (st.log.length < 20000) st.log.push([nat.now(), st.t]);
    return st.t;
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
      t: st.t,
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
