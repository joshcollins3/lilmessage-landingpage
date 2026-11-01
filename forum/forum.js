(() => {
  'use strict';

  const config = window.FORUM_CONFIG || {};
  const THREADS_PER_PAGE = 30;
  const POSTS_PER_PAGE = 100;
  const MAX_BODY = 10000;

  const main = document.getElementById('main');
  const bar = document.getElementById('bar');
  const banner = document.getElementById('banner');
  const progress = document.getElementById('progress');
  const toastEl = document.getElementById('toast');

  let db = null;
  let session = null;
  let me = null; // { id, username, is_admin, banned_at } once a username is chosen
  let renderToken = 0;

  // DOM. All user text goes in as text nodes, never as HTML, so a post can't inject markup.
  function h(spec, attrs, ...children) {
    const [tag, ...classes] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  function link(spec, href, ...children) {
    return h(spec, {
      href,
      onclick(event) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        event.preventDefault();
        go(href);
      },
    }, ...children);
  }

  const button = (cls, label, onclick, attrs) =>
    h(`button.btn.${cls}`, { type: 'button', onclick, ...attrs }, h('span', null, label));
  const quiet = (label, onclick, extra = '') =>
    h(`button.quiet${extra}`, { type: 'button', onclick }, label);

  // A small line drawing unique to each username, in place of an avatar.
  function hashName(name) {
    let hash = 2166136261;
    for (const ch of name.toLowerCase()) {
      hash ^= ch.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function sigil(name, size = 40) {
    const NS = 'http://www.w3.org/2000/svg';
    let seed = hashName(name);
    const next = () => {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0;
      seed = (seed ^ (seed >>> 13)) >>> 0;
      return seed;
    };
    // Irregular points joined in shuffled order and left open, so it reads as a
    // quick pen mark. Evenly spaced points joined in a loop come out as pentagrams.
    const count = 4 + (next() % 4);
    const turn = next() % 360;
    const points = Array.from({ length: count }, (_, i) => {
      const angle = (turn + (i * 360) / count + (next() % 41) - 20) * (Math.PI / 180);
      const radius = 6 + (next() % 11);
      return [20 + radius * Math.cos(angle), 20 + radius * Math.sin(angle)];
    });
    for (let i = count - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [points[i], points[j]] = [points[j], points[i]];
    }
    const path = points.map((point) => point.map((n) => n.toFixed(2)).join(' '));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'sigil');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      svg.append(el);
    };
    const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' };
    add('circle', { cx: 20, cy: 20, r: 19, ...line, opacity: 0.35 });
    add('path', { d: `M${path.join('L')}`, ...line, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    add('circle', { cx: points[0][0], cy: points[0][1], r: 1.6, fill: 'currentColor' });
    return svg;
  }

  // Small helpers
  const pad = (n) => String(n).padStart(2, '0');
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  const friendly = (error) =>
    error && error.code === 'P0001' ? error.message : 'Something went wrong. Try again.';
  const store = {
    get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
    set(key, value) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* drafts are optional */ } },
    clearDrafts() {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith('forum-draft:')).forEach((k) => localStorage.removeItem(k));
      } catch { /* drafts are optional */ }
    },
  };

  const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  function ago(iso) {
    const seconds = (new Date(iso) - Date.now()) / 1000;
    const units = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [604800, 'day'], [2629800, 'week'], [31557600, 'month'], [Infinity, 'year']];
    const sizes = [1, 60, 3600, 86400, 604800, 2629800, 31557600];
    if (Math.abs(seconds) < 45) return 'just now';
    const index = units.findIndex(([limit]) => Math.abs(seconds) < limit);
    return relative.format(Math.round(seconds / sizes[index]), units[index][1]);
  }
  const time = (iso, cls = '') =>
    h(`time${cls}`, { dateTime: iso, title: new Date(iso).toLocaleString() }, ago(iso));

  let toastTimer;
  function toast(message, bad = false) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.className = `toast on${bad ? ' bad' : ''}`;
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, bad ? 6000 : 3000);
  }

  async function busy(btn, work) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await work(); } finally { btn.disabled = false; }
  }

  // Dialogs
  function openDialog(...children) {
    const dialog = h('dialog', null, ...children);
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  function confirmDialog({ title, body, action, danger, extra }) {
    return new Promise((resolve) => {
      let result = false;
      const yes = button(danger ? 'btn-danger' : 'btn-primary', action, () => { result = true; dialog.close(); });
      const dialog = openDialog(
        h('h2', null, title),
        body && h('p', null, body),
        extra,
        h('div.dialog-actions', null, button('btn-ghost', 'Cancel', () => dialog.close()), yes),
      );
      dialog.addEventListener('close', () => resolve(result));
    });
  }

  function signInDialog() {
    const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
    const send = h('button.btn.btn-primary', { type: 'submit' }, h('span', null, 'Email me a code'));
    const form = h('form', {
      async onsubmit(event) {
        event.preventDefault();
        await busy(send, async () => {
          const redirect = location.href.split('#')[0];
          const { error } = await db.auth.signInWithOtp({
            email: email.value.trim(),
            options: { emailRedirectTo: redirect },
          });
          if (error) {
            toast(error.status === 429 ? 'Too many emails sent. Wait a little and try again.' : "We couldn't send that email. Check the address and try again.", true);
            return;
          }
          codeStep(dialog, email.value.trim());
        });
      },
    },
      h('label.field', null, h('span', null, 'Email'), email),
      h('div.dialog-actions', null, button('btn-ghost', 'Cancel', () => dialog.close()), send),
    );
    const dialog = openDialog(
      h('h2', null, 'Sign in'),
      h('p', null, "No password. We'll email you a sign-in code, and your email is never shown to anyone here."),
      form,
    );
    email.focus();
  }

  // A code works inside the installed app, where an emailed link would open the
  // browser and sign in there instead.
  function codeStep(dialog, address) {
    const code = h('input.code-input', {
      type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', required: true,
      maxLength: 10, pattern: '[0-9 ]+', title: 'The numbers from the email', spellcheck: false,
    });
    const problem = h('p.field-error', { role: 'alert' });
    const verify = h('button.btn.btn-primary', { type: 'submit' }, h('span', null, 'Sign in'));
    dialog.replaceChildren(
      h('div.sent-sigil', null, sigil(address, 48)),
      h('h2', null, 'Check your email'),
      h('p', null, `We sent a message to ${address}. Enter the code from it here, or open its link in this browser. Check your spam folder if it doesn't show up in a minute.`),
      h('form', {
        async onsubmit(event) {
          event.preventDefault();
          problem.textContent = '';
          await busy(verify, async () => {
            const { error } = await db.auth.verifyOtp({ email: address, token: code.value.replace(/\s/g, ''), type: 'email' });
            if (error) {
              problem.textContent = error.status === 429
                ? 'Too many tries. Wait a little and try again.'
                : "That code didn't work. It may be mistyped or expired, so check it or request a new one.";
              code.select();
              return;
            }
            dialog.close();
          });
        },
      },
        h('label.field', null, h('span', null, 'Code'), code),
        problem,
        h('div.dialog-actions', null, button('btn-ghost', 'Close', () => dialog.close()), verify),
      ),
    );
    code.focus();
  }

  // Installing to a home screen. Android browsers offer a prompt we can trigger;
  // on iPhone it can only be done by hand from the Share menu.
  let installPrompt = null;
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const onIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    renderFooterLinks();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderFooterLinks();
  });

  async function installApp() {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      await prompt.prompt();
      renderFooterLinks();
      return;
    }
    const dialog = openDialog(
      h('h2', null, 'Install the app'),
      h('ol.steps', null,
        h('li', null, 'Tap the Share button in your browser.'),
        h('li', null, 'Scroll down and tap Add to Home Screen.'),
        h('li', null, 'Tap Add.'),
      ),
      h('p', null, "You'll sign in again inside the app, using the code from your email."),
      h('div.dialog-actions', null, button('btn-primary', 'Got it', () => dialog.close())),
    );
  }

  function renderFooterLinks() {
    const canInstall = !installed() && (installPrompt || onIOS());
    document.getElementById('footer-links').replaceChildren(
      link('a.quiet', '?view=rules', 'Rules'),
      ...(canInstall ? [quiet('Install app', installApp)] : []),
    );
  }

  function usernameDialog() {
    const input = h('input', {
      type: 'text', required: true, minLength: 3, maxLength: 20, autocomplete: 'off', spellcheck: false,
      pattern: '[A-Za-z0-9_]+', placeholder: 'something_of_your_own',
      title: 'Letters, numbers and underscores',
      oninput: () => updatePreview(),
    });
    const preview = h('div.name-preview', { 'aria-hidden': 'true' });
    const updatePreview = () => {
      const name = input.value.trim();
      preview.replaceChildren(...(name ? [sigil(name, 52), h('b', null, name)] : []));
    };
    const agree = h('input', { type: 'checkbox', required: true });
    const save = h('button.btn.btn-primary', { type: 'submit' }, h('span', null, 'Join Written Messages'));
    const dialog = openDialog(
      h('h2', null, 'Choose your name'),
      h('p', null, "It's public and it can't be changed, so don't use your real name unless you want to. The mark beside it is drawn from the name itself."),
      h('form', {
        async onsubmit(event) {
          event.preventDefault();
          await busy(save, async () => {
            const { error } = await db.rpc('claim_username', { new_username: input.value.trim(), accepted_terms: agree.checked });
            if (error) { toast(friendly(error), true); return; }
            await loadMe();
            renderBar();
            dialog.close();
            toast(`Welcome, ${me.username}.`);
            render();
          });
        },
      },
        h('label.field', null, h('span', null, 'Username'), input),
        preview,
        h('label.check', null, agree, h('span', null, "I'm 18 or older and I agree to the ", h('a', { href: '?view=rules', target: '_blank', rel: 'noopener' }, 'rules and privacy notes'), '.')),
        h('div.dialog-actions', null, button('btn-ghost', 'Not now', () => dialog.close()), save),
      ),
    );
    input.focus();
  }

  // True if they can write now. Otherwise walks them through the missing step.
  function canPost() {
    if (!session) { signInDialog(); return false; }
    if (!me) { usernameDialog(); return false; }
    if (me.banned_at) { toast('This account has been banned.', true); return false; }
    return true;
  }

  function reportDialog({ thread = null, post = null }) {
    if (!canPost()) return;
    const reason = h('textarea', { required: true, maxLength: 500, rows: 3, placeholder: 'Spam, harassment, someone being put at risk…' });
    const send = h('button.btn.btn-primary', { type: 'submit' }, h('span', null, 'Send report'));
    const dialog = openDialog(
      h('h2', null, 'Report this'),
      h('p', null, 'Only the moderators see this.'),
      h('form', {
        async onsubmit(event) {
          event.preventDefault();
          await busy(send, async () => {
            const { error } = await db.rpc('report_content', { thread, post, new_reason: reason.value });
            if (error) { toast(friendly(error), true); return; }
            dialog.close();
            toast('Report sent. Thank you.');
          });
        },
      },
        h('label.field', null, h('span', null, "What's wrong?"), reason),
        h('div.dialog-actions', null, button('btn-ghost', 'Cancel', () => dialog.close()), send),
      ),
    );
    reason.focus();
  }

  // Writing box. Drafts survive a reload and the trip through the sign-in email.
  function composer({ draftKey, placeholder, submitLabel, onSubmit, before }) {
    const key = `forum-draft:${draftKey}`;
    const hint = h('span.composer-hint', null, h('span.composer-hint-keys', null, navigator.platform.startsWith('Mac') ? '⌘ + Return to post' : 'Ctrl + Enter to post'));
    const defaultHint = hint.firstChild;
    const textarea = h('textarea', {
      placeholder, value: store.get(key), 'aria-label': placeholder,
      oninput: () => { store.set(key, textarea.value); fit(); count(); },
      onkeydown(event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
      },
    });
    const fit = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    const count = () => {
      const length = textarea.value.length;
      if (length > MAX_BODY - 1000) {
        hint.textContent = `${length.toLocaleString()} / ${MAX_BODY.toLocaleString()}`;
        hint.classList.toggle('over', length > MAX_BODY);
      } else if (hint.firstChild !== defaultHint) {
        hint.replaceChildren(defaultHint);
        hint.classList.remove('over');
      }
    };
    const send = button('btn-primary.btn-sm', session ? submitLabel : 'Sign in to post', () => submit());
    async function submit() {
      if (!canPost()) return;
      if (!textarea.value.trim()) { textarea.focus(); return; }
      await busy(send, async () => {
        const done = await onSubmit(textarea.value);
        if (done) {
          store.set(key, '');
          textarea.value = '';
          fit();
          count();
        }
      });
    }
    requestAnimationFrame(() => { fit(); count(); });
    return {
      el: h('div.composer', null, before, textarea, h('div.composer-foot', null, hint, send)),
      textarea,
    };
  }

  // Routing: real URLs like /forum/?thread=12, so links can be shared.
  function go(href, { replace = false } = {}) {
    history[replace ? 'replaceState' : 'pushState'](null, '', href);
    window.scrollTo(0, 0);
    render();
  }
  window.addEventListener('popstate', () => render());

  const hrefFor = {
    home: () => './',
    board: (slug) => `?board=${encodeURIComponent(slug)}`,
    thread: (id, reply) => `?thread=${id}${reply ? `#r${reply}` : ''}`,
    newThread: (slug) => `?view=new&board=${encodeURIComponent(slug)}`,
  };

  async function render() {
    const token = ++renderToken;
    const params = new URLSearchParams(location.search);
    const view = params.get('view');
    const started = setTimeout(() => progress.classList.add('on'), 120);
    let build;
    if (params.has('thread')) build = threadView(params.get('thread'));
    else if (params.has('board') && view !== 'new') build = boardView(params.get('board'));
    else if (view === 'new') build = newThreadView(params.get('board'));
    else if (view === 'rules') build = rulesView();
    else if (view === 'account') build = accountView();
    else if (view === 'admin') build = adminView();
    else build = homeView();

    let content;
    try {
      content = await build;
    } catch {
      content = message('Written Messages didn\'t load.', 'Check your connection and try again.', button('btn-ghost', 'Try again', () => render()));
    }
    clearTimeout(started);
    if (token !== renderToken) return;
    progress.classList.remove('on');

    const swap = () => {
      main.replaceChildren(content);
      renderBar();
      const target = location.hash && document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    };
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !calm && main.hasChildNodes()) document.startViewTransition(swap);
    else swap();
  }

  function setTitle(title) {
    document.title = title ? `${title} — Written Messages` : 'Written Messages — Lil Message';
  }

  function message(title, body, ...actions) {
    setTitle('');
    return h('div.wrap', null, h('div.page-head', null, h('h1', null, title)), h('p.prose.notice', null, body), actions.length ? h('div.more', { style: 'justify-content:flex-start' }, ...actions) : null);
  }

  function renderBar() {
    renderFooterLinks();
    const view = new URLSearchParams(location.search).get('view');
    const links = [link('a.bar-link.bar-rules', '?view=rules', 'Rules')];
    if (view === 'rules') links[0].setAttribute('aria-current', 'page');
    if (me && me.is_admin) links.push(link('a.bar-link', '?view=admin', 'Moderate'));
    if (me) links.push(link('a.bar-link.bar-me', '?view=account', sigil(me.username, 22), h('span', null, me.username)));
    else if (session) links.push(h('button.bar-link', { type: 'button', onclick: usernameDialog }, 'Choose a name'));
    else if (db) links.push(h('button.bar-link', { type: 'button', onclick: signInDialog }, 'Sign in'));
    bar.replaceChildren(
      h('a.bar-home', { href: '../' }, 'Lil Message'),
      link('a.bar-link', hrefFor.home(), 'Written Messages'),
      h('div.bar-links', null, links),
    );
    banner.replaceChildren(...(me && me.banned_at
      ? [h('p.banner', null, "This account has been banned. You can read the forum and delete what you've posted, but not post.")]
      : []));
  }

  // Thread row
  function threadRow(thread, index, { showBoard = false } = {}) {
    return link('a.row', hrefFor.thread(thread.id),
      h('span.row-num', null, pad(index + 1)),
      h('span.row-title', null, thread.title),
      h('span.row-replies', null, thread.reply_count ? plural(thread.reply_count, 'reply', 'replies') : 'No replies'),
      h('span.row-meta', null,
        showBoard && h('span.gold', null, thread.board_name),
        h('span', null, thread.author),
        h('span', null, time(thread.last_activity)),
      ),
    );
  }

  // Views
  async function homeView() {
    const [boards, latest] = await Promise.all([
      db.from('board_summaries').select('*').order('sort'),
      db.from('thread_summaries').select('*').order('last_activity', { ascending: false }).limit(6),
    ]);
    if (boards.error || latest.error) throw boards.error || latest.error;
    setTitle('');

    const [general, ...albums] = boards.data;
    return h('div.enter', null,
      h('section.masthead', null,
        h('a.eyebrow', { href: '../' }, 'Lil Message'),
        h('h1', { tabIndex: -1 }, 'Written Messages'),
        h('div.masthead-rule'),
        h('p', null, 'The work of becoming someone the system didn\'t design. Talk about the records, and everything around them.'),
      ),
      h('div.wrap', null,
        latest.data.length > 0 && h('section.block', null,
          h('div.block-head', null, h('h2.eyebrow', { style: 'font-weight:400' }, 'Latest')),
          h('div.rows', null, latest.data.map((t, i) => threadRow(t, i, { showBoard: true }))),
        ),
        h('section.block', null,
          h('div.block-head', null, h('h2.eyebrow', { style: 'font-weight:400' }, 'Boards')),
          link('a.general', hrefFor.board(general.slug),
            h('div', null, h('div.general-name', null, general.name), h('div.general-desc', null, general.description)),
            h('span.count', null, plural(general.thread_count, 'thread')),
          ),
          h('div.covers', null, albums.map((board) => link('a.cover', hrefFor.board(board.slug),
            h('img', { src: `covers/${board.cover}`, alt: '', loading: 'lazy', width: 640, height: 640 }),
            h('span.cover-text', null,
              h('span.cover-name', null, board.name),
              h('span.count', null, plural(board.thread_count, 'thread')),
            ),
          ))),
        ),
      ),
    );
  }

  async function loadBoard(slug) {
    const { data, error } = await db.from('boards').select('*').eq('slug', slug).maybeSingle();
    if (error) throw error;
    return data;
  }

  const notFound = () => message('Nothing here.', "That page doesn't exist, or it's been removed.", link('a.btn.btn-ghost', hrefFor.home(), h('span', null, 'Back to Written Messages')));

  async function boardView(slug) {
    const board = await loadBoard(slug);
    if (!board) return notFound();
    setTitle(board.name);

    const fetchPage = (from) => db.from('thread_summaries').select('*').eq('board_id', board.id)
      .order('last_activity', { ascending: false }).range(from, from + THREADS_PER_PAGE - 1);
    const first = await fetchPage(0);
    if (first.error) throw first.error;

    const rows = h('div.rows', null, first.data.map((t, i) => threadRow(t, i)));
    let loaded = first.data.length;
    const moreBox = h('div.more');
    const more = button('btn-ghost', 'Load more', async () => {
      await busy(more, async () => {
        const next = await fetchPage(loaded);
        if (next.error) { toast(friendly(next.error), true); return; }
        rows.append(...next.data.map((t, i) => threadRow(t, loaded + i)));
        loaded += next.data.length;
        if (next.data.length < THREADS_PER_PAGE) moreBox.remove();
      });
    });
    if (first.data.length === THREADS_PER_PAGE) moreBox.append(more);

    const start = link('a.btn.btn-primary.btn-sm', hrefFor.newThread(board.slug), h('span', null, 'New thread'));
    return h('div', null,
      h('section.board-hero', null,
        board.cover && h('img.board-glow', { src: `covers/${board.cover}`, alt: '' }),
        h('div.wrap.board-inner', null,
          board.cover && h('img.board-art', { src: `covers/${board.cover}`, alt: `${board.name} album cover` }),
          h('div.board-info', null,
            link('a.eyebrow', hrefFor.home(), '← Written Messages'),
            h('h1', { tabIndex: -1 }, board.name),
            h('p', null, board.description),
          ),
        ),
      ),
      h('div.wrap.enter', null,
        first.data.length
          ? [h('div.toolbar', null, h('span.count', null, first.data.length === THREADS_PER_PAGE ? 'Threads' : plural(first.data.length, 'thread')), start), rows, moreBox]
          : h('div.empty', null, h('p', null, 'Nothing here yet. Say the first thing.'), start),
      ),
    );
  }

  async function newThreadView(slug) {
    const board = await loadBoard(slug);
    if (!board) return notFound();
    setTitle(`New thread in ${board.name}`);

    const titleKey = `forum-draft:title:${board.slug}`;
    const title = h('input', {
      type: 'text', maxLength: 120, placeholder: 'Title', value: store.get(titleKey), 'aria-label': 'Title',
      oninput: () => store.set(titleKey, title.value),
    });
    const box = composer({
      draftKey: `new:${board.slug}`,
      placeholder: "What's on your mind?",
      submitLabel: 'Post thread',
      before: title,
      async onSubmit(body) {
        const { data, error } = await db.rpc('create_thread', { board: board.id, new_title: title.value, new_body: body });
        if (error) { toast(friendly(error), true); return false; }
        store.set(titleKey, '');
        store.set(`forum-draft:new:${board.slug}`, '');
        go(hrefFor.thread(data), { replace: true });
        return true;
      },
    });
    requestAnimationFrame(() => (title.value ? box.textarea : title).focus());
    return h('div.read.enter', null,
      h('div.page-head', null,
        link('a.eyebrow', hrefFor.board(board.slug), `← ${board.name}`),
        h('h1', { tabIndex: -1 }, 'New thread'),
      ),
      box.el,
    );
  }

  function postActions({ authorId, onDelete, onReport, permalink }) {
    const mine = me && me.id === authorId;
    return h('div.post-actions', null,
      permalink && quiet('Copy link', async () => {
        try {
          await navigator.clipboard.writeText(new URL(permalink, location.href).href);
          toast('Link copied.');
        } catch { toast("Couldn't copy the link.", true); }
      }),
      !mine && quiet('Report', onReport),
      (mine || (me && me.is_admin)) && quiet('Delete', onDelete, '.danger'),
    );
  }

  function authorTags(author, threadAuthorId, authorId) {
    return [
      author && author.is_admin && h('span.tag.tag-mod', null, 'Mod'),
      threadAuthorId === authorId && h('span.tag', null, 'OP'),
    ];
  }

  async function threadView(rawId) {
    if (!/^\d+$/.test(rawId)) return notFound();
    const id = Number(rawId);
    const profileColumns = 'profiles(username, is_admin)';
    const { data: thread, error } = await db.from('threads')
      .select(`id, title, body, created_at, author_id, boards(slug, name), ${profileColumns}`)
      .eq('id', id).maybeSingle();
    if (error) throw error;
    if (!thread) return notFound();
    setTitle(thread.title);

    const fetchPosts = (from) => db.from('posts').select(`id, body, created_at, author_id, ${profileColumns}`)
      .eq('thread_id', id).order('created_at').order('id').range(from, from + POSTS_PER_PAGE - 1);
    const first = await fetchPosts(0);
    if (first.error) throw first.error;

    let loaded = 0;
    const list = h('div');

    function postEl(post, number, fresh = false) {
      const el = h(`article.post${fresh ? '.fresh' : ''}`, { id: `r${post.id}` },
        sigil(post.profiles.username, window.innerWidth <= 600 ? 30 : 40),
        h('div', null,
          h('div.post-head', null,
            h('span.post-author', null, post.profiles.username),
            authorTags(post.profiles, thread.author_id, post.author_id),
            h('span.post-time', null, time(post.created_at)),
            h('a.post-num', { href: `#r${post.id}`, 'aria-label': `Reply ${number}` }, pad(number)),
          ),
          h('div.post-body', null, post.body),
          postActions({
            authorId: post.author_id,
            permalink: hrefFor.thread(id, post.id),
            onReport: () => reportDialog({ post: post.id }),
            async onDelete() {
              const yes = await confirmDialog({ title: 'Delete this reply?', body: "This can't be undone.", action: 'Delete', danger: true });
              if (!yes) return;
              const { error: failed } = await db.rpc('delete_post', { target: post.id });
              if (failed) { toast(friendly(failed), true); return; }
              el.remove();
              loaded -= 1;
              toast('Reply deleted.');
            },
          }),
        ),
      );
      return el;
    }

    const addPosts = (posts) => {
      list.append(...posts.map((post, i) => postEl(post, loaded + i + 1)));
      loaded += posts.length;
    };
    addPosts(first.data);

    const moreBox = h('div.more');
    const more = button('btn-ghost', 'Load more replies', async () => {
      await busy(more, async () => {
        const next = await fetchPosts(loaded);
        if (next.error) { toast(friendly(next.error), true); return; }
        addPosts(next.data);
        if (next.data.length < POSTS_PER_PAGE) moreBox.remove();
      });
    });
    if (first.data.length === POSTS_PER_PAGE) moreBox.append(more);

    const box = composer({
      draftKey: `thread:${id}`,
      placeholder: 'Write a reply…',
      submitLabel: 'Reply',
      async onSubmit(body) {
        const { data: newId, error: failed } = await db.rpc('create_post', { thread: id, new_body: body });
        if (failed) { toast(friendly(failed), true); return false; }
        // Replies are read in order, so only show it now if we've loaded to the end.
        if (!moreBox.hasChildNodes()) {
          const { data: post } = await db.from('posts').select(`id, body, created_at, author_id, ${profileColumns}`).eq('id', newId).single();
          if (post) {
            list.append(postEl(post, loaded + 1, true));
            loaded += 1;
          }
        } else {
          toast('Reply posted.');
        }
        return true;
      },
    });

    return h('div.read.enter', null,
      h('header.thread-head', null,
        link('a.eyebrow', hrefFor.board(thread.boards.slug), `← ${thread.boards.name}`),
        h('h1', { tabIndex: -1 }, thread.title),
      ),
      h('article.post.post-opening', { id: 'top' },
        sigil(thread.profiles.username, window.innerWidth <= 600 ? 30 : 40),
        h('div', null,
          h('div.post-head', null,
            h('span.post-author', null, thread.profiles.username),
            authorTags(thread.profiles, null, null),
            h('span.post-time', null, time(thread.created_at)),
          ),
          h('div.post-body', null, thread.body),
          postActions({
            authorId: thread.author_id,
            permalink: hrefFor.thread(id),
            onReport: () => reportDialog({ thread: id }),
            async onDelete() {
              const yes = await confirmDialog({ title: 'Delete this thread?', body: "This removes the whole thread, including everyone's replies. It can't be undone.", action: 'Delete thread', danger: true });
              if (!yes) return;
              const { error: failed } = await db.rpc('delete_thread', { target: id });
              if (failed) { toast(friendly(failed), true); return; }
              store.set(`forum-draft:thread:${id}`, '');
              toast('Thread deleted.');
              go(hrefFor.board(thread.boards.slug), { replace: true });
            },
          }),
        ),
      ),
      list,
      moreBox,
      h('section.reply-area', null, box.el),
    );
  }

  function rulesView() {
    setTitle('Rules');
    return h('div.read.enter', null,
      h('div.page-head', null, h('a.eyebrow', { href: './' }, 'Written Messages'), h('h1', { tabIndex: -1 }, 'Rules & privacy')),
      h('div.prose', null,
        h('p.notice', null, "People here may be working through hard things. If you're in crisis, this forum isn't watched around the clock, so please reach out to someone who can answer right away. In the US, call or text 988. Elsewhere, findahelpline.com lists services by country."),
        h('h2', null, 'The rules'),
        h('ul', null,
          h('li', null, 'Be decent to each other. No harassment, threats or hate.'),
          h('li', null, "Don't share anyone's private details, or say who someone here is in real life."),
          h('li', null, 'Respect what people tell you about their own lives. Their story is theirs.'),
          h('li', null, 'No recruiting, for a church, a group, a product or anything else. No spam.'),
          h('li', null, 'Nothing illegal, and nothing sexual involving minors, ever.'),
          h('li', null, 'You must be 18 or older.'),
        ),
        h('p', { style: 'margin-top:1rem' }, 'Moderators can remove posts and ban accounts. Use Report on anything that breaks these rules.'),
        h('h2', null, 'Privacy'),
        h('ul', null,
          h('li', null, 'Everything you post is public, and anyone can read it without an account. Think before you share details that could identify you.'),
          h('li', null, "Your email is used only for signing in. It's never shown to anyone here."),
          h('li', null, 'We ask search engines not to list this forum, but we can\'t promise that nothing is ever copied elsewhere.'),
          h('li', null, 'This forum stores your username, email, posts and when you joined. It runs on Supabase. There are no ads or tracking.'),
          h('li', null, 'You can delete any of your posts, or your whole account, whenever you want. Deleted means deleted.'),
        ),
        config.contactEmail && h('p', { style: 'margin-top:1rem' }, 'Questions or removal requests: ', h('a', { href: `mailto:${config.contactEmail}` }, config.contactEmail), '.'),
      ),
    );
  }

  async function accountView() {
    if (!session) return message('Not signed in.', 'Sign in to see your account.', button('btn-primary', 'Sign in', signInDialog));
    setTitle('Your account');
    const signOut = button('btn-ghost.btn-sm', 'Sign out', async () => {
      store.clearDrafts();
      await db.auth.signOut();
      go(hrefFor.home());
    });
    const remove = button('btn-danger.btn-sm', 'Delete account', async () => {
      const expected = me ? me.username : 'delete';
      const typed = h('input', { type: 'text', autocomplete: 'off', spellcheck: false });
      const yes = await confirmDialog({
        title: 'Delete your account?',
        body: "This removes your account, your replies and every thread you started, including other people's replies to those threads. It can't be undone.",
        action: 'Delete everything',
        danger: true,
        extra: h('label.field', null, h('span', null, `Type ${expected} to confirm`), typed),
      });
      if (!yes) return;
      if (typed.value.trim() !== expected) { toast('That didn\'t match, so nothing was deleted.', true); return; }
      const { error } = await db.rpc('delete_my_account');
      if (error) { toast(friendly(error), true); return; }
      store.clearDrafts();
      await db.auth.signOut({ scope: 'local' });
      go(hrefFor.home());
      toast('Your account has been deleted.');
    });
    return h('div.read.enter', null,
      h('div.page-head', null,
        h('a.eyebrow', { href: './' }, 'Written Messages'),
        h('div.identity', { style: 'margin-top:1.25rem' },
          me && sigil(me.username, 72),
          h('h1', { tabIndex: -1, style: 'margin-top:0' }, me ? me.username : 'Your account'),
        ),
      ),
      !me && h('div.settings-row', null,
        h('div', null, h('strong', null, 'Username'), h('small', null, "You haven't chosen one yet.")),
        button('btn-primary.btn-sm', 'Choose a name', usernameDialog),
      ),
      h('div.settings-row', null,
        h('div', null, h('strong', null, 'Signed in as'), h('small', null, `${session.user.email}. Only you can see this.`)),
        signOut,
      ),
      h('div.settings-row', null,
        h('div', null, h('strong', null, 'Delete account'), h('small', null, 'Removes your account and everything you posted.')),
        remove,
      ),
    );
  }

  async function adminView() {
    if (!me || !me.is_admin) return notFound();
    setTitle('Moderate');
    const [reports, banned] = await Promise.all([
      db.rpc('admin_reports'),
      db.from('profiles').select('id, username, banned_at').not('banned_at', 'is', null).order('banned_at', { ascending: false }),
    ]);
    if (reports.error || banned.error) throw reports.error || banned.error;

    const act = async (work, done) => {
      const { error } = await work();
      if (error) { toast(friendly(error), true); return; }
      toast(done);
      render();
    };
    const banDialog = async (report) => {
      const purge = h('input', { type: 'checkbox', checked: true });
      const yes = await confirmDialog({
        title: `Ban ${report.author}?`,
        body: "They'll still be able to read the forum, but not post.",
        action: 'Ban',
        danger: true,
        extra: h('label.check', null, purge, h('span', null, 'Also delete everything they\'ve posted')),
      });
      if (yes) act(() => db.rpc('ban_user', { target: report.author_id, remove_content: purge.checked }), `${report.author} banned.`);
    };

    return h('div.read.enter', null,
      h('div.page-head', null, h('a.eyebrow', { href: './' }, 'Written Messages'), h('h1', { tabIndex: -1 }, 'Moderate')),
      h('h2.eyebrow', { style: 'font-weight:400;margin-bottom:1rem' }, `Open reports · ${reports.data.length}`),
      reports.data.length === 0 && h('p.prose.notice', null, 'Nothing to review.'),
      reports.data.map((report) => h('article.report', null,
        h('div.post-head', null,
          h('span.post-author', null, report.author),
          h('span.post-time', null, `reported by ${report.reporter}`),
          h('span.post-time', null, time(report.created_at)),
        ),
        h('p.report-why', null, report.reason),
        h('p.report-excerpt', null, report.excerpt),
        h('div.report-actions', null,
          link('a.btn.btn-ghost.btn-sm', hrefFor.thread(report.thread_id, report.post_id), h('span', null, 'View')),
          button('btn-ghost.btn-sm', 'Dismiss', () => act(() => db.rpc('dismiss_report', { target: report.id }), 'Report dismissed.')),
          button('btn-danger.btn-sm', 'Delete post', async () => {
            const yes = await confirmDialog({
              title: report.post_id ? 'Delete this reply?' : 'Delete this thread?',
              body: report.post_id ? "This can't be undone." : "This removes the whole thread, including everyone's replies. It can't be undone.",
              action: 'Delete', danger: true,
            });
            if (!yes) return;
            act(() => (report.post_id
              ? db.rpc('delete_post', { target: report.post_id })
              : db.rpc('delete_thread', { target: report.thread_id })), 'Deleted.');
          }),
          button('btn-danger.btn-sm', 'Ban author', () => banDialog(report)),
        ),
      )),
      h('h2.eyebrow', { style: 'font-weight:400;display:block;margin:3rem 0 1rem' }, `Banned · ${banned.data.length}`),
      banned.data.length === 0 && h('p.prose.notice', null, 'Nobody.'),
      banned.data.map((person) => h('div.settings-row', null,
        h('div', null, h('strong', null, person.username), h('small', null, `Banned ${ago(person.banned_at)}`)),
        button('btn-ghost.btn-sm', 'Unban', () => act(() => db.rpc('unban_user', { target: person.id }), `${person.username} unbanned.`)),
      )),
    );
  }

  // Starting up
  async function loadMe() {
    if (!session) { me = null; return; }
    const { data } = await db.from('profiles').select('id, username, is_admin, banned_at').eq('id', session.user.id).maybeSingle();
    me = data;
  }

  async function start() {
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      renderBar();
      main.replaceChildren(h('div.enter', null, h('section.masthead', null,
        h('a.eyebrow', { href: '../' }, 'Lil Message'),
        h('h1', null, 'Written Messages'),
        h('div.masthead-rule'),
        h('p', null, 'Opening soon.'),
      )));
      return;
    }

    db = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

    // An expired or already-used email link comes back with an error in the URL.
    const returned = new URLSearchParams(location.hash.slice(1));
    if (returned.get('error')) {
      history.replaceState(null, '', location.pathname + location.search);
      toast('That sign-in link has expired or was already used. Request a new one.', true);
    }

    const { data } = await db.auth.getSession();
    session = data.session;
    await loadMe();
    if (session && !me) usernameDialog();
    await render();

    db.auth.onAuthStateChange((event, next) => {
      const wasUser = session && session.user.id;
      session = next;
      if (wasUser === (next && next.user.id)) return;
      // Supabase asks that its own calls wait until this callback has returned.
      setTimeout(async () => {
        await loadMe();
        renderBar();
        render();
        if (session && !me) usernameDialog();
      }, 0);
    });
  }

  start();
})();
