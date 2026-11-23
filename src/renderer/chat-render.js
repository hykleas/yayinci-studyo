// Ana pencere ve overlay'in ortak chat mesajı çizimi (DOM)
(function () {
  const PLATFORMS = {
    youtube: { name: 'YouTube', short: 'YT', color: '#ff0033', fg: '#fff' },
    kick: { name: 'Kick', short: 'K', color: '#53fc18', fg: '#0b0b0b' },
    tiktok: { name: 'TikTok', short: 'TT', color: '#fe2c55', fg: '#fff' }
  };

  const TYPE_ICON = { gift: '🎁', superchat: '💰', sub: '⭐', follow: '➕', raid: '🚀', system: 'ℹ️' };
  const NAME_COLORS = ['#ff7a7a', '#ffb86b', '#ffe066', '#8ce99a', '#66d9e8', '#74c0fc', '#b197fc', '#f783ac', '#63e6be', '#ffa94d'];

  function nameColor(evt) {
    const c = evt.user && evt.user.color;
    if (c && /^#[0-9a-f]{3,8}$/i.test(c)) return c;
    const n = (evt.user && evt.user.name) || '';
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return NAME_COLORS[h % NAME_COLORS.length];
  }

  function isHighlight(evt) { return evt.type && evt.type !== 'chat'; }

  function badgeEl(platform) {
    const p = PLATFORMS[platform] || { short: '?', color: '#666', fg: '#fff', name: platform };
    const b = document.createElement('span');
    b.className = 'pf';
    b.textContent = p.short;
    b.title = p.name;
    b.style.background = p.color;
    b.style.color = p.fg;
    return b;
  }

  function partsEl(evt) {
    const frag = document.createDocumentFragment();
    for (const p of evt.parts || []) {
      if (p.t === 'img') {
        const img = document.createElement('img');
        img.className = 'emote';
        img.src = p.src;
        img.alt = p.alt || '';
        img.title = p.alt || '';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.replaceWith(document.createTextNode(p.alt || ''));
        frag.appendChild(img);
      } else {
        frag.appendChild(document.createTextNode(p.v || ''));
      }
    }
    return frag;
  }

  function renderEvent(evt) {
    const el = document.createElement('div');
    el.className = `msg p-${evt.platform} t-${evt.type}`;
    el.dataset.id = evt.id;
    const pc = (PLATFORMS[evt.platform] || {}).color || '#888';
    el.style.setProperty('--pc', pc);
    el.appendChild(badgeEl(evt.platform));

    if (isHighlight(evt)) {
      const icon = document.createElement('span');
      icon.className = 'ticon';
      icon.textContent = TYPE_ICON[evt.type] || '•';
      el.appendChild(icon);
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (evt.user && evt.user.name) || '?';
    name.style.color = nameColor(evt);
    el.appendChild(name);

    if (evt.amount) {
      const a = document.createElement('span');
      a.className = 'amount';
      a.textContent = evt.amount;
      el.appendChild(a);
    }

    if (evt.gift && evt.gift.image) {
      const g = document.createElement('img');
      g.className = 'giftimg';
      g.src = evt.gift.image;
      g.referrerPolicy = 'no-referrer';
      g.onerror = () => g.remove();
      el.appendChild(g);
    }

    const body = document.createElement('span');
    body.className = 'body';
    body.appendChild(partsEl(evt));
    el.appendChild(body);
    return el;
  }

  window.ChatRender = { PLATFORMS, TYPE_ICON, nameColor, isHighlight, renderEvent };
})();
