/* Aash Edu (Apex Stream) — API-driven course viewer for CODEX STUDYS.
   Flow: Courses (main grid) -> Subjects -> Topics -> Lectures (Videos / Notes) -> Player */
(function () {
  "use strict";

  var API_BASE = "https://aashapi.appx.co.in";
  var PLAYER_URL = "https://studyapkmod-player.vercel.app/watch";
  var FALLBACK_IMG = "assets/codex-telegram.png";
  var HEADERS = {
    "Client-Service": "Appx",
    "Auth-Key": "appxapi",
    "source": "website",
    "Authorization": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEzNjg2OTUiLCJ0aW1lc3RhbXAiOjE3OTAwODUwNzQsIml2X3ZlciI6NjksInNlc3Npb24iOiJleUowZVhBaU9pSktWMVFpTENKaGJHY2lPaUpJVXpJMU5pSjkuZXlKcFpDSTZJakV6TmpnMk9UVWlMQ0psYldGcGJDSTZJbUY1T0RnME9ESTJPRUJuYldGcGJDNWpiMjBpTENKdVlXMWxJam9pV1dGa1lYWWlMQ0owWlc1aGJuUlVlWEJsSWpvaWRYTmxjaUlzSW5SbGJtRnVkRTVoYldVaU9pSmhZWE5vWDJSaUlpd2lkR1Z1WVc1MFNXUWlPaUlpTENKa2FYTndiM05oWW14bElqcG1ZV3h6WlgwLnY2X1lzTUJsREttVDJsRDc1NTBUWHRBQ1NfVEUxcVU1UkNTV2t6dGVkcmMifQ.LwEler_Ilz4ZUUgFUmry9McIGXWvOU7q3Pz0tw3_CI4",
    "user_id": "1368695"
  };

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function api(path) {
    var res;
    try {
      res = await fetch(API_BASE + path, { method: "GET", headers: HEADERS });
    } catch (e) {
      throw new Error("Could not reach the Aash Edu server. Check your connection and retry.");
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("Access denied by the server (HTTP " + res.status + ").");
      if (res.status === 429) throw new Error("Server is busy (HTTP 429). Please retry in a moment.");
      throw new Error("Server error (HTTP " + res.status + ").");
    }
    var json;
    try { json = JSON.parse(await res.text()); } catch (e) { throw new Error("The server sent an unreadable response."); }
    if (json && typeof json.data === "string") throw new Error("The server sent an encrypted response that this app cannot read.");
    return json;
  }

  function listOf(json) {
    if (Array.isArray(json)) return json;
    return json && Array.isArray(json.data) ? json.data : [];
  }

  /* ---------- Step 1: courses (feeds the main CODEX grid) ---------- */
  function toBatch(c, id) {
    var price = Number(c.price) || 0;
    return {
      _id: id,
      name: c.course_name || c.title || c.name || "Untitled course",
      byName: String(c.exam_category || c.exam_name || "").split(",")[0].trim() || "Aash Edu",
      previewImage: c.course_thumbnail || c.thumbnail || "",
      language: "Aash Edu",
      startDate: c.start_date || "",
      feeTotal: price > 0 ? price : "Free",
      type: "AASH_COURSE",
      slug: "",
      subBatches: []
    };
  }

  async function fetchCourses(onProgress) {
    var map = new Map();
    function add(items) {
      var added = 0;
      items.forEach(function (c) {
        var id = String(c.id || c.course_id || c.courseid || "");
        if (!id || map.has(id)) return;
        map.set(id, toBatch(c, id));
        added++;
      });
      return added;
    }
    function progress() { if (onProgress && map.size) onProgress(Array.from(map.values())); }

    add(listOf(await api("/get/courselist?exam_name=&start=0")));
    progress();

    var next = 10, guard = 0;
    while (guard++ < 60) {
      var starts = [0, 1, 2, 3, 4].map(function (i) { return next + i * 10; });
      next += 50;
      var results = await Promise.all(starts.map(function (s) {
        return api("/get/courselist?exam_name=&start=" + s).then(listOf).catch(function () { return []; });
      }));
      var added = 0;
      results.forEach(function (items) { added += add(items); });
      if (!added) break;
      progress();
    }
    if (!map.size) throw new Error("No courses were returned by the server.");
    return Array.from(map.values());
  }

  /* ---------- lectures / notes normalisation ---------- */
  function pdfLinkOf(i) { return i.pdf_link || i.pdf_url || i.pdf_link2 || i.download_url || ""; }
  function videoLinkOf(i) { return i.file_link || i.file_link2 || i.recording_hls || i.video_url || ""; }
  function normaliseItems(rows) {
    return rows.slice().sort(function (a, b) {
      var x = a.sortingparam != null && a.sortingparam !== "" ? Number(a.sortingparam) : 999999;
      var y = b.sortingparam != null && b.sortingparam !== "" ? Number(b.sortingparam) : 999999;
      return x - y;
    }).map(function (i, idx) {
      var title = i.Title || i.title || i.name || "Lecture #" + (idx + 1);
      var type = String(i.material_type || i.type || "").toUpperCase();
      var pdf = pdfLinkOf(i);
      var isPdf = type === "PDF" || !!pdf;
      return { id: String(i.id || i.video_id || idx), title: title, isPdf: isPdf, pdf: pdf, video: isPdf ? "" : videoLinkOf(i), thumb: i.thumbnail || "", raw: i };
    });
  }

  /* ---------- viewer ---------- */
  var root, body, stack = [], depth = 0, cache = new Map(), tab = "video", token = 0, playerEl;

  function build() {
    if (root) return;
    root = document.createElement("div");
    root.id = "aashViewer";
    root.className = "aash-viewer";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Aash Edu course viewer");
    root.innerHTML = '<div class="aash-top"><button type="button" class="aash-back" aria-label="Back">←</button><nav class="aash-crumbs" aria-label="Breadcrumb"></nav></div><div class="aash-body"></div>';
    document.body.appendChild(root);
    body = root.querySelector(".aash-body");
    root.querySelector(".aash-back").addEventListener("click", function () { history.back(); });
    playerEl = document.createElement("div");
    playerEl.className = "aash-player";
    playerEl.innerHTML = '<div class="aash-player-box"><div class="aash-player-head"><div class="aash-player-title"></div><a class="aash-btn aash-btn-ghost aash-newtab" target="_blank" rel="noopener">Open in new tab ↗</a><button type="button" class="aash-btn aash-close">✕</button></div><div class="aash-player-crumb"></div><iframe allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="no-referrer"></iframe></div>';
    document.body.appendChild(playerEl);
    playerEl.querySelector(".aash-close").addEventListener("click", closePlayer);
    playerEl.addEventListener("click", function (e) { if (e.target === playerEl) closePlayer(); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !root.classList.contains("open")) return;
      if (playerEl.classList.contains("open")) closePlayer(); else history.back();
    });
    window.addEventListener("popstate", function (e) {
      if (!root.classList.contains("open")) return;
      var d = e.state && typeof e.state.aashDepth === "number" ? e.state.aashDepth : 0;
      if (playerEl.classList.contains("open")) closePlayer(true);
      if (d < 1) { hide(); return; }
      stack.length = d; depth = d; render();
    });
  }

  function hide() {
    root.classList.remove("open");
    document.documentElement.classList.remove("aash-lock");
    stack = []; depth = 0; token++;
  }

  function push(view) {
    stack.push(view); depth = stack.length;
    history.pushState({ aashDepth: depth }, "");
    render();
  }

  function open(batch) {
    var id = batch && (batch._id || batch.batch_id);
    if (!id) return;
    build();
    stack = []; depth = 0;
    root.classList.add("open");
    document.documentElement.classList.add("aash-lock");
    tab = "video";
    push({ level: "subjects", course: { id: String(id), name: batch.name || "Course", cat: batch.byName || "" } });
  }

  function crumbs() {
    var v = stack[stack.length - 1];
    var parts = [{ label: "Home", go: -1 }, { label: v.course.name, go: 0 }];
    if (v.subject) parts.push({ label: v.subject.name, go: 1 });
    if (v.topic) parts.push({ label: v.topic.name, go: 2 });
    return parts;
  }

  function renderCrumbs() {
    var parts = crumbs(), last = parts.length - 1;
    root.querySelector(".aash-crumbs").innerHTML = parts.map(function (p, i) {
      var cls = i === last ? "aash-crumb cur" : "aash-crumb";
      return (i ? '<span class="aash-sep">›</span>' : "") + '<button type="button" class="' + cls + '" data-go="' + p.go + '"' + (i === last ? " disabled" : "") + ">" + esc(p.label) + "</button>";
    }).join("");
    root.querySelectorAll(".aash-crumb:not(.cur)").forEach(function (b) {
      b.addEventListener("click", function () {
        var go = Number(b.dataset.go), target = go + 1; // stack index -> depth
        if (go < 0) { history.go(-depth); return; }
        var back = depth - target;
        if (back > 0) history.go(-back);
      });
    });
  }

  function skeleton(n) {
    return '<div class="aash-grid">' + Array.from({ length: n || 6 }, function () { return '<div class="aash-card aash-skel"><div class="aash-skel-ico"></div><div class="aash-skel-lines"><i></i><i></i></div></div>'; }).join("") + "</div>";
  }

  function errorBox(msg, retry) {
    body.innerHTML = '<div class="aash-error" role="alert"><strong>Something went wrong</strong><p>' + esc(msg) + '</p><button type="button" class="aash-btn aash-retry">Retry</button></div>';
    body.querySelector(".aash-retry").addEventListener("click", retry);
  }

  async function load(key, path, mapper) {
    if (cache.has(key)) return cache.get(key);
    var data = mapper(listOf(await api(path)));
    cache.set(key, data);
    return data;
  }

  async function render() {
    var view = stack[stack.length - 1];
    if (!view) return;
    var my = ++token;
    renderCrumbs();
    body.scrollTop = 0;
    body.innerHTML = '<div class="aash-head"><h2>' + esc(view.level === "subjects" ? view.course.name : view.level === "topics" ? view.subject.name : view.topic.name) + "</h2><p>" + esc(view.level === "subjects" ? (view.course.cat || "Select a subject") : view.level === "topics" ? "Select a chapter" : "Lectures & study material") + "</p></div>" + skeleton(view.level === "lectures" ? 5 : 6);
    try {
      if (view.level === "subjects") {
        var subjects = await load("s:" + view.course.id, "/get/allsubjectfrmlivecourseclass?courseid=" + encodeURIComponent(view.course.id), function (rows) {
          return rows.map(function (s, i) {
            var id = String(s.subjectid || s.id || i);
            return { id: id, name: s.subject_name || s.title || "Subject #" + id, logo: s.subject_logo || s.icon || "", videos: s.total_videos || s.video_count, pdfs: s.total_pdf || s.pdf_count, topics: s.total_topics };
          });
        });
        if (my !== token) return;
        renderList(subjects, "subject", function (s) {
          var bits = [];
          if (s.topics) bits.push(s.topics + " chapters");
          if (s.videos) bits.push(s.videos + " videos");
          if (s.pdfs) bits.push(s.pdfs + " PDFs");
          return bits.join(" · ") || "Open subject";
        }, function (s) { push({ level: "topics", course: view.course, subject: { id: s.id, name: s.name } }); }, "No subjects are available in this course yet.");
      } else if (view.level === "topics") {
        var topics = await load("t:" + view.course.id + ":" + view.subject.id, "/get/alltopicfrmlivecourseclass?courseid=" + encodeURIComponent(view.course.id) + "&subjectid=" + encodeURIComponent(view.subject.id), function (rows) {
          return rows.map(function (t, i) {
            var id = String(t.topicid || t.id || i);
            return { id: id, name: t.topic_name || t.title || "Topic #" + (i + 1), logo: t.topic_logo || t.topic_thumbnail || "", count: t.total_videos || t.video_count || t.live_class_count || t.total_lectures };
          });
        });
        if (my !== token) return;
        renderList(topics, "topic", function (t) { return t.count ? t.count + " lectures" : "Open chapter"; },
          function (t) { push({ level: "lectures", course: view.course, subject: view.subject, topic: { id: t.id, name: t.name } }); }, "No chapters are available in this subject yet.");
      } else {
        var items = await load("l:" + view.course.id + ":" + view.subject.id + ":" + view.topic.id, "/get/livecourseclassbycoursesubtopconceptapiv3?courseid=" + encodeURIComponent(view.course.id) + "&subjectid=" + encodeURIComponent(view.subject.id) + "&topicid=" + encodeURIComponent(view.topic.id) + "&conceptid=&start=-1", normaliseItems);
        if (my !== token) return;
        renderLectures(items, view);
      }
    } catch (err) {
      if (my !== token) return;
      errorBox(err.message || "Unable to load this section.", function () { cache.clear(); render(); });
    }
  }

  function renderList(rows, kind, sub, onPick, emptyMsg) {
    var head = body.querySelector(".aash-head").outerHTML;
    if (!rows.length) { body.innerHTML = head + '<div class="aash-empty">' + esc(emptyMsg) + "</div>"; return; }
    body.innerHTML = head + '<div class="aash-grid">' + rows.map(function (r, i) {
      var ico = r.logo ? '<img src="' + esc(r.logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{textContent:\'' + (kind === "subject" ? "📘" : "📂") + '\'}))">' : "<span>" + (kind === "subject" ? "📘" : "📂") + "</span>";
      return '<button type="button" class="aash-card" data-i="' + i + '"><div class="aash-ico">' + ico + '</div><div class="aash-info"><div class="aash-name">' + esc(r.name) + '</div><div class="aash-sub">' + esc(sub(r)) + '</div></div><span class="aash-go">›</span></button>';
    }).join("") + "</div>";
    body.querySelectorAll(".aash-card").forEach(function (b) {
      b.addEventListener("click", function () { onPick(rows[Number(b.dataset.i)]); });
    });
  }

  function renderLectures(items, view) {
    var head = body.querySelector(".aash-head").outerHTML;
    var vids = items.filter(function (i) { return !i.isPdf; });
    var pdfs = items.filter(function (i) { return i.isPdf; });
    var shown = tab === "video" ? vids : pdfs;
    var html = head + '<div class="aash-tabs" role="tablist"><button type="button" role="tab" class="aash-tab' + (tab === "video" ? " on" : "") + '" data-tab="video">Videos <b>' + vids.length + '</b></button><button type="button" role="tab" class="aash-tab' + (tab === "pdf" ? " on" : "") + '" data-tab="pdf">Notes / PDFs <b>' + pdfs.length + "</b></button></div>";
    if (!shown.length) {
      html += '<div class="aash-empty">' + (tab === "video" ? "No videos in this chapter yet." : "No notes or PDFs in this chapter yet.") + "</div>";
    } else {
      html += '<div class="aash-list">' + shown.map(function (it, i) {
        if (it.isPdf) {
          var has = !!it.pdf;
          return '<div class="aash-row"><div class="aash-ico"><span>📄</span></div><div class="aash-info"><div class="aash-name">' + esc(it.title) + '</div></div>' + (has ? '<a class="aash-btn" href="' + esc(it.pdf) + '" target="_blank" rel="noopener">View</a><a class="aash-btn aash-btn-ghost" href="' + esc(it.pdf) + '" download target="_blank" rel="noopener">Download</a>' : '<span class="aash-na">Unavailable</span>') + "</div>";
        }
        var thumb = it.thumb ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">' : "";
        return '<div class="aash-row"><div class="aash-ico aash-vid">' + thumb + '<span>▶</span></div><div class="aash-info"><div class="aash-name">' + esc(it.title) + "</div></div>" + (it.video ? '<button type="button" class="aash-btn aash-play" data-i="' + i + '">Play</button>' : '<span class="aash-na">Unavailable</span>') + "</div>";
      }).join("") + "</div>";
    }
    body.innerHTML = html;
    body.querySelectorAll(".aash-tab").forEach(function (b) {
      b.addEventListener("click", function () { tab = b.dataset.tab; renderLectures(items, view); });
    });
    body.querySelectorAll(".aash-play").forEach(function (b) {
      b.addEventListener("click", function () { playVideo(shown[Number(b.dataset.i)], view); });
    });
  }

  function playVideo(item, view) {
    var url = PLAYER_URL + "?url=" + encodeURIComponent(item.video) + "&title=" + encodeURIComponent(item.title);
    playerEl.querySelector(".aash-player-title").textContent = item.title;
    playerEl.querySelector(".aash-player-crumb").textContent = ["Home", view.course.name, view.subject.name, view.topic.name, item.title].join(" › ");
    playerEl.querySelector(".aash-newtab").href = url;
    playerEl.querySelector("iframe").src = url;
    playerEl.classList.add("open");
  }

  function closePlayer() {
    playerEl.classList.remove("open");
    playerEl.querySelector("iframe").src = "about:blank";
  }

  window.AashEdu = { open: open, fetchCourses: fetchCourses };
})();
