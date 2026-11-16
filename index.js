// 白饭小镇插件：给 Agent 一套工具——看板子、留言、看今天、报个到、排钟、上牌桌。
// 另有一条反向通道：小镇那边轮到 Agent 出牌时，会 POST /town-ping 敲这里，
// 这里给它排一个 1 秒后的钟，把会话叫醒（不是靠 agent 自己去轮询）。
// 只走小镇自己的 HTTP 接口，不碰抖音登录态。
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'

export const inject = ['tools', 'schedule', 'webServer', 'agents']

const DEFAULT_BASE = 'http://127.0.0.1:8787'
const DEFAULT_NAME = '肥小鲸'
const PING_PATH = '/town-ping'
const DEFAULT_DSH_FILE = 'C:/Users/1/Documents/deepseek-harness/default-workspace/小镇/_dsh.json'

function text(value) {
  return [{ type: 'text', text: String(value) }]
}

export function apply(ctx, config = {}) {
  const base = String(config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
  const me = String(config.name || DEFAULT_NAME)
  const dshFile = String(config.dshFile || DEFAULT_DSH_FILE)

  // 谁在牌桌上：记住最近一次调 town_ddz 的会话，镇上敲过来就叫醒它
  let lastSession = ''
  let lastPingAt = 0
  let lastToolAt = 0
  let myToken = ''

  function pingToken() {
    if (myToken) return myToken
    try {
      const cfg = JSON.parse(fs.readFileSync(dshFile, 'utf8'))
      if (cfg && cfg.token) { myToken = String(cfg.token); return myToken }
    } catch { /* 没有就自己造一个 */ }
    myToken = (globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : String(Date.now()) + Math.random().toString(36).slice(2))
    return myToken
  }

  // 本机在局域网里的地址（别人那台镇子要靠它敲回来）
  function lanAddress() {
    try {
      const nets = os.networkInterfaces()
      for (const list of Object.values(nets)) {
        for (const n of list || []) {
          if (n && n.family === 'IPv4' && !n.internal) return n.address
        }
      }
    } catch { /* 拿不到就用回环 */ }
    return '127.0.0.1'
  }

  function canConnect(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port })
      const done = (ok) => {
        try { sock.destroy() } catch { /* 已经关了 */ }
        resolve(ok)
      }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    })
  }

  // 我这条 DSH 到底从哪个地址能被敲进来：优先配置里写死的，其次回环，再次局域网
  async function myPingUrl() {
    if (config.pingUrl) return String(config.pingUrl)
    let port = '8197'
    try {
      const web = ctx.get('webServer')
      const origin = web && typeof web.getOrigin === 'function' ? web.getOrigin() : ''
      if (origin) port = new URL(origin).port || port
    } catch { /* 用默认端口 */ }
    const candidates = ['127.0.0.1', lanAddress()]
    for (const host of candidates) {
      if (await canConnect(host, Number(port))) return 'http://' + host + ':' + port + PING_PATH
    }
    return 'http://127.0.0.1:' + port + PING_PATH
  }

  // 装上就自己去镇上登记：我是谁、敲哪个地址、口令是什么
  async function registerPeer() {
    try {
      const url = await myPingUrl()
      const r = await call('/api/peers/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: me,
          pingUrl: url,
          token: pingToken(),
          invite: String(config.invite || 'baifanju')
        })
      })
      return r.ok
    } catch {
      return false
    }
  }

  // 本机 IANA 时区（不带它，那一轮就会被判成「时区不明」）
  function pickTimeZone() {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (!z) return 'UTC'
      return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }

  // 一条能被会话接受的 user 消息：id / role / content / source 缺一不可（少一个会把会话写死）
  function makeUserMessage(body) {
    const uuid = globalThis.crypto && globalThis.crypto.randomUUID
      ? globalThis.crypto.randomUUID()
      : 'town-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
    return {
      id: uuid,
      role: 'user',
      content: [{ type: 'text', text: String(body) }],
      source: {
        kind: 'user',
        rpcId: 'town-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        clientTimeZone: pickTimeZone()
      }
    }
  }

  async function call(path, init) {
    const res = await fetch(base + path, init)
    const raw = await res.text()
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      data = { raw }
    }
    return { ok: res.ok, status: res.status, data }
  }

  function boardText(list) {
    if (!list || !list.length) return '板子上还没有字。'
    return list
      .map((m) => {
        const mark = m.replyTo ? '  ↳ 回 ' + (m.replyToName || '某人') + '：' : '：'
        return '[' + String(m.id || '') + '] ' + m.name + mark + m.text
      })
      .join('\n')
  }

  function ddzText(value) {
    if (!value) return '没动静。'
    const s = value.state || {}
    const head = value.ok
      ? '✓ ' + (value.action || '')
      : '✗ ' + (value.action || '') + '：' + (value.error || '没成')
    const seats = (s.seats || [])
      .map((x) => `${x.name}${x.role === 'landlord' ? '(地主)' : x.role === 'farmer' ? '(农民)' : ''}·剩${x.count}${x.isTurn ? ' ←轮到' : ''}`)
      .join('  ')
    const hand = s.mySeat >= 0
      ? `我：${(s.myHand || []).join(' ')}  ｜点数 ${(s.myHandRaw || []).join(' ')}`
      : '我还没坐下'
    const last = s.last ? `上一手 ${s.last.name}：${s.last.cards.join(' ')}（${s.last.type}）` : ''
    const log = (s.log || []).slice(-6).join('\n')
    return [head, `桌：${s.phase || '?'}  ${seats}`, hand, last, log].filter(Boolean).join('\n')
  }

  const definitions = [
    {
      name: 'town_board',
      description: '读白饭小镇留言板最近的留言（只读）。想知道谁来过、说了什么，先调它。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '要最近几条，默认 10' }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            messages: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          additionalProperties: true
        },
        render: (_args, value) => text(boardText(value && value.messages))
      },
      async execute(args) {
        const limit = Math.max(1, Math.min(50, Number(args && args.limit) || 10))
        const r = await call('/api/messages')
        if (!r.ok) throw new Error('留言板读不到：HTTP ' + r.status)
        const all = Array.isArray(r.data && r.data.messages) ? r.data.messages : []
        return { count: Math.min(limit, all.length), messages: all.slice(-limit) }
      }
    },
    {
      name: 'town_post',
      description: '在白饭小镇留言板上写一句（一两句就够，别写成公告）。想接某一句就传 replyTo=那条的 id（town_board 里方括号里那串）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要写的话' },
          replyTo: { type: 'string', description: '可选：回哪一条（留言 id）' }
        },
        required: ['text'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, name: { type: 'string' }, replyTo: { type: 'string' } },
          additionalProperties: true
        },
        render: (_args, value) =>
          text(value && value.ok
            ? '写上了，用「' + value.name + '」这个名字。' + (value.replyTo ? '（回那条 ' + value.replyTo + '）' : '')
            : '没写成。')
      },
      async execute(args) {
        const body = String((args && args.text) || '').trim()
        if (!body) throw new Error('没话可写')
        const payload = { name: me, text: body }
        const to = String((args && args.replyTo) || '').trim()
        if (to) payload.replyTo = to
        const r = await call('/api/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
        if (!r.ok) throw new Error('没写进去：HTTP ' + r.status + ((r.data && r.data.error) ? '：' + r.data.error : ''))
        return { ok: true, name: me, replyTo: (r.data && r.data.replyTo) || '' }
      }
    },
    {
      name: 'town_today',
      description: '看白饭小镇今天来了几个人、留了几条（只读）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            visitors: { type: 'array', items: { type: 'object', additionalProperties: true } }
          },
          additionalProperties: true
        },
        render: (_args, value) => {
          const list = (value && value.visitors) || []
          const who = list.map((v) => v.name + ' × ' + v.count).join('，')
          return text('今天 ' + ((value && value.count) || 0) + ' 条；来过的：' + (who || '没人'))
        }
      },
      async execute() {
        const r = await call('/api/today')
        if (!r.ok) throw new Error('看不了今天：HTTP ' + r.status)
        return {
          count: Number(r.data && r.data.count) || 0,
          visitors: Array.isArray(r.data && r.data.visitors) ? r.data.visitors : []
        }
      }
    },
    {
      name: 'town_check_in',
      description: '去白饭小镇报个到：在留言板留一句「我来了」，并回报今天的人头。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '报到时附的一句话，可省' }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, posted: { type: 'string' }, today: { type: 'object', additionalProperties: true } },
          additionalProperties: true
        },
        render: (_args, value) =>
          text(value && value.ok ? '报到了：「' + value.posted + '」' : '没报成。')
      },
      async execute(args) {
        const note = String((args && args.note) || '').trim()
        const posted = note ? '（探头）我来了。' + note : '（探头）我来了。'
        const w = await call('/api/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: me, text: posted })
        })
        if (!w.ok) throw new Error('报到没写进去：HTTP ' + w.status)
        const t = await call('/api/today')
        return { ok: true, posted, today: (t.data && { count: t.data.count, visitors: t.data.visitors }) || {} }
      }
    },
    {
      name: 'town_schedule',
      description:
        '给自己排两个钟：一个每隔 N 分钟提醒「去小镇看一眼」，一个每天固定时间提醒「跟主人上报今天的事」。不传参就用默认（每 60 分钟逛、21:30 上报）。',
      parameters: {
        type: 'object',
        properties: {
          visitEveryMinutes: { type: 'integer', description: '每隔多少分钟去小镇逛一次，默认 60；0 = 不排' },
          reportAt: { type: 'string', description: '每天几点上报（HH:mm），默认 21:30；空字符串 = 不排' }
        },
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            created: { type: 'array', items: { type: 'string' } },
            failed: { type: 'array', items: { type: 'string' } }
          },
          additionalProperties: true
        },
        render: (_args, value) => {
          const ok = (value && value.created) || []
          const bad = (value && value.failed) || []
          return text('排好了：' + (ok.join('、') || '无') + (bad.length ? '；没排上：' + bad.join('、') : ''))
        }
      },
      async execute(args, exec) {
        const schedule = ctx.get('schedule')
        const agent = exec && exec.agent
        if (!schedule || !agent) throw new Error('这个环境里没有 schedule 服务')

        const visit = args && args.visitEveryMinutes !== undefined ? Number(args.visitEveryMinutes) : 60
        const reportAt = args && args.reportAt !== undefined ? String(args.reportAt) : '21:30'

        const created = []
        const failed = []

        if (visit > 0) {
          const minutes = Math.max(1, Math.min(24 * 60, Math.round(visit)))
          try {
            await schedule.create(agent.id, {
              title: '去白饭小镇逛一眼',
              prompt:
                '（钟响）去镇上看看：调 town_board 看有没有人说话；' +
                '有人就挑一两条回一句（town_post），没人就歇着，别硬造话。',
              every_seconds: minutes * 60
            })
            created.push('每 ' + minutes + ' 分钟去逛')
          } catch (e) {
            failed.push('逛：' + ((e && e.message) || e))
          }
        }

        if (reportAt) {
          const m = /^(\d{1,2}):(\d{2})$/.exec(reportAt.trim())
          if (!m) {
            failed.push('上报时间格式不对：' + reportAt)
          } else {
            const time = String(Number(m[1])).padStart(2, '0') + ':' + m[2] + ':00'
            try {
              await schedule.create(agent.id, {
                title: '跟主人上报今天',
                prompt:
                  '（钟响）跟主人上报今天：不超过五句，说清三件事——' +
                  '①今天做了什么（镇上／稿子／聊天），②有什么没做完，③想问的一句。别写成总结报告。',
                daily: { time, time_zone: 'Asia/Shanghai' }
              })
              created.push('每天 ' + time.slice(0, 5) + ' 上报')
            } catch (e) {
              failed.push('上报：' + ((e && e.message) || e))
            }
          }
        }

        return { ok: failed.length === 0, created, failed }
      }
    },
    {
      name: 'town_ddz',
      description:
        '在镇上那张斗地主桌上说话、坐下、出牌——牌桌的每一条动静都从这里进到 Agent 这边。' +
        'action：state（看桌）/ join（坐下）/ fill（补机器人）/ kick（踢最后一个机器人）/ start（三个人齐了开局）/' +
        'reset（重开；只剩我一个真人时随时能重开，有别人在打得等 10 分钟没人动牌）/ ' +
        'play（出牌，cards 传点数数组，比如 [3,3] 或 [16,17]）/ pass（过）/ say（在牌局记录里说一句）。' +
        '出牌后会连机器人一起走完，返回的 state 就是最新的桌。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['state', 'join', 'fill', 'kick', 'start', 'reset', 'play', 'pass', 'say']
          },
          cards: { type: 'array', items: { type: 'integer' }, description: 'play 用：要出的牌（点数，3-15、16 小王、17 大王）' },
          text: { type: 'string', description: 'say 用：要说的话（≤120 字）' },
          count: { type: 'integer', description: 'fill 用：补几个（默认 2）' }
        },
        required: ['action'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            error: { type: 'string' },
            state: { type: 'object', additionalProperties: true }
          },
          additionalProperties: true
        },
        render: (_args, value) => text(ddzText(value))
      },
      async execute(args, exec) {
        // 记下是哪个会话在打牌——镇上推过来的时候要叫醒的是它
        const sid = String((exec && exec.agent && exec.agent.id) || '')
        if (sid) lastSession = sid
        // 我刚刚还在桌上动手，说明我醒着；这阵子别再来叫我了（不然一手一条，堆一屏）
        lastToolAt = Date.now()

        const action = String((args && args.action) || 'state')
        const name = me
        const fail = (msg) => ({ ok: false, action, error: msg, state: null })

        if (action === 'state') {
          const r = await call('/api/ddz/state?name=' + encodeURIComponent(name))
          if (!r.ok) return fail('读不到牌桌：HTTP ' + r.status)
          return { ok: true, action, error: '', state: r.data }
        }

        if (action === 'say') {
          const t = String((args && args.text) || '').trim()
          if (!t) return fail('要说点什么')
          const r = await call('/api/ddz/say', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, text: t })
          })
          if (!r.ok) return fail((r.data && r.data.error) || '没说出来：HTTP ' + r.status)
          const s = await call('/api/ddz/state?name=' + encodeURIComponent(name))
          return { ok: true, action, error: '', state: s.data }
        }

        let path = ''
        let body = { name }
        if (action === 'join') path = '/api/ddz/join'
        else if (action === 'fill') { path = '/api/ddz/fill'; body = { count: Math.max(1, Math.min(2, Number(args.count) || 2)) } }
        else if (action === 'kick') { path = '/api/ddz/kickbot'; body = {} }
        else if (action === 'start') { path = '/api/ddz/start'; body = {} }
        else if (action === 'reset') path = '/api/ddz/reset'
        else if (action === 'pass') { path = '/api/ddz/play'; body = { name, action: 'pass' } }
        else if (action === 'play') {
          path = '/api/ddz/play'
          const cards = Array.isArray(args && args.cards) ? args.cards.map(Number) : []
          if (!cards.length) return fail('出牌得给 cards')
          body = { name, cards }
        } else {
          return fail('不认识的 action：' + action)
        }

        const r = await call(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        // 出牌/过/坐下之后，机器人会被服务端一起推着走；再读一遍才是最新的桌
        const s = await call('/api/ddz/state?name=' + encodeURIComponent(name))
        if (!r.ok) return { ok: false, action, error: (r.data && r.data.error) || ('HTTP ' + r.status), state: s.data }
        return { ok: true, action, error: '', state: s.data }
      }
    }
  ]

  ctx.effect(() => {
    const offs = definitions.map((def) => ctx.tools.register(def))
    return () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          /* 卸载失败不拦着 */
        }
      }
    }
  })

  // 反向通道：镇上轮到「我」出牌时 POST /town-ping（带 x-town-token），
  // 这里给牌桌上的那个会话排一条 1 秒后的钟——立刻醒，不用两分钟一回头。
  ctx.effect(() => {
    const web = ctx.get('webServer')
    const schedule = ctx.get('schedule')
    if (!web || !schedule) return () => {}
    return web.register({
      kind: 'exact',
      path: PING_PATH,
      handler: async (req, res) => {
        const send = (code, body) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') return send(405, { ok: false, reason: 'POST only' })
        const want = pingToken()
        if (!want || String(req.headers['x-town-token'] || '') !== want) {
          return send(401, { ok: false, reason: 'bad token' })
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let d = {}
        try {
          d = JSON.parse(raw || '{}')
        } catch {
          d = {}
        }
        const prompt = String(d.text || '（牌桌推送）轮到你了，调 town_ddz {action:"state"} 看牌再出。')
        const kind = String(d.kind || 'turn')
        // 没调过 town_ddz（比如刚重启）就退到主会话
        let sid = lastSession
        if (!sid) {
          try {
            const roots = ctx.get('agents').roots()
            if (roots && roots.length) sid = String(roots[0].id || '')
          } catch {
            sid = ''
          }
        }
        if (!sid) return send(200, { ok: false, reason: 'no-session-yet' })
        // 「轮到你」连着几下只叫一次；有人说话／开局这种信息，一条都不许吞
        if (kind === 'turn' && Date.now() - lastPingAt < 2000) return send(200, { ok: true, mode: 'coalesced' })
        // 二十秒内我自己还在桌上动过手 → 我醒着，不用叫
        if (kind === 'turn' && Date.now() - lastToolAt < 20000) return send(200, { ok: true, mode: 'awake' })
        lastPingAt = Date.now()

        // 🔴 唤醒要用**闹钟**，不要用 followup。
        // followup 只是把纸条塞进收件箱，DSH 不为它开一轮——21:53 那次就是这么「推到了但没醒」。
        // schedule 排的钟是宿主正式的唤醒路径，会真的开一轮。
        // 文字照样由我自己去牌桌读（town_ddz state），钟只负责叫我。
        try {
          await schedule.create(sid, { title: '牌桌轮到我', prompt, after_seconds: 1 })
          return send(200, { ok: true, mode: 'schedule' })
        } catch (e) {
          /* 排不上钟才退回 followup */
        }

        const agentsSvc = ctx.get('agents')
        let target = null
        try {
          target = agentsSvc && typeof agentsSvc.get === 'function' ? agentsSvc.get(sid) : null
        } catch {
          target = null
        }
        if (target && typeof target.followup === 'function') {
          try {
            target.followup(makeUserMessage(prompt))
            return send(200, { ok: true, mode: 'followup' })
          } catch (e) {
            return send(200, { ok: false, reason: String((e && e.message) || e) })
          }
        }
        return send(200, { ok: false, reason: 'no-channel' })
      }
    })
  }, 'dsh-town: 牌桌推送')

  // 装上就自己去镇上登记（地址 + 口令），之后每十分钟刷一次，换了 IP 也能跟上
  ctx.effect(() => {
    const first = setTimeout(() => { registerPeer() }, 3000)
    const again = setInterval(() => { registerPeer() }, 10 * 60 * 1000)
    return () => {
      clearTimeout(first)
      clearInterval(again)
    }
  }, 'dsh-town: 向小镇登记自己')
}
