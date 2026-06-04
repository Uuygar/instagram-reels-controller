// ==UserScript==
// @name         Instagram Reels Premium Media Controller
// @namespace    http://tampermonkey.net/
// @version      23.0.0
// @description  Reels kontrolcüsü: dikey reel'lerde YouTube tarzı timeline + dikey ses + reel indirme; feed fotoğraflarında hover indirme; profil avatarında HD büyütme/indirme. Boyut bazlı reel tespiti, scroll-settle ile takılmasız konumlama, ses/mute/hız hafızası + auto-mute düzeltmesi.
// @connect      instagram.com
// @author       Uygar
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @updateURL    https://raw.githubusercontent.com/Uuygar/instagram-reels-controller/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/Uuygar/instagram-reels-controller/main/script.user.js
// @supportURL   https://github.com/Uuygar/instagram-reels-controller/issues
// @grant        none
// @license      MIT
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    // iframe'lerde (gömülü içerik) çalışma — tek üst pencere yeter, çift UI önlenir
    if (window.top !== window.self) return;

    /* ============================ CONFIG ============================ */
    const TICK_MS = 250;            // ana döngü periyodu
    const SCROLL_SETTLE_MS = 120;   // scroll durduğuna karar verme gecikmesi
    // Bir videonun "reel" sayılması için intrinsic yükseklik/genişlik eşiği.
    // 9:16 reel ≈ 1.78, 4:5 feed gönderisi ≈ 1.25. Düşür = daha kapsayıcı.
    const REEL_RATIO = 1.4;

    const VOL_KEY = 'ig_reels_vol_v20';
    const VOL_LAST_KEY = 'ig_reels_lastvol_v20';
    const SPEED_KEY = 'ig_reels_speed_v20';

    /* ============================ STATE ============================ */
    const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

    const State = {
        volume: parseFloat(lsGet(VOL_KEY, '0.5')),
        lastVolume: parseFloat(lsGet(VOL_LAST_KEY, '0.5')) || 0.5,
        speed: parseFloat(lsGet(SPEED_KEY, '1')),
        isSeeking: false,
        setVolume(val) {
            this.volume = val;
            if (val > 0) { this.lastVolume = val; lsSet(VOL_LAST_KEY, val); }
            lsSet(VOL_KEY, val);
        },
        setSpeed(val) { this.speed = val; lsSet(SPEED_KEY, val); }
    };

    const $ = (id) => document.getElementById(id);
    const formatTime = (secs) => {
        if (!isFinite(secs)) return "0:00";
        const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    /* ====================== ACTIVE VIDEO (cached) ====================== */
    let activeVideo = null;

    const scanActiveVideo = () => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (dialog) {
            const dv = dialog.querySelector('video');
            if (dv) return dv;
        }
        const vH = window.innerHeight, vW = window.innerWidth;
        let best = null, maxArea = 0;
        for (const vid of document.querySelectorAll('video')) {
            const r = vid.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const area =
                Math.max(0, Math.min(vH, r.bottom) - Math.max(0, r.top)) *
                Math.max(0, Math.min(vW, r.right) - Math.max(0, r.left));
            if (area > maxArea) { maxArea = area; best = vid; }
        }
        return best;
    };
    const refreshActiveVideo = () => (activeVideo = scanActiveVideo());
    const getActiveVideo = () => activeVideo;

    /* ====================== MODE DETECTION ====================== */
    const isReelsUrl = () => {
        const p = location.pathname;
        return p.startsWith('/reels') || p.includes('/reel/');
    };

    // Gerçek (intrinsic) çözünürlükten oran al; yüklenmemişse kutu oranına düş
    const videoAspect = (v) => {
        if (v.videoWidth && v.videoHeight) return v.videoHeight / v.videoWidth;
        const r = v.getBoundingClientRect();
        return r.width ? r.height / r.width : 0;
    };
    const isReelLikeVideo = (v) => !!v && videoAspect(v) > REEL_RATIO;

    let currentMode = null;
    // 2 mod: 'reels' (izlenen dikey reel) ve 'none' (uygun reel yok -> gizli)
    const computeMode = () => {
        const v = activeVideo;
        if (!v) return 'none';
        const r = v.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return 'none';
        const visH = Math.max(0, Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top));
        const screenFrac = visH / window.innerHeight; // video ekranın ne kadarını kaplıyor

        // Yeterince büyük/görünür değilse (grid önizleme, kaydırma arası) -> gizle.
        // Histerezis: girişte 0.5, çıkışta 0.4 -> sınırda titremeyi önler.
        const prominent = currentMode === 'none' ? screenFrac > 0.5 : screenFrac > 0.4;
        if (!prominent) return 'none';

        return (isReelsUrl() || isReelLikeVideo(v)) ? 'reels' : 'none';
    };

    /* ====================== VIDEO ENFORCE ====================== */
    const enforceVideo = (v) => {
        if (!v) return;
        if (State.volume === 0) { if (!v.muted) v.muted = true; }
        else {
            if (v.muted) v.muted = false;
            if (Math.abs(v.volume - State.volume) > 0.01) v.volume = State.volume;
        }
        if (v.playbackRate !== State.speed) v.playbackRate = State.speed;
    };
    const applyToActive = () => enforceVideo(getActiveVideo());

    /* ============================ ICONS ============================ */
    const icons = {
        pause: `<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
        play: `<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>`,
        volHigh: `<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`,
        volMute: `<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`,
        download: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        expand: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
    };

    /* ====================== DOWNLOAD HELPERS ====================== */
    let toastTimer = null;
    const toast = (msg) => {
        let t = $('ig-toast');
        if (!t) {
            t = document.createElement('div'); t.id = 'ig-toast';
            Object.assign(t.style, {
                position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
                zIndex: '100001', padding: '10px 16px', borderRadius: '10px',
                background: 'rgba(15,15,20,0.92)', color: '#fff', fontSize: '13px', fontWeight: '600',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                boxShadow: '0 6px 24px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.08)',
                pointerEvents: 'none', opacity: '0', transition: 'opacity 0.2s ease'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg; t.style.opacity = '1';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2400);
    };

    // URL'yi indir; CORS engellenirse yeni sekmede aç (kullanıcı sağ tık -> kaydet)
    const downloadUrl = async (url, filename) => {
        toast('İndiriliyor…');
        try {
            const res = await fetch(url, { credentials: 'omit' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 6000);
            toast('İndirildi ✓');
        } catch (e) {
            window.open(url, '_blank');
            toast('Yeni sekmede açıldı (sağ tık → kaydet)');
        }
    };

    // srcset'ten en yüksek çözünürlüklü kaynağı seç
    const pickBestImageSrc = (img) => {
        if (img.srcset) {
            let best = null, bw = -1;
            for (const part of img.srcset.split(',')) {
                const seg = part.trim().split(/\s+/);
                const w = seg[1] ? parseInt(seg[1]) : 0;
                if (w >= bw) { bw = w; best = seg[0]; }
            }
            if (best) return best;
        }
        return img.currentSrc || img.src;
    };

    // Reels indirme: shortcode -> media_id -> IG web API -> mp4
    const SC_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const shortcodeToMediaId = (sc) => {
        let id = 0n;
        for (const ch of sc) {
            const idx = SC_ALPHABET.indexOf(ch);
            if (idx < 0) return null;
            id = id * 64n + BigInt(idx);
        }
        return id.toString();
    };
    const findActiveShortcode = () => {
        const m = location.pathname.match(/\/(reel|p|tv)\/([^/]+)/);
        if (m) return m[2];
        const v = activeVideo;
        if (v) {
            const cont = v.closest('article') || v.closest('div[role="dialog"]') || document;
            const a = cont.querySelector('a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]');
            if (a) { const mm = (a.getAttribute('href') || '').match(/\/(reel|p|tv)\/([^/]+)/); if (mm) return mm[2]; }
        }
        return null;
    };
    const downloadActiveReel = async () => {
        const v = activeVideo;
        if (!v) { toast('Aktif reel bulunamadı'); return; }
        // 1) Doğrudan URL (MSE/blob değilse direkt indir)
        const direct = v.currentSrc || v.src;
        if (direct && !direct.startsWith('blob:')) { downloadUrl(direct, `reel_${Date.now()}.mp4`); return; }
        // 2) IG web API (giriş yapılmış oturum gerekir)
        toast('Reel kaynağı aranıyor…');
        try {
            const sc = findActiveShortcode();
            if (!sc) throw new Error('shortcode yok');
            const mediaId = shortcodeToMediaId(sc);
            if (!mediaId) throw new Error('mediaId yok');
            const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
                headers: { 'X-IG-App-ID': '936619743392459' },
                credentials: 'include'
            });
            if (!res.ok) throw new Error('API ' + res.status);
            const data = await res.json();
            const item = data.items && data.items[0];
            const vv = item && (item.video_versions || (item.carousel_media && item.carousel_media[0] && item.carousel_media[0].video_versions));
            const url = vv && vv[0] && vv[0].url;
            if (!url) throw new Error('video_versions yok');
            downloadUrl(url, `reel_${sc}.mp4`);
        } catch (e) {
            console.warn('[IG Controller] reel indirme başarısız:', e);
            toast('Bu reel doğrudan indirilemedi (IG kısıtı / giriş gerekli)');
        }
    };

    // Profil sayfası kullanıcı adı (rezerve yollar hariç)
    const RESERVED = new Set(['reels','reel','explore','direct','p','tv','stories','accounts','about','legal','privacy','settings','your_activity','emails','session','challenge','oauth','developer','web','ar','lite']);
    const getProfileUsername = () => {
        const seg = location.pathname.split('/').filter(Boolean);
        if (!seg.length) return null;
        return RESERVED.has(seg[0]) ? null : seg[0];
    };

    // HD profil fotoğrafını IG web API'sinden çek ve lightbox'ta göster
    const openAvatarLightbox = async (username) => {
        if (!username) { toast('Kullanıcı adı bulunamadı'); return; }
        toast('HD profil fotoğrafı alınıyor…');
        try {
            const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
                headers: { 'X-IG-App-ID': '936619743392459' },
                credentials: 'include'
            });
            if (!res.ok) throw new Error('API ' + res.status);
            const data = await res.json();
            const user = data.data && data.data.user;
            const url = user && (user.profile_pic_url_hd || user.profile_pic_url);
            if (!url) throw new Error('pic yok');
            showLightbox(url, `${username}_profile.jpg`);
        } catch (e) {
            console.warn('[IG Controller] profil foto alınamadı:', e);
            toast('Profil fotoğrafı alınamadı (IG kısıtı / giriş gerekli)');
        }
    };

    // Tam ekran görsel önizleme + indir butonu
    const showLightbox = (url, filename) => {
        const old = $('ig-lightbox'); if (old) old.remove();
        const ov = document.createElement('div'); ov.id = 'ig-lightbox';
        Object.assign(ov.style, {
            position: 'fixed', inset: '0', zIndex: '100002', cursor: 'zoom-out',
            background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px'
        });
        const img = document.createElement('img'); img.src = url;
        Object.assign(img.style, { maxWidth: '90vw', maxHeight: '78vh', borderRadius: '14px', objectFit: 'contain', boxShadow: '0 12px 48px rgba(0,0,0,0.6)' });
        const dl = document.createElement('div'); dl.textContent = '⬇  İndir';
        Object.assign(dl.style, {
            padding: '10px 20px', borderRadius: '10px', background: '#fff', color: '#000',
            fontWeight: '700', fontSize: '14px', cursor: 'pointer',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        });
        dl.addEventListener('click', (e) => { e.stopPropagation(); downloadUrl(url, filename); });
        ov.append(img, dl);
        ov.addEventListener('click', () => { ov.remove(); document.removeEventListener('keydown', esc); });
        const esc = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } };
        document.addEventListener('keydown', esc);
        document.body.appendChild(ov);
    };

    // Fotoğraf indirme (hover butonu) + profil avatarı HD büyütme
    const createPhotoDl = () => {
        if ($('ig-photo-dl')) return;
        const btn = document.createElement('div');
        btn.id = 'ig-photo-dl'; btn.innerHTML = icons.download; btn.title = 'Fotoğrafı indir';
        Object.assign(btn.style, {
            position: 'fixed', display: 'none', zIndex: '100000', cursor: 'pointer',
            width: '34px', height: '34px', borderRadius: '10px', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(15,15,20,0.7)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.12)',
            transition: 'transform 0.15s ease'
        });
        document.body.appendChild(btn);

        let currentImg = null, hideTimer = null;
        const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
        const hideSoon = () => { cancelHide(); hideTimer = setTimeout(() => { btn.style.display = 'none'; currentImg = null; }, 140); };
        const showFor = (img, action, username) => {
            currentImg = img;
            btn.dataset.action = action;
            btn.dataset.username = username || '';
            btn.innerHTML = action === 'avatar' ? icons.expand : icons.download;
            btn.title = action === 'avatar' ? 'HD profil fotoğrafını gör' : 'Fotoğrafı indir';
            const r = img.getBoundingClientRect();
            if (action === 'avatar') { btn.style.left = (r.right - 38) + 'px'; btn.style.top = (r.bottom - 38) + 'px'; }
            else { btn.style.left = (r.right - 44) + 'px'; btn.style.top = (r.top + 10) + 'px'; }
            btn.style.display = 'flex';
        };

        btn.onmouseenter = () => { cancelHide(); btn.style.transform = 'scale(1.1)'; };
        btn.onmouseleave = () => { btn.style.transform = 'scale(1)'; hideSoon(); };
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (btn.dataset.action === 'avatar') {
                openAvatarLightbox(btn.dataset.username || getProfileUsername());
            } else if (currentImg) {
                const u = pickBestImageSrc(currentImg); if (u) downloadUrl(u, `instagram_${Date.now()}.jpg`);
            }
        });

        document.addEventListener('mouseover', (e) => {
            const tgt = e.target;
            if (!tgt || !tgt.closest) return;
            if (tgt.closest('#ig-photo-dl, #ig-reels-bar, #ig-reels-vol, #ig-lightbox')) { cancelHide(); return; }

            // 1) Profil sayfası header avatarı -> HD büyütme
            const username = getProfileUsername();
            if (username) {
                const header = tgt.closest('header');
                if (header) {
                    let av = null;
                    for (const im of header.querySelectorAll('img')) { const w = im.clientWidth; if (w >= 60 && w <= 220) { av = im; break; } }
                    if (av) { cancelHide(); showFor(av, 'avatar', username); return; }
                }
            }

            // 2) Gönderi fotoğrafı -> indirme
            const cont = tgt.closest('article, div[role="dialog"]');
            if (!cont) { hideSoon(); return; }
            for (const vid of cont.querySelectorAll('video')) { if (vid.clientWidth > 300) { hideSoon(); return; } } // video gönderisi -> atla
            let best = null, area = 0;
            for (const im of cont.querySelectorAll('img')) {
                const a = im.clientWidth * im.clientHeight;
                if (a > area && im.clientWidth > 300 && im.clientHeight > 200) { area = a; best = im; }
            }
            if (best) { cancelHide(); showFor(best, 'photo'); } else { hideSoon(); }
        }, { passive: true });
    };
    const wireMuteToggle = (el) => el.addEventListener('click', () => {
        if (State.volume === 0) State.setVolume(State.lastVolume > 0 ? State.lastVolume : 0.5);
        else State.setVolume(0);
        applyToActive(); updateVolUI();
    });
    const wireVolSlider = (s) => s.addEventListener('input', (e) => {
        State.setVolume(parseFloat(e.target.value)); updateVolUI(); applyToActive();
    });
    const wireTimeSlider = (s) => {
        const start = () => State.isSeeking = true;
        const end = () => State.isSeeking = false;
        s.addEventListener('mousedown', start);
        s.addEventListener('touchstart', start, { passive: true });
        s.addEventListener('input', (e) => { const v = getActiveVideo(); if (v && v.duration) v.currentTime = (parseFloat(e.target.value) / 100) * v.duration; });
        s.addEventListener('mouseup', end);
        s.addEventListener('touchend', end);
    };
    const wirePlayPause = (el) => el.addEventListener('click', () => {
        const v = getActiveVideo();
        if (!v) return;
        if (v.paused) { enforceVideo(v); v.play(); } else v.pause();
    });
    const buildSpeedPills = (className) => {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display: 'flex', gap: '4px', flexShrink: '0' });
        [1, 1.5, 2].forEach(sp => {
            const btn = document.createElement('div');
            btn.className = className; btn.textContent = `${sp}x`; btn.dataset.speed = sp;
            Object.assign(btn.style, {
                padding: '3px 7px', borderRadius: '7px', fontSize: '11px', fontWeight: '700',
                cursor: 'pointer', textAlign: 'center', transition: 'all 0.15s', letterSpacing: '0.4px',
                background: State.speed === sp ? '#ffffff' : 'rgba(255,255,255,0.12)',
                color: State.speed === sp ? '#000' : 'rgba(255,255,255,0.75)'
            });
            btn.addEventListener('click', () => { State.setSpeed(sp); applyToActive(); refreshSpeedUI(); });
            wrap.appendChild(btn);
        });
        return wrap;
    };

    /* ====================== REELS OVERLAY ====================== */
    const createReelsUI = () => {
        if ($('ig-reels-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'ig-reels-bar';
        Object.assign(bar.style, {
            position: 'fixed', display: 'none', alignItems: 'center', gap: '10px', zIndex: '99998',
            padding: '8px 14px', borderRadius: '14px',
            background: 'linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0.3))',
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            userSelect: 'none', boxSizing: 'border-box'
        });

        const rPlay = document.createElement('div'); rPlay.id = 'ig-r-play'; rPlay.innerHTML = icons.pause;
        Object.assign(rPlay.style, { cursor: 'pointer', flexShrink: '0', display: 'flex' });
        wirePlayPause(rPlay);
        const rCur = document.createElement('div'); rCur.id = 'ig-r-current'; rCur.textContent = '0:00';
        Object.assign(rCur.style, { fontSize: '11px', color: 'rgba(255,255,255,0.85)', fontFamily: 'monospace', width: '32px', textAlign: 'right', flexShrink: '0' });
        const rTime = document.createElement('input'); rTime.id = 'ig-r-time-slider'; rTime.type = 'range'; rTime.min = '0'; rTime.max = '100'; rTime.step = '0.1'; rTime.value = '0'; rTime.className = 'ig-tslider ig-r-tslider';
        Object.assign(rTime.style, { flex: '1', height: '4px', appearance: 'none', WebkitAppearance: 'none', background: 'rgba(255,255,255,0.25)', borderRadius: '2px', outline: 'none', cursor: 'pointer', transition: 'height 0.15s' });
        wireTimeSlider(rTime);
        const rDur = document.createElement('div'); rDur.id = 'ig-r-duration'; rDur.textContent = '0:00';
        Object.assign(rDur.style, { fontSize: '11px', color: 'rgba(255,255,255,0.85)', fontFamily: 'monospace', width: '32px', flexShrink: '0' });
        const rSpeed = buildSpeedPills('ig-speed-btn ig-r-speed');
        const rDl = document.createElement('div'); rDl.id = 'ig-r-download'; rDl.innerHTML = icons.download; rDl.title = 'Reel indir';
        Object.assign(rDl.style, { cursor: 'pointer', flexShrink: '0', display: 'flex' });
        rDl.addEventListener('click', downloadActiveReel);
        bar.append(rPlay, rCur, rTime, rDur, rSpeed, rDl);
        document.body.appendChild(bar);

        const vol = document.createElement('div');
        vol.id = 'ig-reels-vol';
        Object.assign(vol.style, {
            position: 'fixed', display: 'none', flexDirection: 'column', alignItems: 'center', gap: '8px', zIndex: '99998',
            padding: '12px 8px', borderRadius: '16px',
            background: 'rgba(15,15,20,0.7)', backdropFilter: 'blur(16px) saturate(180%)', WebkitBackdropFilter: 'blur(16px) saturate(180%)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.08)',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", userSelect: 'none'
        });
        const rVolBadge = document.createElement('div'); rVolBadge.id = 'ig-r-vol-badge'; rVolBadge.textContent = `${Math.round(State.volume * 100)}%`;
        Object.assign(rVolBadge.style, { fontSize: '11px', color: 'rgba(255,255,255,0.9)', fontWeight: '600' });
        const rVolWrap = document.createElement('div');
        Object.assign(rVolWrap.style, { height: '100px', display: 'flex', alignItems: 'center' });
        const rVolSlider = document.createElement('input'); rVolSlider.id = 'ig-r-vol-slider'; rVolSlider.type = 'range'; rVolSlider.min = '0'; rVolSlider.max = '1'; rVolSlider.step = '0.01'; rVolSlider.value = State.volume; rVolSlider.className = 'ig-vslider';
        Object.assign(rVolSlider.style, { writingMode: 'vertical-lr', direction: 'rtl', height: '100%', width: '24px', appearance: 'none', WebkitAppearance: 'none', background: 'transparent', outline: 'none', cursor: 'pointer' });
        wireVolSlider(rVolSlider); rVolWrap.appendChild(rVolSlider);
        const rVolIcon = document.createElement('div'); rVolIcon.id = 'ig-r-vol-icon'; rVolIcon.innerHTML = icons.volHigh;
        Object.assign(rVolIcon.style, { cursor: 'pointer', display: 'flex' });
        wireMuteToggle(rVolIcon);
        vol.append(rVolBadge, rVolWrap, rVolIcon);
        document.body.appendChild(vol);
    };

    // Sadece scroll DURDUĞUNDA çağrılır (per-frame değil) -> jank yok
    const anchorReelsUI = () => {
        const v = activeVideo, bar = $('ig-reels-bar'), vol = $('ig-reels-vol');
        if (!v || !bar || !vol) return;
        const r = v.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;

        const barH = bar.offsetHeight || 44;
        bar.style.left = (r.left + 12) + 'px';
        bar.style.width = (r.width - 24) + 'px';
        bar.style.top = (r.bottom - barH - 10) + 'px';

        const volW = vol.offsetWidth || 52, volH = vol.offsetHeight || 150;
        let vl = r.right - volW - 14;
        if (vl + volW > window.innerWidth) vl = window.innerWidth - volW - 8;
        if (vl < 0) vl = 8;
        vol.style.left = vl + 'px';
        vol.style.top = (r.bottom - barH - 22 - volH) + 'px';
    };

    /* ====================== UI UPDATES ====================== */
    const updateVolUI = () => {
        const pct = `${Math.round(State.volume * 100)}%`;
        const icon = State.volume === 0 ? icons.volMute : icons.volHigh;
        ['ig-r-vol-slider'].forEach(id => { const e = $(id); if (e) e.value = State.volume; });
        ['ig-r-vol-badge'].forEach(id => { const e = $(id); if (e) e.textContent = pct; });
        ['ig-r-vol-icon'].forEach(id => { const e = $(id); if (e) e.innerHTML = icon; });
    };
    const refreshSpeedUI = () => {
        document.querySelectorAll('.ig-speed-btn').forEach(b => {
            const on = parseFloat(b.dataset.speed) === State.speed;
            b.style.background = on ? '#ffffff' : 'rgba(255,255,255,0.12)';
            b.style.color = on ? '#000' : 'rgba(255,255,255,0.75)';
        });
    };
    const updatePlayPauseUI = (v) => {
        v = v || activeVideo; if (!v) return;
        const html = v.paused ? icons.play : icons.pause;
        ['ig-r-play'].forEach(id => { const e = $(id); if (e) e.innerHTML = html; });
    };
    const updateTimelineUI = (v) => {
        v = v || activeVideo;
        if (!v || v !== activeVideo || !v.duration || State.isSeeking) return;
        const percent = (v.currentTime / v.duration) * 100;
        const fill = `linear-gradient(to right, #ffffff ${percent}%, rgba(255,255,255,0.25) ${percent}%)`;
        ['ig-r-time-slider'].forEach(id => { const e = $(id); if (e) { e.value = percent; e.style.background = fill; } });
        ['ig-r-current'].forEach(id => { const e = $(id); if (e) e.textContent = formatTime(v.currentTime); });
        ['ig-r-duration'].forEach(id => { const e = $(id); if (e) e.textContent = formatTime(v.duration); });
    };

    /* ====================== MODE SWITCH ====================== */
    const applyMode = (mode) => {
        const bar = $('ig-reels-bar'), vol = $('ig-reels-vol');
        if (bar) bar.style.display = mode === 'reels' ? 'flex' : 'none';
        if (vol) vol.style.display = mode === 'reels' ? 'flex' : 'none';
        if (mode !== 'none') { updateVolUI(); refreshSpeedUI(); updatePlayPauseUI(); }
    };
    const syncMode = () => {
        const mode = computeMode();
        if (mode !== currentMode) { currentMode = mode; applyMode(mode); }
        if (mode === 'reels' && !isScrolling) anchorReelsUI();
    };

    /* ====================== VIDEO SYNC ====================== */
    const syncVideo = () => {
        const v = activeVideo;
        if (v && !v._igSynced) {
            v._igSynced = true;
            enforceVideo(v);
            v.addEventListener('loadedmetadata', () => { enforceVideo(v); syncMode(); });
            v.addEventListener('loadeddata', () => enforceVideo(v));
            v.addEventListener('timeupdate', () => updateTimelineUI(v));
            v.addEventListener('play', () => updatePlayPauseUI(v));
            v.addEventListener('pause', () => updatePlayPauseUI(v));
            updatePlayPauseUI(v);
        }
    };

    /* ====================== SCROLL-SETTLE (anti-jank) ====================== */
    let isScrolling = false;
    let scrollTimer = null;
    const onScrollEnd = () => {
        isScrolling = false;
        document.body.classList.remove('ig-scrolling');
        refreshActiveVideo();
        syncMode();
        const v = activeVideo;
        if (v && currentMode !== 'none') { syncVideo(); enforceVideo(v); updatePlayPauseUI(v); }
    };
    const onScroll = () => {
        if (!isScrolling) { isScrolling = true; document.body.classList.add('ig-scrolling'); }
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(onScrollEnd, SCROLL_SETTLE_MS);
    };

    /* ====================== MAIN LOOP ====================== */
    let lastActiveVideo = null;
    const tick = () => {
        if (isScrolling) return; // scroll sırasında ağır iş yapma
        refreshActiveVideo();
        syncMode(); // currentMode'u günceller
        const v = activeVideo;
        if (v && currentMode !== 'none') {
            if (v !== lastActiveVideo) { lastActiveVideo = v; syncVideo(); updatePlayPauseUI(v); }
            enforceVideo(v); // sadece izlenen videoya müdahale (grid önizleme sessiz kalır)
        }
    };

    /* ============================ STYLES ============================ */
    const injectStyles = () => {
        const style = document.createElement('style');
        style.textContent = `
            .ig-vslider::-webkit-slider-runnable-track { width: 4px; height: 100%; background: rgba(255,255,255,0.25); border-radius: 2px; }
            .ig-vslider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; background: #fff; border-radius: 50%; cursor: grab; box-shadow: 0 0 8px rgba(255,255,255,0.3); margin-left: -5px; }
            .ig-vslider::-moz-range-track { width: 4px; background: rgba(255,255,255,0.25); border-radius: 2px; border: none; }
            .ig-vslider::-moz-range-thumb { width: 14px; height: 14px; background: #fff; border-radius: 50%; border: none; cursor: grab; box-shadow: 0 0 8px rgba(255,255,255,0.3); }
            .ig-tslider::-webkit-slider-runnable-track { height: 100%; background: transparent; border-radius: 2px; }
            .ig-tslider::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; background: #fff; border-radius: 50%; cursor: grab; box-shadow: 0 0 6px rgba(255,255,255,0.4); margin-top: -4px; transition: transform 0.1s; }
            .ig-tslider:active::-webkit-slider-thumb { transform: scale(1.3); }
            .ig-tslider::-moz-range-thumb { width: 12px; height: 12px; background: #fff; border-radius: 50%; border: none; cursor: grab; box-shadow: 0 0 6px rgba(255,255,255,0.4); }
            .ig-r-tslider { height: 4px; }
            #ig-reels-bar:hover .ig-r-tslider { height: 7px; }
            /* Boş bar alanı tıklamayı yutmasın; sadece kontroller tıklanabilir */
            #ig-reels-bar { pointer-events: none; opacity: 0.9; transition: opacity 0.2s ease; }
            #ig-reels-bar #ig-r-play, #ig-reels-bar #ig-r-time-slider, #ig-reels-bar .ig-r-speed, #ig-reels-bar #ig-r-download { pointer-events: auto; }
            #ig-r-download:hover, #ig-photo-dl:hover { background: rgba(40,40,50,0.85) !important; }
            #ig-reels-vol { opacity: 0.9; transition: opacity 0.2s ease; }
            #ig-reels-bar:hover, #ig-reels-vol:hover { opacity: 1; }
            /* Scroll sırasında overlay'i gizle (yeniden konumlama/jank yok) */
            body.ig-scrolling #ig-reels-bar, body.ig-scrolling #ig-reels-vol { opacity: 0 !important; pointer-events: none !important; }
        `;
        document.head.appendChild(style);
    };

    /* ============================ INIT ============================ */
    const init = () => {
        injectStyles();
        createReelsUI();
        createPhotoDl();
        refreshActiveVideo();
        syncMode();
        const v = activeVideo;
        if (v && currentMode !== 'none') { syncVideo(); enforceVideo(v); }
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
        window.addEventListener('resize', onScroll, { passive: true });
        setInterval(tick, TICK_MS);
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
