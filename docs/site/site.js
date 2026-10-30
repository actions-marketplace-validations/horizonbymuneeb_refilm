/* refilm docs — the only script on the site.
   Two jobs, no dependencies, no network:
     1. mobile nav toggle (the sidebar is a <nav>, collapsed by default under 900px)
     2. a copy button injected into command blocks, which degrades to plain
        selectable text when JS is off or the clipboard API is unavailable */
(function () {
  "use strict";

  /* ---- 1. mobile navigation --------------------------------------------- */
  var toggle = document.querySelector("[data-nav-toggle]");
  var body = document.body;
  if (toggle) {
    var setOpen = function (open) {
      body.setAttribute("data-nav", open ? "open" : "closed");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    setOpen(false);
    toggle.addEventListener("click", function () {
      setOpen(body.getAttribute("data-nav") !== "open");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && body.getAttribute("data-nav") === "open") {
        setOpen(false);
        toggle.focus();
      }
    });
    // a wider window brings the persistent sidebar back; drop the open state
    var mq = window.matchMedia("(min-width: 901px)");
    var onChange = function () {
      if (mq.matches) setOpen(false);
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---- 2. copy buttons on command blocks -------------------------------- */
  if (!navigator.clipboard) return;
  var blocks = document.querySelectorAll("pre.cmd");
  Array.prototype.forEach.call(blocks, function (pre) {
    var wrap = document.createElement("div");
    wrap.className = "copy";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy__btn";
    btn.textContent = "copy";
    btn.setAttribute("aria-label", "Copy this command");
    wrap.appendChild(btn);

    btn.addEventListener("click", function () {
      // the block may hold several lines; copy them all without the "$" prefix
      var text = pre.textContent.replace(/^\s*\$\s?/gm, "");
      navigator.clipboard.writeText(text).then(
        function () {
          btn.textContent = "copied";
          btn.setAttribute("data-done", "1");
          setTimeout(function () {
            btn.textContent = "copy";
            btn.removeAttribute("data-done");
          }, 1400);
        },
        function () {
          btn.textContent = "select";
        }
      );
    });
  });
})();
