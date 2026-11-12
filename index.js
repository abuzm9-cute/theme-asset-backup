(function () {
  "use strict";

  const EXTENSION_NAME = "theme-asset-backup";
  const ROOT = `#${EXTENSION_NAME}-root`;
  const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf", "eot"]);
  let items = [];
  let currentThemeName = "美化素材";

  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;", "'": "&#39;", }[ch]) ); function isHttpUrl(value) { try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; } catch (_) { return false; } } function isFontUrl(value) { try { const pathname = new URL(value).pathname; const ext = pathname.split(".").pop().toLowerCase(); return FONT_EXTENSIONS.has(ext); } catch (_) { return false; } } function fileNameFromUrl(url, index) { try { const pathname = new URL(url).pathname; let base = pathname.split("/").filter(Boolean).pop() || ""; try { base = decodeURIComponent(base); } catch (_) { /* keep original */ } base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
      if (!base || base === "." || base === "..")
        return `image_${String(index + 1).padStart(3, "0")}`;
      return base.slice(0, 150);
    } catch (_) {
      return `image_${String(index + 1).padStart(3, "0")}`;
    }
  }

  function lineAndColumn(source, index) {
    const before = source.slice(0, index);
    const line = (before.match(/\n/g) || []).length + 1;
    const lastBreak = before.lastIndexOf("\n");
    return { line, column: index - lastBreak };
  }

  function makeContext(source, lineNumber, url) {
    const lines = source.split(/\r?\n/);
    const start = Math.max(1, lineNumber - 2);
    const end = Math.min(lines.length, lineNumber + 2);
    const snippet = [];
    for (let n = start; n <= end; n++) {
      const raw = lines[n - 1] ?? "";
      let safe = esc(raw);
      if (n === lineNumber) {
        const at = raw.indexOf(url);
        if (at >= 0) {
          safe = `${esc(raw.slice(0, at))}<mark>${esc(
            raw.slice(at, at + url.length)
          )}</mark>${esc(raw.slice(at + url.length))}`;
        }
      }
      snippet.push(
        `<div class="tab-code-line ${ n === lineNumber ? "is-target" : "" }"><span class="tab-line-no">${n}</span><code>${
          safe || "&nbsp;"
        }</code></div>`
      );
    }
    return snippet.join("");
  }

  // Extract only CSS url(...) references. Font files are intentionally excluded;
  // the tool is an image-material backup utility, not a font backup tool.
  function scanString(source, path, found) {
    if (typeof source !== "string" || !source.toLowerCase().includes("url("))
      return;
    const re = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
    let match;
    while ((match = re.exec(source)) !== null) {
      const previousBreak = source.lastIndexOf("\n", match.index);
      const linePrefix = source.slice(previousBreak + 1, match.index);
      // Ignore @import stylesheet URLs (for example externally hosted font CSS).
      if (/@import\b/i.test(linePrefix)) continue;
      let url = (match[2] !== undefined ? match[2] : match[3] || "").trim();
      // CSS may contain escaped spaces; leave the actual URL unchanged otherwise.
      url = url.replace(/\\(["'() ])/g, "$1");
      if (!isHttpUrl(url) || isFontUrl(url)) continue;
      const pos = lineAndColumn(source, match.index);
      found.push({
        url,
        path,
        line: pos.line,
        column: pos.column,
        context: makeContext(source, pos.line, url),
      });
    }
  }

  function walkJson(value, path, found) {
    if (typeof value === "string") {
      scanString(value, path || "(根字段)", found);
    } else if (Array.isArray(value)) {
      value.forEach((child, index) =>
        walkJson(child, `${path}[${index}]`, found)
      );
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => {
        walkJson(child, path ? `${path}.${key}` : key, found);
      });
    }
  }

  function groupByExactUrl(found) {
    const map = new Map();
    for (const ref of found) {
      if (!map.has(ref.url)) map.set(ref.url, { url: ref.url, refs: [] });
      map.get(ref.url).refs.push(ref);
    }
    return [...map.values()].map((entry, index) => ({
      ...entry,
      id: index,
      name: fileNameFromUrl(entry.url, index),
      selected: true,
      detailsOpen: false,
      previewFailed: false,
      status: "等待备份",
    }));
  }

  function render() {
    const root = document.querySelector(ROOT);
    if (!root) return;
    const list = root.querySelector(".tab-list");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="tab-empty">扫描结果会显示在这里。</div>';
    } else {
      list.innerHTML = items
        .map(
          (item) => `
                <article class="tab-item" data-item="${item.id}">
                    <label class="tab-select"><input type="checkbox" data-select="${ item.id }" ${
            item.selected ? "checked" : ""
          }><span>选择</span></label>
                    <div class="tab-preview"><img loading="lazy" data-preview="${ item.id }" src="${esc( item.url )}" alt="图片预览"><span class="tab-preview-fallback">预览不可用</span></div>
                    <div class="tab-info">
                        <div class="tab-file-name" title="${esc( item.name )}">${esc(item.name)}</div>
                        <div class="tab-ref-count">${
                          item.refs.length
                        } 处 CSS 引用</div>
                        <div class="tab-url">${esc(item.url)}</div>
                        <div class="tab-status" data-status="${item.id}">${esc(
            item.status
          )}</div>
                        <button type="button" class="tab-location-button" data-details="${ item.id }">${
            item.detailsOpen ? "收起 CSS 位置" : "查看 CSS 位置"
          }</button>
                    </div>
                    <button type="button" class="tab-open" data-open="${ item.id }">打开原图</button>
                    ${
                      item.detailsOpen
                        ? `<div class="tab-locations">${item.refs
                            .map(
                              (ref, n) => `
                        <section class="tab-location">
                            <div class="tab-location-title">位置 ${
                              n + 1
                            }：<b>${esc(ref.path)}</b> · 第 ${
                                ref.line
                              } 行，第 ${ref.column} 列</div>
                            <div class="tab-code">${ref.context}</div>
                        </section>`
                            )
                            .join("")}</div>`
                        : ""
                    }
                </article>`
        )
        .join("");
    }
    const selected = items.filter((item) => item.selected).length;
    const count = root.querySelector(".tab-count");
            "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/avif": ".avif",
        "image/svg+xml": ".svg",
        "image/bmp": ".bmp",
        "image/x-icon": ".ico",
        "image/vnd.microsoft.icon": ".ico",
      }[
        String(type || "")
          .split(";")[0]
          .toLowerCase()
      ] || ""
    );
  }

  function ensureUniqueName(name, used) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate.toLowerCase()))
      candidate = `${base}_${suffix++}${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  async function downloadSelected() {
    const chosen = items.filter((item) => item.selected);
    if (!chosen.length) return alert("请先勾选想备份的图片。");
    const files = [];
    const manifest = [];
    const usedNames = new Set();
    let failed = 0;

    for (const item of chosen) {
      try {
        setStatus(item.id, "正在读取原图…");
        const response = await fetch(item.url, {
          mode: "cors",
          credentials: "omit",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("图片内容为空");
        if (blob.type && !blob.type.toLowerCase().startsWith("image/"))
          throw new Error(`响应类型不是图片：${blob.type}`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let name = item.name;
        if (!/\.[a-z0-9]{2,8}$/i.test(name))
          name += extensionForMime(blob.type) || ".img";
        name = ensureUniqueName(name, usedNames);
        files.push({ name, data: bytes });
        manifest.push({
          saved_file: name,
          original_filename_from_url: item.name,
          original_url: item.url,
          css_references: item.refs.map((ref) => ({
            field: ref.path,
            line: ref.line,
            column: ref.column,
          })),
        });
        setStatus(item.id, "已加入 ZIP");
      } catch (error) {
        failed++;
        setStatus(
          item.id,
          `读取失败：${error.message}（可尝试打开原图手动保存）`
        );
      }
    }

    if (!files.length) {
      alert(
        "这次没有图片能被网页直接读取。常见原因是图床不允许跨域读取。你仍可以逐张点击「打开原图」，再用浏览器保存。"
      );
      return;
    }
    const manifestText = JSON.stringify(
      {
        tool: "美化素材备份器",
        version: "0.3.0",
        theme: currentThemeName,
        created_at: new Date().toISOString(),
        files: manifest,
      },
      null,
      2
    );
    files.push({
      name: "素材清单.json",        const item = items.find(
          (entry) => entry.id === Number(open.dataset.open)
        );
        if (item) window.open(item.url, "_blank", "noopener,noreferrer");
      }
    });
    list.addEventListener(
      "error",
      (event) => {
        if (!event.target.matches("[data-preview]")) return;
        const item = items.find(
          (entry) => entry.id === Number(event.target.dataset.preview)
        );
        if (item) {
          item.previewFailed = true;
          const preview = event.target.closest(".tab-preview");
          if (preview) preview.classList.add("preview-error");
        }
      },
      true
    );
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
  const observer = new MutationObserver(() => {
    if (!document.querySelector(ROOT)) init();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
