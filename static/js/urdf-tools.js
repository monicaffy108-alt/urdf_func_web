// URDF 工具库（经典脚本，挂 window.URDFTools）：解析、关节树布局、参数读写
// 镜像/检查将在 1-2 阶段由后端 Python 脚本承担，这里只保留前端需要的部分
(function () {
  const MOVABLE = new Set(['revolute', 'prismatic', 'continuous']);

  function parseURDF(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('URDF XML 解析失败：' + err.textContent.slice(0, 160));
    if (!doc.documentElement || doc.documentElement.tagName !== 'robot')
      throw new Error('根节点不是 <robot>');
    return doc;
  }

  function serializeURDF(doc) {
    let s = new XMLSerializer().serializeToString(doc);
    if (!s.startsWith('<?xml')) s = '<?xml version="1.0"?>\n' + s;
    return s;
  }

  const jointsOf = doc => [...doc.getElementsByTagName('joint')];
  const linksOf = doc => [...doc.getElementsByTagName('link')];
  const childLinkOf = j => { const e = j.querySelector(':scope > child'); return e ? e.getAttribute('link') : null; };
  const parentLinkOf = j => { const e = j.querySelector(':scope > parent'); return e ? e.getAttribute('link') : null; };

  // 构建关节树（仅可动关节成节点；fixed 关节透传）
  // 返回 { nodes:[{name,type,parentLink,childLink,hasMimic,depth,x,y,children:[],parent}], totalDof, activeDof, passiveDof }
  function buildJointTree(doc) {
    const joints = jointsOf(doc);
    const byChild = {};   // childLink -> joint
    jointsOf(doc).forEach(j => { const c = childLinkOf(j); if (c) byChild[c] = j; });

    const nodes = [];
    const idx = {};
    jointsOf(doc).forEach(j => {
      const type = j.getAttribute('type') || 'fixed';
      if (!MOVABLE.has(type)) return;
      idx[j.getAttribute('name')] = nodes.length;
      nodes.push({
        name: j.getAttribute('name'),
        type,
        parentLink: parentLinkOf(j),
        childLink: childLinkOf(j),
        hasMimic: !!j.querySelector(':scope > mimic'),
        depth: 0, x: 0, y: 0, children: [], parent: -1,
      });
    });

    // 向上找最近的可动父关节
    function nearestMovableParent(joint) {
      let pl = parentLinkOf(joint);
      let guard = 0;
      while (pl && guard++ < 500) {
        const pj = byChild[pl];
        if (!pj) return null;
        if (MOVABLE.has(pj.getAttribute('type'))) return pj;
        pl = parentLinkOf(pj);
      }
      return null;
    }
    nodes.forEach(n => {
      const j = jointsOf(doc).find(x => x.getAttribute('name') === n.name);
      const p = j && nearestMovableParent(j);
      if (p && idx[p.getAttribute('name')] !== undefined) {
        n.parent = idx[p.getAttribute('name')];
        nodes[n.parent].children.push(idx[n.name]);
      }
    });
    // 深度
    const roots = nodes.map((n, i) => (n.parent === -1 ? i : -1)).filter(i => i >= 0);
    const setDepth = (i, d) => { nodes[i].depth = d; nodes[i].children.forEach(c => setDepth(c, d + 1)); };
    roots.forEach(r => setDepth(r, 0));
    // 布局：叶子计数分配 x，depth 分配 y
    let leaf = 0;
    const assignX = i => {
      const n = nodes[i];
      if (!n.children.length) { n.x = leaf++; }
      else { n.children.forEach(assignX); n.x = (nodes[n.children[0]].x + nodes[n.children[n.children.length - 1]].x) / 2; }
    };
    roots.forEach(assignX);

    const totalDof = nodes.length;
    const passiveDof = nodes.filter(n => n.hasMimic).length;
    return { nodes, roots, totalDof, activeDof: totalDof - passiveDof, passiveDof };
  }

  // 区域4：读取关节的运动学/动力学参数
  function readJointParams(doc, jointName) {
    const j = jointsOf(doc).find(x => x.getAttribute('name') === jointName);
    if (!j) return null;
    const lim = j.querySelector(':scope > limit');
    const mim = j.querySelector(':scope > mimic');
    const cl = childLinkOf(j);
    const link = linksOf(doc).find(l => l.getAttribute('name') === cl);
    const ine = link ? link.querySelector(':scope > inertial') : null;
    const mass = ine ? ine.querySelector(':scope > mass') : null;
    const inertia = ine ? ine.querySelector(':scope > inertia') : null;
    const g = (el, a) => (el && el.getAttribute(a) !== null ? el.getAttribute(a) : null);
    return {
      meta: { type: j.getAttribute('type'), parentLink: parentLinkOf(j), childLink: cl },
      kinematic: {
        limit_lower: g(lim, 'lower'),
        limit_upper: g(lim, 'upper'),
        mimic_joint: g(mim, 'joint'),
        mimic_multiplier: g(mim, 'multiplier'),
        mimic_offset: g(mim, 'offset'),
      },
      dynamic: {
        mass: g(mass, 'value'),
        effort: g(lim, 'effort'),
        velocity: g(lim, 'velocity'),
        'inertia-ixx': g(inertia, 'ixx'),
        'inertia-ixy': g(inertia, 'ixy'),
        'inertia-ixz': g(inertia, 'ixz'),
        'inertia-iyy': g(inertia, 'iyy'),
        'inertia-iyz': g(inertia, 'iyz'),
        'inertia-izz': g(inertia, 'izz'),
      },
    };
  }

  // PRD 数据类型要求：mimic_joint 为 str，其余均为 float/int
  const FLOAT_FIELDS = new Set([
    'limit_lower', 'limit_upper', 'mimic_multiplier', 'mimic_offset',
    'mass', 'effort', 'velocity',
    'inertia-ixx', 'inertia-ixy', 'inertia-ixz', 'inertia-iyy', 'inertia-iyz', 'inertia-izz']);
  function validateValue(field, value) {
    if (value === null || value === undefined || value === '') return true; // 空 = 不修改
    if (field === 'mimic_joint') return typeof value === 'string';
    if (FLOAT_FIELDS.has(field)) return isFinite(Number(value));
    return true;
  }

  // 把确认后的修改写回 XML doc
  function applyJointEdits(doc, jointName, edits) {
    const j = jointsOf(doc).find(x => x.getAttribute('name') === jointName);
    if (!j) return false;
    const setOrMake = (parent, tag, attr, val) => {
      if (val === null || val === undefined || val === '') return;
      let el = parent.querySelector(':scope > ' + tag);
      if (!el) { el = doc.createElement(tag); parent.appendChild(el); }
      el.setAttribute(attr, String(val));
    };
    const k = edits.kinematic || {}, d = edits.dynamic || {};
    if (k.limit_lower !== undefined) setOrMake(j, 'limit', 'lower', k.limit_lower);
    if (k.limit_upper !== undefined) setOrMake(j, 'limit', 'upper', k.limit_upper);
    if (k.mimic_joint) {
      setOrMake(j, 'mimic', 'joint', k.mimic_joint);
      if (k.mimic_multiplier !== undefined && k.mimic_multiplier !== '')
        setOrMake(j, 'mimic', 'multiplier', k.mimic_multiplier);
      if (k.mimic_offset !== undefined && k.mimic_offset !== '')
        setOrMake(j, 'mimic', 'offset', k.mimic_offset);
    }
    if (d.effort !== undefined) setOrMake(j, 'limit', 'effort', d.effort);
    if (d.velocity !== undefined) setOrMake(j, 'limit', 'velocity', d.velocity);
    const cl = childLinkOf(j);
    const link = linksOf(doc).find(l => l.getAttribute('name') === cl);
    if (link) {
      let ine = link.querySelector(':scope > inertial');
      const needIne = (d.mass !== undefined && d.mass !== '') ||
        Object.keys(d).some(key => key.startsWith('inertia-') && d[key] !== undefined && d[key] !== '');
      if (needIne && !ine) { ine = doc.createElement('inertial'); link.insertBefore(ine, link.firstChild); }
      if (ine) {
        if (d.mass !== undefined) setOrMake(ine, 'mass', 'value', d.mass);
        for (const key of Object.keys(d)) {
          if (key.startsWith('inertia-') && d[key] !== undefined && d[key] !== '') {
            let el = ine.querySelector(':scope > inertia');
            if (!el) { el = doc.createElement('inertia'); ine.appendChild(el); }
                            el.setAttribute(key.replace('inertia-', ''), String(d[key]));
          }
        }
      }
    }
    return true;
  }

  window.URDFTools = {
    parseURDF, serializeURDF, buildJointTree, readJointParams, applyJointEdits,
    validateValue, MOVABLE,
    jointsOf, linksOf,
  };
})();
