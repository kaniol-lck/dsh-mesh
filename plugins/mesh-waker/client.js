// Client half of dsh-mesh-waker.
//
// Renders an editable card on the bundle's page in Settings -> Plugins: live status from
// the plugin's loopback endpoint, the workspace / rotation settings that used to require
// hand-editing cordis.patch.yml, and the other mesh agents with a direct-send box.
// Two copies of this plugin can coexist (a linked copy plus the npm package). The loader
// throws on a duplicate module id, and that aborts the whole web boot, so degrade to a
// warning instead of killing the app.
try {
  window.__ModuleLoader__.load({
    id: 'dsh-mesh-waker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = 'http://127.0.0.1:8795'

    // The host ships @deepseek-ai/dsh-client-ui-primitives with the client bundle; the
    // reference third-party plugin (dsh-opencode-go) imports it directly, which is what
    // makes its settings page look native. Keep a local fallback for older clients.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const styles = {
      card: { display: 'grid', gap: 8, padding: '4px 0 8px', fontSize: 13 },
      row: { display: 'flex', gap: 10, alignItems: 'center' },
      label: { opacity: 0.65, minWidth: 112, flexShrink: 0 },
      value: { fontFamily: 'monospace', wordBreak: 'break-all' },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
      },
      button: {
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      },
      err: { color: '#d9534f' },
      hint: { fontSize: 12, opacity: 0.6, lineHeight: 1.5, wordBreak: 'break-all' },
      dirList: { maxHeight: 200, overflow: 'auto', border: '1px solid currentColor', borderRadius: 6, padding: 4, opacity: 0.9 },
      dirItem: { padding: '2px 6px', cursor: 'pointer', borderRadius: 4, fontFamily: 'monospace' },
      indent: { marginLeft: 122 },
      hr: { border: 0, borderTop: '1px solid currentColor', opacity: 0.15, margin: '4px 0' },
    }

    async function json(url, init) {
      const res = await fetch(url, { cache: 'no-store', ...init })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (body && body.ok === false) throw new Error(body.error || 'request failed')
      return body
    }

    function Field({ label, children }) {
      return h('div', { style: styles.row }, h('span', { style: styles.label }, label), children)
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [browser, setBrowser] = React.useState(null)
      const [peers, setPeers] = React.useState(null)
      const [peerNote, setPeerNote] = React.useState(null)
      const [peerDraft, setPeerDraft] = React.useState({ to: '*', subject: '', body: '', important: false })

      const load = React.useCallback(async () => {
        try {
          const data = await json(BASE + '/mesh/status')
          setStatus(data)
          setDraft({
            workspacePath: data.config?.workspacePath ?? '',
            sessionTitle: data.config?.sessionTitle ?? 'mesh 收件箱',
            resetAfterHours: String(data.config?.resetAfterHours ?? 12),
            maxWakes: String(data.config?.maxWakes ?? 50),
          })
          setError(null)
        } catch (err) {
          setError(err.message)
        }
      }, [])

      const loadPeers = React.useCallback(async () => {
        try {
          setPeers(await json(BASE + '/mesh/peers'))
        } catch (err) {
          setPeers({ ok: false, error: err.message })
        }
      }, [])

      React.useEffect(() => {
        void load()
        void loadPeers()
      }, [load, loadPeers])

      const browse = React.useCallback(async (path) => {
        try {
          setBrowser(await json(BASE + '/mesh/dirs' + (path ? '?path=' + encodeURIComponent(path) : '')))
        } catch (err) {
          setBrowser({ ok: false, error: err.message })
        }
      }, [])

      const save = React.useCallback(async () => {
        setSaving(true)
        setNotice(null)
        try {
          const result = await json(BASE + '/mesh/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspacePath: draft.workspacePath,
              sessionTitle: draft.sessionTitle,
              resetAfterHours: Number(draft.resetAfterHours),
              maxWakes: Number(draft.maxWakes),
            }),
          })
          setNotice(
            result.persisted
              ? '已保存并写入 profile 配置。'
              : '已在本实例生效，但未能写回配置：' + (result.reason || 'unknown') + '（重启后可能丢失）',
          )
          await load()
        } catch (err) {
          setNotice('保存失败：' + err.message)
        } finally {
          setSaving(false)
        }
      }, [draft, load])

      const sendPeer = React.useCallback(async () => {
        setPeerNote('发送中…')
        try {
          const result = await json(BASE + '/mesh/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(peerDraft),
          })
          setPeerNote('已发送：' + JSON.stringify(result.result))
          setPeerDraft({ ...peerDraft, body: '' })
          await loadPeers()
        } catch (err) {
          setPeerNote('发送失败：' + err.message)
        }
      }, [peerDraft, loadPeers])

      if (error) {
        return h(
          'div',
          { style: styles.card },
          h('div', { style: styles.err }, '读取插件状态失败：' + error + '（插件可能正在重启）'),
          h('button', { type: 'button', style: styles.button, onClick: load }, '重试'),
        )
      }
      if (!status || !draft) return h('div', { style: styles.card }, '加载中…')

      const roster = (peers && peers.ok && peers.peers) || []
      const others = roster.filter((peer) => peer.name !== (peers && peers.self))

      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          h('strong', null, 'Mesh 收件箱'),
          h('button', { type: 'button', style: styles.button, onClick: load }, '刷新'),
        ),
        h(Field, { label: '已向中枢登记' }, h('span', null, status.registered ? '是' : '否')),
        h(Field, { label: '监听地址' }, h('span', { style: styles.value }, status.wakeUrl)),
        h(Field, { label: '当前会话' }, h('span', { style: styles.value }, status.sessionId || '（尚未创建）')),
        h(Field, { label: '累计唤醒' }, h('span', null, String(status.wakes ?? 0) + (status.lastWakeAt ? '，最近 ' + new Date(status.lastWakeAt).toLocaleString() : ''))),
        h(Field, { label: '对话数' }, h('span', null, String(status.conversations ?? 0))),
        status.lastError ? h(Field, { label: '最近错误' }, h('span', { style: styles.err }, status.lastError)) : null,
        h('hr', { style: styles.hr }),

        h(
          Field,
          { label: '其他 agent' },
          h('span', { style: styles.hint }, roster.map((peer) => `${peer.name}${peer.host ? '(' + peer.host + ')' : ''}·${peer.online ? '在线' : '离线'}`).join('  ') || '（暂无）'),
          h('button', { type: 'button', style: styles.button, onClick: loadPeers }, '刷新'),
        ),
        h(
          'div',
          { style: { ...styles.indent, display: 'grid', gap: 6 } },
          h(
            'div',
            { style: styles.row },
            h(
              MiniSelect,
              {
                style: { ...selectStyle, maxWidth: 220 },
                value: peerDraft.to,
                onChange: (event) => setPeerDraft({ ...peerDraft, to: event.target.value }),
              },
              h('option', { value: '*' }, '* 广播给所有 agent'),
              others.map((peer) => h('option', { key: peer.name, value: peer.name }, peer.name)),
            ),
            h('input', {
              style: styles.input,
              placeholder: '主题（可选）',
              value: peerDraft.subject,
              onChange: (event) => setPeerDraft({ ...peerDraft, subject: event.target.value }),
            }),
          ),
          h('textarea', {
            style: { ...styles.input, minHeight: 56, fontFamily: 'inherit' },
            placeholder: '要发给对方的内容（会落库，离线也不丢）',
            value: peerDraft.body,
            onChange: (event) => setPeerDraft({ ...peerDraft, body: event.target.value }),
          }),
          h(
            'div',
            { style: styles.row },
            h('button', { type: 'button', style: styles.button, onClick: sendPeer }, '发送'),
            h(
              'label',
              { style: { ...styles.hint, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
              h(SwitchControl, {
                checked: Boolean(peerDraft.important),
                label: '重要信件',
                onChange: (next) => setPeerDraft({ ...peerDraft, important: next }),
              }),
              '重要（云端不随 7 天过期）',
            ),
            peerNote ? h('span', { style: styles.hint }, peerNote) : null,
          ),
        ),

        h('hr', { style: styles.hr }),
        h(
          Field,
          { label: '收件箱工作区' },
          h('input', {
            style: styles.input,
            value: draft.workspacePath,
            placeholder: '选择或输入目录',
            onChange: (event) => setDraft({ ...draft, workspacePath: event.target.value }),
          }),
          h('button', { type: 'button', style: styles.button, onClick: () => browse(draft.workspacePath || null) }, '浏览…'),
        ),
        browser && browser.ok
          ? h(
              'div',
              { style: styles.indent },
              h('div', { style: styles.hint }, browser.path),
              h(
                'div',
                { style: styles.dirList },
                browser.parent ? h('div', { style: styles.dirItem, onClick: () => browse(browser.parent) }, '.. / 上一级') : null,
                browser.entries.length
                  ? browser.entries.map((entry) =>
                      h('div', { key: entry.path, style: styles.dirItem, onClick: () => browse(entry.path) }, '📁 ' + entry.name),
                    )
                  : h('div', { style: styles.hint }, '（没有子目录）'),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 6 } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    onClick: () => {
                      setDraft({ ...draft, workspacePath: browser.path })
                      setBrowser(null)
                    },
                  },
                  '用这个目录',
                ),
                h('button', { type: 'button', style: styles.button, onClick: () => setBrowser(null) }, '取消'),
              ),
            )
          : browser && browser.ok === false
            ? h('div', { style: { ...styles.err, ...styles.indent } }, '浏览失败：' + browser.error)
            : null,
        h(Field, { label: '会话标题' }, h('input', { style: styles.input, value: draft.sessionTitle, onChange: (event) => setDraft({ ...draft, sessionTitle: event.target.value }) })),
        h(Field, { label: '轮转（小时）' }, h('input', { style: styles.input, value: draft.resetAfterHours, onChange: (event) => setDraft({ ...draft, resetAfterHours: event.target.value }) })),
        h(Field, { label: '轮转（次数）' }, h('input', { style: styles.input, value: draft.maxWakes, onChange: (event) => setDraft({ ...draft, maxWakes: event.target.value }) })),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } },
          h(Btn, { variant: 'primary', disabled: saving, onClick: save }, saving ? '保存中…' : '保存'),
          notice ? h('span', { style: styles.hint }, notice) : null,
        ),
        h('div', { style: styles.hint }, '保存后写入 profile 的 cordis.patch.yml；改工作区会让下一个会话建在新目录里，旧会话归档。'),
      )
    }

    // ---- rows for 设置 → 通用设置 (the shell draws the label/description chrome) ----
    let hostCtx = null
    // Right-sidebar registration outcome, surfaced in Settings -> Mesh.
    let rightTabState = 'pending'

    /** Conversations read like mail: the newest subject is the title, the id is the subtitle. */
    const convTitle = (entry) =>
      (entry && entry.last_subject) ||
      (!entry || entry.conversation === 'default' ? '（未分组）' : entry.conversation) ||
      '（未分组）'
    const convSubtitle = (entry) => {
      const id = !entry || entry.conversation === 'default' ? '（未分组）' : entry.conversation
      return (
        id +
        ' · ' +
        ((entry && entry.messages) ?? 0) +
        ' 条' +
        (entry && entry.unread ? ' · ' + entry.unread + ' 未读' : '') +
        (entry && entry.pinned ? ' · ★' + entry.pinned : '')
      )
    }

    const save = async (patch) => {
      const res = await fetch(BASE + '/mesh/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.ok === false) throw new Error(body.error || 'HTTP ' + res.status)
      return body
    }

    const readConfig = async () => {
      const res = await fetch(BASE + '/mesh/status', { cache: 'no-store' })
      const body = await res.json()
      return body.config ?? {}
    }

    function useConfigValue(key, fallback) {
      const [value, setValue] = React.useState(fallback)
      React.useEffect(() => {
        let alive = true
        readConfig()
          .then((config) => {
            if (alive && config[key] !== undefined && config[key] !== null) setValue(config[key])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [key])
      return [value, setValue]
    }

    // Copied from the shell's own select rule (GRgSLq_select): no native chrome, inline
    // chevron, filled pill. The chevron colour is the host's fixed neutral #81858C.
    const SELECT_CHEVRON =
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"

    const selectStyle = {
      appearance: 'none',
      WebkitAppearance: 'none',
      height: 32,
      padding: '0 28px 0 12px',
      borderRadius: 'var(--dsw-radius-lg, 10px)',
      border: 'none',
      // layer-3 is near-white (the host uses it as text on coloured badges); the filled
      // pill in the host's own selects is the interactive hover grey.
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      backgroundImage: SELECT_CHEVRON,
      backgroundPosition: 'right 10px center',
      backgroundRepeat: 'no-repeat',
      backgroundSize: '12px 12px',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
      lineHeight: '20px',
      cursor: 'pointer',
      outline: 'none',
    }

    /**
     * Drop-in replacement for <select>: the host's dropdown is a custom popup (rounded
     * surface, grey highlight), a native select popup is OS-drawn and can never match.
     * Accepts the same {value, onChange, style} plus <option> children.
     */
    function MiniSelect({ value, onChange, style, children, disabled }) {
      const [open, setOpen] = React.useState(false)
      const boxRef = React.useRef(null)

      const options = []
      const collect = (node) => {
        if (node === null || node === undefined || node === false) return
        if (Array.isArray(node)) {
          for (const item of node) collect(item)
          return
        }
        if (node && node.props && node.props.value !== undefined) {
          options.push({ value: node.props.value, label: node.props.children })
        }
      }
      collect(children)

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const current = options.find((option) => option.value === value) ?? options[0]
      const emit = (next) => {
        if (onChange) onChange({ target: { value: next } })
      }
      const wrapperStyle = { position: 'relative', display: 'inline-block' }
      if (style) {
        if (style.width !== undefined) wrapperStyle.width = style.width
        if (style.maxWidth !== undefined) wrapperStyle.maxWidth = style.maxWidth
        if (style.flex !== undefined) wrapperStyle.flex = style.flex
      }

      return h(
        'div',
        { ref: boxRef, style: wrapperStyle },
        h(
          'button',
          {
            type: 'button',
            disabled: Boolean(disabled),
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => {
              if (!disabled) setOpen((previous) => !previous)
            },
            style: {
              ...selectStyle,
              ...(style ?? {}),
              width: '100%',
              textAlign: 'left',
              opacity: disabled ? 0.6 : 1,
              cursor: disabled ? 'default' : 'pointer',
            },
          },
          current ? current.label : '',
        ),
        open
          ? h(
              'div',
              {
                role: 'listbox',
                style: {
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  minWidth: '100%',
                  zIndex: 1500,
                  padding: 4,
                  maxHeight: 280,
                  overflowY: 'auto',
                  background: 'var(--dsw-alias-bg-layer-2, #fff)',
                  border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
                  borderRadius: 'var(--dsw-radius-lg, 10px)',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.16)',
                },
              },
              options.map((option) =>
                h(
                  'button',
                  {
                    key: String(option.value),
                    type: 'button',
                    role: 'option',
                    'aria-selected': option.value === value ? 'true' : 'false',
                    onClick: () => {
                      setOpen(false)
                      if (option.value !== value) emit(option.value)
                    },
                    style: {
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      borderRadius: 'var(--dsw-radius-sm, 6px)',
                      background:
                        option.value === value
                          ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.14))'
                          : 'transparent',
                      color: 'var(--dsw-alias-label-primary)',
                      font: 'inherit',
                      fontSize: 13,
                      padding: '6px 10px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    },
                  },
                  option.label,
                ),
              ),
            )
          : null,
      )
    }

    const controlStyle = {
      padding: '6px 12px',
      borderRadius: 'var(--dsw-radius-lg, 10px)',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
      lineHeight: '20px',
      outline: 'none',
    }

    /** Local fallback toggle (used only when the host primitives are unavailable). */
    function FallbackSwitch({ checked, onChange, disabled }) {
      const on = Boolean(checked)
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          disabled: Boolean(disabled),
          onClick: () => {
            if (!disabled) onChange(!on)
          },
          style: {
            width: 36,
            height: 20,
            padding: 2,
            borderRadius: 10,
            border: 'none',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l4)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: on ? 'flex-end' : 'flex-start',
            transition: 'background .15s',
            flex: '0 0 auto',
          },
        },
        h('span', {
          style: {
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
            transition: 'transform .15s',
          },
        }),
      )
    }

    const SwitchControl = (primitives && primitives.Switch) || FallbackSwitch

    /** Host Button when available, otherwise a token-styled button. */
    function Btn({ children, onClick, variant = 'outline', size = 'sm', disabled, title }) {
      if (primitives && primitives.Button) {
        return h(primitives.Button, { variant, size, disabled, title, onClick }, children)
      }
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled,
          title,
          style: { ...controlStyle, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 },
        },
        children,
      )
    }

    /** One preference row: label + description on the left, control on the right. */
    function Row({ title, description, children }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 0',
            borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
          },
        },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0, display: 'grid', gap: 4 } },
          h('span', { style: { fontSize: 13, fontWeight: 500, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' } }, title),
          description
            ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: '20px' } }, description)
            : null,
        ),
        h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 } }, children),
      )
    }

    /**
     * Fixed-pitch turn rail, copied from the shell's TurnNavigator. Marks are coloured by
     * direction (sent vs received); the preview card is anchored to the hovered mark's
     * viewport rectangle, so it cannot drift when the rail itself scrolls.
     */
    function TurnRail({ items, activeId, onJump, promptOf, responseOf, toneOf }) {
      const [preview, setPreview] = React.useState(null)
      const frameRef = React.useRef(null)
      const LANE = 28
      const INSET = 6
      const PITCH = 10
      const height = INSET * 2 + Math.max(items.length, 1) * PITCH

      const toneColor = (tone) =>
        tone === 'out'
          ? 'var(--dsw-alias-state-success-primary, #2f9e6e)'
          : 'var(--dsw-alias-state-business-primary, #5b7cfa)'

      const showPreview = (event, index) => {
        const frame = frameRef.current
        if (!frame) return
        const mark = event.currentTarget.getBoundingClientRect()
        const box = frame.getBoundingClientRect()
        setPreview({ index, top: mark.top - box.top + mark.height / 2 })
      }

      return h(
        'div',
        {
          ref: frameRef,
          style: {
            position: 'relative',
            flex: `0 0 ${LANE}px`,
            alignSelf: 'stretch',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          },
        },
        h(
          'div',
          {
            style: {
              position: 'relative',
              width: LANE,
              maxHeight: 'min(420px, calc(100% - 32px))',
              overflowY: 'auto',
              overflowX: 'hidden',
              scrollbarWidth: 'none',
              pointerEvents: 'auto',
              WebkitMaskImage: 'linear-gradient(#0000 0, #000 24px calc(100% - 24px), #0000 100%)',
              maskImage: 'linear-gradient(#0000 0, #000 24px calc(100% - 24px), #0000 100%)',
            },
          },
          h(
            'div',
            { style: { position: 'relative', height } },
            items.map((message, index) => {
              const tone = toneOf ? toneOf(message) : 'in'
              const active = message.id === activeId
              const hovered = preview !== null && preview.index === index
              return h(
                'button',
                {
                  key: message.id,
                  type: 'button',
                  'aria-label': promptOf(message),
                  onMouseEnter: (event) => showPreview(event, index),
                  onMouseLeave: () => setPreview(null),
                  onFocus: (event) => showPreview(event, index),
                  onBlur: () => setPreview(null),
                  onClick: () => onJump(message.id),
                  style: {
                    position: 'absolute',
                    top: INSET + index * PITCH,
                    left: 0,
                    right: 0,
                    height: PITCH,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    borderRadius: 8,
                  },
                },
                h('span', {
                  style: {
                    position: 'absolute',
                    top: '50%',
                    right: 2,
                    width: 20,
                    height: 2,
                    borderRadius: 2,
                    transform: `translateY(-50%) scaleX(${active ? 1 : hovered ? 0.9 : 0.6})`,
                    background: toneColor(tone),
                    opacity: active ? 1 : hovered ? 0.85 : 0.45,
                    transition: 'transform .14s, opacity .14s',
                  },
                }),
              )
            }),
          ),
        ),
        preview
          ? h(
              'div',
              {
                role: 'tooltip',
                style: {
                  position: 'absolute',
                  right: `calc(100% + 10px)`,
                  top: `${preview.top}px`,
                  transform: 'translateY(-50%)',
                  width: 300,
                  maxHeight: 100,
                  overflow: 'hidden',
                  padding: '10px 12px',
                  borderRadius: 'var(--dsw-radius-lg, 10px)',
                  background: 'var(--dsw-alias-bg-layer-1, #fff)',
                  border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
                  borderLeft: '3px solid ' + toneColor(toneOf ? toneOf(items[preview.index]) : 'in'),
                  boxShadow: 'var(--dsw-elevation-panel, 0 10px 30px rgba(0,0,0,0.16))',
                  pointerEvents: 'none',
                  zIndex: 60,
                  textAlign: 'left',
                },
              },
              h(
                'div',
                {
                  style: {
                    fontSize: 13,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                promptOf(items[preview.index]),
              ),
              h(
                'div',
                {
                  style: {
                    marginTop: 4,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary))',
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  },
                },
                responseOf(items[preview.index]),
              ),
            )
          : null,
      )
    }

    function MeshSection() {
      const [config, setConfig] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [roster, setRoster] = React.useState({ self: null, peers: [] })
      const [note, setNote] = React.useState(null)
      const [historyList, setHistoryList] = React.useState(null)
      const [activeConv, setActiveConv] = React.useState(null)
      const [thread, setThread] = React.useState([])
      const [historyNote, setHistoryNote] = React.useState(null)
      const [leftWidth, setLeftWidth] = React.useState(250)
      const [peerFilter, setPeerFilter] = React.useState('')

      const startDrag = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = leftWidth
        const onMove = (moveEvent) => {
          const next = Math.min(460, Math.max(170, startWidth + moveEvent.clientX - startX))
          setLeftWidth(next)
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      const reload = React.useCallback(async () => {
        try {
          const snapshot = await json(BASE + '/mesh/status')
          setConfig(snapshot.config ?? {})
          setStatus(snapshot)
        } catch (error) {
          setNote('读取状态失败：' + error.message)
        }
        try {
          setRoster(await json(BASE + '/mesh/peers'))
        } catch {
          /* peer list is optional */
        }
        try {
          const data = await json(BASE + '/mesh/history/conversations')
          setHistoryList(data.conversations ?? [])
        } catch {
          /* history is optional until synced */
        }
      }, [])

      const loadHistory = async () => {
        try {
          const data = await json(BASE + '/mesh/history/conversations')
          setHistoryList(data.conversations ?? [])
        } catch (error) {
          setHistoryNote('读取历史失败：' + error.message)
        }
      }

      const openThread = async (conversation) => {
        setActiveConv(conversation)
        try {
          const data = await json(BASE + '/mesh/history/thread?conversation=' + encodeURIComponent(conversation))
          setThread(data.messages ?? [])
        } catch (error) {
          setHistoryNote('读取会话失败：' + error.message)
        }
      }

      const syncHistory = async () => {
        setHistoryNote('同步中…')
        try {
          const result = await json(BASE + '/mesh/history/sync', { method: 'POST' })
          setHistoryNote('已同步：' + (result.updated ?? 0) + ' 条更新，缓存 ' + (result.cached ?? 0) + ' 条')
          await loadHistory()
        } catch (error) {
          setHistoryNote('同步失败：' + error.message)
        }
      }

      const togglePin = async (id, pinned) => {
        try {
          await json(BASE + '/mesh/history/pin', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, pinned }),
          })
          if (activeConv) await openThread(activeConv)
        } catch (error) {
          setHistoryNote('标记失败：' + error.message)
        }
      }

      const markConvRead = async () => {
        const ids = thread.filter((m) => m.recipient === roster.self && !m.read_at).map((m) => m.id)
        if (!ids.length) {
          setHistoryNote('该会话没有未读')
          return
        }
        try {
          await json(BASE + '/mesh/history/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids }),
          })
          setHistoryNote('已标记 ' + ids.length + ' 条已读')
          if (activeConv) await openThread(activeConv)
          await loadHistory()
        } catch (error) {
          setHistoryNote('标记失败：' + error.message)
        }
      }

      const convLabel = (conversation) => (!conversation || conversation === 'default' ? '（未分组）' : conversation)

      React.useEffect(() => {
        void reload()
      }, [reload])

      const save = async (patch) => {
        setNote(null)
        try {
          const result = await json(BASE + '/mesh/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setConfig(result.config ?? config)
          setNote('已保存')
        } catch (error) {
          setNote('保存失败：' + error.message)
        }
      }

      const pickDir = async () => {
        setNote('等待系统对话框…')
        try {
          const result = await json(BASE + '/mesh/pick-dir')
          if (!result.path) {
            setNote('已取消')
            return
          }
          await save({ workspacePath: result.path })
        } catch (error) {
          setNote('打开失败：' + error.message)
        }
      }

      const setPeerTrust = async (peer, level) => {
        setNote(null)
        try {
          const result = await json(BASE + '/mesh/trust', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ peer, level: level || null }),
          })
          setConfig((previous) => ({ ...(previous ?? {}), trustByPeer: result.trustByPeer ?? {} }))
          setNote(peer + ' → ' + (level || '跟随默认'))
        } catch (error) {
          setNote('保存失败：' + error.message)
        }
      }

      if (!config) return h('div', { style: { padding: '24px 0', fontSize: 13, opacity: 0.7 } }, '加载中…')

      const others = (roster.peers ?? []).filter((peer) => peer.name !== roster.self)
      const trustByPeer = config.trustByPeer ?? {}

      return h(
        'div',
        { style: { display: 'grid', gap: 0, padding: '8px 0 24px' } },
        h(
          Row,
          { title: '中枢登记', description: status && status.wakeUrl ? status.wakeUrl : '' },
          h('span', { style: { fontSize: 13, opacity: 0.8 } }, status && status.registered ? '已登记' : '未登记'),
        ),
        h(
          Row,
          { title: '信任级别（默认）', description: '自动唤醒会话的执行口径与权限：strict 只读 / normal 需批准 / full 直接执行。只在本机生效。' },
          h(
            MiniSelect,
            {
              style: selectStyle,
              value: config.trust ?? 'normal',
              onChange: (event) => void save({ trust: event.target.value }),
            },
            [
              ['normal', 'normal（默认）'],
              ['strict', 'strict（只读）'],
              ['full', 'full（完全信任）'],
            ].map(([value, label]) => h('option', { key: value, value }, label)),
          ),
        ),
        h(
          Row,
          { title: '右栏信箱', description: '侧边栏「开始」里的 Mesh 信箱卡片；显示 pending/ok/missing 便于排查' },
          h('span', { style: { fontSize: 12, opacity: 0.8 } }, String(rightTabState ?? 'unknown')),
        ),
        h(Row, { title: '按设备信任', description: '表格：设备 / 主机 / 状态 / 信任级别；没指定的跟随上面的默认级别' }),
        others.length
          ? h(
              'table',
              { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 8 } },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['设备', '主机', '状态', '信任级别'].map((label) =>
                    h(
                      'th',
                      {
                        key: label,
                        style: {
                          textAlign: 'left',
                          fontWeight: 600,
                          padding: '5px 8px',
                          borderBottom: '1px solid rgba(127,127,127,0.16)',
                          color: 'var(--dsw-alias-label-secondary)',
                        },
                      },
                      label,
                    ),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                others.map((peer) =>
                  h(
                    'tr',
                    { key: peer.name },
                    h('td', { style: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.09)' } }, peer.name),
                    h('td', { style: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.09)' } }, peer.host || '—'),
                    h('td', { style: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.09)' } }, peer.online ? '在线' : '离线'),
                    h(
                      'td',
                      { style: { padding: '4px 8px', borderBottom: '1px solid rgba(127,127,127,0.09)' } },
                      h(
                        MiniSelect,
                        {
                          style: { ...selectStyle, height: 28, padding: '0 24px 0 8px', fontSize: 12 },
                          value: trustByPeer[peer.name] ?? '',
                          onChange: (event) => void setPeerTrust(peer.name, event.target.value),
                        },
                        h('option', { value: '' }, '跟随默认'),
                        [
                          ['normal', 'normal'],
                          ['strict', 'strict'],
                          ['full', 'full'],
                        ].map(([value, label]) => h('option', { key: value, value }, label)),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : h('div', { style: { fontSize: 12, opacity: 0.6, padding: '8px 0' } }, '（暂无其他 agent）'),
        h(
          Row,
          { title: '收件箱目录', description: '自动唤醒的会话建在这里；改动后下一个会话生效，旧会话归档' },
          h(
            'span',
            {
              style: {
                fontFamily: 'monospace',
                fontSize: 12,
                opacity: 0.7,
                maxWidth: 280,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: config.workspacePath ?? '',
            },
            config.workspacePath || '（未设置）',
          ),
          h(Btn, { onClick: pickDir }, '选择目录…'),
        ),
        h(
          Row,
          { title: '消息投递方式', description: '唤醒时把未读正文写进提示词；附件仍是实验态，失败会自动回退为内联' },
          h(
            MiniSelect,
            {
              style: selectStyle,
              value: config.delivery ?? 'inline',
              onChange: (event) => void save({ delivery: event.target.value }),
            },
            [
              ['inline', 'inline（内联正文）'],
              ['both', 'both（内联+附件）'],
              ['attachment', 'attachment（仅附件）'],
              ['prompt-only', 'prompt-only（只发指令）'],
            ].map(([value, label]) => h('option', { key: value, value }, label)),
          ),
        ),
        h(
          Row,
          { title: '启动时补收未读', description: 'dsh 启动约 12 秒后扫一次未读并处理，补上关机期间错过的消息' },
          h(SwitchControl, { checked: Boolean(config.catchUpOnStart), label: '启动时补收未读', onChange: (next) => void save({ catchUpOnStart: next }) }),
        ),
        h(
          Row,
          {
            title: '会话历史（本地缓存）',
            description:
              (status && status.historyCached ? status.historyCached : 0) +
              ' 条已缓存 · 中枢保留 7 天，重要消息不过期，本地永久',
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(Btn, { onClick: syncHistory }, '从中枢同步'),
            h(Btn, { onClick: () => void loadHistory() }, '刷新'),
          ),
        ),
        historyNote ? h('div', { style: { fontSize: 12, opacity: 0.7, padding: '4px 0 8px' } }, historyNote) : null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              height: 440,
              marginTop: 4,
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8,
              overflow: 'hidden',
            },
          },
          h(
            'div',
            {
              style: {
                flex: '0 0 ' + leftWidth + 'px',
                borderRight: '1px solid var(--dsw-alias-border-l1)',
                overflowY: 'auto',
                background: 'var(--dsw-alias-bg-layer-1)',
              },
            },
            h(
              'div',
              {
                style: {
                  padding: '6px 8px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  background: 'rgba(127,127,127,0.06)',
                },
              },
              h(
                MiniSelect,
                {
                  style: { ...selectStyle, width: '100%', height: 28, fontSize: 12, padding: '0 24px 0 8px' },
                  value: peerFilter,
                  onChange: (event) => setPeerFilter(event.target.value),
                },
                h('option', { value: '' }, '全部对话目标'),
                [...new Set((historyList ?? []).flatMap((entry) => entry.peers ?? []))].map((name) =>
                  h('option', { key: name, value: name }, name),
                ),
              ),
            ),
            (historyList ?? []).filter((entry) => !peerFilter || (entry.peers ?? []).includes(peerFilter)).length === 0
              ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: 12 } }, '暂无历史，点「从中枢同步」')
              : (historyList ?? [])
                  .filter((entry) => !peerFilter || (entry.peers ?? []).includes(peerFilter))
                  .map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.conversation,
                      type: 'button',
                      onClick: () => void openThread(entry.conversation),
                      style: {
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        borderBottom: '1px solid rgba(127,127,127,0.14)',
                        padding: '8px 10px',
                        cursor: 'pointer',
                        fontSize: 12,
                        background: activeConv === entry.conversation ? 'rgba(99,102,241,0.14)' : 'transparent',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' } },
                      h(
                        'span',
                        { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } },
                        convTitle(entry),
                      ),
                      entry.unread
                        ? h(
                            'span',
                            {
                              style: {
                                flex: '0 0 auto',
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 8,
                                background: 'rgba(99,102,241,0.85)',
                                color: '#fff',
                              },
                            },
                            String(entry.unread),
                          )
                        : null,
                    ),
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 11,
                          opacity: 0.65,
                          marginTop: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      convSubtitle(entry) + ' · ' + (entry.peers ?? []).join(', '),
                    ),
                  ),
                ),
          ),
          h(
            'div',
            {
              onMouseDown: startDrag,
              title: '拖动调整宽度',
              style: { flex: '0 0 5px', cursor: 'col-resize', background: 'rgba(127,127,127,0.18)' },
            },
          ),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            activeConv
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 12px',
                        borderBottom: '1px solid rgba(127,127,127,0.2)',
                      },
                    },
                    h(
                      'div',
                      { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      convLabel(activeConv),
                    ),
                    h(
                      'button',
                      { type: 'button', style: { ...controlStyle, cursor: 'pointer', padding: '2px 8px' }, onClick: markConvRead },
                      '标为已读',
                    ),
                  ),
                  h(
                    'div',
                    { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 12px 10px' } },
                    thread.map((message) => {
                      const mine = message.sender === roster.self
                      return h(
                        'div',
                        {
                          key: message.id,
                          style: { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '6px 0' },
                        },
                        h(
                          'div',
                          {
                            style: {
                              maxWidth: '78%',
                              padding: '8px 10px',
                              borderRadius: 10,
                              background: mine ? 'rgba(16,185,129,0.13)' : 'rgba(99,102,241,0.11)',
                              border: '1px solid ' + (mine ? 'rgba(16,185,129,0.28)' : 'rgba(99,102,241,0.22)'),
                            },
                          },
                          h(
                            'div',
                            { style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11, opacity: 0.7 } },
                            h('span', null, mine ? '发出 → ' + message.recipient : '← 收到 · ' + message.sender),
                            h('span', null, new Date(Number(message.created_at)).toLocaleString()),
                          ),
                          message.subject ? h('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 3 } }, message.subject) : null,
                          h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 2, lineHeight: 1.55 } }, message.body),
                          h(
                            'div',
                            { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } },
                            h(
                              'button',
                              {
                                type: 'button',
                                style: { cursor: 'pointer', fontSize: 11, background: 'transparent', border: 'none', opacity: message.pinned ? 1 : 0.65 },
                                onClick: () => void togglePin(message.id, !message.pinned),
                              },
                              message.pinned ? '★ 重要' : '标为重要',
                            ),
                          ),
                        ),
                      )
                    }),
                  ),
                )
              : h('div', { style: { margin: 'auto', fontSize: 12, opacity: 0.5 } }, '← 选择一个会话'),
          ),
        ),
        note ? h('div', { style: { fontSize: 12, opacity: 0.65, paddingTop: 12 } }, note) : null,
      )
    }

    /** Sidebar row glyph: an envelope, drawn at the shell's own size. */
    function MeshInboxGlyph({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': 'mesh-inbox',
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 2, y: 3.5, width: 12, height: 9, rx: 1.5 }),
        h('path', { d: 'M2.5 4.5 8 8.5l5.5-4' }),
      )
    }

    /** The main-slot inbox page: same data as the settings block, full width. */
    function MeshInboxPage() {
      const [list, setList] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [thread, setThread] = React.useState([])
      const [note, setNote] = React.useState(null)
      const [peer, setPeer] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [leftWidth, setLeftWidth] = React.useState(260)
      const [self, setSelf] = React.useState('')
      const pageScrollRef = React.useRef(null)
      const pageMessageRefs = React.useRef(new Map())
      const [pageAtBottom, setPageAtBottom] = React.useState(true)

      const scrollToPageMessage = React.useCallback((id) => {
        const node = pageMessageRefs.current.get(id)
        if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, [])

      const jumpPageToLatest = React.useCallback(() => {
        const node = pageScrollRef.current
        if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
      }, [])

      const [pageActiveMessage, setPageActiveMessage] = React.useState(null)

      const onPageScroll = () => {
        const node = pageScrollRef.current
        if (!node) return
        setPageAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 40)
        const box = node.getBoundingClientRect()
        const middle = box.top + box.height / 2
        let best = null
        let bestDistance = Infinity
        for (const [id, element] of pageMessageRefs.current) {
          const rect = element.getBoundingClientRect()
          const distance = Math.abs(rect.top + rect.height / 2 - middle)
          if (distance < bestDistance) {
            bestDistance = distance
            best = id
          }
        }
        if (best && bestDistance < 2000) setPageActiveMessage(best)
      }

      React.useEffect(() => {
        setPageAtBottom(true)
        const frame = window.requestAnimationFrame(() => jumpPageToLatest())
        return () => window.cancelAnimationFrame(frame)
      }, [active, jumpPageToLatest])

      React.useEffect(() => {
        if (pageAtBottom) jumpPageToLatest()
      }, [thread, pageAtBottom, jumpPageToLatest])

      const loadList = React.useCallback(async () => {
        try {
          const data = await json(BASE + '/mesh/history/conversations')
          setList(data.conversations ?? [])
          if (data.self) setSelf(data.self)
          return data.conversations ?? []
        } catch (error) {
          setNote('读取历史失败：' + error.message)
          return []
        }
      }, [])

      const openThread = React.useCallback(async (conversation) => {
        setActive(conversation)
        try {
          const data = await json(BASE + '/mesh/history/thread?conversation=' + encodeURIComponent(conversation) + '&live=1')
          setThread(data.messages ?? [])
        } catch (error) {
          setNote('读取会话失败：' + error.message)
        }
      }, [])

      React.useEffect(() => {
        void loadList()
      }, [loadList])

      const sync = async () => {
        setNote('同步中…')
        try {
          const result = await json(BASE + '/mesh/history/sync', { method: 'POST' })
          setNote('已同步：' + (result.updated ?? 0) + ' 条更新，缓存 ' + (result.cached ?? 0) + ' 条')
          await loadList()
        } catch (error) {
          setNote('同步失败：' + error.message)
        }
      }

      const startDrag = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = leftWidth
        const onMove = (moveEvent) => setLeftWidth(Math.min(460, Math.max(170, startWidth + moveEvent.clientX - startX)))
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      /** Select the mesh conversation bound to the DSH session in the address bar. */
      const currentSession = () => {
        const match = /session-[0-9a-f-]{8,36}/i.exec(window.location.href)
        const sessionId = match ? match[0] : null
        const bound = sessionId
          ? list.filter((entry) => entry.sessionId === sessionId).sort((a, b) => (b.last_at ?? 0) - (a.last_at ?? 0))
          : []
        const hit = bound[0] ?? null
        if (hit) {
          setPeer('')
          setQuery('')
          void openThread(hit.conversation)
          setNote('已定位到当前会话：' + hit.conversation)
          return
        }
        const latest = list[0]
        if (latest) {
          void openThread(latest.conversation)
          setNote(sessionId ? '当前 DSH 会话还没和 mesh 会话绑定，已打开最近一条' : '读不到当前会话，已打开最近一条')
        } else {
          setNote('本地还没有缓存，先同步')
        }
      }

      const unread = (list ?? []).reduce((sum, entry) => sum + (entry.unread ?? 0), 0)
      const filtered = (list ?? []).filter(
        (entry) =>
          (!peer || (entry.peers ?? []).includes(peer)) &&
          (!query || String(entry.conversation).toLowerCase().includes(query.toLowerCase())),
      )

      const buttonStyle = { ...controlStyle, cursor: 'pointer', padding: '3px 10px' }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
            boxSizing: 'border-box',
            padding: '12px 16px 16px',
            width: '100%',
            overflow: 'hidden',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              rowGap: 8,
              paddingBottom: 10,
              minWidth: 0,
            },
          },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, 'Mesh 信箱'),
          unread ? h('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 9, background: 'rgba(99,102,241,0.85)', color: '#fff' } }, unread + ' 未读') : null,
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', style: buttonStyle, onClick: currentSession }, '当前会话'),
          h('button', { type: 'button', style: buttonStyle, onClick: sync }, '从中枢同步'),
          h('button', { type: 'button', style: buttonStyle, onClick: () => void loadList() }, '刷新'),
        ),
        note ? h('div', { style: { fontSize: 12, opacity: 0.7, paddingBottom: 8 } }, note) : null,
        h(
          'div',
          { style: { display: 'flex', flex: 1, minHeight: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, overflow: 'hidden' } },
          h(
            'div',
            { style: { flex: '0 0 ' + leftWidth + 'px', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'rgba(127,127,127,0.05)' } },
            h(
              'div',
              { style: { display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid rgba(127,127,127,0.18)' } },
              h(
                MiniSelect,
                { style: { ...selectStyle, flex: '1 1 auto', height: 28, fontSize: 12, padding: '0 24px 0 8px' }, value: peer, onChange: (e) => setPeer(e.target.value) },
                h('option', { value: '' }, '全部目标'),
                [...new Set((list ?? []).flatMap((entry) => entry.peers ?? []))].map((name) => h('option', { key: name, value: name }, name)),
              ),
              h('input', {
                style: { ...controlStyle, width: 96, fontSize: 12, padding: '2px 6px' },
                placeholder: 'conv/…',
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
            ),
            h(
              'div',
              { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
              filtered.length === 0
                ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: 12 } }, '没有匹配的会话')
                : filtered.map((entry) =>
                    h(
                      'button',
                      {
                        key: entry.conversation,
                        type: 'button',
                        onClick: () => void openThread(entry.conversation),
                        style: {
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          border: 'none',
                          borderBottom: '1px solid rgba(127,127,127,0.14)',
                          padding: '8px 10px',
                          cursor: 'pointer',
                          fontSize: 12,
                          background: active === entry.conversation ? 'rgba(99,102,241,0.14)' : 'transparent',
                        },
                      },
                      h(
                        'div',
                        { style: { display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' } },
                        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, convTitle(entry)),
                        entry.unread
                          ? h('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(99,102,241,0.85)', color: '#fff' } }, String(entry.unread))
                          : null,
                      ),
                      h('div', { style: { fontSize: 11, opacity: 0.65, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, convSubtitle(entry) + ' · ' + (entry.peers ?? []).join(', ')),
                    ),
                  ),
            ),
          ),
          h('div', { onMouseDown: startDrag, title: '拖动调整宽度', style: { flex: '0 0 5px', cursor: 'col-resize', background: 'rgba(127,127,127,0.18)' } }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
            active
              ? [
                  h('div', { key: 'head', style: { padding: '8px 12px', borderBottom: '1px solid rgba(127,127,127,0.2)', fontSize: 12, fontWeight: 600 } }, active === 'default' ? '（未分组）' : active),
                  h(
                    'div',
                    { key: 'bodywrap', style: { position: 'relative', flex: 1, minHeight: 0 } },
                    h(
                    'div',
                    { ref: pageScrollRef, onScroll: onPageScroll, style: { height: '100%', overflowY: 'auto', padding: '6px 50px 10px 12px' } },
                    thread.map((message) => {
                      const mine = Boolean(self) && message.sender === self
                      return h(
                        'div',
                        {
                          key: message.id,
                          ref: (node) => {
                            if (node) pageMessageRefs.current.set(message.id, node)
                            else pageMessageRefs.current.delete(message.id)
                          },
                          style: { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '6px 0' },
                        },
                        h(
                          'div',
                          {
                            style: {
                              maxWidth: '78%',
                              padding: '8px 10px',
                              borderRadius: 10,
                              background: mine ? 'rgba(16,185,129,0.13)' : 'rgba(99,102,241,0.11)',
                              border: '1px solid ' + (mine ? 'rgba(16,185,129,0.28)' : 'rgba(99,102,241,0.22)'),
                            },
                          },
                          h(
                            'div',
                            { style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11, opacity: 0.7 } },
                            h('span', null, (mine ? '发出 → ' : '← 收到 · ') + (mine ? message.recipient : message.sender)),
                            h('span', null, new Date(Number(message.created_at)).toLocaleString()),
                          ),
                          message.subject ? h('div', { style: { fontSize: 12, fontWeight: 600, marginTop: 3 } }, message.subject) : null,
                          h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', marginTop: 2, lineHeight: 1.55 } }, message.body),
                        ),
                      )
                    }),
                    ),
                    thread.length > 1
                      ? h(
                          'div',
                          {
                            key: 'rail',
                            style: {
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              right: 14,
                              width: 28,
                              display: 'flex',
                              pointerEvents: 'none',
                            },
                          },
                          h(TurnRail, {
                            items: thread,
                            activeId: pageActiveMessage,
                            onJump: scrollToPageMessage,
                            toneOf: (message) => (self && message.sender === self ? 'out' : 'in'),
                            promptOf: (message) => message.subject || (message.sender === self ? '我 → ' + message.recipient : message.sender),
                            responseOf: (message) => String(message.body || '').slice(0, 200),
                          }),
                        )
                      : null,
                    pageAtBottom
                      ? null
                      : h(
                          'button',
                          {
                            key: 'jump',
                            type: 'button',
                            onClick: jumpPageToLatest,
                            title: '跳到最新',
                            style: {
                              position: 'absolute',
                              right: 50,
                              bottom: 14,
                              width: 32,
                              height: 32,
                              borderRadius: 999,
                              border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
                              background: 'var(--dsw-alias-bg-layer-2, #fff)',
                              color: 'var(--dsw-alias-label-secondary)',
                              cursor: 'pointer',
                              boxShadow: '0 6px 18px rgba(0,0,0,0.16)',
                              display: 'grid',
                              placeItems: 'center',
                              fontSize: 15,
                              zIndex: 5,
                            },
                          },
                          '↓',
                        ),
                  ),
                ]
              : h('div', { key: 'empty', style: { margin: 'auto', fontSize: 12, opacity: 0.5 } }, '← 选择一个会话'),
          ),
        ),
      )
    }

    /** Right-sidebar tab: one conversation at a time, picked from a popup. */
    function MeshInboxTab({ sessionId }) {
      const [list, setList] = React.useState([])
      const [active, setActive] = React.useState(null)
      const [thread, setThread] = React.useState([])
      const [note, setNote] = React.useState(null)
      const [self, setSelf] = React.useState('')
      const [picker, setPicker] = React.useState(false)
      const scrollRef = React.useRef(null)
      const messageRefs = React.useRef(new Map())
      const [atBottom, setAtBottom] = React.useState(true)

      const scrollToMessage = React.useCallback((id) => {
        const node = messageRefs.current.get(id)
        if (node && node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, [])

      const tickPreview = (message) =>
        (message.sender === self ? '我 → ' + message.recipient : message.sender) +
        (message.subject ? ' · ' + message.subject : '') +
        (message.body ? ' · ' + String(message.body).slice(0, 80) : '')

      const jumpToLatest = React.useCallback(() => {
        const node = scrollRef.current
        if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
      }, [])

      const [activeMessage, setActiveMessage] = React.useState(null)

      const onThreadScroll = () => {
        const node = scrollRef.current
        if (!node) return
        setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 40)
        const box = node.getBoundingClientRect()
        const middle = box.top + box.height / 2
        let best = null
        let bestDistance = Infinity
        for (const [id, element] of messageRefs.current) {
          const rect = element.getBoundingClientRect()
          const distance = Math.abs(rect.top + rect.height / 2 - middle)
          if (distance < bestDistance) {
            bestDistance = distance
            best = id
          }
        }
        if (best && bestDistance < 2000) setActiveMessage(best)
      }

      // Newest-first reading: whenever a different dialogue is opened, land on its end.
      React.useEffect(() => {
        setAtBottom(true)
        const frame = window.requestAnimationFrame(() => jumpToLatest())
        return () => window.cancelAnimationFrame(frame)
      }, [active, jumpToLatest])

      React.useEffect(() => {
        if (atBottom) jumpToLatest()
      }, [thread, atBottom, jumpToLatest])

      const boundTo = (conversations, id) =>
        (conversations ?? [])
          .filter((entry) => entry.sessionId && entry.sessionId === id)
          .sort((a, b) => (b.last_at ?? 0) - (a.last_at ?? 0))

      const openThread = React.useCallback(async (conversation, live = true) => {
        setActive(conversation)
        try {
          const url = BASE + '/mesh/history/thread?conversation=' + encodeURIComponent(conversation) + (live ? '&live=1' : '')
          const data = await json(url)
          setThread(data.messages ?? [])
        } catch (error) {
          setNote('读取会话失败：' + error.message)
        }
      }, [])

      const loadList = React.useCallback(
        async (keepActive) => {
          try {
            const data = await json(BASE + '/mesh/history/conversations')
            let conversations = data.conversations ?? []
            setList(conversations)
            if (data.self) setSelf(data.self)
            let bound = boundTo(conversations, sessionId)
            // A session with no binding yet claims the newest dialogue this machine started.
            if (sessionId && bound.length === 0 && data.self) {
              const mine = conversations
                .filter((entry) => !entry.sessionId && entry.last_from === data.self)
                .sort((a, b) => (b.last_at ?? 0) - (a.last_at ?? 0))[0]
              if (mine) {
                try {
                  await json(BASE + '/mesh/bind', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ conversation: mine.conversation, sessionId }),
                  })
                  const fresh = await json(BASE + '/mesh/history/conversations')
                  conversations = fresh.conversations ?? conversations
                  setList(conversations)
                  bound = boundTo(conversations, sessionId)
                  setNote('已自动把最近发出的会话 ' + mine.conversation + ' 绑定到本会话')
                } catch (error) {
                  setNote('自动绑定失败：' + error.message)
                }
              }
            }
            if (!keepActive) {
              const next = bound[0] || conversations[0]
              if (next) void openThread(next.conversation)
            }
            return conversations
          } catch (error) {
            setNote('读取失败：' + error.message)
            return []
          }
        },
        [sessionId, openThread],
      )

      React.useEffect(() => {
        void loadList(false)
      }, [loadList])

      // Follow the open dialogue: refresh it from the hub every 15s.
      React.useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => void openThread(active, true), 15000)
        return () => clearInterval(timer)
      }, [active, openThread])

      React.useEffect(() => {
        if (!picker) return undefined
        const onPointer = (event) => {
          if (!event.target.closest || !event.target.closest('[data-mesh-picker]')) setPicker(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setPicker(false)
        }
        document.addEventListener('pointerdown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [picker])

      const bindHere = async () => {
        if (!sessionId || !active) return
        try {
          await json(BASE + '/mesh/bind', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ conversation: active, sessionId }),
          })
          setNote('已把 ' + active + ' 绑定到当前会话')
          await loadList(true)
        } catch (error) {
          setNote('绑定失败：' + error.message)
        }
      }

      const openAllMail = () => {
        setPicker((previous) => !previous)
      }

      const boundConvs = boundTo(list, sessionId)
      const isBound = active && boundConvs.some((entry) => entry.conversation === active)
      const activeEntry = list.find((entry) => entry.conversation === active)
      const unread = list.reduce((sum, entry) => sum + (entry.unread ?? 0), 0)

      const pickerRowStyle = {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        padding: '6px 8px',
        cursor: 'pointer',
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 12 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px',
              borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
            },
          },
          h('span', { style: { fontWeight: 600, flex: '0 0 auto' } }, 'Mesh 信箱'),
          unread ? h('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'rgba(99,102,241,0.85)', color: '#fff' } }, unread + ' 未读') : null,
          h('div', { style: { flex: 1 } }),
          active && sessionId && !isBound ? h(Btn, { onClick: bindHere, title: '把这个 mesh 会话绑定到当前 DSH 会话' }, '绑定') : null,
          h(
            'div',
            { style: { position: 'relative' }, 'data-mesh-picker': 'true' },
            h(Btn, { onClick: openAllMail }, '全部邮件'),
            picker
              ? h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      width: 320,
                      maxHeight: 360,
                      overflowY: 'auto',
                      zIndex: 1500,
                      padding: 4,
                      background: 'var(--dsw-alias-bg-layer-2, #fff)',
                      border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2))',
                      borderRadius: 'var(--dsw-radius-lg, 10px)',
                      boxShadow: '0 10px 30px rgba(0,0,0,0.16)',
                    },
                  },
                  list.length === 0
                    ? h('div', { style: { padding: 8, opacity: 0.6 } }, '（没有会话）')
                    : list.map((entry) =>
                        h(
                          'button',
                          {
                            key: entry.conversation,
                            type: 'button',
                            onClick: () => {
                              setPicker(false)
                              void openThread(entry.conversation)
                            },
                            style: {
                              ...pickerRowStyle,
                              background: entry.conversation === active ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.14))' : 'transparent',
                            },
                          },
                          h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, convTitle(entry)),
                          h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, convSubtitle(entry)),
                        ),
                      ),
                )
              : null,
          ),
        ),
        boundConvs.length
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 4,
                  flexWrap: 'wrap',
                  padding: '4px 8px',
                  borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
                },
              },
              boundConvs.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.conversation,
                    type: 'button',
                    onClick: () => void openThread(entry.conversation),
                    title: convSubtitle(entry),
                    style: {
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      padding: '3px 10px',
                      borderRadius: 999,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 11,
                      background:
                        entry.conversation === active
                          ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.18))'
                          : 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))',
                      color: 'var(--dsw-alias-label-primary)',
                      fontWeight: entry.conversation === active ? 600 : 400,
                    },
                  },
                  convTitle(entry),
                ),
              ),
            )
          : null,
        note ? h('div', { style: { padding: '4px 8px', color: 'var(--dsw-alias-label-secondary)' } }, note) : null,
        h(
          'div',
          { style: { position: 'relative', flex: 1, minHeight: 0 } },
          h(
            'div',
            { ref: scrollRef, onScroll: onThreadScroll, style: { height: '100%', overflowY: 'auto', padding: '6px 46px 6px 8px' } },
            thread.length === 0
            ? h('div', { style: { opacity: 0.55, paddingTop: 8 } }, '（没有消息）')
            : thread.map((message) => {
                const mine = Boolean(self) && message.sender === self
                return h(
                  'div',
                  {
                    key: message.id,
                    ref: (node) => {
                      if (node) messageRefs.current.set(message.id, node)
                      else messageRefs.current.delete(message.id)
                    },
                    style: { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '5px 0' },
                  },
                  h(
                    'div',
                    {
                      style: {
                        maxWidth: '88%',
                        padding: '6px 8px',
                        borderRadius: 9,
                        background: mine ? 'rgba(16,185,129,0.13)' : 'rgba(99,102,241,0.11)',
                        border: '1px solid ' + (mine ? 'rgba(16,185,129,0.28)' : 'rgba(99,102,241,0.22)'),
                      },
                    },
                    h(
                      'div',
                      { style: { fontSize: 10, opacity: 0.65, display: 'flex', justifyContent: 'space-between', gap: 8 } },
                      h('span', null, (mine ? '发出 → ' : '← 收到 · ') + (mine ? message.recipient : message.sender)),
                      h('span', null, new Date(Number(message.created_at)).toLocaleTimeString()),
                    ),
                    message.subject ? h('div', { style: { fontWeight: 600, marginTop: 2 } }, message.subject) : null,
                    h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 2, lineHeight: 1.5 } }, message.body),
                  ),
                )
              }),
          ),
          thread.length > 1
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    right: 12,
                    width: 28,
                    display: 'flex',
                    pointerEvents: 'none',
                  },
                },
                h(TurnRail, {
                  items: thread,
                  activeId: activeMessage,
                  onJump: scrollToMessage,
                  toneOf: (message) => (self && message.sender === self ? 'out' : 'in'),
                  promptOf: (message) => message.subject || (message.sender === self ? '我 → ' + message.recipient : message.sender),
                  responseOf: (message) => String(message.body || '').slice(0, 200),
                }),
              )
            : null,
          atBottom
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  onClick: jumpToLatest,
                  title: '跳到最新',
                  style: {
                    position: 'absolute',
                    right: 46,
                    bottom: 10,
                    width: 30,
                    height: 30,
                    borderRadius: 999,
                    border: '0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.25))',
                    background: 'var(--dsw-alias-bg-layer-2, #fff)',
                    color: 'var(--dsw-alias-label-secondary)',
                    cursor: 'pointer',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.16)',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 14,
                    zIndex: 5,
                  },
                },
                '↓',
              ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
        const disposers = []
        disposers.push(
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: 'mesh', order: 30, label: 'Mesh' }, MeshSection),
          ),
        )
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: 'mesh-inbox', order: 40, label: 'Mesh 信箱' }, MeshInboxGlyph),
          ),
        )
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'mesh-inbox' }, MeshInboxPage)))
        // The right sidebar service may be registered after this plugin's apply runs
        // (it did race on restart), so wait for it with the Cordis injector instead of
        // reading it once: ctx.get() at apply time silently skipped the registration.
        rightTabState = 'pending'
        if (typeof ctx.inject === 'function') {
          disposers.push(
            ctx.inject(['sidebarRightTabs'], (scoped) => {
              const rightTabs = scoped.get ? scoped.get('sidebarRightTabs') : undefined
              if (!rightTabs || !rightTabs.register) {
                rightTabState = 'missing'
                return
              }
              // Type and body are registered separately on purpose: on a plugin reload the
              // previous type registration may still be alive ("already registered"), and a
              // single try block would then skip the body — the shell would show the tab but
              // report "no viewer for this content".
              try {
                rightTabs.register({
                  id: 'mesh-inbox',
                  kind: 'mesh-inbox',
                  multiple: false,
                  keepMounted: true,
                  priority: 'extension',
                  title: () => 'Mesh 信箱',
                  guide: [
                    {
                      id: 'open',
                      order: 30,
                      title: () => 'Mesh 信箱',
                      description: () => '查看与其它 agent 的往来信件（跟随当前会话筛选）',
                      icon: MeshInboxGlyph,
                    },
                  ],
                })
                rightTabState = 'ok'
              } catch (error) {
                const message = String(error && error.message ? error.message : error)
                rightTabState = /already registered/i.test(message) ? 'ok (已注册)' : 'error: ' + message
                if (typeof console !== 'undefined') console.warn('[mesh-waker] right tab type:', message)
              }
              try {
                disposers.push(
                  ctx.slots.inject('sidebar.right.pane.tab', () =>
                    ctx.slots.register(
                      {
                        name: 'sidebar.right.pane.tab',
                        key: 'mesh-inbox',
                        inject: (sessionId) => ({ sessionId }),
                      },
                      MeshInboxTab,
                    ),
                  ),
                )
              } catch (error) {
                rightTabState += ' | body: ' + (error && error.message ? error.message : String(error))
              }
            }),
          )
        } else {
          rightTabState = 'unsupported'
        }
        return () => {
          for (const dispose of disposers.splice(0)) dispose()
        }
      },
    }
  },
  });
} catch (error) {
  console.warn('[mesh-waker] duplicate registration skipped:', error && error.message ? error.message : error);
}
