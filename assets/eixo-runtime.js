/* Eixo runtime: renderizador mínimo para os componentes do site (templates com {{buracos}}, sc-for, sc-if, dc-import). */
(function () {
  'use strict';
  var REG = {};
  var ROOTS = new WeakMap();
  var EVENTS = { onclick: 'click', onchange: 'input', oninput: 'input', onsubmit: 'submit', onkeydown: 'keydown' };
  var WHOLE = /^\s*\{\{([^}]*)\}\}\s*$/;
  var HOLE = /\{\{(.*?)\}\}/g;

  function lookup(path, scope) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null' || path === 'undefined') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    if (/^'.*'$/.test(path) || /^".*"$/.test(path)) return path.slice(1, -1);
    var parts = path.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) { if (v == null) return undefined; v = v[parts[i]]; }
    return v;
  }
  function interp(str, scope) {
    return str.replace(HOLE, function (m, p) { var v = lookup(p, scope); return v == null || v === false ? '' : String(v); });
  }
  function camel(s) { return s.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (p) {
    var next = typeof p === 'function' ? p(this.state, this.props) : p;
    this.state = Object.assign({}, this.state, next);
    if (this.__inst) this.__inst.schedule();
  };
  DCLogic.prototype.forceUpdate = function () { if (this.__inst) this.__inst.schedule(); };
  window.DCLogic = DCLogic;

  function Instance(name, props, key) {
    var def = REG[name];
    if (!def) throw new Error('Componente não registrado: ' + name);
    this.name = name; this.key = key; this.def = def;
    this.children = {};
    this.handlers = [];
    this.logic = new def.Cls(props || {});
    this.logic.props = props || {};
    this.logic.__inst = this;
    this.root = null; this.pending = false; this.mounted = false;
  }
  Instance.prototype.schedule = function () {
    if (this.pending || !this.root) return;
    this.pending = true;
    var self = this;
    Promise.resolve().then(function () { self.pending = false; self.render(); });
  };
  Instance.prototype.mount = function (host) {
    this.root = document.createElement('div');
    this.root.setAttribute('data-dc-root', this.name);
    this.root.style.display = 'contents';
    ROOTS.set(this.root, this);
    host.appendChild(this.root);
    this.render();
    this.mounted = true;
    if (typeof this.logic.componentDidMount === 'function') this.logic.componentDidMount();
  };
  Instance.prototype.setProps = function (props) {
    var old = this.logic.props || {}, changed = false, k;
    for (k in props) if (props[k] !== old[k]) changed = true;
    for (k in old) if (!(k in props)) changed = true;
    if (!changed) return;
    this.logic.props = props;
    this.render();
  };
  Instance.prototype.render = function () {
    var vals = this.logic.renderVals ? this.logic.renderVals() : {};
    var ctx = { handlers: [], imports: [], n: 0, key: this.key };
    var tmp = document.createElement('div');
    tmp.setAttribute('data-dc-root', this.name);
    var nodes = build(this.def.nodes, vals, ctx);
    for (var i = 0; i < nodes.length; i++) tmp.appendChild(nodes[i]);
    this.handlers = ctx.handlers;
    window.morphdom(this.root, tmp, {
      childrenOnly: true,
      onBeforeElUpdated: function (from, to) {
        if (from.hasAttribute && from.hasAttribute('data-dc-host') && from.getAttribute('data-dc-host') === to.getAttribute('data-dc-host')) {
          for (var a = 0; a < to.attributes.length; a++) from.setAttribute(to.attributes[a].name, to.attributes[a].value);
          return false;
        }
        if (from.tagName === 'DETAILS') { if (from.open) to.setAttribute('open', ''); else to.removeAttribute('open'); }
        return true;
      }
    });
    // filhos
    var seen = {};
    for (var j = 0; j < ctx.imports.length; j++) {
      var im = ctx.imports[j];
      seen[im.key] = true;
      var host = this.root.querySelector('[data-dc-host="' + im.key + '"]');
      if (!host) continue;
      var child = this.children[im.key];
      if (child && child.host === host) { child.setProps(im.props); continue; }
      host.innerHTML = '';
      child = new Instance(im.name, im.props, im.key);
      child.host = host;
      this.children[im.key] = child;
      child.mount(host);
    }
    for (var k in this.children) if (!seen[k]) delete this.children[k];
  };

  function build(srcNodes, scope, ctx) {
    var out = [];
    for (var i = 0; i < srcNodes.length; i++) {
      var n = srcNodes[i];
      if (n.nodeType === 3) { out.push(document.createTextNode(n.nodeValue.indexOf('{{') >= 0 ? interp(n.nodeValue, scope) : n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      var tag = n.localName;
      if (tag === 'sc-for') {
        var list = lookup((n.getAttribute('list') || '').replace(/[{}]/g, ''), scope) || [];
        var alias = n.getAttribute('as') || 'item';
        for (var x = 0; x < list.length; x++) {
          var s = Object.create(scope); s[alias] = list[x]; s.$index = x;
          out.push.apply(out, build(n.childNodes, s, ctx));
        }
        continue;
      }
      if (tag === 'sc-if') {
        var raw = n.getAttribute('value') || '';
        var m = WHOLE.exec(raw);
        if (m ? lookup(m[1], scope) : raw) out.push.apply(out, build(n.childNodes, scope, ctx));
        continue;
      }
      if (tag === 'dc-import') {
        var props = {}, name = n.getAttribute('name');
        for (var a = 0; a < n.attributes.length; a++) {
          var at = n.attributes[a];
          if (at.name === 'name' || at.name.indexOf('hint-') === 0) continue;
          var mm = WHOLE.exec(at.value);
          props[camel(at.name)] = mm ? lookup(mm[1], scope) : interp(at.value, scope);
        }
        var key = ctx.key + '/' + (ctx.n++);
        ctx.imports.push({ name: name, props: props, key: key });
        var host = document.createElement('div');
        host.setAttribute('data-dc-host', key);
        host.style.display = 'contents';
        out.push(host);
        continue;
      }
      var el = n.namespaceURI && n.namespaceURI !== 'http://www.w3.org/1999/xhtml' ? document.createElementNS(n.namespaceURI, n.nodeName) : document.createElement(tag);
      for (var b = 0; b < n.attributes.length; b++) {
        var attr = n.attributes[b], an = attr.name, av = attr.value;
        if (av.indexOf('{{') < 0) { el.setAttribute(an, av); continue; }
        var w = WHOLE.exec(av);
        var lname = an.toLowerCase();
        if (w && EVENTS[lname]) {
          var fn = lookup(w[1], scope);
          if (typeof fn === 'function') { ctx.handlers.push(fn); el.setAttribute('data-dc-on-' + EVENTS[lname], String(ctx.handlers.length - 1)); }
          continue;
        }
        if (w) {
          var v = lookup(w[1], scope);
          if (v == null || v === false) continue;
          el.setAttribute(an, v === true ? '' : String(v));
        } else {
          el.setAttribute(an, interp(av, scope));
        }
      }
      var kids = build(n.childNodes, scope, ctx);
      for (var c = 0; c < kids.length; c++) el.appendChild(kids[c]);
      if (tag === 'input' && el.hasAttribute('value')) el.value = el.getAttribute('value');
      out.push(el);
    }
    return out;
  }

  function dispatch(type) {
    document.addEventListener(type, function (e) {
      var t = e.target;
      while (t && t !== document) {
        if (t.nodeType === 1 && t.hasAttribute('data-dc-on-' + type)) {
          var root = t.closest('[data-dc-root]');
          var inst = root && ROOTS.get(root);
          var fn = inst && inst.handlers[Number(t.getAttribute('data-dc-on-' + type))];
          if (fn) {
            if (type === 'click' && t.tagName === 'A' && (t.getAttribute('href') || '').charAt(0) !== '#') { /* deixa navegar */ }
            fn.call(null, e);
          }
          return;
        }
        t = t.parentNode;
      }
    }, false);
  }
  ['click', 'input', 'submit', 'keydown'].forEach(dispatch);

  window.DC = {
    define: function (name, Cls) {
      var tpl = document.getElementById('dc-tpl-' + name);
      REG[name] = { Cls: Cls, nodes: Array.prototype.slice.call(tpl.content.childNodes) };
    },
    mount: function (name, el, props) { var inst = new Instance(name, props || {}, name); inst.mount(el); return inst; }
  };
})();
