(() => {
	'use strict';

	const CONFIG = {
		user: 'Geronimo206',
		// Read-only key from https://www.last.fm/api/account/create. It ends up public in
		// the page source, so use one that nothing else depends on. Leave it empty and the
		// sleeve keeps its static sticker and stays shut.
		apiKey: '28d5d4136a204166cb8aa55f3d07746c',
		perSide: 8,
		pollSeconds: 60,
		// last.fm only scrobbles a track once it has (mostly) played, and many scrobblers never
		// send a "now playing" ping. A scrobble this fresh means the needle is probably still down.
		liveMinutes: 10,
		// Top lists barely change minute to minute; keep them in the visitor's browser for a bit.
		cacheMinutes: 10,
	};

	const API = 'https://ws.audioscrobbler.com/2.0/';
	const BLANK_ART = '2a96cbd8b46e442fc41c2b86b821562f';
	const LEADS = ['includes the heavy-rotation hit', 'featuring the current obsession', 'contains the hit single', 'now on repeat'];

	const $ = (id) => document.getElementById(id);
	const root = document.documentElement;
	const stage = $('stage');
	const num = new Intl.NumberFormat('en');
	const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	const lead = LEADS[Math.floor(Math.random() * LEADS.length)];

	let user = null;
	let weekTop = null;
	let featured = null;
	let featureKey = '';
	let flipTimer = 0;

	// ---------- helpers ----------

	async function lastfm(method, params = {}, retries = 1) {
		const url = new URL(API);
		url.search = new URLSearchParams({ method, user: CONFIG.user, api_key: CONFIG.apiKey, format: 'json', ...params });
		const key = `lastfm:${url.search}`;
		const cacheable = method !== 'user.getrecenttracks';
		if (cacheable) {
			try {
				const hit = JSON.parse(localStorage.getItem(key));
				if (hit && Date.now() - hit.t < CONFIG.cacheMinutes * 60000) return hit.data;
			} catch {}
		}
		try {
			const res = await fetch(url);
			const data = await res.json();
			// last.fm occasionally answers with an error, or with nothing at all.
			if (!res.ok || data.error || !Object.keys(data).length) throw new Error(`last.fm ${method}: ${data.message || res.status}`);
			if (cacheable) {
				try {
					localStorage.setItem(key, JSON.stringify({ t: Date.now(), data }));
				} catch {}
			}
			return data;
		} catch (err) {
			if (retries < 1) throw err;
			await new Promise((r) => setTimeout(r, 900));
			return lastfm(method, params, retries - 1);
		}
	}

	// For calls where a failure should just leave a gap rather than break the page.
	const settle = (promise) => promise.catch((err) => {
		console.warn(err);
		return null;
	});

	// last.fm returns a bare object instead of an array when there is only one result.
	const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

	function art(images) {
		const all = list(images);
		const pick = all.find((i) => i.size === 'extralarge') || all[all.length - 1];
		const src = pick && pick['#text'];
		return src && !src.includes(BLANK_ART) ? src : '';
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function ago(uts) {
		const diff = Number(uts) - Date.now() / 1000;
		const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
		for (const [unit, secs] of units) {
			if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
		}
		return 'just now';
	}

	function isoWeek(date) {
		const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
		d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
		return Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
	}

	const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
	const and = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '');
	const since = () => (user ? new Date(user.registered.unixtime * 1000).getFullYear() : 2007);
	const portrait = matchMedia('(max-aspect-ratio: 1/1)');

	function sticker({ top, title, foot }) {
		$('sticker-top').textContent = top;
		$('sticker-title').textContent = `“${title}”`;
		$('sticker-title').dataset.size = title.length > 30 ? 's' : title.length > 16 ? 'm' : '';
		$('sticker-foot').textContent = foot;
		const node = $('sticker');
		node.classList.remove('is-new');
		void node.offsetWidth;
		node.classList.add('is-new');
	}

	// ---------- cover colour → room, sticker, label ink and favicon ----------

	function loadImage(src) {
		return new Promise((resolve) => {
			if (!src) return resolve(null);
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.decoding = 'async';
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = src;
		});
	}

	// Average colour of the cover, weighted towards its most saturated pixels.
	function sampleColor(img) {
		if (!img) return null;
		try {
			const size = 24;
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = size;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			ctx.drawImage(img, 0, 0, size, size);
			const { data } = ctx.getImageData(0, 0, size, size);
			let r = 0, g = 0, b = 0, w = 0;
			for (let i = 0; i < data.length; i += 4) {
				const max = Math.max(data[i], data[i + 1], data[i + 2]);
				const min = Math.min(data[i], data[i + 1], data[i + 2]);
				const light = (max + min) / 510;
				if (light < 0.08 || light > 0.94) continue;
				const sat = (max - min) / max;
				const weight = sat * sat + 0.02;
				r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; w += weight;
			}
			return w ? [r / w, g / w, b / w] : null;
		} catch {
			return null; // a cover without CORS headers can't be read; keep the current colours
		}
	}

	function tintFrom(img) {
		const rgb = sampleColor(img);
		if (!rgb) return;
		const [r, g, b] = rgb.map((v) => v / 255);
		const max = Math.max(r, g, b), min = Math.min(r, g, b);
		const d = max - min;
		let h = 0;
		if (d) h = 60 * (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
		const s = d ? (d / (1 - Math.abs(max + min - 1))) * 100 : 0;
		h = Math.round(h);

		root.style.setProperty('--tint', `hsl(${h} ${Math.round(clamp(s, 30, 80))}% 48%)`);
		// A grey cover would give a muddy sticker: keep the classic yellow then.
		if (s >= 12) {
			const colour = `hsl(${h} ${Math.round(clamp(s, 60, 90))}% 64%)`;
			root.style.setProperty('--sticker', colour);
			root.style.setProperty('--paper-accent', `hsl(${h} ${Math.round(clamp(s, 45, 75))}% 33%)`);
			favicon(colour);
		}
	}

	// Same record as favicon.svg, with the label in the colour of whatever's on the turntable.
	function favicon(color) {
		const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
		if (!link) return;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0d0d0f" stroke="#4a4a52" stroke-width="2.5"/><circle cx="32" cy="32" r="23" fill="none" stroke="#2c2c31" stroke-width="1.5"/><circle cx="32" cy="32" r="17.5" fill="none" stroke="#2c2c31" stroke-width="1.5"/><circle cx="32" cy="32" r="12" fill="${color}"/><circle cx="32" cy="32" r="2.5" fill="#0d0d0f"/></svg>`;
		link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
	}

	// ---------- front: sticker + record ----------

	async function feature(next) {
		featured = next;
		// While the bonus disc is out, it owns the sticker and the label; catch up when it goes back in.
		if (next.key === featureKey || stage.classList.contains('is-secret')) return;
		featureKey = next.key;

		sticker(next);
		const art = $('art');
		const swapping = art.classList.contains('is-loaded');
		art.classList.remove('is-loaded');
		const [img] = await Promise.all([loadImage(next.image), swapping && new Promise((r) => setTimeout(r, 600))]);
		if (featureKey !== next.key) return;
		if (img) {
			art.style.backgroundImage = `url(${JSON.stringify(img.src)})`;
			art.classList.add('is-loaded');
			tintFrom(img);
		}
	}

	// The record stays in its sleeve until there is a label to show, so nothing pops in half-done.
	function ready() {
		if (root.classList.contains('is-ready')) return;
		root.classList.add('is-ready');
		const node = $('sticker');
		node.classList.remove('is-new');
		void node.offsetWidth;
		node.classList.add('is-new');
	}

	async function refreshNow(first = false) {
		const recent = await settle(lastfm('user.getrecenttracks', { limit: 1 }));
		// A hiccup while someone's looking: keep showing what we had.
		if (!recent && !first) return;
		const track = list(recent?.recenttracks?.track)[0];
		const artist = track?.artist['#text'];
		const pinged = track?.['@attr']?.nowplaying === 'true';
		const fresh = track?.date && Date.now() / 1000 - Number(track.date.uts) < CONFIG.liveMinutes * 60;
		const live = Boolean(pinged || fresh);

		root.classList.toggle('is-live', live);
		$('status').classList.toggle('is-live', live);
		$('status-text').textContent = live
			? `now playing · ${track.name} — ${artist}`
			: track?.date ? `needle up · last played ${ago(track.date.uts)}` : 'needle up';

		if (live) {
			await feature({
				key: `now:${track.url}`,
				top: 'now spinning',
				title: track.name,
				foot: artist,
				image: art(track.image),
			});
		} else if (weekTop) {
			await feature({
				key: `top:${weekTop.url}`,
				top: lead,
				title: weekTop.name,
				foot: `${weekTop.artist.name} · ${num.format(weekTop.playcount)} plays this week`,
				image: art(weekTop.image),
			});
		} else if (track) {
			await feature({
				key: `last:${track.url}`,
				top: 'last heard',
				title: track.album['#text'] || track.name,
				foot: artist,
				image: art(track.image),
			});
		}
	}

	// ---------- back: the tracklist ----------

	function side(id, tracks) {
		const ol = $(id);
		if (!tracks.length) return ol.replaceChildren(el('li', 'empty', 'Silence.'));
		ol.replaceChildren(...tracks.map((track, i) => {
			const item = el('li');
			item.style.setProperty('--k', (i / Math.max(1, tracks.length - 1)).toFixed(3));
			item.append(el('b', '', track.name), el('i', '', `${track.artist.name} · ${num.format(track.playcount)}`));
			return item;
		}));
	}

	function credits(cat, thanks) {
		const names = and(thanks.map((a) => a.name));
		$('fine-credits').textContent = `${cat}. Produced, arranged and played to death by Jeroen Sannen.${names ? ` Special thanks to ${names}.` : ''}`;

		const counts = [`${num.format(user.playcount)} scrobbles`];
		if (user.album_count) counts.push(`${num.format(user.album_count)} albums`);
		if (user.artist_count) counts.push(`${num.format(user.artist_count)} artists`);
		$('fine-recorded').textContent = `Recorded ${since()}–${new Date().getFullYear()} over ${and(counts)}.`;
	}

	// EAN-13 bar patterns, fed with the all-time scrobble count. It even scans.
	function barcode(count) {
		const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
		const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
		const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
		const R = L.map((code) => code.replace(/./g, (bit) => (bit === '1' ? '0' : '1')));

		const body = String(count).replace(/\D/g, '').padStart(12, '0').slice(-12);
		const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 ? 3 : 1), 0);
		const digits = body + ((10 - (sum % 10)) % 10);
		const parity = PARITY[digits[0]];

		let bits = '101';
		for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[digits[i]];
		bits += '01010';
		for (let i = 7; i <= 12; i++) bits += R[digits[i]];
		bits += '101';

		let path = '';
		for (let x = 0; x < bits.length; x++) {
			if (bits[x] !== '1') continue;
			let w = 1;
			while (bits[x + w] === '1') w++;
			path += `M${x} 0h${w}v40h-${w}z`;
			x += w - 1;
		}
		const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		shape.setAttribute('d', path);
		$('barcode').replaceChildren(shape);
		$('barcode-digits').textContent = `${digits[0]} ${digits.slice(1, 7)} ${digits.slice(7)}`;
	}

	// ---------- the bonus disc: pull the record all the way out ----------

	let bonus = null;
	let lastPick = -1;

	function fetchBonus() {
		bonus ||= Promise.all([
			lastfm('user.gettoptracks', { period: 'overall', limit: 10 }),
			lastfm('user.gettopartists', { period: 'overall', limit: 5 }),
			lastfm('user.gettopalbums', { period: 'overall', limit: 5 }),
		].map(settle)).then(([tracks, artists, albums]) => [
			...list(tracks?.toptracks?.track).map((x, i) => ({ kind: 'track', rank: i + 1, name: x.name, artist: x.artist.name, plays: x.playcount })),
			...list(artists?.topartists?.artist).map((x, i) => ({ kind: 'artist', rank: i + 1, name: x.name, plays: x.playcount })),
			...list(albums?.topalbums?.album).map((x, i) => ({ kind: 'album', rank: i + 1, name: x.name, artist: x.artist.name, plays: x.playcount, image: art(x.image) })),
		]);
		bonus.then((items) => {
			if (!items.length) bonus = null; // try again on the next pull
		});
		return bonus;
	}

	// Something different every time it comes out.
	function pick(items) {
		let i;
		do i = Math.floor(Math.random() * items.length);
		while (items.length > 1 && i === lastPick);
		lastPick = i;
		return items[i];
	}

	function pressBonus(item) {
		const plays = `${num.format(item.plays)} plays`;
		const base = (item.kind === 'artist'
			? `${item.name} ✦ ${plays} since ${since()} ✦ `
			: `${item.name.slice(0, 40)} ✦ ${item.artist} ✦ ${plays} ✦ `).toUpperCase();
		let ring = base;
		while (ring.length < 46) ring += base;

		$('secret').dataset.kind = item.kind === 'album' && !item.image ? 'track' : item.kind;
		$('secret-text').textContent = ring;
		$('secret-top').textContent = 'ALL-TIME';
		$('secret-bottom').textContent = `${item.kind.toUpperCase()} #${item.rank}`;
		$('secret-art').setAttribute('href', item.image || '');

		sticker({
			top: `bonus disc · all-time ${item.kind} #${item.rank}`,
			title: item.name,
			foot: item.kind === 'artist' ? `${plays} since ${since()}` : `${item.artist} · ${plays}`,
		});
	}

	function confetti(x, y) {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const canvas = el('canvas', 'confetti');
		const ratio = Math.min(2, window.devicePixelRatio || 1);
		const w = window.innerWidth, h = window.innerHeight;
		canvas.width = w * ratio;
		canvas.height = h * ratio;
		document.body.append(canvas);
		const ctx = canvas.getContext('2d');
		ctx.scale(ratio, ratio);

		const css = getComputedStyle(root);
		const colors = ['--sticker', '--tint', '--paper-accent'].map((prop) => css.getPropertyValue(prop).trim()).concat('#f6cf45', '#f4f1ea');
		const bits = Array.from({ length: 160 }, (_, i) => {
			const angle = Math.random() * Math.PI * 2;
			const speed = 3 + Math.random() * 11;
			return {
				x, y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed - 5,
				size: 5 + Math.random() * 7,
				rot: Math.random() * Math.PI,
				spin: (Math.random() - 0.5) * 0.35,
				color: colors[i % colors.length],
				shape: i % 10 === 0 ? 'record' : i % 4 === 0 ? 'star' : 'strip',
			};
		});

		const start = performance.now();
		let last = start;
		const frame = (now) => {
			const t = (now - start) / 2800;
			const step = Math.min(3, (now - last) / 16.7); // same speed on 60 and 120 Hz screens
			last = now;
			ctx.clearRect(0, 0, w, h);
			ctx.globalAlpha = Math.max(0, 1 - t * t);
			for (const b of bits) {
				b.vx *= 0.985 ** step;
				b.vy = b.vy * 0.985 ** step + 0.28 * step;
				b.x += b.vx * step;
				b.y += b.vy * step;
				b.rot += b.spin * step;
				ctx.save();
				ctx.translate(b.x, b.y);
				ctx.rotate(b.rot);
				ctx.fillStyle = b.color;
				if (b.shape === 'record') {
					ctx.fillStyle = '#0d0d0f';
					ctx.beginPath();
					ctx.arc(0, 0, b.size * 0.8, 0, Math.PI * 2);
					ctx.fill();
					ctx.fillStyle = b.color;
					ctx.beginPath();
					ctx.arc(0, 0, b.size * 0.3, 0, Math.PI * 2);
					ctx.fill();
				} else if (b.shape === 'star') {
					ctx.beginPath();
					for (let k = 0; k < 8; k++) {
						const r = k % 2 ? b.size * 0.22 : b.size * 0.7;
						ctx.lineTo(Math.cos((k * Math.PI) / 4) * r, Math.sin((k * Math.PI) / 4) * r);
					}
					ctx.fill();
				} else {
					ctx.scale(1, Math.cos(b.rot * 1.7)); // paper strips flutter
					ctx.fillRect(-b.size / 2, -b.size / 5, b.size, b.size / 2.5);
				}
				ctx.restore();
			}
			if (t < 1) requestAnimationFrame(frame);
			else canvas.remove();
		};
		requestAnimationFrame(frame);
		setTimeout(() => canvas.remove(), 3500);
	}

	async function revealSecret() {
		if (stage.classList.contains('is-secret')) return;
		stage.classList.add('is-secret');
		root.classList.add('is-party');
		setTimeout(() => root.classList.remove('is-party'), 3200);

		const box = $('label').getBoundingClientRect();
		confetti(box.left + box.width / 2, box.top + box.height / 2);
		sticker({ top: 'you found the', title: 'Bonus Disc', foot: 'digging through the crates…' });

		const items = await fetchBonus();
		if (!stage.classList.contains('is-secret')) return;
		if (items.length) pressBonus(pick(items));
		else sticker({ top: 'you found the', title: 'Bonus Disc', foot: 'you were not supposed to' });
	}

	function hideSecret() {
		if (!stage.classList.contains('is-secret')) return;
		stage.classList.remove('is-secret');
		delete $('secret').dataset.kind;
		featureKey = '';
		if (featured) feature(featured);
	}

	function enablePulling() {
		const record = $('record');
		const sleeve = stage.querySelector('.sleeve');
		let drag = null;

		record.addEventListener('pointerdown', (event) => {
			if (stage.dataset.side !== 'front' || event.button !== 0) return;
			const s = sleeve.offsetWidth;
			const axis = portrait.matches ? { x: 0, y: -1 } : { x: 1, y: 0 };
			const out = (root.classList.contains('is-live') ? (portrait.matches ? 0.74 : 0.8) : 0.66) * s;
			const rest = stage.classList.contains('is-secret') ? (portrait.matches ? 0.05 : 0.14) * s : 0;
			const nudge = record.matches(':hover') ? 0.05 * s : 0;
			drag = { axis, s, out, from: event.clientX * axis.x + event.clientY * axis.y, base: rest + nudge, pull: rest + nudge };
			stage.classList.add('is-pulling');
			stage.style.setProperty('--pull', `${drag.pull}px`);
			fetchBonus();
			record.setPointerCapture(event.pointerId);
		});

		record.addEventListener('pointermove', (event) => {
			if (!drag) return;
			const delta = event.clientX * drag.axis.x + event.clientY * drag.axis.y - drag.from;
			// It can go back in all the way; past the normal stop it gets heavier and heavier.
			let pull = Math.max(-drag.out, drag.base + delta);
			const give = 0.12 * drag.s;
			if (pull > give) pull = give + (pull - give) * 0.4;
			drag.pull = pull;
			stage.style.setProperty('--pull', `${pull}px`);
		});

		const release = () => {
			if (!drag) return;
			const { pull, s } = drag;
			drag = null;
			stage.classList.remove('is-pulling');
			stage.style.removeProperty('--pull');
			if (pull > 0.15 * s) revealSecret();
			else if (pull < 0.05 * s) hideSecret();
		};
		record.addEventListener('pointerup', release);
		record.addEventListener('pointercancel', release);
	}

	// ---------- flipping + handling ----------

	function flip(toBack = stage.dataset.side !== 'back') {
		if (toBack === (stage.dataset.side === 'back')) return;
		const hiding = toBack ? $('front') : $('back');
		if (hiding.contains(document.activeElement)) $('flip').focus({ preventScroll: true });
		if (toBack) hideSecret();

		// Going back to the front: let the sleeve turn before the record slides out again.
		stage.style.setProperty('--record-delay', toBack ? '0s' : '.85s');
		clearTimeout(flipTimer);
		flipTimer = setTimeout(() => stage.style.removeProperty('--record-delay'), 2000);

		stage.dataset.side = toBack ? 'back' : 'front';
		$('front').inert = toBack;
		$('back').inert = !toBack;
		$('flip').setAttribute('aria-pressed', String(toBack));
		$('flip-text').textContent = toBack ? 'Back to the cover' : 'Flip it over';
	}

	function enableHandling() {
		$('flip').hidden = false;
		$('flip').setAttribute('aria-pressed', 'false');
		document.querySelector('.front__flip').disabled = false;

		document.addEventListener('click', (event) => {
			if (event.target.closest('[data-flip]')) flip();
		});
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') flip(false);
		});

		enablePulling();

		const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
		const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!fine || calm) return;
		let pointer = null;
		let frame = 0;
		const tilt = () => {
			frame = 0;
			if (!pointer || stage.classList.contains('is-pulling')) return;
			const box = stage.getBoundingClientRect();
			const x = (pointer.clientX - box.left) / box.width - 0.5;
			const y = (pointer.clientY - box.top) / box.height - 0.5;
			stage.style.setProperty('--ry', `${(x * 7).toFixed(2)}deg`);
			stage.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`);
			stage.style.setProperty('--sheen', `${(50 - x * 70).toFixed(1)}%`);
		};
		stage.addEventListener('pointermove', (event) => {
			pointer = event;
			frame ||= requestAnimationFrame(tilt);
		});
		stage.addEventListener('pointerleave', () => {
			pointer = null;
			for (const prop of ['--rx', '--ry', '--sheen']) stage.style.removeProperty(prop);
		});
	}

	// ---------- boot ----------

	async function init() {
		Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]).then(() => root.classList.add('is-shown'));

		const now = new Date();
		const cat = `JS ${String(now.getFullYear()).slice(2)}${String(isoWeek(now)).padStart(2, '0')}`;
		$('cat-front').textContent = cat;

		if (!CONFIG.apiKey) {
			console.info('jeroensannen.be: add a last.fm API key in assets/site.js to press the record.');
			$('status-text').textContent = 'needle up';
			return ready();
		}
		const giveUp = setTimeout(ready, 3500);

		// Every part of the sleeve gets its own data, so one failing call only leaves one gap.
		const [info, week, month, year, artists] = await Promise.all([
			lastfm('user.getinfo'),
			lastfm('user.gettopalbums', { period: '7day', limit: 1 }),
			lastfm('user.gettoptracks', { period: '1month', limit: CONFIG.perSide }),
			lastfm('user.gettoptracks', { period: '12month', limit: CONFIG.perSide }),
			lastfm('user.gettopartists', { period: '12month', limit: 3 }),
		].map(settle));
		user = info?.user || null;
		weekTop = list(week?.topalbums?.album)[0] || null;
		const monthTracks = list(month?.toptracks?.track);
		const yearTracks = list(year?.toptracks?.track);
		side('side-a', monthTracks);
		side('side-b', yearTracks);
		if (user) {
			credits(cat, list(artists?.topartists?.artist));
			barcode(user.playcount);
		}
		await refreshNow(true);
		clearTimeout(giveUp);
		ready();
		if (user || monthTracks.length || yearTracks.length) enableHandling();

		const poll = () => {
			if (!document.hidden) refreshNow().catch((err) => console.warn(err));
		};
		setInterval(poll, CONFIG.pollSeconds * 1000);
		document.addEventListener('visibilitychange', poll);
	}

	init();
})();
