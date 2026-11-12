(function () {
    const EXTENSION_NAME = 'theme-asset-backup';
    const ROOT = `#${EXTENSION_NAME}-root`;
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let items = [];

    function classify(text) {
        const s = String(text || '').toLowerCase();
        const rules = [
            [/chat.?background|chat.?bg|background.*chat|#chat|mes.?background/, '聊天背景'],
            [/drawer|side.?panel|left.?panel|right.?panel|wand.?menu|extensions.?menu/, '抽屉/侧边面板'],
            [/avatar|profile.?image|user.?avatar|character.?avatar/, '头像'],
            [/message.*(header|head)|mes.*(header|head)|header.*message/, '消息头部'],
            [/message.*(footer|foot)|mes.*(footer|foot)|footer.*message/, '消息尾部'],
            [/bubble|mes_text|mes.?block|message.?body/, '消息气泡/正文'],
            [/textarea|input.?area|send.?form|prompt.?form/, '输入框区域'],
            [/top.?bar|topbar|header.?bar|navigation/, '顶部栏'],
            [/button|icon|ellipsis|pencil|edit|menu/, '按钮/功能图标'],
            [/background|wallpaper|backdrop/, '背景图片']
        ];
        for (const [re, label] of rules) if (re.test(s)) return label;
        return '未识别用途';
    }

    function collect(value, path, out) {
        if (typeof value === 'string') {
            const re = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;
            let m;
            while ((m = re.exec(value))) {
                out.push({ url: m[2], path, use: classify(path + ' ' + value.slice(Math.max(0, m.index - 180), Math.min(value.length, re.lastIndex + 100))) });
            }
            // Also accept a bare image URL only when it appears in a CSS-like string.
            if (/(background|image|icon|url|css|style)/i.test(path) && /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(value.trim())) {
                out.push({ url: value.trim(), path, use: classify(path) });
            }
        } else if (Array.isArray(value)) {
            value.forEach((v, i) => collect(v, `${path}[${i}]`, out));
        } else if (value && typeof value === 'object') {
            Object.entries(value).forEach(([k, v]) => collect(v, path ? `${path}.${k}` : k, out));
        }
    }

    function uniqueItems(found) {
        const map = new Map();
        for (const x of found) {
            if (!map.has(x.url)) map.set(x.url, { url: x.url, uses: [], paths: [] });
            const item = map.get(x.url);
            if (!item.uses.includes(x.use)) item.uses.push(x.use);
            if (!item.paths.includes(x.path)) item.paths.push(x.path);
        }
        return [...map.values()].map((x, i) => ({
            ...x, id: i, name: makeName(x.uses) + extensionFromUrl(x.url, 'bin'), selected: true,
            status: '待下载', blob: null
        }));
    }

    function makeName(uses) {
        const names = [...new Set(uses)].filter(Boolean);
        const base = names.length ? names.join('与') : '未识别用途';
        return base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 70) + '_';
    }
    function extensionFromUrl(url, fallback) {
        try {
            const p = new URL(url).pathname;
            const m = p.match(/\.([a-z0-9]{2,5})$/i);
            return m ? '.' + m[1].toLowerCase() : '.' + fallback;
        } catch { return '.' + fallback; }
    }
    function uniqueFileName(name, used) {
        const dot = name.lastIndexOf('.');
        const base = dot > -1 ? name.slice(0, dot) : name;
        const ext = dot > -1 ? name.slice(dot) : '';
        let candidate = name, n = 2;
        while (used.has(candidate.toLowerCase())) candidate = `${base}_${n++}${ext}`;
        used.add(candidate.toLowerCase());
        return candidate;
    }

    function render() {
        const list = document.querySelector(`${ROOT} .tab-list`);
        if (!list) return;
        list.innerHTML = items.map(item => `
            <div class="tab-item">
              <input type="checkbox" data-select="${item.id}" ${item.selected ? 'checked' : ''}>
              <div class="tab-preview">${item.preview ? `<img src="${esc(item.preview)}">` : '<span>图片</span>'}</div>
              <div class="tab-info">
                <input class="tab-name" data-name="${item.id}" value="${esc(item.name)}" aria-label="文件名">
                <div class="tab-use">用途：${esc(item.uses.join('、'))}</div>
                <div class="tab-use">识别依据：${esc(item.paths.join('；'))}</div>
                <div class="tab-status" data-status="${item.id}">${esc(item.status)}</div>
              </div>
              <button type="button" data-open="${item.id}">打开原图</button>
            </div>`).join('');
        const count = items.filter(x => x.selected).length;
        const countEl = document.querySelector(`${ROOT} .tab-count`);
        if (countEl) countEl.textContent = `共 ${items.length} 张，已选择 ${count} 张`;
    }

    function setStatus(id, text) {
        const el = document.querySelector(`${ROOT} [data-status="${id}"]`);
        if (el) el.textContent = text;
        const item = items.find(x => x.id === id);
        if (item) item.status = text;
    }

    function crc32(bytes) {
        let c = -1;
        for (let i = 0; i < bytes.length; i++) {
            c ^= bytes[i];
            for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
        }
        return (c ^ -1) >>> 0;
    }
    function u16(n) { return [n & 255, (n >>> 8) & 255]; }
    function u32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
    function concat(chunks) {
        const size = chunks.reduce((a, b) => a + b.length, 0);
        const out = new Uint8Array(size); let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.length; }
        return out;
    }
    function makeZip(files) {
        const enc = new TextEncoder(), local = [], central = []; let offset = 0;
        for (const f of files) {
            const name = enc.encode(f.name), data = f.data, crc = crc32(data);
            const header = new Uint8Array([
                0x50,0x4b,0x03,0x04,20,0,0,0,0,0,0,0,0,0,
                ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),0,0
            ]);
            const chunk = concat([header, name, data]); local.push(chunk);
            const ch = new Uint8Array([
                0x50,0x4b,0x01,0x02,20,0,20,0,0,0,0,0,0,0,
                ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),0,0,0,0,0,0,0,0,0,0,
                ...u32(offset)
            ]);
            central.push(concat([ch, name]));
            offset += chunk.length;
        }
        const cd = concat(central), body = concat(local);
        const end = new Uint8Array([0x50,0x4b,0x05,0x06,0,0,0,0,...u16(files.length),...u16(files.length),...u32(cd.length),...u32(body.length),0,0]);
        return new Blob([body, cd, end], { type: 'application/zip' });
    }

    async function downloadSelected() {
        const chosen = items.filter(x => x.selected);
        if (!chosen.length) return alert('请先选择要保存的图片。');
        const files = [], manifestRows = [], used = new Set();
        for (const item of chosen) {
            try {
                setStatus(item.id, '正在读取原图…');
                const response = await fetch(item.url, { mode: 'cors', credentials: 'omit' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                if (!blob.size) throw new Error('图片内容为空');
                const bytes = new Uint8Array(await blob.arrayBuffer());
                const typeExt = ({'image/jpeg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','image/avif':'.avif','image/svg+xml':'.svg'})[blob.type] || extensionFromUrl(item.url, 'bin');
                let name = item.name.replace(/\.[^.]+$/, '') + typeExt;
                name = uniqueFileName(name, used);
                files.push({ name, data: bytes });
                manifestRows.push({ file: name, original_url: item.url, uses: item.uses, css_locations: item.paths });
                setStatus(item.id, '已读取');
            } catch (e) {
                setStatus(item.id, '读取失败（可能受图床跨域限制）：' + e.message);
            }
        }
        if (!files.length) return alert('没有图片能够被网页直接读取。你可以点击「打开原图」，再用浏览器保存图片。');
        const manifestText = JSON.stringify({ tool: '美化素材备份器', version: '0.2.1', created_at: new Date().toISOString(), files: manifestRows }, null, 2);
        files.push({ name: '素材清单.json', data: new TextEncoder().encode(manifestText) });
        const zip = makeZip(files), a = document.createElement('a');
        const url = URL.createObjectURL(zip); a.href = url; a.download = '美化素材备份.zip';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        alert(`已打包 ${files.length - 1} 张图片。读取失败的图片没有被放入 ZIP，请按列表提示单独保存。`);
    }

    function init() {
        if (document.querySelector(ROOT)) return;
        const target = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
        if (!target) return;
        const wrap = document.createElement('section');
        wrap.id = `${EXTENSION_NAME}-root`;
        wrap.innerHTML = `
          <div class="inline-drawer">
            <div class="inline-drawer-header">
              <b>美化素材备份器</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">
              <p>选择你主动指定的美化 JSON，扫描其中的图片外链。图片用途识别仅供参考，可自行修改文件名。</p>
              <label class="tab-file-label">选择美化 JSON 文件 <input class="tab-file" type="file" accept=".json,application/json"></label>
              <div class="tab-toolbar">
                <button type="button" class="tab-all">全选</button>
                <button type="button" class="tab-none">取消全选</button>
                <span class="tab-count">尚未扫描</span>
              </div>
              <div class="tab-list"></div>
              <button type="button" class="tab-download">下载选中图片 ZIP</button>
              <p class="tab-note">说明：本扩展只在你选择文件后扫描；不会上传你的 JSON。允许跨域读取的图片可批量打包，受图床限制的图片请打开原图后手动保存。字体暂不处理。</p>
            </div>
          </div>`;
        target.appendChild(wrap);
        wrap.querySelector('.inline-drawer-header').addEventListener('click', () => wrap.querySelector('.inline-drawer').classList.toggle('closed'));
        wrap.querySelector('.tab-file').addEventListener('change', async e => {
            const file = e.target.files && e.target.files[0];
            items = [];
            if (!file) return;
            try {
                const json = JSON.parse(await file.text()), found = [];
                collect(json, '', found);
                items = uniqueItems(found);
                render();
                if (!items.length) alert('没有找到 CSS url(https://...) 图片链接。请确认选择的是包含美化 CSS 的 JSON 文件。');
            } catch (err) { alert('JSON 读取失败：' + err.message); }
        });
        wrap.querySelector('.tab-all').addEventListener('click', () => { items.forEach(x => x.selected = true); render(); });
        wrap.querySelector('.tab-none').addEventListener('click', () => { items.forEach(x => x.selected = false); render(); });
        wrap.querySelector('.tab-download').addEventListener('click', downloadSelected);
        wrap.querySelector('.tab-list').addEventListener('change', e => {
            const id = Number(e.target.dataset.select);
            if (e.target.matches('[data-select]')) { const item = items.find(x => x.id === id); if (item) item.selected = e.target.checked; render(); }
            if (e.target.matches('[data-name]')) { const item = items.find(x => x.id === Number(e.target.dataset.name)); if (item) item.name = e.target.value; }
        });
        wrap.querySelector('.tab-list').addEventListener('click', e => {
            const id = Number(e.target.dataset.open);
            if (e.target.matches('[data-open]') && items[id]) window.open(items[id].url, '_blank', 'noopener');
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    const observer = new MutationObserver(() => { if (!document.querySelector(ROOT)) init(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();