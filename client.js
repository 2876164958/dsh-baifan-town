/**
 * 白饭小镇 —— 浏览器半端（设置页里一页，名字「白饭小镇」）
 * 跟刷抖音插件同一个模板：ModuleLoader.load + settings.section 槽 + Boundary 包住。
 * 面板直接调小镇的 HTTP 接口（小镇已开 CORS）。
 *
 * v2（2026-11-15 19:40）：把「读板/发一句」撤了——人家有网址，不用在这儿抄一遍。
 * 留的是网址上没有的：一张能出牌的斗地主桌（省得在小网页上点小按钮）。
 */
window.__ModuleLoader__.load({
  // 注册 id 必须等于包名（package.json 的 name），否则宿主按包名找不到这一行，
  // 会回落到单文件 URL 再执行一遍脚本 → duplicate factory registration 直接炸掉整个启动。
  id: 'dsh-baifan-town',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_BUILD = 3
    const BASE = 'http://127.0.0.1:8787'
    const SITE = 'https://xiaojing4.serveousercontent.com'
    const NAME_KEY = 'town.player.v2'

    const req = async (path, init) => {
      const res = await fetch(BASE + path, Object.assign({ credentials: 'omit' }, init || {}))
      let data = null
      try {
        data = await res.json()
      } catch (e) {
        data = null
      }
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
      return data
    }
    const jget = (p) => req(p)
    const jpost = (p, body) => req(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    })

    const CSS = `
[data-town-page]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 10px;max-width:660px;font-size:13px;}
[data-town-card]{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-town-title]{font-size:13px;font-weight:600;}
[data-town-sub]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-town-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-town-btn]{padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-town-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-town-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-town-btn][disabled]{opacity:.45;cursor:default;}
[data-town-input]{padding:8px 10px;border-radius:8px;font-size:12px;width:110px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-town-seat]{font-size:11px;padding:3px 8px;border-radius:99px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));}
[data-town-seat][data-turn]{outline:1px solid #3b82f6;}
[data-town-hand]{display:flex;flex-wrap:wrap;gap:6px;}
[data-town-cardface]{min-width:34px;padding:8px 6px;border-radius:7px;font-size:13px;font-weight:600;
  cursor:pointer;font-family:inherit;text-align:center;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;}
[data-town-cardface][data-picked]{background:#3b82f6;border-color:#3b82f6;color:#fff;transform:translateY(-3px);}
[data-town-log]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);
  display:flex;flex-direction:column-reverse;gap:2px;max-height:96px;overflow:auto;}
`

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      render() {
        if (this.state.err) {
          return h('div', { 'data-town-card': '' },
            h('div', { 'data-town-title': '' }, '这页出错了'),
            h('div', { 'data-town-sub': '' }, String(this.state.err && this.state.err.message || this.state.err)),
            h('button', { 'data-town-btn': '', onClick: () => this.setState({ err: null }) }, '重试'))
        }
        return this.props.children
      }
    }

    const readName = () => {
      try {
        return window.localStorage.getItem(NAME_KEY) || '小鱼'
      } catch (e) {
        return '小鱼'
      }
    }

    function Table() {
      const [name, setName] = React.useState(readName)
      const [state, setState] = React.useState(null)
      const [picked, setPicked] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const s = await jget('/api/ddz/state?name=' + encodeURIComponent(name))
          setState(s)
        } catch (e) {
          setNote('连不上小镇：' + (e && e.message))
        }
      }, [name])

      React.useEffect(() => {
        load()
        const t = setInterval(load, 3000)
        return () => clearInterval(t)
      }, [load])

      const saveName = (v) => {
        setName(v)
        try {
          window.localStorage.setItem(NAME_KEY, v)
        } catch (e) {
          /* 存不了就算了 */
        }
      }

      const act = async (fn) => {
        setBusy(true)
        setNote('')
        try {
          await fn()
        } catch (e) {
          setNote((e && e.message) || String(e))
        } finally {
          setBusy(false)
          await load()
        }
      }

      const mySeat = state ? state.mySeat : -1
      const phase = state ? state.phase : 'waiting'
      const myTurn = state && phase === 'playing' && state.turn === state.mySeat && mySeat >= 0
      const handRaw = (state && state.myHandRaw) || []
      const hand = (state && state.myHand) || []

      const toggle = (i) => {
        setPicked((prev) => prev.indexOf(i) >= 0 ? prev.filter((x) => x !== i) : prev.concat([i]))
      }

      const playCards = () => act(async () => {
        if (!picked.length) throw new Error('先点几张牌')
        const cards = picked.map((i) => handRaw[i])
        const r = await jpost('/api/ddz/play', { name, cards })
        setPicked([])
        if (r && r.winner) setNote(r.winner + ' 走完了')
      })

      const passTurn = () => act(async () => {
        const r = await jpost('/api/ddz/play', { name, action: 'pass' })
        setPicked([])
        if (r && r.winner) setNote(r.winner + ' 走完了')
      })

      const status = !state
        ? '还没读到牌桌'
        : phase === 'waiting'
          ? '等人坐下'
          : phase === 'over'
            ? (state.winner || '有人') + ' 走完了'
            : '轮到 ' + (state.turnName || '?')

      return h('div', { 'data-town-card': '' },
        h('div', { 'data-town-row': '' },
          h('div', { 'data-town-title': '', style: { flex: 1 } }, '牌桌'),
          h('span', { 'data-town-seat': '' }, status)),

        h('div', { 'data-town-row': '' },
          h('input', {
            'data-town-input': '',
            placeholder: '名字',
            value: name,
            onChange: (e) => saveName(e.target.value)
          }),
          h('button', {
            'data-town-btn': '',
            'data-primary': '',
            disabled: busy || mySeat >= 0,
            onClick: () => act(() => jpost('/api/ddz/join', { name }))
          }, mySeat >= 0 ? '已经坐下了' : '坐下'),
          h('button', {
            'data-town-btn': '',
            disabled: busy,
            onClick: () => act(() => jpost('/api/ddz/fill', { count: 2 }))
          }, '补两个人'),
          h('button', {
            'data-town-btn': '',
            'data-primary': '',
            disabled: busy || phase !== 'waiting' || ((state && state.seats) || []).length < 3,
            onClick: () => act(() => jpost('/api/ddz/start', {}))
          }, '开局'),
          h('button', {
            'data-town-btn': '',
            disabled: busy,
            onClick: () => act(() => jpost('/api/ddz/kickbot', {}))
          }, '踢掉机器人'),
          h('button', {
            'data-town-btn': '',
            disabled: busy,
            onClick: () => act(() => jpost('/api/ddz/nudge', {}))
          }, '催一下'),
          h('button', {
            'data-town-btn': '',
            disabled: busy,
            onClick: () => act(() => jpost('/api/ddz/reset', { name }))
          }, '重开')),

        h('div', { 'data-town-row': '' },
          ((state && state.seats) || []).map((s, i) =>
            h('span', {
              'data-town-seat': '',
              'data-turn': s.isTurn ? '' : undefined,
              key: i
            }, (s.role === 'landlord' ? '地主 ' : '') + s.name + ' · 剩 ' + s.count))),

        hand.length
          ? h('div', { 'data-town-hand': '' },
            hand.map((label, i) => h('button', {
              'data-town-cardface': '',
              'data-picked': picked.indexOf(i) >= 0 ? '' : undefined,
              key: i,
              onClick: () => toggle(i)
            }, label)))
          : h('div', { 'data-town-sub': '' }, mySeat >= 0 ? '手里没牌了' : '坐下才有牌'),

        h('div', { 'data-town-row': '' },
          h('button', {
            'data-town-btn': '',
            'data-primary': '',
            disabled: busy || !myTurn || !picked.length,
            onClick: playCards
          }, '出牌'),
          h('button', {
            'data-town-btn': '',
            disabled: busy || !myTurn,
            onClick: passTurn
          }, '过'),
          h('button', {
            'data-town-btn': '',
            disabled: busy || !picked.length,
            onClick: () => setPicked([])
          }, '取消选牌'),
          note ? h('span', { 'data-town-sub': '' }, note) : null),

        state && state.last
          ? h('div', { 'data-town-sub': '' },
            '上一手 ' + state.last.name + '：' + state.last.cards.join(' ') + '（' + state.last.type + '）')
          : null,

        state && state.log && state.log.length
          ? h('div', { 'data-town-log': '' },
            state.log.map((line, i) => h('div', { key: i }, line)))
          : null)
    }

    function Today() {
      const [today, setToday] = React.useState(null)
      const [note, setNote] = React.useState('')

      React.useEffect(() => {
        let alive = true
        jget('/api/today')
          .then((t) => { if (alive) setToday(t) })
          .catch((e) => { if (alive) setNote('连不上小镇：' + (e && e.message)) })
        return () => { alive = false }
      }, [])

      return h('div', { 'data-town-card': '' },
        h('div', { 'data-town-row': '' },
          h('div', { 'data-town-title': '', style: { flex: 1 } }, '今天'),
          h('button', {
            'data-town-btn': '',
            onClick: () => { try { window.open(SITE, '_blank') } catch (e) { /* 弹不出就算了 */ } }
          }, '打开网址')),
        h('div', { 'data-town-sub': '' },
          note || (today
            ? '留言 ' + (today.count || 0) + ' 条 · 来过 ' + ((today.visitors || []).length) + ' 人'
            : '还没读到')),
        h('div', { 'data-town-row': '' },
          ((today && today.visitors) || []).map((v, i) =>
            h('span', { 'data-town-seat': '', key: i }, v.name + ' × ' + v.count))))
    }

    function Panel() {
      return h('div', { 'data-town-page': '' },
        h('div', { 'data-town-row': '' },
          h('div', { 'data-town-title': '', style: { flex: 1 } }, '白饭小镇'),
          h('span', { 'data-town-seat': '' }, 'v2 · b' + PANEL_BUILD)),
        h(Table),
        h(Today))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-town')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-town: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'town', order: 32, label: '白饭小镇' },
          () => h(Boundary, null, h(Panel))
        ))
      }
    }
  }
})
