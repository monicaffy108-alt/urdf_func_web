/* global Vue, URDFTools */
// URDF 可视化功能在线系统 — 前端主逻辑（Vue 3 无构建版）
(function () {
  const { createApp } = Vue;

  // ---------- API ----------
  let onUnauthorized = () => {};
  async function api(url, opts = {}) {
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.body = JSON.stringify(opts.body);
      opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    }
    const r = await fetch(url, opts);
    let data = null;
    try { data = await r.json(); } catch (e) { /* 空响应 */ }
    if (r.status === 401) { onUnauthorized((data && data.detail) || '登录已过期'); throw new Error('未登录'); }
    if (!r.ok) throw new Error((data && data.detail) || `请求失败 (${r.status})`);
    return data;
  }
  const logEvent = (action, detail) =>
    api('/api/events', { method: 'POST', body: { action, detail } }).catch(() => {});

  // ---------- 关节节点连接图组件 ----------
  const X_GAP = 128, Y_GAP = 108, PAD = 64, R = 18;
  const JointGraph = {
    props: { tree: Object, stdNames: Array, selected: String },
    emits: ['select'],
    data: () => ({ tip: null }),
    computed: {
      stdSet() { return new Set(this.stdNames || []); },
      laid() {
        if (!this.tree || !this.tree.nodes.length) return null;
        const nodes = this.tree.nodes.map(n => ({
          ...n, px: PAD + n.x * X_GAP, py: PAD + n.depth * Y_GAP,
        }));
        const maxX = Math.max(...nodes.map(n => n.px));
        const maxY = Math.max(...nodes.map(n => n.py));
        const edges = [];
        nodes.forEach(n => n.children.forEach(ci => edges.push([nodes[ci].px, nodes[ci].py, n.px, n.py])));
        return { nodes, edges, w: maxX + PAD, h: maxY + PAD };
      },
    },
    methods: {
      isBad(n) {
        if (!this.stdSet.size) return false;
        return !this.stdSet.has(n.name) || (n.childLink && !this.stdSet.has(n.childLink));
      },
      shortName(n) {
        const s = n.name.replace(/^(left|right)[_\-]/i, '');
        return s.length > 13 ? s.slice(0, 12) + '…' : s;
      },
      clickNode(n, ev) {
        this.$emit('select', n.name);
        const wrap = ev.target.closest('.graph-wrap');
        const rect = wrap.getBoundingClientRect();
        this.tip = {
          x: Math.min(n.px + R + 8 - wrap.scrollLeft, rect.width - 300),
          y: n.py - 10 - wrap.scrollTop,
          joint: n.name, link: n.childLink, type: n.type,
          active: !n.hasMimic,
        };
      },
      hideTip() { this.tip = null; },
    },
    template: `
    <div class="graph-wrap" @click.self="hideTip">
      <div v-if="!laid" class="graph-empty">导入 URDF 后，这里显示关节节点连接图</div>
      <svg v-else :width="laid.w" :height="laid.h" style="display:block">
        <line v-for="(e,i) in laid.edges" :key="i" class="jg-link"
          :x1="e[0]" :y1="e[1]" :x2="e[2]" :y2="e[3]" />
        <g v-for="n in laid.nodes" :key="n.name"
           :class="['jg-node', {bad: isBad(n), selected: selected===n.name}]"
           :transform="'translate(' + n.px + ',' + n.py + ')'"
           @click.stop="clickNode(n, $event)">
          <circle class="body" r="16"></circle>
          <text v-if="!n.hasMimic" class="m-badge" x="10" y="-10">m</text>
          <text text-anchor="middle" y="34">{{ shortName(n) }}</text>
        </g>
      </svg>
      <div v-if="tip" class="jg-tip" :style="{left: tip.x+'px', top: tip.y+'px'}">
        <div><span class="dim">joint：</span>{{ tip.joint }} <span class="dim">({{ tip.type }}{{ tip.active ? '，主动' : '，被动' }})</span></div>
        <div><span class="dim">link：</span>{{ tip.link }}</div>
      </div>
    </div>`,
  };

  // ---------- 工具 ----------
  const emptyHand = () => ({ loaded: false, filename: '', xml: '', tree: null });
  const KIN_KEYS = ['limit_lower', 'limit_upper', 'mimic_joint', 'mimic_multiplier', 'mimic_offset'];
  const DYN_KEYS = ['mass', 'effort', 'velocity',
    'inertia-ixx', 'inertia-ixy', 'inertia-ixz', 'inertia-iyy', 'inertia-iyz', 'inertia-izz'];
  const ACTION_LABELS = {
    login: '登录', import_urdf: '导入 URDF（功能1）',
    mirror_run: '左右手镜像（功能2）', check_run: '分类检查（功能3）', param_export: '参数修改导出（功能4）',
  };

  // ---------- 根组件 ----------
  createApp({
    components: { JointGraph },
    data: () => ({
      page: 'login',            // login | main | admin
      user: null,
      authMsg: '',              // 被踢出/过期时回填到登录页
      // 登录 / 注册
      authTab: 'login',
      loginForm: { username: '', password: '' },
      regForm: { username: '', password: '', confirm: '', invite_code: '' },
      authErr: '', authOk: '', authBusy: false,
      // 修改密码
      chpwShow: false, chpwOld: '', chpwNew: '', chpwMsg: '',
      // 主功能页
      hands: { left: emptyHand(), right: emptyHand() },
      curHand: 'left',
      stdNames: [], stdLoaded: false,
      selNode: null,
      // 区域4
      selJoint: '', editBuf: null, invalidCells: {}, staged: {},
      region4Msg: '', region4Err: false, exportBusy: false, exportPct: 0,
      // 管理统计页
      statsForm: { year: new Date().getFullYear(), month: '', day: '' },
      statsResult: null, statsLabel: '',
      users: [], userQuery: '',
      invites: [],
      banName: '', adminMsg: '',
      stdUploadMsg: '',
    }),
    computed: {
      hand() { return this.hands[this.curHand]; },
      isAdmin() { return this.user && (this.user.is_admin || this.user.is_super); },
      dofLine() {
        const t = this.hand.tree;
        if (!t) return '';
        return `总计 ${t.totalDof} 个自由度，其中 ${t.activeDof} 个主动自由度，${t.passiveDof} 个被动自由度`;
      },
      curJointMeta() {
        if (!this.selJoint || !this.editBuf) return null;
        return this.editBuf.meta;
      },
      tableRows() {
        if (!this.editBuf) return [];
        const n = Math.max(KIN_KEYS.length, DYN_KEYS.length);
        const rows = [];
        for (let i = 0; i < n; i++) {
          rows.push({ kin: KIN_KEYS[i] || null, dyn: DYN_KEYS[i] || null });
        }
        return rows;
      },
      exportDisabled() {
        return this.exportBusy || Object.values(this.invalidCells).some(v => v)
          || !Object.keys(this.staged).length;
      },
    },
    methods: {
      // ---------- 认证 ----------
      async init() {
        try {
          // 用裸 fetch 探测，避免未登录时触发“会话过期”提示
          const r = await fetch('/api/me');
          if (!r.ok) { this.page = 'login'; return; }
          this.user = await r.json();
          this.page = 'main';
          await Promise.all([this.loadStdNames(), this.loadHand('left'), this.loadHand('right')]);
          if (!this.hands.left.loaded && this.hands.right.loaded) this.curHand = 'right';
        } catch (e) { this.page = 'login'; }
      },
      async doLogin() {
        this.authErr = ''; this.authBusy = true;
        try {
          this.user = await api('/api/login', { method: 'POST', body: this.loginForm });
          this.loginForm.password = '';
          this.page = 'main';
          await Promise.all([this.loadStdNames(), this.loadHand('left'), this.loadHand('right')]);
          if (!this.hands.left.loaded && this.hands.right.loaded) this.curHand = 'right';
        } catch (e) { this.authErr = e.message; }
        this.authBusy = false;
      },
      async doRegister() {
        this.authErr = ''; this.authOk = ''; this.authBusy = true;
        try {
          await api('/api/register', { method: 'POST', body: this.regForm });
          this.authOk = '注册成功，请登录';
          this.authTab = 'login';
          this.loginForm.username = this.regForm.username;
          this.regForm = { username: '', password: '', confirm: '', invite_code: '' };
        } catch (e) { this.authErr = e.message; }
        this.authBusy = false;
      },
      async doLogout() {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        this.user = null; this.page = 'login'; this.authMsg = '';
        this.hands = { left: emptyHand(), right: emptyHand() };
        this.selJoint = ''; this.editBuf = null; this.staged = {};
      },
      async doChpw() {
        this.chpwMsg = '';
        try {
          await api('/api/change_password', { method: 'POST',
            body: { old: this.chpwOld, new: this.chpwNew } });
          alert('密码已修改，请重新登录');
          this.chpwShow = false;
          await this.doLogout();
        } catch (e) { this.chpwMsg = e.message; }
      },

      // ---------- 区域1：导入 & 节点图 ----------
      async loadStdNames() {
        const d = await api('/api/standard-names');
        this.stdNames = d.names; this.stdLoaded = d.loaded;
      },
      async loadHand(hand) {
        const d = await api('/api/urdf/current?hand=' + hand);
        const h = this.hands[hand];
        if (!d.exists) { this.hands[hand] = emptyHand(); return; }
        h.filename = d.filename; h.xml = d.content;
        try {
          const doc = URDFTools.parseURDF(d.content);
          h.tree = URDFTools.buildJointTree(doc);
          h.loaded = true;
        } catch (e) {
          h.loaded = false; h.tree = null;
          alert(hand + '手 URDF 解析失败：' + e.message);
        }
      },
      async importHand(hand, ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.urdf')) { alert('只能选择 .urdf 文件'); return; }
        const fd = new FormData();
        fd.append('hand', hand);
        fd.append('file', file);
        try {
          await api('/api/urdf/upload', { method: 'POST', body: fd });
          await this.loadHand(hand);
          this.curHand = hand;
          this.selJoint = ''; this.editBuf = null; this.staged = {};
        } catch (e) { alert('导入失败：' + e.message); }
      },
      switchHand(hand) {
        this.curHand = hand;
        this.selJoint = ''; this.editBuf = null; this.invalidCells = {};
        this.region4Msg = ''; this.selNode = null;
      },

      // ---------- 区域4：参数修改 ----------
      selectJoint(name) {
        if (!this.hand.xml) return;
        const doc = URDFTools.parseURDF(this.hand.xml);
        const p = URDFTools.readJointParams(doc, name);
        if (!p) return;
        this.selJoint = name;
        const blank = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v ?? '']));
        this.editBuf = { meta: p.meta, kinematic: blank(p.kinematic), dynamic: blank(p.dynamic) };
        this.invalidCells = {}; this.region4Msg = ''; this.region4Err = false;
        // 已暂存过的值回显
        const st = this.staged[name];
        if (st) {
          Object.assign(this.editBuf.kinematic, st.kinematic);
          Object.assign(this.editBuf.dynamic, st.dynamic);
        }
      },
      cellKey(field) { return this.selJoint + '|' + field; },
      isInvalid(field) { return !!this.invalidCells[this.cellKey(field)]; },
      paramLabel(key) {
        const map = {
          'limit_lower': '下限角度（度）',
          'limit_upper': '上限角度（度）',
          'mimic_joint': 'Mimic 关节',
          'mimic_multiplier': 'Mimic 倍率',
          'mimic_offset': 'Mimic 偏移',
          'mass': '质量',
          'effort': '力矩上限',
          'velocity': '速度上限',
          'inertia-ixx': '转动惯量 Ixx',
          'inertia-ixy': '转动惯量 Ixy',
          'inertia-ixz': '转动惯量 Ixz',
          'inertia-iyy': '转动惯量 Iyy',
          'inertia-iyz': '转动惯量 Iyz',
          'inertia-izz': '转动惯量 Izz',
        };
        return map[key] || key;
      },
      isStaged(field) {
        const st = this.staged[this.selJoint];
        if (!st) return false;
        const v1 = (st.kinematic[field] ?? st.dynamic[field]);
        return v1 !== undefined && v1 !== '';
      },
      confirmEdits() {
        if (!this.editBuf) return;
        const invalid = {};
        const check = (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (!URDFTools.validateValue(k, v)) invalid[this.cellKey(k)] = true;
          }
        };
        check(this.editBuf.kinematic); check(this.editBuf.dynamic);
        this.invalidCells = invalid;
        if (Object.keys(invalid).length) {
          this.region4Msg = '存在数据类型错误的单元格（已标红），请修正后再确认修改';
          this.region4Err = true;
          return;
        }
        this.staged[this.selJoint] = {
          kinematic: { ...this.editBuf.kinematic },
          dynamic: { ...this.editBuf.dynamic },
        };
        this.region4Msg = `关节 ${this.selJoint} 的修改已暂存（共 ${Object.keys(this.staged).length} 个关节待导出）`;
        this.region4Err = false;
      },
      async exportUrdf() {
        if (this.exportDisabled || !this.hand.xml) return;
        this.exportBusy = true; this.exportPct = 0;
        const timer = setInterval(() => {
          this.exportPct = Math.min(this.exportPct + 20, 90);
        }, 80);
        try {
          const doc = URDFTools.parseURDF(this.hand.xml);
          for (const [jn, edits] of Object.entries(this.staged))
            URDFTools.applyJointEdits(doc, jn, edits);
          const xml2 = URDFTools.serializeURDF(doc);
          const base = (this.hand.filename || this.curHand + '.urdf').replace(/\.urdf$/i, '');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([xml2], { type: 'text/xml' }));
          a.download = base + '_modified.urdf';
          a.click();
          URL.revokeObjectURL(a.href);
          logEvent('param_export', this.curHand);
          // 同步更新服务器端当前文件
          const fd = new FormData();
          fd.append('hand', this.curHand);
          fd.append('file', new File([xml2], base + '_modified.urdf'));
          await api('/api/urdf/upload', { method: 'POST', body: fd }).catch(() => {});
          this.hands[this.curHand].xml = xml2;
          this.hands[this.curHand].filename = base + '_modified.urdf';
          this.staged = {};
          this.region4Msg = '导出成功，服务器端当前文件已同步更新';
          this.region4Err = false;
          this.selectJoint(this.selJoint);
        } catch (e) {
          this.region4Msg = '导出失败：' + e.message; this.region4Err = true;
        }
        clearInterval(timer);
        this.exportPct = 100;
        setTimeout(() => { this.exportBusy = false; this.exportPct = 0; }, 600);
      },

      // ---------- 管理统计页 ----------
      async openAdmin() {
        if (!this.isAdmin) return;
        this.page = 'admin';
        this.adminMsg = '';
        await Promise.all([this.loadUsers(), this.loadInvites(), this.runStats()]);
      },
      async runStats() {
        const p = new URLSearchParams();
        p.set('year', this.statsForm.year || new Date().getFullYear());
        if (this.statsForm.month) p.set('month', this.statsForm.month);
        if (this.statsForm.day) p.set('day', this.statsForm.day);
        const d = await api('/api/admin/stats?' + p);
        this.statsResult = d;
        this.statsLabel = d.label;
      },
      actionLabel(a) { return ACTION_LABELS[a] || a; },
      async loadUsers() {
        const d = await api('/api/admin/users' + (this.userQuery ? '?q=' + encodeURIComponent(this.userQuery) : ''));
        this.users = d.users;
      },
      roleOf(u) { return u.is_super ? '超级管理员' : u.is_admin ? '管理员' : '普通用户'; },
      async toggleAdmin(u) {
        try {
          await api('/api/admin/users/' + u.id, { method: 'PATCH', body: { is_admin: !u.is_admin } });
          await this.loadUsers();
        } catch (e) { this.adminMsg = e.message; }
      },
      async toggleBan(u) {
        try {
          await api('/api/admin/users/' + u.id, { method: 'PATCH', body: { is_enabled: !u.is_enabled } });
          await this.loadUsers();
        } catch (e) { this.adminMsg = e.message; }
      },
      async banByName() {
        const name = this.banName.trim();
        if (!name) return;
        try {
          const d = await api('/api/admin/users?q=' + encodeURIComponent(name));
          const u = d.users.find(x => x.username === name);
          if (!u) { this.adminMsg = '未找到用户：' + name; return; }
          await api('/api/admin/users/' + u.id, { method: 'PATCH', body: { is_enabled: false } });
          this.adminMsg = `已禁止 ${name} 登录`;
          this.banName = '';
          await this.loadUsers();
        } catch (e) { this.adminMsg = e.message; }
      },
      async banAll() {
        if (!confirm('确定禁止全员访问？除超级管理员外所有人都将立即无法登录。')) return;
        const d = await api('/api/admin/ban_all', { method: 'POST' });
        this.adminMsg = d.msg;
        await this.loadUsers();
      },
      async unbanAll() {
        const d = await api('/api/admin/unban_all', { method: 'POST' });
        this.adminMsg = d.msg;
        await this.loadUsers();
      },
      async genInvite() {
        const d = await api('/api/admin/invite-codes', { method: 'POST' });
        await this.loadInvites();
        this.adminMsg = '新邀请码：' + d.code;
      },
      async loadInvites() {
        const d = await api('/api/admin/invite-codes');
        this.invites = d.codes;
      },
      fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString() : '-'; },
      async uploadStdNames(ev) {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        try {
          const d = await api('/api/admin/standard-names', { method: 'POST', body: fd });
          this.stdUploadMsg = `标准命名表已更新，共 ${d.count} 个名称`;
          await this.loadStdNames();
        } catch (e) { this.stdUploadMsg = '上传失败：' + e.message; }
      },
    },
    mounted() {
      onUnauthorized = (msg) => {
        this.user = null; this.page = 'login';
        this.authMsg = msg || '会话已过期，请重新登录';
      };
      this.init();
    },
    template: `
    <!-- ======= 登录/注册页 ======= -->
    <div v-if="page==='login'" class="login-wrap">
      <div class="login-card">
        <h1>URDF 可视化功能在线系统</h1>
        <p class="login-sub">关节节点显示 · 参数修改 · 镜像 · 分类检查</p>
        <div class="auth-tabs">
          <button :class="{active: authTab==='login'}" @click="authTab='login'; authErr=''">登 录</button>
          <button :class="{active: authTab==='register'}" @click="authTab='register'; authErr=''">注 册</button>
        </div>
        <form v-if="authTab==='login'" @submit.prevent="doLogin">
          <label>用户名<input v-model.trim="loginForm.username" autocomplete="username" required></label>
          <label>密码<input v-model="loginForm.password" type="password" autocomplete="current-password" required></label>
          <div v-if="authMsg" class="form-error">{{ authMsg }}</div>
          <div v-if="authErr" class="form-error">{{ authErr }}</div>
          <div v-if="authOk" class="form-ok">{{ authOk }}</div>
          <button class="btn btn-primary btn-block" :disabled="authBusy">登 录</button>
        </form>
        <form v-else @submit.prevent="doRegister">
          <label>用户名<input v-model.trim="regForm.username" placeholder="2~32位字母/数字/_-" required></label>
          <label>密码<input v-model="regForm.password" type="password" placeholder="至少6位" required minlength="6"></label>
          <label>确认密码<input v-model="regForm.confirm" type="password" required></label>
          <label>邀请码<input v-model.trim="regForm.invite_code" placeholder="向管理员索取邀请码" required></label>
          <div v-if="authErr" class="form-error">{{ authErr }}</div>
          <button class="btn btn-primary btn-block" :disabled="authBusy">注 册</button>
        </form>
      </div>
    </div>

    <!-- ======= 主功能页 ======= -->
    <div v-else-if="page==='main'">
      <header class="topbar">
        <div class="brand">URDF 可视化功能在线系统</div>
        <div class="topbar-right">
          <span class="who">{{ user.username }}<template v-if="user.is_super">（超级管理员）</template>
            <template v-else-if="user.is_admin">（管理员）</template></span>
          <button class="btn btn-ghost" @click="chpwShow=true; chpwMsg=''; chpwOld=''; chpwNew=''">修改密码</button>
          <button v-if="isAdmin" class="btn btn-ghost" @click="openAdmin">管理统计</button>
          <button class="btn btn-ghost" @click="doLogout">退出</button>
        </div>
      </header>

      <!-- Hero -->
      <section class="hero">
        <div class="hero-eyebrow">URDF Visualization</div>
        <h1>URDF 可视化功能在线系统</h1>
        <p class="hero-sub">关节节点可视化 · 参数精确修改 · 左右手镜像 · 分类检查，一站式 URDF 编辑体验。</p>
      </section>

      <div class="page">
        <!-- 区域1：URDF 导入 & 命名检查 -->
        <section class="section">
          <div class="section-header">
            <div class="section-number">01 / Import</div>
            <h2 class="section-title">URDF 导入 &amp; 关节节点连接图</h2>
            <p class="section-desc">分别导入左右手 URDF 文件，直观查看关节节点连接结构。</p>
          </div>
          <div class="card">
            <div class="btn-row" style="align-items:center; margin-bottom: 16px;">
              <label class="btn btn-primary" style="cursor:pointer">导入左手 URDF
                <input type="file" accept=".urdf" hidden @change="importHand('left', $event)"></label>
              <label class="btn btn-primary" style="cursor:pointer">导入右手 URDF
                <input type="file" accept=".urdf" hidden @change="importHand('right', $event)"></label>
              <span class="hand-switch" style="margin-left:auto">
                <button :class="{active: curHand==='left'}" :disabled="!hands.left.loaded" @click="switchHand('left')">
                  左手{{ hands.left.loaded ? '（'+hands.left.filename+'）' : '' }}</button>
                <button :class="{active: curHand==='right'}" :disabled="!hands.right.loaded" @click="switchHand('right')">
                  右手{{ hands.right.loaded ? '（'+hands.right.filename+'）' : '' }}</button>
              </span>
            </div>
            <div v-if="!stdLoaded" class="hint warn">未检测到标准命名表（standard_urdf_name.xlsx），暂不做命名标红；管理员可在「管理统计」页上传。</div>
            <div v-else class="hint">标准命名表已加载（{{ stdNames.length }} 个名称）。红色节点 = joint/link 命名不在标准列表内；单击节点查看全称。</div>
            <div v-if="hand.tree" class="dof-stats" v-html="'当前显示：' + (curHand==='left'?'左手':'右手') + ' ｜ ' + dofLine.replace(/(\\d+)/g, '<b>$1</b>')"></div>
            <joint-graph :tree="hand.tree" :std-names="stdNames" :selected="selNode" @select="selNode=$event"></joint-graph>
          </div>
        </section>

        <!-- 区域2：左右手镜像 -->
        <section class="section">
          <div class="section-header">
            <div class="section-number">02 / Mirror</div>
            <h2 class="section-title">URDF 左右手镜像</h2>
            <p class="section-desc">一键生成对侧手 URDF，自动处理命名与参数镜像。</p>
          </div>
          <div class="card">
            <div class="placeholder-box">
              <p style="margin:0 0 10px">如下情况下，左右手镜像会失败：</p>
              <p style="margin:0 0 6px">1. URDF 中存在镜像脚本无法识别的命名规则；</p>
              <p style="margin:0 0 16px">2. URDF 文件结构不完整或语法错误。</p>
              <div class="btn-row" style="justify-content:center">
                <button class="btn btn-primary" disabled>点击执行镜像</button>
                <button class="btn" disabled>点击下载镜像文件</button>
              </div>
              <p class="hint" style="margin:16px 0 0">镜像功能将在下一阶段集成后端 urdf_mirror.py 后开放。</p>
            </div>
          </div>
        </section>

        <!-- 区域3：分类检查 -->
        <section class="section">
          <div class="section-header">
            <div class="section-number">03 / Check</div>
            <h2 class="section-title">URDF 分类检查 &amp; 检查结果</h2>
            <p class="section-desc">语法、运动学、动力学、对称性全方位检查，确保 URDF 质量。</p>
          </div>
          <div class="card">
            <div class="check-btns">
              <button class="btn" disabled>语法检查</button>
              <button class="btn" disabled>运动学参数检查</button>
              <button class="btn" disabled>动力学参数检查</button>
              <button class="btn" disabled>对称性检查</button>
            </div>
            <div class="btn-row" style="margin-bottom: 16px;">
              <select class="btn" disabled><option>语法检查项（待集成）</option></select>
              <select class="btn" disabled><option>运动学检查项（待集成）</option></select>
              <select class="btn" disabled><option>动力学检查项（待集成）</option></select>
              <select class="btn" disabled><option>对称性检查项（待集成）</option></select>
            </div>
            <div class="placeholder-box">检查功能将在下一阶段集成后端 urdf_parser_checker.py 后开放。</div>
          </div>
        </section>

        <!-- 区域4：参数修改 -->
        <section class="section">
          <div class="section-header">
            <div class="section-number">04 / Parameters</div>
            <h2 class="section-title">URDF 参数修改</h2>
            <p class="section-desc">精确调整关节运动学与动力学参数，实时预览，一键导出。</p>
          </div>
          <div class="card">
            <span class="hand-switch" style="margin-bottom: 20px">
              <button :class="{active: curHand==='left'}" :disabled="!hands.left.loaded" @click="switchHand('left')">左手</button>
              <button :class="{active: curHand==='right'}" :disabled="!hands.right.loaded" @click="switchHand('right')">右手</button>
            </span>
            <div class="region4-grid">
              <div>
                <div v-if="editBuf" class="cur-joint-label">
                  当前 joint：<b>{{ selJoint }}</b>，当前 link：<b>{{ curJointMeta.childLink }}</b>
                </div>
                <div v-else class="hint">点击右侧关节节点图中的圆圈，这里显示该关节的运动学 / 动力学参数</div>

                <!-- 运动学参数 -->
                <div v-if="editBuf" class="settings-group">
                  <div class="settings-group-title">运动学参数</div>
                  <div v-for="k in KIN_KEYS" :key="k"
                       :class="['settings-row', {'cell-invalid': isInvalid(k), 'cell-staged': isStaged(k)}]">
                    <span class="pname">{{ paramLabel(k) }}</span>
                    <span class="pinput">
                      <input v-model="editBuf.kinematic[k]" placeholder="-">
                    </span>
                  </div>
                </div>

                <!-- 动力学参数 -->
                <div v-if="editBuf" class="settings-group">
                  <div class="settings-group-title">动力学参数</div>
                  <div v-for="k in DYN_KEYS" :key="k"
                       :class="['settings-row', {'cell-invalid': isInvalid(k), 'cell-staged': isStaged(k)}]">
                    <span class="pname">{{ paramLabel(k) }}</span>
                    <span class="pinput">
                      <input v-model="editBuf.dynamic[k]" placeholder="-">
                    </span>
                  </div>
                </div>

                <div v-if="editBuf" class="btn-row" style="margin-top: 8px;">
                  <button class="btn btn-primary" @click="confirmEdits">确认修改</button>
                  <button class="btn" :disabled="exportDisabled" @click="exportUrdf">导出 URDF</button>
                </div>
                <div v-if="exportBusy || exportPct" class="progress"><i :style="{width: exportPct+'%'}"></i></div>
                <div v-if="region4Msg" :class="region4Err ? 'form-error' : 'form-ok'">{{ region4Msg }}</div>
              </div>
              <joint-graph :tree="hand.tree" :std-names="stdNames" :selected="selJoint" @select="selectJoint"></joint-graph>
            </div>
          </div>
        </section>
      </div>

      <!-- 修改密码弹窗 -->
      <div v-if="chpwShow" class="overlay-mask" style="background:rgba(10,15,26,.55)" @click.self="chpwShow=false">
        <div class="login-card" style="width:320px">
          <h2>修改密码</h2>
          <label style="display:block;margin-bottom:10px;color:var(--text-dim);font-size:13px">原密码
            <input v-model="chpwOld" type="password" style="width:100%;margin-top:4px;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)"></label>
          <label style="display:block;margin-bottom:10px;color:var(--text-dim);font-size:13px">新密码（至少6位）
            <input v-model="chpwNew" type="password" style="width:100%;margin-top:4px;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)"></label>
          <div v-if="chpwMsg" class="form-error">{{ chpwMsg }}</div>
          <div class="btn-row">
            <button class="btn btn-primary" @click="doChpw">确认</button>
            <button class="btn" @click="chpwShow=false">取消</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ======= 管理统计页 ======= -->
    <div v-else-if="page==='admin'">
      <header class="topbar">
        <div class="brand">管理统计</div>
        <div class="topbar-right">
          <span class="who">{{ user.username }}</span>
          <button class="btn btn-ghost" @click="page='main'">返回主功能页</button>
          <button class="btn btn-ghost" @click="doLogout">退出</button>
        </div>
      </header>
      <div class="page">
        <div v-if="adminMsg" class="hint" style="color:var(--text); font-weight:500">{{ adminMsg }}</div>
        <div class="admin-grid">
          <!-- 分区1：月度用户统计 -->
          <section class="section">
            <div class="section-header">
              <div class="section-number">01 / Statistics</div>
              <h2 class="section-title">使用统计</h2>
              <p class="section-desc">按年 / 月 / 日查看用户活跃度与功能使用情况。</p>
            </div>
            <div class="card">
              <div class="stat-form">
                <label>年<input type="number" v-model.number="statsForm.year" min="2020"></label>
                <label>月（可空）<input type="number" v-model.number="statsForm.month" min="1" max="12" placeholder="全年"></label>
                <label>日（可空）<input type="number" v-model.number="statsForm.day" min="1" max="31" placeholder="整月"></label>
                <button class="btn btn-primary" @click="runStats">查询</button>
              </div>
              <div v-if="statsResult" class="stat-result">
                <div class="stat-card"><div class="num">{{ statsResult.active_users }}</div><div class="lbl">{{ statsLabel }} 使用人数</div></div>
                <div class="stat-card" v-for="(n, a) in statsResult.actions" :key="a">
                  <div class="num">{{ n }}</div><div class="lbl">{{ actionLabel(a) }}</div>
                </div>
              </div>
            </div>
          </section>

          <!-- 分区2：人员权限设置 -->
          <section class="section">
            <div class="section-header">
              <div class="section-number">02 / Users</div>
              <h2 class="section-title">人员权限设置</h2>
              <p class="section-desc">管理用户角色、生成邀请码。</p>
            </div>
            <div class="card">
              <div class="search-row">
                <input v-model.trim="userQuery" placeholder="输入用户名查询权限" @keyup.enter="loadUsers">
                <button class="btn" @click="loadUsers">查询</button>
              </div>
              <table class="utable">
                <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="u in users" :key="u.id">
                    <td>{{ u.username }}</td>
                    <td><span class="role-tag" :class="{super:u.is_super, admin:u.is_admin&&!u.is_super}">{{ roleOf(u) }}</span></td>
                    <td><span class="role-tag" :class="{banned:!u.is_enabled}">{{ u.is_enabled ? '正常' : '黑名单' }}</span></td>
                    <td>
                      <button class="btn" :disabled="u.is_super" @click="toggleAdmin(u)">{{ u.is_admin ? '取消管理员' : '设为管理员' }}</button>
                      <button class="btn btn-danger" :disabled="u.is_super" @click="toggleBan(u)">{{ u.is_enabled ? '拉黑' : '恢复' }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <h3 style="margin-top:24px">邀请码</h3>
              <div class="btn-row" style="margin-bottom:12px">
                <button class="btn btn-primary" @click="genInvite">生成新邀请码</button>
              </div>
              <div class="invite-list">
                <div v-for="c in invites" :key="c.code" class="invite-item">
                  <span :class="{used: c.used_by}">{{ c.code }}</span>
                  <span class="hint" style="margin:0">{{ c.used_by ? '已被 ' + c.used_by + ' 使用' : '未使用' }}</span>
                </div>
              </div>
            </div>
          </section>

          <!-- 分区3：黑名单设置 -->
          <section class="section">
            <div class="section-header">
              <div class="section-number">03 / Settings</div>
              <h2 class="section-title">黑名单 &amp; 标准命名表</h2>
              <p class="section-desc">访问控制与 URDF 命名标准管理。</p>
            </div>
            <div class="card">
              <div class="search-row">
                <input v-model.trim="banName" placeholder="输入用户名" @keyup.enter="banByName">
                <button class="btn btn-danger" @click="banByName">禁止登录</button>
              </div>
              <div class="btn-row">
                <button class="btn btn-danger" @click="banAll">禁止全员访问</button>
                <button class="btn" @click="unbanAll">恢复全员访问</button>
              </div>
              <p class="hint">「禁止全员访问」不影响超级管理员。</p>
              <h3 style="margin-top:24px">标准命名表</h3>
              <label class="btn" style="cursor:pointer">上传 standard_urdf_name.xlsx
                <input type="file" accept=".xlsx" hidden @change="uploadStdNames"></label>
              <div v-if="stdUploadMsg" class="hint">{{ stdUploadMsg }}</div>
            </div>
          </section>
        </div>
      </div>
    </div>`,
  }).mount('#app');
})();
